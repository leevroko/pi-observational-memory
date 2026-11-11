import { describe, expect, it } from "vitest";

import { estimateStringTokens, observationLineTokenCount } from "../src/tokens.js";

describe("estimateStringTokens script-aware ratios", () => {
	it("keeps the ~4 chars/token estimate for pure ASCII", () => {
		expect(estimateStringTokens("abcd")).toBe(1);
		expect(estimateStringTokens("abcdefgh")).toBe(2);
		expect(estimateStringTokens("")).toBe(0);
	});

	it("estimates non-ASCII text at ~2 chars/token instead of ~4", () => {
		const cyrillic = "абвг"; // 4 chars, all non-ASCII
		expect(estimateStringTokens(cyrillic)).toBe(2);
	});

	it("sums the two script halves independently", () => {
		// 4 ASCII + 4 Cyrillic: 1 + 2
		expect(estimateStringTokens("abcdабвг")).toBe(3);
	});

	it("rounds each half up separately", () => {
		expect(estimateStringTokens("ab")).toBe(1); // ceil(2/4)
		expect(estimateStringTokens("а")).toBe(1); // ceil(1/2)
	});

	it("counts observation line metadata on the same basis", () => {
		const line = observationLineTokenCount({
			id: "aaaaaaaaaaaa",
			timestamp: "2026-11-10T20:17:45.000Z",
			relevance: "high",
			content: "тест кириллицы", // 15 chars incl. space
		});
		// ascii: "[aaaaaaaaaaaa] " (15) + timestamp (24) + " [high] " (8) + content space (1) = 48 => ceil(48/4) = 12
		// non-ascii: "тесткириллицы" without space = 13 => ceil(13/2) = 7
		expect(line).toBe(19);
	});
});
