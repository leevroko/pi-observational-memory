import { describe, expect, it } from "vitest";

import {
	normalizeDropReflectionIds,
	runReflectionDropper,
	selectDropReflectionCandidates,
} from "../src/agents/reflection-dropper/agent.js";
import { reflectionPoolMetrics, reflectionTokenSum } from "../src/agents/dropper/pool.js";
import { foldLedger } from "../src/session-ledger/index.js";
import { recallMemorySources } from "../src/session-ledger/recall.js";
import { buildCompactionProjection } from "../src/session-ledger/projection.js";
import { loadConfig } from "../src/config.js";
import { observation, reflection } from "./fixtures/session.js";
import {
	memoryDetails,
	observationsRecordedEntry,
	reflectionsDroppedEntry,
	reflectionsRecordedEntry,
	textCustomMessage,
} from "./fixtures/session.js";

function fakeAgentLoop(handler: (prompts: any[], context: any) => Promise<void> | void): any {
	return ((prompts: any[], context: any, config: any) => ({
		async *[Symbol.asyncIterator]() {},
		result: async () => {
			await handler(prompts, context, config);
			return {};
		},
	})) as any;
}

describe("reflection pool metrics", () => {
	it("is not ready at or below the hard max", () => {
		const reflections = [reflection("aaaaaaaaaaaa"), reflection("bbbbbbbbbbbb")];
		const tokens = reflectionTokenSum(reflections);
		expect(reflectionPoolMetrics(reflections, tokens + 1, 1).ready).toBe(false);
		expect(reflectionPoolMetrics(reflections, tokens, 1).ready).toBe(false);
	});

	it("arms over the hard max with drops sized toward the target", () => {
		const reflections = Array.from({ length: 10 }, (_, index) =>
			reflection(`${index}`.padStart(12, "a"), ["cccccccccccc"], { content: `fact ${index} ${"x".repeat(40)}` }),
		);
		const tokens = reflectionTokenSum(reflections);
		const metrics = reflectionPoolMetrics(reflections, tokens - 1, Math.floor(tokens / 2));
		expect(metrics.ready).toBe(true);
		expect(metrics.overMax).toBe(true);
		expect(metrics.maxDropsAllowed).toBeGreaterThan(0);
		expect(metrics.maxDropsAllowed).toBeLessThanOrEqual(reflections.length);
	});
});

describe("reflection dropper agent", () => {
	const refA = reflection("aaaaaaaaaaaa", ["cccccccccccc"], { content: "fact a" });
	const refB = reflection("bbbbbbbbbbbb", ["cccccccccccc"], { content: "fact b" });

	it("normalizes proposed ids against the active list", () => {
		expect(normalizeDropReflectionIds(["aaaaaaaaaaaa", "zzzzzzzzzzzz", "aaaaaaaaaaaa"], [refA, refB]))
			.toEqual(["aaaaaaaaaaaa"]);
		expect(normalizeDropReflectionIds(undefined, [refA])).toBeUndefined();
		expect(normalizeDropReflectionIds([], [refA])).toBeUndefined();
	});

	it("selects candidates in proposal order capped at maxDrops", () => {
		expect(selectDropReflectionCandidates(["bbbbbbbbbbbb", "aaaaaaaaaaaa", "zzzzzzzzzzzz"], [refA, refB], 1))
			.toEqual(["bbbbbbbbbbbb"]);
		expect(selectDropReflectionCandidates(["aaaaaaaaaaaa"], [refA, refB], 5)).toEqual(["aaaaaaaaaaaa"]);
		expect(selectDropReflectionCandidates(["aaaaaaaaaaaa"], [refA, refB], 0)).toEqual([]);
	});

	it("returns undefined without a model call when the pool is under the max", async () => {
		const result = await runReflectionDropper({
			model: undefined as any,
			reflections: [refA, refB],
			maxTokens: 1_000_000,
			targetTokens: 10,
		});
		expect(result).toBeUndefined();
	});

	it("collects drops proposed through the tool", async () => {
		const dropped = await runReflectionDropper({
			model: {} as any,
			reflections: [refA, refB],
			// Hard max below the pool so the run is armed; target 0 allows both drops.
			maxTokens: 1,
			targetTokens: 0,
			agentLoop: fakeAgentLoop(async (_prompts, context) => {
				const tool = context.tools[0];
				await tool.execute("t1", { ids: ["aaaaaaaaaaaa", "zzzzzzzzzzzz", "bbbbbbbbbbbb"] });
			}) as any,
		});
		expect(dropped).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
	});
});

describe("reflection ledger drops", () => {
	it("foldLedger tombstones dropped reflections", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			reflectionsRecordedEntry("om-rr", { reflections: [reflection("aaaaaaaaaaaa"), reflection("bbbbbbbbbbbb")], coversUpToId: "raw-1" }),
			reflectionsDroppedEntry("om-rd", { reflectionIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-1" }),
		];
		const folded = foldLedger(entries);
		expect(folded.reflections.map((r) => r.id)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
		expect(folded.droppedReflectionIds).toEqual(new Set(["aaaaaaaaaaaa"]));
		expect(folded.activeReflections.map((r) => r.id)).toEqual(["bbbbbbbbbbbb"]);
	});

	it("recall marks dropped reflections", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-or", { observations: [observation("cccccccccccc")], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-rr", { reflections: [reflection("aaaaaaaaaaaa", ["cccccccccccc"])], coversUpToId: "raw-1" }),
			reflectionsDroppedEntry("om-rd", { reflectionIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-1" }),
		];
		const recalled = recallMemorySources(entries, "aaaaaaaaaaaa");
		expect(recalled.status).toBe("found");
		expect(recalled.kind).toBe("reflection");
		expect(recalled.reflections[0]?.status).toBe("dropped");
	});

	it("reflection pool overflow forces a full fold that applies drops", () => {
		const bigReflections = Array.from({ length: 8 }, (_, index) =>
			reflection(`${index}`.padStart(12, "e"), ["aaaaaaaaaaaa"], { content: `durable fact ${index} ${"y".repeat(60)}` }),
		);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-or", { observations: [observation("aaaaaaaaaaaa", { tokenCount: 5 })], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-rr", { reflections: bigReflections, coversUpToId: "raw-1" }),
			{ type: "compaction", id: "cmp-full", parentId: "om-rr", timestamp: "2026-11-10T00:00:00.000Z", summary: "s", firstKeptEntryId: "raw-1", tokensBefore: 1, details: memoryDetails({ fullFold: true, observations: [], reflections: bigReflections }) },
			textCustomMessage("raw-2", "bbbb"),
			reflectionsDroppedEntry("om-rd", { reflectionIds: [bigReflections[0].id], coversUpToId: "om-or" }),
		];
		// Reflection tokens above a small reflections max: full fold expected, with the
		// dropped reflection filtered out of the projection.
		const result = buildCompactionProjection(entries, "raw-2", {
			observationsPoolMaxTokens: 100_000,
			reflectionsPoolMaxTokens: 10,
		});
		expect(result.fullFold).toBe(true);
		expect(result.reflections.map((r) => r.id)).not.toContain(bigReflections[0].id);
		expect(result.reflections.length).toBe(bigReflections.length - 1);
	});

	it("observation-only budgets keep the old full-fold behavior", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-or", { observations: [observation("aaaaaaaaaaaa", { tokenCount: 5 })], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-rr", { reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])], coversUpToId: "raw-1" }),
		];
		const result = buildCompactionProjection(entries, "raw-1", { observationsPoolMaxTokens: 100_000 });
		expect(result.fullFold).toBe(false);
	});
});

describe("reflection pool config", () => {
	it("derives the trim target as half the max", () => {
		const config = loadConfig("/nonexistent-om-test-dir");
		expect(config.reflectionsPoolMaxTokens).toBeGreaterThan(0);
		expect(config.reflectionsPoolTargetTokens).toBe(Math.floor(config.reflectionsPoolMaxTokens / 2));
	});
});
