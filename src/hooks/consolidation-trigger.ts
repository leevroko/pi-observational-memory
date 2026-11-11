import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runDropper } from "../agents/dropper/agent.js";
import { observationPoolMetrics, reflectionPoolMetrics } from "../agents/dropper/pool.js";
import { runReflectionDropper } from "../agents/reflection-dropper/agent.js";
import { runObserver } from "../agents/observer/agent.js";
import { runReflector } from "../agents/reflector/agent.js";
import { debugLog, withDebugLogContext } from "../debug-log.js";
import { resolveObserverChunkMaxTokens } from "../config.js";
import { ModelCursor, type ResolveResult, type ResolvedModelCandidate, type Runtime } from "../runtime.js";
import { serializeSourceAddressedBranchEntries } from "../serialize.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_DROPPED,
	OM_REFLECTIONS_RECORDED,
	buildObservationsDroppedData,
	buildObservationsRecordedData,
	buildReflectionsDroppedData,
	buildReflectionsRecordedData,
	earlierCoverageMarkerId,
	foldLedger,
	fullProjection,
	isSourceEntry,
	latestCoverageIndex,
	latestCoverageMarkerId,
	observationToSummaryLine,
	realTokensSinceAnchor,
	rawTokensSinceObservationCoverage,
	rawTokensSinceReflectionCoverage,
	reflectionToSummaryLine,
	type Entry,
	type Reflection,
	type V3MemoryCustomType,
} from "../session-ledger/index.js";

type StageName = "observer" | "reflector" | "dropper" | "reflection-dropper";

type ConsolidationCtx = {
	cwd: string;
	hasUI: boolean;
	ui?: { notify: (message: string, type?: "warning" | "info" | "error") => void };
	model: unknown;
	modelRegistry: any;
	getContextUsage?: () => { tokens?: number | null; contextWindow?: number } | undefined;
	sessionManager: {
		getBranch: () => unknown;
		getSessionId?: () => string;
		getSessionFile?: () => string | undefined;
	};
};

type StageOutcome = "continue" | "abort";

type ReflectorStageResult = {
	outcome: StageOutcome;
	sameRunReflections: Reflection[];
	effectiveReflectionCoverageId?: string;
};

function sourceEntriesAfter(entries: Entry[], index: number): Entry[] {
	return entries.slice(index + 1).filter(isSourceEntry);
}

function appendEntry(pi: ExtensionAPI, customType: string, data: unknown): void {
	pi.appendEntry(customType, data);
}

function mergeReflections(existing: Reflection[], additional: Reflection[]): Reflection[] {
	const seen = new Set(existing.map((reflection) => reflection.id));
	const merged = [...existing];
	for (const reflection of additional) {
		if (seen.has(reflection.id)) continue;
		seen.add(reflection.id);
		merged.push(reflection);
	}
	return merged;
}

/**
 * Real current context tokens from the session (provider-reported usage, the
 * same basis the footer percentage uses). Falls back to undefined when the
 * host pi lacks getContextUsage or the count is unknown (e.g. right after a
 * compaction, before the next valid assistant response).
 */
function realContextTokens(ctx: ConsolidationCtx): number | undefined {
	const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
	const tokens = usage?.tokens;
	return typeof tokens === "number" && Number.isFinite(tokens) ? tokens : undefined;
}

function stageDue(
	entries: Entry[],
	runtime: Runtime,
	currentTokens: number | undefined,
	customType: V3MemoryCustomType,
	rawEstimateFn: (entries: Entry[]) => number,
	threshold: number,
): boolean {
	if (currentTokens !== undefined) {
		const real = realTokensSinceAnchor(entries, customType, currentTokens);
		if (real !== undefined) return real >= threshold;
	}
	// Real delta unmeasurable (no usage baseline, or accounting basis changed) or
	// old pi host without getContextUsage — fall back to the raw estimate, which
	// self-limits after coverage and cannot over-fire or starve.
	return rawEstimateFn(entries) >= threshold;
}

function anyStageDue(entries: Entry[], runtime: Runtime, currentTokens: number | undefined): boolean {
	return stageDue(entries, runtime, currentTokens, OM_OBSERVATIONS_RECORDED, rawTokensSinceObservationCoverage, runtime.config.observeAfterTokens)
		|| stageDue(entries, runtime, currentTokens, OM_REFLECTIONS_RECORDED, rawTokensSinceReflectionCoverage, runtime.config.reflectAfterTokens);
}

function shouldNotifyWorker(runtime: Runtime, ctx: ConsolidationCtx): boolean {
	return runtime.config.showWorkerNotifications && ctx.hasUI;
}

/**
 * Resolve the memory-model chain once per consolidation run and hand each stage a
 * cursor over it. Every stage starts at the head of the chain: the model that suits
 * the observer's chunk is not necessarily the one that survives the dropper's call,
 * and a stage that falls back must not inherit another stage's failures.
 */
function makeModelResolver(runtime: Runtime, ctx: ConsolidationCtx): (stage: StageName) => Promise<ModelCursor | undefined> {
	let cached: Promise<ResolveResult> | undefined;
	return async (stage) => {
		cached ??= runtime.resolveModel({
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
		});
		const result = await cached;
		if (result.ok) {
			runtime.resolveFailureNotified = false;
			return new ModelCursor(result.candidates, result.rejected);
		}
		debugLog(`${stage}.model_unavailable`, { reason: result.reason });
		if (!runtime.resolveFailureNotified && ctx.hasUI && ctx.ui) {
			ctx.ui.notify(`Observational memory: ${stage} skipped — ${result.reason}`, "warning");
			runtime.resolveFailureNotified = true;
		}
		return undefined;
	};
}

/**
 * Run one stage attempt across the memory-model chain.
 *
 * Any error thrown by the attempt counts as that model being unavailable for this
 * piece of work (connection refused, rate limit, stream failure, oversized request),
 * so the same attempt is retried against the next candidate. When the chain is spent
 * the last error comes back for the caller to record, and a session replacement
 * mid-attempt stops the walk instead of burning the remaining candidates on a ctx
 * that is about to go stale.
 */
async function withModelFallback<T>(
	runtime: Runtime,
	ctx: ConsolidationCtx,
	stage: StageName,
	cursor: ModelCursor,
	attempt: (candidate: ResolvedModelCandidate) => Promise<T>,
): Promise<
	| { ok: true; value: T; candidate: ResolvedModelCandidate }
	| { ok: false; error: unknown; candidate: ResolvedModelCandidate | undefined }
> {
	for (;;) {
		const candidate = cursor.current;
		if (!candidate) {
			return { ok: false, error: new Error(`${stage} has no usable memory model`), candidate: undefined };
		}
		try {
			return { ok: true, value: await attempt(candidate), candidate };
		} catch (error) {
			if (runtime.consolidationCancelled) return { ok: false, error, candidate };
			const next = cursor.advance();
			const message = error instanceof Error ? error.message : String(error);
			debugLog(`${stage}.model_attempt_failed`, { model: candidate.label, errorMessage: message, nextModel: next?.label });
			if (!next) return { ok: false, error, candidate };
			if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
				`Observational memory: ${stage} retried on ${next.label} after ${candidate.label} failed: ${message}`,
				"warning",
			);
		}
	}
}

export function registerConsolidationTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	const launch = (_event: unknown, ctx: ConsolidationCtx) => {
		maybeLaunchConsolidation(pi, runtime, ctx);
	};
	pi.on("agent_start", launch);
	pi.on("turn_end", launch);
	// A session replacement or reload emits session_shutdown on the (still-active)
	// old runtime before tearing it down. Stop the in-flight pipeline there — the
	// captured pi/ctx it holds goes stale right after (docs/extensions.md,
	// "Session replacement lifecycle and footguns"), and using it would reject the
	// remaining stages with the stale-ctx error instead of cancelling them cleanly.
	pi.on("session_shutdown", () => {
		runtime.cancelConsolidation();
	});
}

function debugSessionMetadata(ctx: ConsolidationCtx): { sessionId?: string; sessionFile?: string } {
	try {
		return {
			sessionId: ctx.sessionManager.getSessionId?.(),
			sessionFile: ctx.sessionManager.getSessionFile?.(),
		};
	} catch {
		return {};
	}
}

function maybeLaunchConsolidation(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx): void {
	runtime.ensureConfig(ctx.cwd);
	if (runtime.config.passive === true) return;
	if (runtime.consolidationInFlight) return;

	const entries = ctx.sessionManager.getBranch() as Entry[];
	if (!anyStageDue(entries, runtime, realContextTokens(ctx))) return;

	const runId = `consolidation-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
	const consolidationCtx: ConsolidationCtx = {
		cwd: ctx.cwd,
		hasUI: ctx.hasUI,
		ui: ctx.ui,
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
		getContextUsage: ctx.getContextUsage,
		sessionManager: ctx.sessionManager,
	};

	const sessionMetadata = debugSessionMetadata(ctx);
	void runtime.launchConsolidationTask(ctx, async () => withDebugLogContext({
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		...sessionMetadata,
		runId,
	}, async () => {
		await runConsolidationPipeline(pi, runtime, consolidationCtx);
	}));
}

export async function runConsolidationPipeline(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
): Promise<void> {
	const resolveModel = makeModelResolver(runtime, ctx);
	const cancelled = () => runtime.consolidationCancelled === true;

	runtime.consolidationPhase = "observer";
	try {
		const observerOutcome = await runObserverStage(pi, runtime, ctx, resolveModel);
		if (cancelled()) {
			debugLog("consolidation.cancelled", { after: "observer" });
			return;
		}
		if (observerOutcome === "abort") return;
	} catch (error) {
		if (cancelled()) return; // stale ctx — no warning spam after session replacement
		debugLog("observer.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "observer", error) });
		return;
	}

	runtime.consolidationPhase = "reflector";
	let reflectorResult: ReflectorStageResult;
	try {
		reflectorResult = await runReflectorStage(pi, runtime, ctx, resolveModel);
		if (cancelled()) {
			debugLog("consolidation.cancelled", { after: "reflector" });
			return;
		}
		if (reflectorResult.outcome === "abort") return;
	} catch (error) {
		if (cancelled()) return;
		debugLog("reflector.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "reflector", error) });
		return;
	}

	runtime.consolidationPhase = "dropper";
	try {
		await runDropperStage(pi, runtime, ctx, resolveModel, reflectorResult.sameRunReflections, reflectorResult.effectiveReflectionCoverageId);
		if (cancelled()) debugLog("consolidation.cancelled", { after: "dropper" });
	} catch (error) {
		if (cancelled()) return;
		debugLog("dropper.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "dropper", error) });
	}

	runtime.consolidationPhase = "reflection-dropper";
	try {
		await runReflectionDropperStage(pi, runtime, ctx, resolveModel);
		if (cancelled()) debugLog("consolidation.cancelled", { after: "reflection-dropper" });
	} catch (error) {
		if (cancelled()) return;
		debugLog("reflection-dropper.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "reflection-dropper", error) });
	}
}

/**
 * Trim the active reflection pool once it crosses the hard max. Reflections are
 * durable distillates, so unlike observations this stage fires only over the
 * hard ceiling (not the target) and trims toward the target in one pass.
 */
async function runReflectionDropperStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: StageName) => Promise<ModelCursor | undefined>,
): Promise<StageOutcome> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const folded = foldLedger(entries);
	const metrics = reflectionPoolMetrics(
		folded.activeReflections,
		runtime.config.reflectionsPoolMaxTokens,
		runtime.config.reflectionsPoolTargetTokens,
	);
	if (!metrics.ready) {
		debugLog("reflection-dropper.not_ready", {
			reflectionTokens: metrics.reflectionTokens,
			maxTokens: metrics.maxTokens,
			targetTokens: metrics.targetTokens,
			activeReflectionCount: metrics.activeReflectionCount,
			maxDropsAllowed: metrics.maxDropsAllowed,
		});
		return "continue";
	}
	debugLog("reflection-dropper.stage_start", {
		reflectionTokens: metrics.reflectionTokens,
		maxTokens: metrics.maxTokens,
		targetTokens: metrics.targetTokens,
		activeReflectionCount: metrics.activeReflectionCount,
		maxDropsAllowed: metrics.maxDropsAllowed,
	});

	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: reflection pool ~${metrics.reflectionTokens.toLocaleString()} tokens over the ~${metrics.maxTokens.toLocaleString()} hard max; trimming toward ~${metrics.targetTokens.toLocaleString()}`,
		"info",
	);
	const cursor = await resolveModel("reflection-dropper");
	if (!cursor) return "abort";
	if (runtime.consolidationCancelled) return "abort";

	const attempt = await withModelFallback(runtime, ctx, "reflection-dropper", cursor, (candidate) => runReflectionDropper({
		model: candidate.model as any,
		apiKey: candidate.apiKey,
		headers: candidate.headers,
		env: candidate.env,
		reflections: folded.activeReflections,
		maxTokens: runtime.config.reflectionsPoolMaxTokens,
		targetTokens: runtime.config.reflectionsPoolTargetTokens,
		maxTurns: runtime.config.agentMaxTurns,
		thinkingLevel: candidate.thinking ?? "low",
	}));
	if (!attempt.ok) throw attempt.error;
	runtime.lastStageModels["reflection-dropper"] = attempt.candidate.label;
	const droppedIds = attempt.value;
	if (runtime.consolidationCancelled) return "abort";
	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	const reflectionCoverageId = latestCoverageMarkerId(entries, OM_REFLECTIONS_RECORDED);
	const coversUpToId = earlierCoverageMarkerId(entries, observationCoverageId, reflectionCoverageId);
	const data = coversUpToId && droppedIds ? buildReflectionsDroppedData(droppedIds, coversUpToId) : undefined;
	debugLog("reflection-dropper.append", {
		droppedIdsCount: droppedIds?.length ?? 0,
		coversUpToId,
		dataBuilt: data !== undefined,
	});
	if (data) appendEntry(pi, OM_REFLECTIONS_DROPPED, data);
	if (data && shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: ${data.reflectionIds.length} reflection${data.reflectionIds.length === 1 ? "" : "s"} dropped from active memory`,
		"info",
	);
	return "continue";
}

async function runObserverStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: StageName) => Promise<ModelCursor | undefined>,
): Promise<StageOutcome> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const currentTokens = realContextTokens(ctx);
	const real = currentTokens !== undefined ? realTokensSinceAnchor(entries, OM_OBSERVATIONS_RECORDED, currentTokens) : undefined;
	const tokens = real !== undefined ? real : rawTokensSinceObservationCoverage(entries); // fallback: no usage baseline / basis change
	if (tokens < runtime.config.observeAfterTokens) return "continue";

	const sessionMetadata = debugSessionMetadata(ctx);
	const sessionIdentity = sessionMetadata.sessionId ?? sessionMetadata.sessionFile;
	const coverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);

	// Deliberate-empty backoff (#23): an intentional "nothing to record" verdict
	// must not re-fire the observer every turn over the same span. Retry only
	// after another observeAfterTokens worth of new source tokens arrives, and
	// drop the backoff as soon as coverage advances.
	const backoff = runtime.observerEmptyBackoff;
	if (backoff) {
		if (
			sessionIdentity !== backoff.sessionIdentity
			|| coverageId !== backoff.coverageId
			|| tokens >= backoff.tokensAtEmpty + runtime.config.observeAfterTokens
		) {
			runtime.observerEmptyBackoff = undefined;
		} else {
			debugLog("observer.empty_backoff", { tokens, resumeAtTokens: backoff.tokensAtEmpty + runtime.config.observeAfterTokens });
			return "continue";
		}
	}

	const cursor = await resolveModel("observer");
	if (!cursor) return "abort";
	if (runtime.consolidationCancelled) return "abort"; // session replaced while resolving — drop out before touching captured ctx

	const lastCoverageIdx = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	const backlogEntries = sourceEntriesAfter(entries, lastCoverageIdx);
	const memory = fullProjection(entries);
	const priorReflections = memory.reflections.map(reflectionToSummaryLine);
	const priorObservations = memory.observations.map(observationToSummaryLine);

	// The chunk is budgeted inside the attempt: its default cap derives from the context
	// window of the model that is about to be called, so a fallback model with a smaller
	// window gets a smaller chunk instead of a request the provider would reject.
	const outcome = await withModelFallback(runtime, ctx, "observer", cursor, async (candidate) => {
		// Budget the text that is actually sent to the observer, including source labels
		// and rendered message content. Complete entries are kept intact. Only a first
		// entry that cannot fit by itself is represented by a clearly marked head/tail
		// excerpt; the original ledger entry remains untouched.
		const contextWindow = (candidate.model as { contextWindow?: number }).contextWindow;
		const maxChunkTokens = resolveObserverChunkMaxTokens(runtime.config, contextWindow);
		const {
			text: chunk,
			sourceEntryIds,
			estimatedTokens: chunkTokens,
			truncatedSourceEntryIds,
		} = serializeSourceAddressedBranchEntries(backlogEntries, { maxTokens: maxChunkTokens });
		if (!chunk.trim() || sourceEntryIds.length === 0) return { kind: "nothing-to-send" } as const;
		const coversUpToId = sourceEntryIds.at(-1);
		if (!coversUpToId) return { kind: "nothing-to-send" } as const;

		if (sourceEntryIds.length < backlogEntries.length || truncatedSourceEntryIds.length > 0) {
			debugLog("observer.chunk_capped", {
				maxChunkTokens,
				backlogEntries: backlogEntries.length,
				backlogTokens: tokens,
				chunkEntries: sourceEntryIds.length,
				chunkTokens,
				truncatedSourceEntryIds,
			});
		}

		if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
			`Observational memory: observer running on ~${chunkTokens.toLocaleString()}-token chunk`,
			"info",
		);
		debugLog("observer.start", {
			tokens,
			chunkTokens,
			coversUpToId,
			sourceEntryIds,
			sourceEntryCount: sourceEntryIds.length,
			priorReflections: priorReflections.length,
			priorObservations: priorObservations.length,
		});

		const observations = await runObserver({
			model: candidate.model as any,
			apiKey: candidate.apiKey,
			headers: candidate.headers,
			env: candidate.env,
			priorReflections,
			priorObservations,
			chunk,
			allowedSourceEntryIds: sourceEntryIds,
			maxTurns: runtime.config.agentMaxTurns,
			thinkingLevel: candidate.thinking ?? "low",
		});
		return { kind: "ran", observations, coversUpToId } as const;
	});

	if (!outcome.ok) {
		// An API/stream failure is not a clean empty (#32): once every candidate has
		// been tried it surfaces as a real failure and coverage stays where it was.
		if (runtime.consolidationCancelled) return "abort";
		runtime.recordConsolidationStageError(ctx, "observer", outcome.error);
		return "abort";
	}
	runtime.lastStageModels.observer = outcome.candidate.label;
	const attempt = outcome.value;
	if (attempt.kind === "nothing-to-send") return "continue";
	if (runtime.consolidationCancelled) return "abort"; // cancel before appending with a possibly-stale pi
	const { observations, coversUpToId } = attempt;
	if (!observations || observations.length === 0) {
		// Deliberate empty: routine info, not a warning, and back off re-fires
		// over the same span (#23).
		debugLog("observer.empty", { coversUpToId });
		runtime.observerEmptyBackoff = { sessionIdentity, coverageId, tokensAtEmpty: tokens };
		if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
			"Observational memory: observer found nothing new in this chunk (coverage unchanged; will retry later)",
			"info",
		);
		return "continue";
	}
	runtime.observerEmptyBackoff = undefined;

	const data = buildObservationsRecordedData(observations, coversUpToId);
	if (!data) return "continue";
	debugLog("observer.records", {
		count: observations.length,
		observationTokens: observations.reduce((sum, observation) => sum + observation.tokenCount, 0),
		coversUpToId,
	});
	appendEntry(pi, OM_OBSERVATIONS_RECORDED, data);
	debugLog("observer.appended", { count: observations.length, coversUpToId });
	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: ${observations.length} observation${observations.length === 1 ? "" : "s"} recorded`,
		"info",
	);
	return "continue";
}

async function runReflectorStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: StageName) => Promise<ModelCursor | undefined>,
): Promise<ReflectorStageResult> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const currentTokens = realContextTokens(ctx);
	const real = currentTokens !== undefined ? realTokensSinceAnchor(entries, OM_REFLECTIONS_RECORDED, currentTokens) : undefined;
	const reflectionTokens = real !== undefined ? real : rawTokensSinceReflectionCoverage(entries); // fallback: no usage baseline / basis change
	if (reflectionTokens < runtime.config.reflectAfterTokens) return { outcome: "continue", sameRunReflections: [] };

	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return { outcome: "continue", sameRunReflections: [] };

	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: reflector running (~${reflectionTokens.toLocaleString()} tokens)`,
		"info",
	);
	const cursor = await resolveModel("reflector");
	if (!cursor) return { outcome: "abort", sameRunReflections: [] };
	if (runtime.consolidationCancelled) return { outcome: "abort", sameRunReflections: [] };

	const folded = foldLedger(entries);
	const attempt = await withModelFallback(runtime, ctx, "reflector", cursor, (candidate) => runReflector({
		model: candidate.model as any,
		apiKey: candidate.apiKey,
		headers: candidate.headers,
		env: candidate.env,
		reflections: folded.reflections,
		observations: folded.activeObservations,
		maxTurns: runtime.config.agentMaxTurns,
		thinkingLevel: candidate.thinking ?? "low",
	}));
	if (!attempt.ok) throw attempt.error;
	runtime.lastStageModels.reflector = attempt.candidate.label;
	const reflections = attempt.value;
	if (!reflections) return { outcome: "continue", sameRunReflections: [] };
	if (runtime.consolidationCancelled) return { outcome: "abort", sameRunReflections: [] }; // cancel before appending

	const data = buildReflectionsRecordedData(reflections, observationCoverageId);
	if (!data) return { outcome: "continue", sameRunReflections: [] };
	appendEntry(pi, OM_REFLECTIONS_RECORDED, data);
	return {
		outcome: "continue",
		sameRunReflections: reflections,
		effectiveReflectionCoverageId: data.coversUpToId,
	};
}

async function runDropperStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: StageName) => Promise<ModelCursor | undefined>,
	sameRunReflections: Reflection[],
	sameRunReflectionCoverageId: string | undefined,
): Promise<StageOutcome> {
	if (!sameRunReflectionCoverageId || sameRunReflections.length === 0) {
		debugLog("dropper.waiting_for_reflection", { sameRunReflections: sameRunReflections.length });
		return "continue";
	}

	const entries = ctx.sessionManager.getBranch() as Entry[];
	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return "continue";

	const folded = foldLedger(entries);
	const metrics = observationPoolMetrics(folded.activeObservations, runtime.config.observationsPoolTargetTokens);
	if (!metrics.ready) {
		debugLog("dropper.not_ready", {
			observationTokens: metrics.observationTokens,
			targetTokens: metrics.targetTokens,
			tokensOverTarget: metrics.tokensOverTarget,
			fullness: metrics.fullness,
			activeObservationCount: metrics.activeObservationCount,
			droppableCount: metrics.droppableCount,
			maxDropsAllowed: metrics.maxDropsAllowed,
		});
		return "continue";
	}
	debugLog("dropper.stage_start", {
		observationCoverageId,
		sameRunReflectionCoverageId,
		sameRunReflectionCount: sameRunReflections.length,
		activeObservationCount: metrics.activeObservationCount,
		observationTokens: metrics.observationTokens,
		targetTokens: metrics.targetTokens,
		tokensOverTarget: metrics.tokensOverTarget,
		fullness: metrics.fullness,
		maxDropsAllowed: metrics.maxDropsAllowed,
	});

	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: dropper running after reflection — active observation pool ~${metrics.observationTokens.toLocaleString()} / ${metrics.targetTokens.toLocaleString()} target tokens (${Math.round(metrics.fullness * 100).toLocaleString()}%)`,
		"info",
	);
	const cursor = await resolveModel("dropper");
	if (!cursor) return "abort";
	if (runtime.consolidationCancelled) return "abort"; // session replaced while resolving

	const reflectionsForDropper = mergeReflections(folded.reflections, sameRunReflections);
	const attempt = await withModelFallback(runtime, ctx, "dropper", cursor, (candidate) => runDropper({
		model: candidate.model as any,
		apiKey: candidate.apiKey,
		headers: candidate.headers,
		env: candidate.env,
		reflections: reflectionsForDropper,
		observations: folded.activeObservations,
		targetTokens: runtime.config.observationsPoolTargetTokens,
		maxTurns: runtime.config.agentMaxTurns,
		thinkingLevel: candidate.thinking ?? "low",
	}));
	if (!attempt.ok) throw attempt.error;
	runtime.lastStageModels.dropper = attempt.candidate.label;
	const droppedIds = attempt.value;
	if (runtime.consolidationCancelled) return "abort"; // cancel before appending with a possibly-stale pi
	const coversUpToId = earlierCoverageMarkerId(entries, observationCoverageId, sameRunReflectionCoverageId);
	const data = coversUpToId && droppedIds ? buildObservationsDroppedData(droppedIds, coversUpToId) : undefined;
	debugLog("dropper.append", {
		droppedIdsCount: droppedIds?.length ?? 0,
		coversUpToId,
		dataBuilt: data !== undefined,
		appended: data !== undefined,
	});
	if (data) appendEntry(pi, OM_OBSERVATIONS_DROPPED, data);
	return "continue";
}
