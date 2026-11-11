import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ConfiguredModel {
	provider: string;
	id: string;
	thinking?: ModelThinkingLevel;
}

/**
 * How `compactAfterTokens` is interpreted.
 *
 * - `"calibrated"` (default): use the static `compactAfterTokens` value directly.
 *   Backwards-compatible with all existing V3 configs.
 *
 * - `"ratio"`: compute the effective threshold as
 *   `floor(model.contextWindow * compactAfterTokensRatio)`. This auto-scales the
 *   proactive compaction trigger to the active model's context window, so a 1M
 *   context model is not preempted at the same 81K threshold as a 128K model.
 *
 *   Some models advertise a large context window but lose attention at long
 *   range; users can lower `compactAfterTokensRatio` to compact earlier on such
 *   models without giving up the window on models that stay sharp.
 *
 *   When the active model's `contextWindow` is unavailable (undefined, 0, or
 *   negative), ratio mode falls back to the calibrated `compactAfterTokens`
 *   value so compaction still triggers safely.
 */
export type CompactAfterTokensMode = "calibrated" | "ratio";

export interface Config {
	observeAfterTokens: number;
	reflectAfterTokens: number;
	/**
	 * Maximum estimated source tokens serialized into a single observer chunk.
	 * Unset (default) derives the cap from the resolved memory model's context
	 * window; see {@link resolveObserverChunkMaxTokens}.
	 */
	observerChunkMaxTokens?: number;
	/**
	 * Hard cap (estimated tokens) on the rendered compaction summary. Unset
	 * (default) derives the cap from the session model's context window; see
	 * {@link resolveSummaryMaxTokens}. The cap is the deterministic guard against
	 * a summary that alone exceeds the context budget and re-triggers compaction
	 * in a loop.
	 */
	summaryMaxTokens?: number;
	compactAfterTokens: number;
	compactAfterTokensMode: CompactAfterTokensMode;
	compactAfterTokensRatio: number;
	observationsPoolMaxTokens: number;
	observationsPoolTargetTokens: number;
	/** Hard ceiling for the active reflection pool; crossing it arms the reflection dropper. */
	reflectionsPoolMaxTokens: number;
	/** Pool size the reflection dropper trims toward once the hard ceiling is crossed. */
	reflectionsPoolTargetTokens: number;
	agentMaxTurns: number;
	/**
	 * Ordered chain of models the memory workers may use. The head is preferred;
	 * the next entry takes over when an earlier one cannot be resolved (unknown
	 * provider or model id, no credential) or fails while a call is in flight.
	 */
	models?: ConfiguredModel[];
	/**
	 * Legacy single-model form, kept so existing V3 configs keep working.
	 * modelChain reads it as the tail of the chain, so a config that sets only
	 * model behaves exactly like models: [model].
	 */
	model?: ConfiguredModel;
	showWorkerNotifications: boolean;
	passive: boolean;
	debugLog: boolean;
}

export const DEFAULTS: Config = {
	observeAfterTokens: 10_000,
	reflectAfterTokens: 20_000,
	compactAfterTokens: 81_000,
	compactAfterTokensMode: "calibrated",
	compactAfterTokensRatio: 0.68,
	observationsPoolMaxTokens: 20_000,
	observationsPoolTargetTokens: 10_000,
	reflectionsPoolMaxTokens: 24_000,
	reflectionsPoolTargetTokens: 12_000,
	agentMaxTurns: 16,
	showWorkerNotifications: true,
	passive: false,
	debugLog: false,
};

export const COMPACT_AFTER_TOKENS_MODE_VALUES: readonly CompactAfterTokensMode[] = ["calibrated", "ratio"] as const;

/**
 * Resolve the effective proactive-compaction token threshold for the given
 * config and active model context window.
 *
 * In `"calibrated"` mode this is always `config.compactAfterTokens`.
 *
 * In `"ratio"` mode this is `floor(contextWindow * compactAfterTokensRatio)`
 * (clamped to a minimum of 1) when `contextWindow` is a positive number, and
 * falls back to `config.compactAfterTokens` otherwise.
 */
export function resolveCompactAfterTokens(config: Config, contextWindow: number | undefined): number {
	if (config.compactAfterTokensMode === "ratio" && typeof contextWindow === "number" && contextWindow > 0) {
		return Math.max(1, Math.floor(contextWindow * config.compactAfterTokensRatio));
	}
	return config.compactAfterTokens;
}

export const THINKING_LEVEL_VALUES: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Observer chunk cap used when no config is set and the model's context window is unknown. */
export const OBSERVER_CHUNK_FALLBACK_MAX_TOKENS = 60_000;

/** Smallest useful observer chunk: enough for labels, omission markers, and source context. */
export const OBSERVER_CHUNK_MIN_TOKENS = 256;

/**
 * Fraction of the memory model's context window used for the derived observer
 * chunk cap. Chunk sizes are estimated at ~4 chars/token, which can undercount
 * real tokens by up to ~4x on non-ASCII content, so 0.2 keeps even the worst
 * case at ~80% of the window with room left for the system prompt, prior
 * memory, and the response.
 */
export const OBSERVER_CHUNK_CONTEXT_RATIO = 0.2;

/**
 * Resolve the maximum estimated tokens the observer serializes into one chunk.
 *
 * An explicit `observerChunkMaxTokens` config value always wins. Otherwise the
 * cap is `floor(contextWindow * OBSERVER_CHUNK_CONTEXT_RATIO)` for the resolved
 * memory model, falling back to {@link OBSERVER_CHUNK_FALLBACK_MAX_TOKENS} when
 * the context window is unavailable.
 *
 * Without a cap, a backlog that outgrows the model's context window (e.g.
 * after repeated observer failures, or when the extension is enabled mid-way
 * into a long session) makes every observer call fail, so coverage never
 * advances and the session can never recover. With the cap, oversized backlogs
 * are drained oldest-first across successive runs.
 */
export function resolveObserverChunkMaxTokens(config: Config, contextWindow: number | undefined): number {
	if (config.observerChunkMaxTokens !== undefined && config.observerChunkMaxTokens > 0) {
		return Math.max(OBSERVER_CHUNK_MIN_TOKENS, config.observerChunkMaxTokens);
	}
	if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
		return Math.max(
			OBSERVER_CHUNK_MIN_TOKENS,
			Math.floor(contextWindow * OBSERVER_CHUNK_CONTEXT_RATIO),
		);
	}
	return OBSERVER_CHUNK_FALLBACK_MAX_TOKENS;
}

/**
 * Fraction of the session model's context window the rendered compaction summary
 * may occupy. The summary is injected into every subsequent context, so it must
 * leave the bulk of the window for actual work; 0.15 keeps a 128K window's memory
 * at ~19K tokens and a 200K window's at ~30K.
 */
export const SUMMARY_CONTEXT_RATIO = 0.15;

/** Summary cap used when no config is set and the context window is unknown. */
export const SUMMARY_FALLBACK_MAX_TOKENS = 24_000;

/**
 * Resolve the hard cap (estimated tokens) on the rendered compaction summary.

 * An explicit `summaryMaxTokens` config value always wins. Otherwise the cap is
 * `floor(contextWindow * SUMMARY_CONTEXT_RATIO)`, falling back to
 * {@link SUMMARY_FALLBACK_MAX_TOKENS} when the context window is unavailable.

 * Without this cap a memory pool that outgrows the model's context budget
 * renders a summary that alone exceeds the window, so every compaction
 * immediately re-triggers compaction (the compaction thrash loop) and each
 * cycle appends another full snapshot to the session file.
 */
export function resolveSummaryMaxTokens(config: Config, contextWindow: number | undefined): number {
	if (config.summaryMaxTokens !== undefined && config.summaryMaxTokens > 0) {
		return config.summaryMaxTokens;
	}
	if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
		return Math.max(1, Math.floor(contextWindow * SUMMARY_CONTEXT_RATIO));
	}
	return SUMMARY_FALLBACK_MAX_TOKENS;
}

const SETTINGS_KEY = "observational-memory";
const PASSIVE_ENV = "PI_OBSERVATIONAL_MEMORY_PASSIVE";

function positiveIntegerOrUndefined(value: unknown): number | undefined {
	return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : undefined;
}

function validTargetOrUndefined(value: unknown, maxTokens: number): number | undefined {
	const target = positiveIntegerOrUndefined(value);
	return target !== undefined && target < maxTokens ? target : undefined;
}

function derivedObservationPoolTarget(maxTokens: number): number {
	return Math.floor(maxTokens / 2);
}

function derivedReflectionPoolTarget(maxTokens: number): number {
	return Math.floor(maxTokens / 2);
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && (THINKING_LEVEL_VALUES as readonly string[]).includes(value);
}

function isCompactAfterTokensMode(value: unknown): value is CompactAfterTokensMode {
	return typeof value === "string" && (COMPACT_AFTER_TOKENS_MODE_VALUES as readonly string[]).includes(value);
}

/**
 * A valid ratio is a finite number strictly between 0 and 1.
 * 0 would never trigger; >= 1 would compact at/after the full window with no
 * room left for the response.
 */
function validRatioOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeModel(value: unknown): ConfiguredModel | undefined {
	if (!isRecord(value)) return undefined;
	const provider = nonEmptyString(value.provider);
	const id = nonEmptyString(value.id);
	if (!provider || !id) return undefined;
	const model: ConfiguredModel = { provider, id };
	if (isThinkingLevel(value.thinking)) model.thinking = value.thinking;
	return model;
}

/** Identity used to dedupe chain entries and to compare against the session model. */
export function configuredModelKey(model: ConfiguredModel): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Normalize an ordered `models` array. Entries that are not usable model objects are
 * dropped, and repeats of the same `provider/id` keep only their first position. The
 * result is undefined when nothing usable is left, so an invalid array never hides a
 * valid legacy `model`.
 */
function normalizeModels(value: unknown): ConfiguredModel[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const chain: ConfiguredModel[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		const model = normalizeModel(entry);
		if (!model) continue;
		const key = configuredModelKey(model);
		if (seen.has(key)) continue;
		seen.add(key);
		chain.push(model);
	}
	return chain.length > 0 ? chain : undefined;
}

/**
 * The ordered chain the memory workers try: `models` in order, then the legacy `model`
 * when it is not already present. An empty chain means no override is configured, so
 * the session model is the only candidate.
 */
export function modelChain(config: Config): ConfiguredModel[] {
	const chain = config.models ? [...config.models] : [];
	const legacy = config.model;
	if (legacy && !chain.some((model) => configuredModelKey(model) === configuredModelKey(legacy))) {
		chain.push(legacy);
	}
	return chain;
}

function normalizeSettingsConfig(value: Record<string, unknown>): Partial<Config> {
	const normalized: Partial<Config> = {};
	const numberKeys = [
		"observeAfterTokens",
		"reflectAfterTokens",
		"observerChunkMaxTokens",
		"summaryMaxTokens",
		"compactAfterTokens",
		"observationsPoolMaxTokens",
		"observationsPoolTargetTokens",
		"reflectionsPoolMaxTokens",
		"reflectionsPoolTargetTokens",
		"agentMaxTurns",
	] as const;
	for (const key of numberKeys) {
		const normalizedValue = positiveIntegerOrUndefined(value[key]);
		if (normalizedValue !== undefined) normalized[key] = normalizedValue;
	}
	if (isCompactAfterTokensMode(value.compactAfterTokensMode)) {
		normalized.compactAfterTokensMode = value.compactAfterTokensMode;
	}
	const ratio = validRatioOrUndefined(value.compactAfterTokensRatio);
	if (ratio !== undefined) normalized.compactAfterTokensRatio = ratio;
	if (typeof value.showWorkerNotifications === "boolean") normalized.showWorkerNotifications = value.showWorkerNotifications;
	if (typeof value.passive === "boolean") normalized.passive = value.passive;
	if (typeof value.debugLog === "boolean") normalized.debugLog = value.debugLog;
	const models = normalizeModels(value.models);
	if (models) normalized.models = models;
	const model = normalizeModel(value.model);
	if (model) normalized.model = model;
	return normalized;
}

export function readEnvConfig(env: NodeJS.ProcessEnv = process.env): Partial<Config> {
	const rawPassive = env[PASSIVE_ENV];
	if (rawPassive === undefined) return {};
	const passive = rawPassive.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(passive)) return { passive: true };
	if (["0", "false", "no", "off"].includes(passive)) return { passive: false };
	return {};
}

function readNamespacedConfig(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		const nested = raw[SETTINGS_KEY];
		return isRecord(nested) ? normalizeSettingsConfig(nested) : {};
	} catch {
		return {};
	}
}

export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Config {
	const globalPath = join(getAgentDir(), "settings.json");
	const projectPath = join(cwd, ".pi", "settings.json");
	const globalConfig = readNamespacedConfig(globalPath);
	const projectConfig = readNamespacedConfig(projectPath);
	const envConfig = readEnvConfig(env);
	const merged = {
		...DEFAULTS,
		observationsPoolTargetTokens: undefined,
		reflectionsPoolTargetTokens: undefined,
		...globalConfig,
		...projectConfig,
		...envConfig,
	};
	const observationTarget = validTargetOrUndefined(
		merged.observationsPoolTargetTokens,
		merged.observationsPoolMaxTokens,
	) ?? derivedObservationPoolTarget(merged.observationsPoolMaxTokens);
	const reflectionTarget = validTargetOrUndefined(
		merged.reflectionsPoolTargetTokens,
		merged.reflectionsPoolMaxTokens,
	) ?? derivedReflectionPoolTarget(merged.reflectionsPoolMaxTokens);

	return {
		...merged,
		observationsPoolTargetTokens: observationTarget,
		reflectionsPoolTargetTokens: reflectionTarget,
	};
}
