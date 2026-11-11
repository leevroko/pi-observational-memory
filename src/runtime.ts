import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type Config, configuredModelKey, DEFAULTS, loadConfig, modelChain } from "./config.js";
import { debugLog } from "./debug-log.js";

/** Request auth pi hands to a model call, resolved once per candidate. */
export interface ModelAuth {
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	baseUrl?: string;
}

/** One memory model that resolved AND authenticated, ready to be attempted. */
export interface ResolvedModelCandidate {
	/** Model object from pi's registry, or the session model. */
	model: unknown;
	/** "provider/id" for a configured entry, session-derived label otherwise. */
	label: string;
	source: "configured" | "session";
	/** Thinking level configured for this chain entry; stages fall back to "low". */
	thinking?: ModelThinkingLevel;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	baseUrl?: string;
}

/** A chain entry that was skipped, with the reason it was unusable. */
export interface RejectedModel {
	label: string;
	reason: string;
}

export type ResolveResult =
	| { ok: true; candidates: ResolvedModelCandidate[]; rejected: RejectedModel[] }
	| { ok: false; reason: string };

/**
 * Mirrors pi's own request-auth acceptance rule (`AgentSession._getRequiredRequestAuth`):
 * resolved auth is usable when it carries an apiKey OR at least one header value.
 * OAuth providers (kimi-coding, xai, openai-codex, anthropic OAuth, …) authenticate via
 * `toAuth()` returning `{ headers: { Authorization: "Bearer …" } }` with no apiKey, and
 * pi-ai providers accept a caller-supplied Authorization header in place of an apiKey.
 *
 * NOTE: a `false` result does NOT mean "unauthenticated" — see `resolveModel`. Providers
 * that authenticate at request time (Amazon Bedrock SigV4 from AWS_PROFILE/SSO, Google
 * Vertex ADC) legitimately expose neither an apiKey nor a header, because pi signs their
 * requests itself.
 */
function hasUsableAuth(auth: { apiKey?: unknown; headers?: unknown }): boolean {
	if (typeof auth.apiKey === "string" && auth.apiKey.length > 0) return true;
	return countUsableHeaders(auth.headers) > 0;
}

/** How many headers the auth payload carries at all (diagnostics only, never values). */
function countHeaders(headers: unknown): number {
	return headers && typeof headers === "object" ? Object.keys(headers as Record<string, unknown>).length : 0;
}

/** How many headers carry a non-empty string value — the ones pi could actually send. */
function countUsableHeaders(headers: unknown): number {
	if (!headers || typeof headers !== "object") return 0;
	return Object.values(headers as Record<string, unknown>).filter(
		(value) => typeof value === "string" && value.length > 0,
	).length;
}

/**
 * How long to wait for the availability re-check in `recheckProviderCredential`, and how
 * long before the same provider may be re-checked again.
 *
 * The re-check is network-free and measured at ~1ms on a warm Bedrock/SSO host, but
 * `checkAuth` can block on a provider's own credential resolution, so it is bounded. The
 * re-arm interval keeps an unauthenticated host from paying the cost on every
 * consolidation while still recovering within a session when credentials are renewed out
 * of band (`aws sso login` in another terminal, `gcloud auth application-default login`).
 */
const AVAILABILITY_RECHECK_TIMEOUT_MS = 5_000;
const AVAILABILITY_RECHECK_REARM_MS = 60_000;

type NotifyLevel = "warning" | "info" | "error";
type Notify = (message: string, type?: NotifyLevel) => void;
export type ConsolidationPhase = "observer" | "reflector" | "dropper" | "reflection-dropper";

/**
 * Whether pi positively reports a working credential source for this model's provider.
 *
 * `ModelRegistry.hasConfiguredAuth(model)` is true when pi's availability check
 * (`ModelRuntime.checkAuth`) resolved *something* for the provider — an API key, a
 * stored credential, or an ambient source such as `AWS_PROFILE` / `AWS_ACCESS_KEY_ID`
 * / gcloud ADC. Combined with `auth.ok === true` and an auth payload that carries
 * nothing, that is the signature of a provider pi signs at request time:
 *
 *   pi has a credential source, and deliberately hands the caller nothing to attach.
 *
 * Measured on a Bedrock/SSO host (pi 0.84.2), with `AWS_PROFILE` exported:
 *   checkAuth("amazon-bedrock") -> { source: "AWS_PROFILE", type: "api_key" }
 *   hasConfiguredAuth(model)    -> true
 *   getApiKeyAndHeaders(model)  -> { ok: true, apiKey: undefined, headers: undefined }
 * `googleVertexProvider`'s ADC branch returns the same empty-auth resolution.
 *
 * The inverse case — `hasConfiguredAuth === false` with an empty auth payload — is a
 * provider pi could not authenticate at all (no key, no ambient source). That must
 * keep failing: it is the ordinary "not logged in" state, not ambient auth.
 *
 * Defensive: older pi versions and partial test doubles may not expose this, and an
 * unknown answer must not be read as "authenticated".
 */
function hasConfiguredProviderCredential(registry: unknown, model: unknown): boolean {
	try {
		return (registry as { hasConfiguredAuth?: (m: unknown) => unknown }).hasConfiguredAuth?.(model) === true;
	} catch {
		return false;
	}
}

export interface ResolveCtx {
	model: unknown;
	modelRegistry: any;
	hasUI: boolean;
	ui?: { notify: Notify };
}

export interface LaunchCtx {
	hasUI: boolean;
	ui?: { notify: Notify };
}

/** Display identity of a model object ("provider/id"), or `fallback` when unknown. */
export function modelLabel(model: unknown, fallback: string): string {
	const entry = model as { provider?: unknown; id?: unknown } | undefined;
	const provider = typeof entry?.provider === "string" ? entry.provider : undefined;
	const id = typeof entry?.id === "string" ? entry.id : undefined;
	if (provider && id) return `${provider}/${id}`;
	if (provider) return provider;
	return fallback;
}

/**
 * Whether two model objects describe the same model. Compares by reference first,
 * then by label, so a configured chain entry that names the session model does not
 * get attempted twice.
 */
function sameModel(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	const labelA = modelLabel(a, "");
	return labelA !== "" && labelA === modelLabel(b, "");
}

/**
 * Ordered walk through the resolved memory-model chain. A stage starts at the head
 * and calls {@link advance} after a failed attempt; the chain is spent once
 * {@link current} returns undefined.
 */
export class ModelCursor {
	private index = 0;

	constructor(
		readonly candidates: readonly ResolvedModelCandidate[],
		readonly rejected: readonly RejectedModel[] = [],
	) {}

	get current(): ResolvedModelCandidate | undefined {
		return this.candidates[this.index];
	}

	/** Move past the candidate that just failed. Returns the next one, or undefined. */
	advance(): ResolvedModelCandidate | undefined {
		this.index += 1;
		return this.current;
	}
}

export class Runtime {
	config: Config = { ...DEFAULTS };
	configLoaded = false;
	consolidationInFlight = false;
	consolidationPromise: Promise<void> | null = null;
	consolidationPhase: ConsolidationPhase | undefined;
	/** Set while a consolidation run should stop quietly (session replaced/reloaded mid-flight). */
	consolidationCancelled = false;
	compactInFlight = false;
	compactHookInFlight = false;
	resolveFailureNotified = false;
	/** Notified once per session when the compaction summary had to be truncated to fit the context budget. */
	summaryBudgetNotified = false;
	lastObserverError: string | undefined;
	lastReflectorError: string | undefined;
	lastDropperError: string | undefined;
	lastReflectionDropperError: string | undefined;
	/** Model each stage of the last consolidation run actually used, by stage label. */
	lastStageModels: Partial<Record<ConsolidationPhase, string>> = {};
	/** provider -> epoch ms of the last availability re-check (see `recheckProviderCredential`). */
	availabilityRecheckedAt = new Map<string, number>();
	/** Deliberate-empty backoff (#23): skip observer re-fires over the same span until enough new tokens arrive. */
	observerEmptyBackoff: {
		sessionIdentity: string | undefined;
		coverageId: string | undefined;
		tokensAtEmpty: number;
	} | undefined;

	ensureConfig(cwd: string): void {
		if (this.configLoaded) return;
		this.config = loadConfig(cwd);
		this.configLoaded = true;
	}

	/**
	 * Resolve the memory-model chain into usable candidates, in configured order.
	 *
	 * A configured entry pi's registry does not know, or one whose credential does
	 * not resolve, is skipped and recorded in `rejected` rather than failing the run:
	 * that is what keeps a chain usable while one provider is down. The session model
	 * is always tried last. Historically a `model` override that could not be found
	 * meant "use the session model", and keeping the session model as the tail is also
	 * the safety net when the whole configured chain is unavailable.
	 */
	async resolveModel(ctx: ResolveCtx): Promise<ResolveResult> {
		const candidates: ResolvedModelCandidate[] = [];
		const rejected: RejectedModel[] = [];
		const chain = modelChain(this.config);

		for (const configured of chain) {
			const label = configuredModelKey(configured);
			const found = ctx.modelRegistry.find(configured.provider, configured.id);
			if (!found) {
				rejected.push({ label, reason: "not found in model registry" });
				continue;
			}
			const resolved = await this.checkCredential(ctx, found);
			if (!resolved.ok) {
				rejected.push({ label, reason: resolved.reason });
				continue;
			}
			candidates.push({ model: found, label, source: "configured", thinking: configured.thinking, ...resolved.auth });
		}

		const sessionModel = ctx.model;
		const sessionTried = sessionModel !== undefined
			&& candidates.some((candidate) => sameModel(candidate.model, sessionModel));
		if (sessionModel !== undefined && !sessionTried) {
			const label = modelLabel(sessionModel, "session model");
			const resolved = await this.checkCredential(ctx, sessionModel);
			if (resolved.ok) {
				// Reaching the session model through the chain keeps the configured
				// thinking level, the way a single `model` override always did.
				candidates.push({ model: sessionModel, label, source: "session", thinking: chain[0]?.thinking, ...resolved.auth });
			} else {
				rejected.push({ label, reason: resolved.reason });
			}
		}

		if (candidates.length === 0) {
			if (rejected.length === 0) {
				return { ok: false, reason: "no model available (session has no model and no observational-memory model configured)" };
			}
			if (rejected.length === 1) return { ok: false, reason: rejected[0]!.reason };
			const summary = rejected.map((entry) => `${entry.label} (${entry.reason})`).join("; ");
			return { ok: false, reason: `no usable memory model: ${summary}` };
		}

		if (rejected.length > 0) {
			for (const entry of rejected) debugLog("resolve.rejected_candidate", { model: entry.label, reason: entry.reason });
			if (ctx.hasUI && ctx.ui) {
				const skipped = rejected.map((entry) => `${entry.label} skipped (${entry.reason})`).join(", ");
				ctx.ui.notify(`Observational memory: ${skipped}, using ${candidates[0]!.label}`, "warning");
			}
		}

		return { ok: true, candidates, rejected };
	}

	/**
	 * Whether pi can authenticate requests for one resolved model object, and the
	 * auth payload to use when it can.
	 */
	private async checkCredential(ctx: ResolveCtx, model: unknown): Promise<{ ok: true; auth: ModelAuth } | { ok: false; reason: string }> {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		const provider = (model as { provider?: string }).provider ?? "unknown";
		const isOAuth = ctx.modelRegistry.isUsingOAuth?.(model) === true;
		// `auth.ok === false` is the only unambiguous failure: pi returns it when a
		// provider requires a request auth header and no credential resolved.
		//
		// `auth.ok === true` with neither apiKey nor headers, for a provider pi DOES
		// report a credential source for, is not a failure — it is how pi describes a
		// provider that authenticates at request time: Amazon Bedrock signing SigV4 from
		// ambient AWS credentials (`bedrockAuth.resolve` returns `{ auth: {}, source:
		// "AWS_PROFILE" }`), Google Vertex using ADC (same empty resolution). pi's own
		// native streaming path forwards no apiKey either, and its pre-prompt gate is
		// merely `hasConfiguredAuth(provider) || checkAuth(provider) !== undefined` —
		// om's pre-flight check must not be stricter than pi's own. Treating it as "no
		// auth" aborted consolidation before the model was ever called, disabling
		// observational memory silently — no error, no cost, no latency — on such hosts.
		//
		// Three cases deliberately keep failing: OAuth providers, where an empty
		// resolution means the credentials no longer resolve and the user must log in
		// again; a credential that resolved to an empty *string* key, which is a
		// misconfiguration rather than ambient auth; and a provider pi reports no
		// credential source for at all, which is simply unauthenticated.
		const usable = hasUsableAuth(auth);
		const resolvedEmptyApiKey = typeof auth.apiKey === "string" && auth.apiKey.length === 0;
		let providerCredentialConfigured = hasConfiguredProviderCredential(ctx.modelRegistry, model);
		// pi's gate has TWO halves and never trusts the availability snapshot alone
		// (`AgentSession._getRequiredRequestAuth` in pi): a provider missing from a
		// stale or failed snapshot is re-checked live before the run gives up. See
		// `recheckProviderCredential`.
		if (auth.ok === true && !usable && !isOAuth && !resolvedEmptyApiKey && !providerCredentialConfigured) {
			providerCredentialConfigured = await this.recheckProviderCredential(ctx.modelRegistry, model, provider);
		}
		const signsAtRequestTime = auth.ok === true && !isOAuth && !resolvedEmptyApiKey && providerCredentialConfigured;
		if (!auth.ok || (!usable && !signsAtRequestTime)) {
			const reason = isOAuth
				? `authentication failed for provider "${provider}" — OAuth credentials may have expired; run '/login ${provider}' to re-authenticate`
				: `no API key or auth headers for provider "${provider}"`;
			// Record the decision inputs — booleans and counts only, never values.
			debugLog("resolve.rejected", {
				provider,
				reason,
				authOk: auth.ok === true,
				hasApiKey: typeof auth.apiKey === "string" && auth.apiKey.length > 0,
				resolvedEmptyApiKey,
				headerCount: countHeaders(auth.headers),
				usableHeaderCount: countUsableHeaders(auth.headers),
				isOAuth,
				providerCredentialConfigured,
				signsAtRequestTime,
			});
			return { ok: false, reason };
		}
		if (!usable) {
			debugLog("resolve.request_time_signing", { provider, providerCredentialConfigured });
		}
		return {
			ok: true,
			auth: {
				apiKey: auth.apiKey as string | undefined,
				headers: auth.headers as Record<string, string> | undefined,
				env: auth.env as Record<string, string> | undefined,
				baseUrl: auth.baseUrl as string | undefined,
			},
		};
	}

	/**
	 * Re-check one provider's credential live, then re-read pi's snapshot.
	 *
	 * Implements the second half of pi's own auth gate for the only case that needs it: an
	 * otherwise-ambient-looking resolution whose provider is missing from a stale or never
	 * populated availability snapshot. Bounded and rate-limited; never throws.
	 */
	private async recheckProviderCredential(registry: unknown, model: unknown, provider: string): Promise<boolean> {
		const last = this.availabilityRecheckedAt.get(provider);
		const now = Date.now();
		if (last !== undefined && now - last < AVAILABILITY_RECHECK_REARM_MS) return false;
		this.availabilityRecheckedAt.set(provider, now);

		const refresh = (registry as { refresh?: (options?: unknown) => Promise<unknown> }).refresh;
		if (typeof refresh !== "function") {
			debugLog("resolve.availability_recheck", { provider, refreshed: false, reason: "registry exposes no refresh()" });
			return false;
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), AVAILABILITY_RECHECK_TIMEOUT_MS);
		let refreshError: string | undefined;
		let timedOut = false;
		try {
			// allowNetwork:false — a credential re-check must not wait on a model-catalog fetch.
			// providers:[provider] — scope the work, and the snapshot writes, to the one provider.
			//
			// Both are honoured from pi 0.84; on pi 0.81 the facade is `refresh()` with no
			// parameters, delegating to `runtime.reloadConfig()`, which reloads models.json and
			// then runs a FULL, network-permitted availability pass. Passing the options is
			// harmless there, but the work is wider and slower — hence the race below rather
			// than relying on the abort signal, which that version never sees.
			await Promise.race([
				refresh.call(registry, { allowNetwork: false, providers: [provider], signal: controller.signal }),
				new Promise<void>((resolve) => {
					controller.signal.addEventListener("abort", () => {
						timedOut = true;
						resolve();
					});
				}),
			]);
		} catch (error) {
			refreshError = error instanceof Error ? error.message : String(error);
		} finally {
			clearTimeout(timer);
		}

		// Re-read even when the refresh reported an error or timed out: a scoped pass can
		// update the snapshot for this provider and still fail elsewhere.
		const recovered = hasConfiguredProviderCredential(registry, model);
		debugLog("resolve.availability_recheck", {
			provider,
			refreshed: refreshError === undefined && !timedOut,
			recovered,
			elapsedMs: Date.now() - now,
			timedOut,
			...(refreshError === undefined ? {} : { refreshError }),
		});
		return recovered;
	}

	/** Cancel the in-flight consolidation run: session_shutdown emitted mid-flight means
	 * captured pi/ctx objects are about to go stale, so the run must stop before it
	 * touches them (docs/extensions.md — session replacement lifecycle). */
	cancelConsolidation(): void {
		this.consolidationCancelled = true;
	}

	launchConsolidationTask(ctx: LaunchCtx, work: () => Promise<void>): Promise<void> {
		this.consolidationInFlight = true;
		this.consolidationCancelled = false;
		this.consolidationPhase = undefined;
		this.lastObserverError = undefined;
		this.lastReflectorError = undefined;
		this.lastDropperError = undefined;
		this.lastStageModels = {};
		const promise = this.launchTrackedTask(ctx, "consolidation", work, () => {
			this.consolidationInFlight = false;
			this.consolidationPhase = undefined;
			if (this.consolidationPromise === promise) this.consolidationPromise = null;
		});
		this.consolidationPromise = promise;
		return promise;
	}

	recordConsolidationStageError(ctx: LaunchCtx, phase: ConsolidationPhase, error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		if (phase === "observer") this.lastObserverError = message;
		if (phase === "reflector") this.lastReflectorError = message;
		if (phase === "dropper") this.lastDropperError = message;
		if (ctx.hasUI && ctx.ui) ctx.ui.notify(`Observational memory: ${phase} failed: ${message}`, "warning");
		return message;
	}

	private launchTrackedTask(
		ctx: LaunchCtx,
		label: string,
		work: () => Promise<void>,
		onFinally: (error: string | undefined) => void,
	): Promise<void> {
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;
		return (async () => {
			let errorMessage: string | undefined;
			try {
				await work();
			} catch (error) {
				errorMessage = error instanceof Error ? error.message : String(error);
				if (hasUI && ui) ui.notify(`Observational memory: ${label} failed: ${errorMessage}`, "warning");
			} finally {
				onFinally(errorMessage);
			}
		})();
	}
}
