import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

import type { Runtime } from "../runtime.js";
import { resolveSummaryMaxTokens } from "../config.js";
import { buildCompactionProjection, renderSummaryWithinBudget, type Entry } from "../session-ledger/index.js";

const DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS = 20_000;
const DEFAULT_REFLECTIONS_POOL_MAX_TOKENS = 24_000;

function observationsPoolMaxTokens(runtime: Runtime): number {
	const value = (runtime.config as { observationsPoolMaxTokens?: unknown }).observationsPoolMaxTokens;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS;
}

function reflectionsPoolMaxTokens(runtime: Runtime): number {
	const value = (runtime.config as { reflectionsPoolMaxTokens?: unknown }).reflectionsPoolMaxTokens;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: DEFAULT_REFLECTIONS_POOL_MAX_TOKENS;
}

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
		if (runtime.compactHookInFlight) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Observational memory: another compaction is already in progress; cancelling duplicate",
					"warning",
				);
			}
			return { cancel: true };
		}

		runtime.compactHookInFlight = true;
		try {
			runtime.ensureConfig(ctx.cwd);
			const { preparation, branchEntries } = event;
			const { firstKeptEntryId, tokensBefore } = preparation;
			const projection = buildCompactionProjection(
				branchEntries as Entry[],
				firstKeptEntryId,
				{
					observationsPoolMaxTokens: observationsPoolMaxTokens(runtime),
					reflectionsPoolMaxTokens: reflectionsPoolMaxTokens(runtime),
				},
			);
			const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
			const summaryMaxTokens = resolveSummaryMaxTokens(runtime.config, contextWindow);
			const budgeted = renderSummaryWithinBudget(projection.reflections, projection.observations, summaryMaxTokens);
			if (budgeted.summary.length === 0) {
				// Decline ownership so Pi's native summarizer preserves the pre-cut context.
				if (budgeted.truncated && ctx.hasUI) {
					ctx.ui.notify(
						"Observational memory: summary budget too small to render any memory; declining ownership",
						"warning",
					);
				}
				return;
			}
			if (budgeted.truncated && !runtime.summaryBudgetNotified) {
				runtime.summaryBudgetNotified = true;
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Observational memory: compaction summary capped at ~${summaryMaxTokens.toLocaleString()} tokens; ${budgeted.omittedReflections} reflection(s) and ${budgeted.omittedObservations} observation(s) omitted from context (ids stay recallable). Consider pruning memory (/om:status).`,
						"warning",
					);
				}
			}

			return {
				compaction: {
					summary: budgeted.summary,
					firstKeptEntryId,
					tokensBefore,
					details: projection.details,
				},
			};
		} finally {
			runtime.compactHookInFlight = false;
		}
	});
}
