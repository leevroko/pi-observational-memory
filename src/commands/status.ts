import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { observationPoolMetrics, reflectionPoolMetrics } from "../agents/dropper/pool.js";
import { configuredModelKey, modelChain, resolveCompactAfterTokens } from "../config.js";
import { modelLabel, type Runtime } from "../runtime.js";
import {
	diffProjection,
	foldLedger,
	fullProjection,
	rawTokensSinceLastCompaction,
	rawTokensSinceObservationCoverage,
	rawTokensSinceReflectionCoverage,
	visibleProjection,
	type Entry,
} from "../session-ledger/index.js";

function pct(current: number, total: number): number {
	return total > 0 ? Math.round((current / total) * 100) : 0;
}

function tokenSum(items: { tokenCount: number }[]): number {
	return items.reduce((sum, item) => sum + item.tokenCount, 0);
}

function addedSuffix(count: number): string | undefined {
	return count > 0 ? `+${count.toLocaleString()}` : undefined;
}

function removedSuffix(count: number): string | undefined {
	return count > 0 ? `-${count.toLocaleString()}` : undefined;
}

function appendSuffixes(line: string, suffixes: (string | undefined)[]): string {
	const rendered = suffixes.filter((suffix): suffix is string => suffix !== undefined);
	return rendered.length > 0 ? `${line} ${rendered.join(" ")}` : line;
}

export function registerStatusCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:status", {
		description: "Show observational memory status",
		handler: async (_args, ctx) => {
			runtime.ensureConfig(ctx.cwd);
			const entries = ctx.sessionManager.getBranch() as Entry[];
			const folded = foldLedger(entries);
			const visible = visibleProjection(entries);
			const full = fullProjection(entries);
			const drift = diffProjection(visible, full);

			const visibleObservationTokens = tokenSum(visible.observations);
			const activeObservationPool = observationPoolMetrics(folded.activeObservations, runtime.config.observationsPoolTargetTokens);
			const observationLine = appendSuffixes(
				`Observations: ${folded.observations.length} recorded / ${folded.droppedObservationIds.size} dropped / ${folded.activeObservations.length} active / ${visible.observations.length} visible`,
				[
					addedSuffix(drift.observationsOnlyInFull.length),
					removedSuffix(drift.droppedOnlyInFull.length),
				],
			);
			const reflectionLine = appendSuffixes(
				`Reflections:  ${folded.reflections.length} recorded / ${folded.droppedReflectionIds.size} dropped / ${folded.activeReflections.length} active / ${visible.reflections.length} visible`,
				[addedSuffix(drift.reflectionsOnlyInFull.length)],
			);
			const obsProgress = rawTokensSinceObservationCoverage(entries);
			const reflectionProgress = rawTokensSinceReflectionCoverage(entries);
			const compactionProgress = rawTokensSinceLastCompaction(entries);
			const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
			const compactThreshold = resolveCompactAfterTokens(runtime.config, contextWindow);

		// Memory models are tried in this order, with the session model last, so a
		// provider being down does not silently stop memory work.
		const chain = modelChain(runtime.config);
		const sessionLabel = ctx.model ? modelLabel(ctx.model, "session model") : undefined;
		const chainLabels = chain.map((entry) => `${configuredModelKey(entry)}${entry.thinking ? ` (${entry.thinking})` : ""}`);
		if (sessionLabel && !chain.some((entry) => configuredModelKey(entry) === sessionLabel)) {
			chainLabels.push(`${sessionLabel} (session)`);
		}
		const usedLines = (["observer", "reflector", "dropper", "reflection-dropper"] as const)
			.filter((stage) => runtime.lastStageModels[stage])
			.map((stage) => `Last run ${stage}: ${runtime.lastStageModels[stage]}`);

			const passiveLines = runtime.config.passive === true
				? [
					"── Mode ──",
					"Passive: automatic memory workers and auto-compaction disabled; manual/Pi compaction, commands, and recall remain active",
					"",
				]
				: [];

			// Configs assembled before the reflection pool existed may lack these fields.
			const reflectionsPoolMax = runtime.config.reflectionsPoolMaxTokens ?? 24_000;
			const reflectionTrimTarget = runtime.config.reflectionsPoolTargetTokens ?? Math.floor(reflectionsPoolMax / 2);
			const reflectionPool = reflectionPoolMetrics(folded.activeReflections, reflectionsPoolMax, reflectionTrimTarget);

			const lines = [
				...passiveLines,
				"── Model ──",
				`Chain: ${chainLabels.length > 0 ? chainLabels.join(", ") : "session model (none configured)"}`,
				...usedLines,
				"",
				"── Memory ──",
			observationLine,
			reflectionLine,
				"",
				"── Activity ──",
				`Next observation: ~${obsProgress.toLocaleString()} / ${runtime.config.observeAfterTokens.toLocaleString()} tokens (${pct(obsProgress, runtime.config.observeAfterTokens)}%)`,
				`Next reflection:  ~${reflectionProgress.toLocaleString()} / ${runtime.config.reflectAfterTokens.toLocaleString()} tokens (${pct(reflectionProgress, runtime.config.reflectAfterTokens)}%)`,
				`Next compaction:  ~${compactionProgress.toLocaleString()} / ${compactThreshold.toLocaleString()} estimated source tokens (${pct(compactionProgress, compactThreshold)}%)`,
				`Visible observation pool: ~${visibleObservationTokens.toLocaleString()} / ${runtime.config.observationsPoolMaxTokens.toLocaleString()} tokens (${pct(visibleObservationTokens, runtime.config.observationsPoolMaxTokens)}%)`,
				`Active observation pool: ~${activeObservationPool.observationTokens.toLocaleString()} / ${runtime.config.observationsPoolTargetTokens.toLocaleString()} target tokens (${pct(activeObservationPool.observationTokens, runtime.config.observationsPoolTargetTokens)}%)`,
				`Reflection pool:         ~${reflectionPool.reflectionTokens.toLocaleString()} / ${reflectionsPoolMax.toLocaleString()} max tokens (${pct(reflectionPool.reflectionTokens, reflectionsPoolMax)}%)`,
				`Reflection trim target:  ~${reflectionPool.targetTokens.toLocaleString()} tokens${reflectionPool.overMax ? " (over hard max, dropper armed)" : ""}`,
			];

			if (runtime.consolidationInFlight || runtime.compactInFlight || runtime.compactHookInFlight) {
				lines.push("", "── In flight ──");
				if (runtime.consolidationInFlight) {
					const phase = runtime.consolidationPhase ? ` (${runtime.consolidationPhase})` : "";
					lines.push(`Consolidation: running${phase}`);
				}
				if (runtime.compactInFlight) lines.push("Auto-compaction: running");
				if (runtime.compactHookInFlight) lines.push("Compaction hook: running");
			}

			if (runtime.lastObserverError || runtime.lastReflectorError || runtime.lastDropperError) {
				lines.push("", "── Last error ──");
				if (runtime.lastObserverError) lines.push(`Observer: ${runtime.lastObserverError}`);
				if (runtime.lastReflectorError) lines.push(`Reflector: ${runtime.lastReflectorError}`);
				if (runtime.lastDropperError) lines.push(`Dropper: ${runtime.lastDropperError}`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
