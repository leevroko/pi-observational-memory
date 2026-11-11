import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Static } from "typebox";
import { debugLog } from "../../debug-log.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { logAgentStreamError } from "../stream-errors.js";
import { reflectionToSummaryLine, type Reflection } from "../../session-ledger/index.js";
import { maxDropCountForPool, reflectionPoolMetrics, reflectionTokenSum } from "../dropper/pool.js";
import { REFLECTION_DROPPER_SYSTEM } from "./prompts.js";

interface RunReflectionDropperArgs {
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	reflections: Reflection[];
	maxTokens: number;
	targetTokens: number;
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	maxTurns?: number;
	thinkingLevel?: ModelThinkingLevel;
}

const DropReflectionsSchema = Type.Object({
	ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	reason: Type.Optional(Type.String()),
});

type DropReflectionsArgs = Static<typeof DropReflectionsSchema>;

function joinOrEmpty(items: string[]): string {
	return items.length ? items.join("\n") : "(none yet)";
}

export function normalizeDropReflectionIds(
	ids: readonly string[] | undefined,
	reflections: readonly Reflection[],
): string[] | undefined {
	if (!ids || ids.length === 0) return undefined;
	const allowed = new Set(reflections.map((reflection) => reflection.id));
	const result: string[] = [];
	const seen = new Set<string>();
	for (const id of ids) {
		if (!allowed.has(id) || seen.has(id)) continue;
		seen.add(id);
		result.push(id);
	}
	return result.length > 0 ? result : undefined;
}

/**
 * Keep the first proposal order: the dropper model is instructed to propose the
 * safest drops first, and reflections carry no timestamps to rank by.
 */
export function selectDropReflectionCandidates(
	ids: readonly string[],
	reflections: readonly Reflection[],
	maxDrops: number,
): string[] {
	if (maxDrops <= 0 || ids.length === 0) return [];
	const allowed = new Set(reflections.map((reflection) => reflection.id));
	const seen = new Set<string>();
	const result: string[] = [];
	for (const id of ids) {
		if (result.length >= maxDrops) break;
		if (!allowed.has(id) || seen.has(id)) continue;
		seen.add(id);
		result.push(id);
	}
	return result;
}

export async function runReflectionDropper(args: RunReflectionDropperArgs): Promise<string[] | undefined> {
	const { model, apiKey, headers, env, reflections, maxTokens, targetTokens, signal } = args;
	if (reflections.length === 0) return undefined;

	const metrics = reflectionPoolMetrics(reflections, maxTokens, targetTokens);
	const { reflectionTokens, maxDropsAllowed, tokensOverTarget } = metrics;
	debugLog("reflection-dropper.agent_start", {
		activeReflectionCount: reflections.length,
		reflectionTokens,
		maxTokens,
		targetTokens,
		tokensOverTarget,
		maxDropsAllowed,
	});
	if (!metrics.ready) {
		debugLog("reflection-dropper.result", { reason: "not_over_max", toolCallCount: 0, selectedDropsCount: 0 });
		return undefined;
	}

	const proposedDropIds: string[] = [];
	const proposed = new Set<string>();
	const allowed = new Map(reflections.map((reflection) => [reflection.id, reflection]));
	let toolCallCount = 0;

	const dropReflections: AgentTool<typeof DropReflectionsSchema> = {
		name: "drop_reflections",
		label: "Drop reflections",
		description: "Propose active reflection ids that are safe to remove from compacted memory.",
		parameters: DropReflectionsSchema,
		execute: async (_id, params: DropReflectionsArgs) => {
			toolCallCount++;
			let added = 0;
			for (const id of params.ids) {
				if (!allowed.has(id) || proposed.has(id)) continue;
				proposed.add(id);
				proposedDropIds.push(id);
				added++;
			}
			debugLog("reflection-dropper.tool_call", {
				toolCallCount,
				acceptedIdsCount: added,
				totalCandidates: proposedDropIds.length,
				maxDropsAllowed,
			});
			return {
				content: [{ type: "text", text: `Queued ${added} drop candidate${added === 1 ? "" : "s"}. Candidates this run: ${proposedDropIds.length}. Maximum drops allowed: ${maxDropsAllowed}.` }],
				details: { added, totalCandidates: proposedDropIds.length, maxDropsAllowed },
			};
		},
	};

	const userText = `CURRENT REFLECTIONS (oldest-recorded first):\n${joinOrEmpty(reflections.map(reflectionToSummaryLine))}\n\nActive reflection pool: ~${reflectionTokens.toLocaleString()} tokens; hard max: ~${maxTokens.toLocaleString()} tokens; trim target: ~${targetTokens.toLocaleString()} tokens; over target by ~${tokensOverTarget.toLocaleString()} tokens.\nMaximum drops allowed this run: ${maxDropsAllowed.toLocaleString()} reflection${maxDropsAllowed === 1 ? "" : "s"}. This maximum is sized to move the pool toward the target if every proposed drop is clearly safe.\nThis maximum is a hard upper bound, not a target. Drop fewer or none if fewer reflections are clearly safe.`;
	const prompts: Message[] = [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }];
	const context: AgentContext = { systemPrompt: REFLECTION_DROPPER_SYSTEM, messages: [], tools: [dropReflections as AgentTool<any>] };
	const reasoning = (model as { reasoning?: unknown }).reasoning;
	const thinkingLevel = args.thinkingLevel ?? "low";
	const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined;
	let turnCount = 0;
	const config: AgentLoopConfig = {
		model,
		apiKey,
		headers,
		env,
		maxTokens: boundedMaxTokens(model, AGENT_LOOP_MAX_TOKENS),
		convertToLlm: (msgs) => msgs as Message[],
		toolExecution: "sequential",
		...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
		...(effectiveMaxTurns !== undefined ? { shouldStopAfterTurn: () => ++turnCount >= effectiveMaxTurns } : {}),
	};

	const loop = args.agentLoop ?? agentLoop;
	const stream = loop(prompts, context, config, signal, streamSimple);
	for await (const event of stream) {
		logAgentStreamError("reflection-dropper", event);
	}
	await stream.result();
	const droppedIds = selectDropReflectionCandidates(proposedDropIds, reflections, maxDropsAllowed);
	const selectedDropTokens = reflectionTokenSum(droppedIds.map((id) => allowed.get(id)).filter((r): r is Reflection => r !== undefined));
	debugLog("reflection-dropper.result", {
		reason: droppedIds.length > 0 ? "selected_nonempty" : toolCallCount === 0 ? "no_tool_call" : "selected_empty",
		toolCallCount,
		acceptedCandidateCount: proposedDropIds.length,
		selectedDropsCount: droppedIds.length,
		selectedDropTokens,
		maxDropsAllowed,
	});
	return droppedIds.length > 0 ? droppedIds : undefined;
}
