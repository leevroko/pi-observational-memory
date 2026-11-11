import { estimateTokens as estimateMessageTokens } from "@earendil-works/pi-coding-agent";

/**
 * Rough token estimate for a string.
 *
 * ASCII-dominant text averages ~4 chars/token on modern tokenizers, but Cyrillic
 * and other non-ASCII scripts average ~2-2.5 chars/token. Counting everything at
 * 4 chars/token underestimates non-ASCII memory by up to ~2x, which made pool
 * budgets and compaction thresholds fire far too late on Cyrillic sessions. Each
 * half is estimated with its own ratio and the results are summed; CJK surrogate
 * pairs still land near ~1 token/char, which is also closer than a flat /4.
 */
export function estimateStringTokens(text: string): number {
	let asciiChars = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) <= 0x7f) asciiChars++;
	}
	const nonAsciiChars = text.length - asciiChars;
	return Math.ceil(asciiChars / 4) + Math.ceil(nonAsciiChars / 2);
}

/**
 * Estimate the rendered footprint of an observation line as it appears in
 * summaries / pool listings: "[id] YYYY-MM-DD HH:MM [relevance] content".
 * Pool budgets that only count bare content undercount every line's
 * metadata overhead (id + timestamp + relevance tags), so the configured
 * pool target was reached later than the rendered memory actually allowed.
 */
export function observationLineTokenCount(observation: {
	id: string;
	timestamp: string;
	relevance: string;
	content: string;
}): number {
	return estimateStringTokens(
		`[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`,
	);
}

/**
 * Estimate the rendered footprint of a reflection line as it appears in
 * summaries / pool listings: "[id] content".
 */
export function reflectionLineTokenCount(reflection: {
	id: string;
	content: string;
}): number {
	return estimateStringTokens(`[${reflection.id}] ${reflection.content}`);
}

export function estimateEntryTokens(entry: { type: string; message?: unknown; content?: unknown; summary?: unknown }): number {
	if (entry.type === "message" && entry.message) {
		return estimateMessageTokens(entry.message as Parameters<typeof estimateMessageTokens>[0]);
	}
	if (entry.type === "custom_message" && entry.content) {
		const content = entry.content;
		if (typeof content === "string") return estimateStringTokens(content);
		if (Array.isArray(content)) {
			let total = 0;
			for (const block of content) {
				if (block.type === "text" && block.text) total += estimateStringTokens(block.text);
			}
			return total;
		}
	}
	if (entry.type === "branch_summary" && typeof entry.summary === "string") {
		return estimateStringTokens(entry.summary);
	}
	return 0;
}

