import { describe, expect, it } from "vitest";

import { planSessionVacuum } from "../src/session-ledger/vacuum.js";
import { memoryDetails, observation, observationsRecordedEntry, reflection, reflectionsRecordedEntry, textCustomMessage } from "./fixtures/session.js";

function compaction(id: string, parentId: string | null, summary: string): Record<string, unknown> {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2026-11-10T00:00:00.000Z",
		summary,
		firstKeptEntryId: parentId,
		tokensBefore: 100,
		details: memoryDetails({ fullFold: true, observations: [observation("aaaaaaaaaaaa")], reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])] }),
		systemMessage: { role: "system", content: "x" },
	};
}

describe("planSessionVacuum", () => {
	it("keeps the leaf path, stubs superseded compactions, drops dead branches", () => {
		const bigSummary = "s".repeat(1000);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-or", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "raw-1" }, { parentId: "raw-1" }),
			compaction("cmp-1", "om-or", bigSummary) as never,
			textCustomMessage("raw-2", "bbbb", { parentId: "cmp-1" }),
			reflectionsRecordedEntry("om-rr", { reflections: [reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"])], coversUpToId: "raw-2" }, { parentId: "raw-2" }),
			compaction("cmp-2", "om-rr", bigSummary) as never,
			// Dead branch off cmp-1 that the current leaf does not walk.
			textCustomMessage("dead-1", "dddd", { parentId: "cmp-1" }),
			// Current tail after the latest compaction.
			textCustomMessage("raw-3", "cccc", { parentId: "cmp-2" }),
		];

		const plan = planSessionVacuum(entries as never);

		expect(plan.kept.map((entry) => entry.id)).toEqual(["raw-1", "om-or", "cmp-1", "raw-2", "om-rr", "cmp-2", "raw-3"]);
		expect(plan.removedIds).toEqual(["dead-1"]);
		expect(plan.strippedCompactions).toBe(1);

		const stub = plan.kept.find((entry) => entry.id === "cmp-1") as Record<string, unknown>;
		expect(stub.summary).toBe("");
		expect(stub.details).toBeUndefined();
		expect(stub.systemMessage).toBeUndefined();
		expect(stub.parentId).toBe("om-or");

		const latest = plan.kept.find((entry) => entry.id === "cmp-2") as Record<string, unknown>;
		expect(latest.summary).toBe(bigSummary);
		expect(latest.details).toBeDefined();
	});

	it("handles a linear file with a single compaction without stripping it", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			compaction("cmp-1", "raw-1", "summary") as never,
			textCustomMessage("raw-2", "bbbb", { parentId: "cmp-1" }),
		];
		const plan = planSessionVacuum(entries as never);
		expect(plan.strippedCompactions).toBe(0);
		expect(plan.removedIds).toEqual([]);
		expect(plan.kept.map((entry) => entry.id)).toEqual(["raw-1", "cmp-1", "raw-2"]);
	});

	it("returns an empty plan for empty input", () => {
		expect(planSessionVacuum([])).toEqual({ kept: [], removedIds: [], strippedCompactions: 0 });
	});

	it("always shrinks the serialized output when compactions are stripped", () => {
		const bigSummary = "s".repeat(5000);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			compaction("cmp-1", "raw-1", bigSummary) as never,
			compaction("cmp-2", "cmp-1", bigSummary) as never,
			textCustomMessage("raw-2", "bbbb", { parentId: "cmp-2" }),
		];
		const plan = planSessionVacuum(entries as never);
		const before = JSON.stringify(entries).length;
		const after = JSON.stringify(plan.kept).length;
		expect(after).toBeLessThan(before);
	});
});
