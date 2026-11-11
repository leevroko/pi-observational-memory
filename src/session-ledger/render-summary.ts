import { estimateStringTokens } from "../tokens.js";
import type { Observation, Reflection } from "./types.js";

const CONTEXT_USAGE_INSTRUCTIONS = `These are condensed memories from earlier in this session.

- Reflections: stable, long-lived facts about the user, project, decisions, and constraints. New reflection lines may include ids in brackets.
- Observations: timestamped events from the conversation history, in chronological order. Observation lines include ids in brackets.

Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.

When exact source context is needed for precision or traceability, use the recall tool with the relevant observation or reflection id. This is especially useful when a reflection materially affects a decision or is too compressed to continue confidently. Do not use recall as broad search or inject raw source unless it is needed.`;

export function observationToSummaryLine(observation: Observation): string {
	return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
}

export function reflectionToSummaryLine(reflection: Reflection): string {
	return `[${reflection.id}] ${reflection.content}`;
}

export function renderSummary(reflections: Reflection[], observations: Observation[]): string {
	if (reflections.length === 0 && observations.length === 0) return "";

	const parts: string[] = [CONTEXT_USAGE_INSTRUCTIONS];
	if (reflections.length > 0) {
		parts.push(`## Reflections\n${reflections.map(reflectionToSummaryLine).join("\n")}`);
	}
	if (observations.length > 0) {
		parts.push(`## Observations\n${observations.map(observationToSummaryLine).join("\n")}`);
	}
	return parts.join("\n\n");
}

export type BudgetedSummary = {
	summary: string;
	/** True when memory lines had to be omitted (or the budget cannot hold even the instructions). */
	truncated: boolean;
	omittedReflections: number;
	omittedObservations: number;
};

function assembleSummary(
	reflections: readonly Reflection[],
	observations: readonly Observation[],
	omittedReflections: number,
	omittedObservations: number,
): string {
	if (reflections.length === 0 && observations.length === 0 && omittedReflections === 0 && omittedObservations === 0) {
		return "";
	}
	const parts: string[] = [CONTEXT_USAGE_INSTRUCTIONS];
	if (reflections.length > 0) {
		parts.push(`## Reflections\n${reflections.map(reflectionToSummaryLine).join("\n")}`);
	}
	if (observations.length > 0) {
		parts.push(`## Observations\n${observations.map(observationToSummaryLine).join("\n")}`);
	}
	if (omittedReflections > 0 || omittedObservations > 0) {
		parts.push(
			`[memory truncated to fit the context budget: ${omittedReflections} oldest reflection(s) and ${omittedObservations} oldest observation(s) omitted; omitted ids remain recallable]`,
		);
	}
	return parts.join("\n\n");
}

/**
 * Render the compaction summary within a hard estimated-token budget.
 *
 * Drop order when the render exceeds the budget: oldest observations first
 * (timestamped, least current), then oldest reflections (record order approximates
 * age). The instructions preamble is never dropped; when even it cannot fit, an
 * empty summary is returned so the compaction hook declines ownership and pi's
 * native summarizer handles the cut.
 */
export function renderSummaryWithinBudget(
	reflections: readonly Reflection[],
	observations: readonly Observation[],
	maxTokens: number,
): BudgetedSummary {
	if (reflections.length === 0 && observations.length === 0) {
		return { summary: "", truncated: false, omittedReflections: 0, omittedObservations: 0 };
	}
	if (maxTokens <= 0 || estimateStringTokens(CONTEXT_USAGE_INSTRUCTIONS) > maxTokens) {
		return { summary: "", truncated: true, omittedReflections: reflections.length, omittedObservations: observations.length };
	}
	const keptReflections = [...reflections];
	const keptObservations = [...observations];
	let summary = assembleSummary(keptReflections, keptObservations, 0, 0);
	while (estimateStringTokens(summary) > maxTokens) {
		if (keptObservations.length > 0) {
			keptObservations.shift();
		} else if (keptReflections.length > 0) {
			keptReflections.shift();
		} else {
			// Only the instructions + marker remain and still overflow: fall back to
			// the bare preamble, which the check above guarantees fits.
			summary = CONTEXT_USAGE_INSTRUCTIONS;
			return { summary, truncated: true, omittedReflections: reflections.length, omittedObservations: observations.length };
		}
		summary = assembleSummary(
			keptReflections,
			keptObservations,
			reflections.length - keptReflections.length,
			observations.length - keptObservations.length,
		);
	}
	return {
		summary,
		truncated: reflections.length - keptReflections.length > 0 || observations.length - keptObservations.length > 0,
		omittedReflections: reflections.length - keptReflections.length,
		omittedObservations: observations.length - keptObservations.length,
	};
}
