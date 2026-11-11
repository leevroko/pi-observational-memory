import { describe, expect, it, vi } from "vitest";

import { Runtime } from "../src/runtime.js";

function modelRegistry(args: { found?: unknown; auth?: unknown } = {}) {
	return {
		find: vi.fn(() => args.found),
		getApiKeyAndHeaders: vi.fn(async () => args.auth ?? { ok: true, apiKey: "key", headers: { test: "yes" } }),
	};
}

describe("Runtime V3 behavior", () => {
	it("uses configured model when present", async () => {
		const runtime = new Runtime();
		const configured = { provider: "anthropic", id: "configured" };
		const registry = modelRegistry({ found: configured });
		runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "configured" } };

		const result = await runtime.resolveModel({ model: { provider: "openai" }, modelRegistry: registry, hasUI: false });

		expect(registry.find).toHaveBeenCalledWith("anthropic", "configured");
		expect(result).toEqual({
			ok: true,
			rejected: [],
			candidates: [
				// The configured model is the head of the chain, and the session model
				// follows it as the tail candidate a stage falls back to.
				{ model: configured, label: "anthropic/configured", source: "configured", thinking: undefined, apiKey: "key", headers: { test: "yes" }, env: undefined, baseUrl: undefined },
				{ model: { provider: "openai" }, label: "openai", source: "session", thinking: undefined, apiKey: "key", headers: { test: "yes" }, env: undefined, baseUrl: undefined },
			],
		});
	});

	it("falls back to session model and notifies when configured model is missing", async () => {
		const runtime = new Runtime();
		const notify = vi.fn();
		const sessionModel = { provider: "openai" };
		const registry = modelRegistry();
		runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "missing" } };

		const result = await runtime.resolveModel({ model: sessionModel, modelRegistry: registry, hasUI: true, ui: { notify } });

		expect(result).toMatchObject({ ok: true, candidates: [{ model: sessionModel, source: "session" }] });
		expect(notify).toHaveBeenCalledWith(
			"Observational memory: anthropic/missing skipped (not found in model registry), using openai",
			"warning",
		);
	});

	it("returns model resolution failures", async () => {
		const runtime = new Runtime();
		await expect(runtime.resolveModel({ model: undefined, modelRegistry: modelRegistry(), hasUI: false })).resolves.toEqual({
			ok: false,
			reason: "no model available (session has no model and no observational-memory model configured)",
		});

		const registry = modelRegistry({ auth: { ok: false } });
		await expect(runtime.resolveModel({ model: { provider: "anthropic" }, modelRegistry: registry, hasUI: false })).resolves.toEqual({
			ok: false,
			reason: 'no API key or auth headers for provider "anthropic"',
		});
	});

	it("accepts OAuth-shaped auth (headers only, no apiKey)", async () => {
		const runtime = new Runtime();
		const model = { provider: "kimi-coding", id: "kimi-for-coding" };
		const registry = modelRegistry({
			auth: { ok: true, apiKey: undefined, headers: { Authorization: "Bearer oauth-token" } },
		});

		const result = await runtime.resolveModel({ model, modelRegistry: registry, hasUI: false });

		expect(result).toMatchObject({
			ok: true,
			candidates: [{ model, apiKey: undefined, headers: { Authorization: "Bearer oauth-token" } }],
		});
	});

	it("accepts apiKey auth unchanged", async () => {
		const runtime = new Runtime();
		const model = { provider: "anthropic", id: "claude" };
		const registry = modelRegistry({ auth: { ok: true, apiKey: "sk-ant-key" } });

		const result = await runtime.resolveModel({ model, modelRegistry: registry, hasUI: false });

		expect(result).toMatchObject({ ok: true, candidates: [{ model, apiKey: "sk-ant-key", headers: undefined }] });
	});

	it("rejects auth that carries neither apiKey nor usable headers", async () => {
		const runtime = new Runtime();
		const model = { provider: "xai" };

		for (const auth of [
			{ ok: true },
			{ ok: true, apiKey: "" },
			{ ok: true, headers: {} },
			{ ok: true, headers: { Authorization: "" } },
		]) {
			const registry = modelRegistry({ auth });
			await expect(runtime.resolveModel({ model, modelRegistry: registry, hasUI: false })).resolves.toEqual({
				ok: false,
				reason: 'no API key or auth headers for provider "xai"',
			});
		}
	});

	it("points OAuth providers at /login when auth resolution fails", async () => {
		const runtime = new Runtime();
		const model = { provider: "openai-codex", id: "gpt-5-codex" };
		const registry = {
			...modelRegistry({ auth: { ok: false, error: "refresh failed" } }),
			isUsingOAuth: vi.fn((candidate: { provider?: string }) => candidate?.provider === "openai-codex"),
		};

		const result = await runtime.resolveModel({ model, modelRegistry: registry, hasUI: false });

		expect(registry.isUsingOAuth).toHaveBeenCalledWith(model);
		expect(result).toEqual({
			ok: false,
			reason: 'authentication failed for provider "openai-codex" — OAuth credentials may have expired; run \'/login openai-codex\' to re-authenticate',
		});
	});

	it("tracks consolidation task state", async () => {
		const runtime = new Runtime();
		let release: (() => void) | undefined;
		const work = new Promise<void>((resolve) => {
			release = resolve;
		});

		const promise = runtime.launchConsolidationTask({ hasUI: false }, async () => {
			runtime.consolidationPhase = "observer";
			await work;
		});

		expect(runtime.consolidationInFlight).toBe(true);
		expect(runtime.consolidationPromise).toBe(promise);
		expect(runtime.consolidationPhase).toBe("observer");
		release?.();
		await promise;
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.consolidationPromise).toBeNull();
		expect(runtime.consolidationPhase).toBeUndefined();
	});

	it("records stage-specific consolidation errors", () => {
		const runtime = new Runtime();
		const notify = vi.fn();

		expect(runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, "observer", new Error("observe failed"))).toBe("observe failed");
		expect(runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, "reflector", new Error("reflect failed"))).toBe("reflect failed");
		expect(runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, "dropper", "drop failed")).toBe("drop failed");

		expect(runtime.lastObserverError).toBe("observe failed");
		expect(runtime.lastReflectorError).toBe("reflect failed");
		expect(runtime.lastDropperError).toBe("drop failed");
		expect(notify).toHaveBeenCalledWith("Observational memory: observer failed: observe failed", "warning");
		expect(notify).toHaveBeenCalledWith("Observational memory: reflector failed: reflect failed", "warning");
		expect(notify).toHaveBeenCalledWith("Observational memory: dropper failed: drop failed", "warning");
	});

	it("keeps compaction flags independent", () => {
		const runtime = new Runtime();
		runtime.compactInFlight = true;
		runtime.compactHookInFlight = true;
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.consolidationPhase).toBeUndefined();
	});


	describe("memory model chain", () => {
		function registryWith(found: Record<string, unknown>, auth: Record<string, unknown> = {}) {
			return {
				find: vi.fn((provider: string, id: string) => found[`${provider}/${id}`]),
				getApiKeyAndHeaders: vi.fn(async (model: { provider?: string; id?: string }) => {
					const key = `${model?.provider}/${model?.id}`;
					return auth[key] ?? { ok: true, apiKey: `key-${key}` };
				}),
			};
		}

		it("keeps the configured order and skips entries the registry does not know", async () => {
			const runtime = new Runtime();
			const first = { provider: "a", id: "one" };
			const second = { provider: "b", id: "two" };
			runtime.config = {
				...runtime.config,
				models: [
					{ provider: "a", id: "one", thinking: "high" },
					{ provider: "ghost", id: "gone" },
					{ provider: "b", id: "two" },
				],
			};

			const result = await runtime.resolveModel({
				model: undefined,
				modelRegistry: registryWith({ "a/one": first, "b/two": second }),
				hasUI: false,
			});

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.candidates.map((candidate) => candidate.label)).toEqual(["a/one", "b/two"]);
			expect(result.candidates.map((candidate) => candidate.apiKey)).toEqual(["key-a/one", "key-b/two"]);
			expect(result.candidates[0]!.thinking).toBe("high");
			expect(result.rejected).toEqual([{ label: "ghost/gone", reason: "not found in model registry" }]);
		});

		it("skips a known model whose credential does not resolve", async () => {
			const runtime = new Runtime();
			runtime.config = { ...runtime.config, models: [{ provider: "a", id: "one" }, { provider: "b", id: "two" }] };

			const result = await runtime.resolveModel({
				model: undefined,
				modelRegistry: registryWith(
					{ "a/one": { provider: "a", id: "one" }, "b/two": { provider: "b", id: "two" } },
					{ "a/one": { ok: false, error: "no key" } },
				),
				hasUI: false,
			});

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.candidates.map((candidate) => candidate.label)).toEqual(["b/two"]);
			expect(result.rejected).toEqual([{ label: "a/one", reason: 'no API key or auth headers for provider "a"' }]);
		});

		it("reports every rejection when nothing in the chain is usable", async () => {
			const runtime = new Runtime();
			runtime.config = { ...runtime.config, models: [{ provider: "a", id: "one" }, { provider: "b", id: "two" }] };

			const result = await runtime.resolveModel({
				model: undefined,
				modelRegistry: registryWith({ "a/one": { provider: "a", id: "one" } }, { "a/one": { ok: false } }),
				hasUI: false,
			});

			expect(result).toEqual({
				ok: false,
				reason: 'no usable memory model: a/one (no API key or auth headers for provider "a"); b/two (not found in model registry)',
			});
		});

		it("does not append the session model twice when the chain already names it", async () => {
			const runtime = new Runtime();
			const sessionModel = { provider: "a", id: "one" };
			runtime.config = { ...runtime.config, model: { provider: "a", id: "one", thinking: "medium" } };

			const result = await runtime.resolveModel({ model: sessionModel, modelRegistry: registryWith({ "a/one": sessionModel }), hasUI: false });

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.candidates).toHaveLength(1);
			expect(result.candidates[0]).toMatchObject({ source: "configured", thinking: "medium" });
		});

		it("keeps the configured thinking level when falling back to the session model", async () => {
			const runtime = new Runtime();
			runtime.config = { ...runtime.config, model: { provider: "ghost", id: "gone", thinking: "high" } };
			const sessionModel = { provider: "openai", id: "gpt" };

			const result = await runtime.resolveModel({ model: sessionModel, modelRegistry: registryWith({}), hasUI: false });

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.candidates).toHaveLength(1);
			expect(result.candidates[0]).toMatchObject({ model: sessionModel, source: "session", thinking: "high" });
		});
	});

	it("forwards env and baseUrl from model registry", async () => {
		const runtime = new Runtime();
		const model = { provider: "cloudflare-workers-ai", id: "@cf/mistralai/mistral-small-3.1-24b-instruct" };
		const registry = modelRegistry({
			auth: {
				ok: true,
				apiKey: "test-key",
				headers: { Authorization: "Bearer test" },
				env: { CLOUDFLARE_ACCOUNT_ID: "abc123" },
				baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1"
			}
		});

		const result = await runtime.resolveModel({ model, modelRegistry: registry, hasUI: false });

		expect(result).toMatchObject({
			ok: true,
			candidates: [{
				model,
				apiKey: "test-key",
				headers: { Authorization: "Bearer test" },
				env: { CLOUDFLARE_ACCOUNT_ID: "abc123" },
				baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
			}],
		});
	});
});
