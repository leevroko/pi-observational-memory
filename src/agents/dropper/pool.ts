import { observationLineTokenCount, reflectionLineTokenCount } from "../../tokens.js";
import type { Observation, Reflection } from "../../session-ledger/index.js";

export type ObservationPoolMetrics = {
	observationTokens: number;
	targetTokens: number;
	tokensOverTarget: number;
	fullness: number;
	activeObservationCount: number;
	droppableCount: number;
	maxDropsAllowed: number;
	overTarget: boolean;
	ready: boolean;
};

export function observationTokenSum(observations: readonly Observation[]): number {
	// Count the full rendered line (id + timestamp + relevance + content), not
	// bare content: the pool budget caps how much observation text is re-rendered
	// into future contexts, and every line carries metadata overhead.
	return observations.reduce((sum, observation) => sum + observationLineTokenCount(observation), 0);
}

export function observationPoolFullness(observationTokens: number, targetTokens: number): number {
	if (!Number.isFinite(observationTokens) || observationTokens <= 0) return 0;
	if (!Number.isFinite(targetTokens) || targetTokens <= 0) return 0;
	return observationTokens / targetTokens;
}

export function droppableObservationCount(observations: readonly Observation[]): number {
	return observations.length;
}

export function maxDropCountForPool<T>(items: readonly T[], observationTokens: number, targetTokens: number): number {
	const activeObservationCount = items.length;
	if (activeObservationCount === 0) return 0;
	if (!Number.isFinite(observationTokens) || observationTokens <= 0) return 0;
	if (!Number.isFinite(targetTokens) || targetTokens < 0) return 0;

	const tokensOverTarget = observationTokens - targetTokens;
	if (tokensOverTarget <= 0) return 0;

	const averageObservationTokens = observationTokens / activeObservationCount;
	if (!Number.isFinite(averageObservationTokens) || averageObservationTokens <= 0) return 0;

	const estimatedDrops = Math.ceil(tokensOverTarget / averageObservationTokens);
	return Math.min(activeObservationCount, Math.max(1, estimatedDrops));
}

export function observationPoolMetrics(
	observations: readonly Observation[],
	targetTokens: number,
): ObservationPoolMetrics {
	const observationTokens = observationTokenSum(observations);
	const fullness = observationPoolFullness(observationTokens, targetTokens);
	const activeObservationCount = observations.length;
	const droppableCount = droppableObservationCount(observations);
	const tokensOverTarget = Math.max(0, observationTokens - targetTokens);
	const maxDropsAllowed = maxDropCountForPool(observations, observationTokens, targetTokens);
	const overTarget = Number.isFinite(targetTokens) && targetTokens >= 0 && observationTokens > targetTokens;
	return {
		observationTokens,
		targetTokens,
		tokensOverTarget,
		fullness,
		activeObservationCount,
		droppableCount,
		maxDropsAllowed,
		overTarget,
		ready: overTarget && maxDropsAllowed > 0,
	};
}

export type ReflectionPoolMetrics = {
	reflectionTokens: number;
	maxTokens: number;
	targetTokens: number;
	tokensOverTarget: number;
	fullness: number;
	activeReflectionCount: number;
	maxDropsAllowed: number;
	overMax: boolean;
	ready: boolean;
};

export function reflectionTokenSum(reflections: readonly Reflection[]): number {
	// Count the rendered line (id + content), the same basis the summary uses.
	return reflections.reduce((sum, reflection) => sum + reflectionLineTokenCount(reflection), 0);
}

/**
 * Reflection pool state. Unlike observations (which trim toward the target as
 * soon as they are over it), reflections are durable distillates: the dropper
 * only fires once the pool crosses the HARD max, and then trims toward the
 * target in one thorough pass. This keeps reflection churn rare.
 */
export function reflectionPoolMetrics(
	reflections: readonly Reflection[],
	maxTokens: number,
	targetTokens: number,
): ReflectionPoolMetrics {
	const reflectionTokens = reflectionTokenSum(reflections);
	const activeReflectionCount = reflections.length;
	const tokensOverTarget = Math.max(0, reflectionTokens - targetTokens);
	const maxDropsAllowed = maxDropCountForPool(reflections, reflectionTokens, targetTokens);
	const overMax = Number.isFinite(maxTokens) && maxTokens > 0 && reflectionTokens > maxTokens;
	return {
		reflectionTokens,
		maxTokens,
		targetTokens,
		tokensOverTarget,
		fullness: observationPoolFullness(reflectionTokens, targetTokens),
		activeReflectionCount,
		maxDropsAllowed,
		overMax,
		ready: overMax && maxDropsAllowed > 0,
	};
}
