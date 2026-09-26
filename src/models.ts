/**
 * The models this plugin makes available beyond pi-ai's catalogue.
 *
 * A new Claude model ships days before pi-ai's data does, and the plugin's own
 * promise is that the account pool under `anthropic` is what answers - so the
 * picker has to offer the model there. Registering `models` on the native
 * provider *replaces* its list (the SDK composes extension models over the base
 * only when the extension declares none), so the registration must carry the
 * whole catalogue: what the registry already has, plus anything missing.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The shape the SDK accepts per model; kept structural to stay import-light. */
export interface RegisteredModel {
	id: string;
	name: string;
	api?: string;
	baseUrl?: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Record<string, string | null | undefined>;
	compat?: object;
	promptCache?: object;
	inputLimits?: object;
	headers?: Record<string, string>;
	/** Present on the registry's own objects; ignored on the way back in. */
	provider?: string;
}

/**
 * Models newer than the installed pi-ai data.
 *
 * Opus 5.5 is Claude Code's current top model. Everything except the id and the
 * display name mirrors Opus 5 (same 1M window, same 128k output, same effort and
 * cache support), which is what Anthropic shipped it as - if it ever differs,
 * this is the one place to say so.
 */
export const EXTRA_ANTHROPIC_MODELS: readonly RegisteredModel[] = [
	{
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5",
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
		compat: {
			supportsMidConvoEffort: true,
			supportsMidConvoSystemMessages: true,
			supportsMidConvoToolChanges: true,
			forceAdaptiveThinking: true,
			supportsTemperature: false,
			supportsStrictTools: true,
		},
		promptCache: { short: 300, long: 3600 },
	},
];

/** The catalogue to register: what pi has, plus the extras it does not. */
export function withExtraModels(base: readonly RegisteredModel[], extras: readonly RegisteredModel[] = EXTRA_ANTHROPIC_MODELS): RegisteredModel[] {
	const known = new Set(base.map((model) => model.id));
	return [...base, ...extras.filter((model) => !known.has(model.id))];
}

/** Strip the registry's own bookkeeping so a registration round-trips cleanly. */
export function asRegisteredModel(model: RegisteredModel): RegisteredModel {
	const { id, name, api, baseUrl, reasoning, input, cost, contextWindow, maxTokens, thinkingLevelMap, compat, promptCache, inputLimits, headers } = model;
	return {
		id,
		name,
		...(api === undefined ? {} : { api }),
		...(baseUrl === undefined ? {} : { baseUrl }),
		reasoning,
		input,
		cost,
		contextWindow,
		maxTokens,
		...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
		...(compat === undefined ? {} : { compat }),
		...(promptCache === undefined ? {} : { promptCache }),
		...(inputLimits === undefined ? {} : { inputLimits }),
		...(headers === undefined ? {} : { headers }),
	};
}

/**
 * Register the complete anthropic catalogue, with the extras appended.
 *
 * Returns whether anything was registered: a registry that cannot list its own
 * models (a host without the API) is left alone rather than replaced with a
 * one-model list, which is the failure that would hide every other Claude model.
 */
export function registerAnthropicModels(pi: Pick<ExtensionAPI, "registerProvider">, models: readonly RegisteredModel[] | undefined): boolean {
	const anthropic = (models ?? []).filter((model) => model.provider === "anthropic").map((model) => asRegisteredModel(model));
	if (anthropic.length === 0) return false;
	pi.registerProvider("anthropic", { models: withExtraModels(anthropic) });
	return true;
}
