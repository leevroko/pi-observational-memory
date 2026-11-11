import { describe, expect, it } from "vitest";

import { renderSummary, renderSummaryWithinBudget } from "../src/session-ledger/index.js";
import { estimateStringTokens } from "../src/tokens.js";
import { observation, reflection } from "./fixtures/session.js";

const MARKER = (r: number, o: number) =>
	`[memory truncated to fit the context budget: ${r} oldest reflection(s) and ${o} oldest observation(s) omitted; omitted ids remain recallable]`;

describe("renderSummaryWithinBudget", () => {
	it("returns the full render when it fits", () => {
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "short fact" });
		const obs1 = observation("aaaaaaaaaaaa", { content: "short event" });
		const result = renderSummaryWithinBudget([ref1], [obs1], 10_000);
		expect(result.truncated).toBe(false);
		expect(result.omittedReflections).toBe(0);
		expect(result.omittedObservations).toBe(0);
		expect(result.summary).toContain("[eeeeeeeeeeee] short fact");
		expect(result.summary).toContain("[aaaaaaaaaaaa]");
	});

	it("drops oldest observations first when over budget", () => {
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "durable fact" });
		const obsOld = observation("aaaaaaaaaaaa", { content: `old event ${"x".repeat(300)}` });
		const obsNew = observation("bbbbbbbbbbbb", { content: "new event" });
		// Budget sized to exactly the render that keeps the reflection and the newer
		// observation plus the truncation marker: dropping the oldest observation
		// alone must be enough to fit.
		const target = `${renderSummary([ref1], [obsNew])}\n\n${MARKER(0, 1)}`;
		const budget = estimateStringTokens(target);
		const result = renderSummaryWithinBudget([ref1], [obsOld, obsNew], budget);
		expect(result.truncated).toBe(true);
		expect(result.omittedObservations).toBe(1);
		expect(result.omittedReflections).toBe(0);
		expect(result.summary).not.toContain("old event");
		expect(result.summary).toContain("new event");
		expect(result.summary).toContain("durable fact");
		expect(result.summary).toContain("memory truncated to fit the context budget");
		expect(estimateStringTokens(result.summary)).toBeLessThanOrEqual(budget);
	});

	it("drops reflections only after all observations are gone", () => {
		const refOld = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "older durable fact with some length" });
		const refNew = reflection("ffffffffffff", ["aaaaaaaaaaaa"], { content: "newer durable fact with some length" });
		const obs1 = observation("aaaaaaaaaaaa", { content: "an event that will be dropped first" });
		// Budget sized to the render that keeps only the newer reflection plus the
		// marker: forces the observation and the older reflection out, keeps the newer.
		const target = `${renderSummary([refNew], [])}\n\n${MARKER(1, 1)}`;
		const budget = estimateStringTokens(target);
		const result = renderSummaryWithinBudget([refOld, refNew], [obs1], budget);
		expect(result.omittedObservations).toBe(1);
		expect(result.omittedReflections).toBe(1);
		expect(result.summary).not.toContain("older durable fact");
		expect(result.summary).toContain("newer durable fact");
		expect(estimateStringTokens(result.summary)).toBeLessThanOrEqual(budget);
	});

	it("returns an empty summary when the budget cannot hold the instructions", () => {
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { content: "fact" });
		const result = renderSummaryWithinBudget([ref1], [], 10);
		expect(result.summary).toBe("");
		expect(result.truncated).toBe(true);
	});

	it("returns an empty summary for empty memory regardless of budget", () => {
		const result = renderSummaryWithinBudget([], [], 10);
		expect(result).toEqual({ summary: "", truncated: false, omittedReflections: 0, omittedObservations: 0 });
	});
});

describe("resolveSummaryMaxTokens", () => {
	it("prefers the explicit config value", async () => {
		const { resolveSummaryMaxTokens } = await import("../src/config.js");
		expect(resolveSummaryMaxTokens({ summaryMaxTokens: 5_000 } as never, 200_000)).toBe(5_000);
	});

	it("derives from the context window when unset", async () => {
		const { resolveSummaryMaxTokens, SUMMARY_CONTEXT_RATIO } = await import("../src/config.js");
		expect(resolveSummaryMaxTokens({} as never, 200_000)).toBe(Math.floor(200_000 * SUMMARY_CONTEXT_RATIO));
		expect(resolveSummaryMaxTokens({} as never, 128_000)).toBe(Math.floor(128_000 * SUMMARY_CONTEXT_RATIO));
	});

	it("falls back to a constant without a context window", async () => {
		const { resolveSummaryMaxTokens, SUMMARY_FALLBACK_MAX_TOKENS } = await import("../src/config.js");
		expect(resolveSummaryMaxTokens({} as never, undefined)).toBe(SUMMARY_FALLBACK_MAX_TOKENS);
		expect(resolveSummaryMaxTokens({} as never, 0)).toBe(SUMMARY_FALLBACK_MAX_TOKENS);
	});
});
