/**
 * Codex Fast mode (the `priority` service tier) from the extension.
 *
 * Why the extension and not pi: pi-ai's openai-codex adapter reads
 * `options.serviceTier` and writes it to the body, but `buildBaseOptions`
 * rebuilds the options for `streamSimple` without that field, and `streamSimple`
 * is the path the runtime calls. Setting the tier on the payload instead
 * survives both, so this is a workaround with an upstream issue behind it
 * (earendil-works/pi#11040, PR #11042).
 *
 * The backend accepts `priority` only: it answers `400 Unsupported
 * service_tier: fast` for the REST spelling, and both names mean Fast mode.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** `PI_MULTI_ACCOUNT_CODEX_FAST=1` turns it on wherever `/fast on` was not needed. */
export const CODEX_FAST_ENV = "PI_MULTI_ACCOUNT_CODEX_FAST";

const FAST_TIER = "priority";
const CODEX_API = "openai-codex-responses";

/**
 * undefined = follow the environment. `/fast on|off` sets it for the rest of the
 * process, which is the session in the TUI and every session of a PI WEB daemon
 * (one daemon serves several). Verified from the patch side: `prepareRequest` is
 * wrapped once per runtime, so a per-session key read from the patch's own ctx
 * would always answer with the session that got there first.
 */
let sessionFast: boolean | undefined;

export function fastEnabled(): boolean {
	if (sessionFast !== undefined) return sessionFast;
	const value = process.env[CODEX_FAST_ENV]?.toLowerCase();
	return value === "1" || value === "on" || value === "true";
}

export function setFast(enabled: boolean): void {
	sessionFast = enabled;
}

/**
 * Match by api and not by provider id: the aliases (`codex`, `codex-<account>`)
 * and pi's own `openai-codex` all end up on this api, and a provider named
 * `codex…` that is not one is unlikely enough to be worth the fallback.
 */
export function isCodexTarget(model: { api?: string; provider?: string } | undefined): boolean {
	if (model === undefined) return false;
	return model.api === CODEX_API || model.provider === "openai-codex" || model.provider?.startsWith("codex") === true;
}

/**
 * Wrap the payload hook of an already-prepared request. Called for every
 * request, from the same runtime seam the shaping hook uses, so it covers the
 * aliases, pi's own codex login and compaction alike.
 */
export function applyCodexFast(options: unknown, model: { api?: string; provider?: string } | undefined): void {
	if (!fastEnabled() || !isCodexTarget(model)) return;
	const record = (options ?? {}) as Record<string, unknown>;
	const previous = record.onPayload as ((payload: unknown, model?: unknown) => unknown) | undefined;
	record.onPayload = async (payload: unknown, payloadModel?: unknown) => {
		const next = (await previous?.(payload, payloadModel)) ?? payload;
		if (next !== null && typeof next === "object") (next as Record<string, unknown>).service_tier = FAST_TIER;
		return next;
	};
	// pi drops this field before the adapter reads it (#11040). Setting it anyway
	// costs nothing, prices the turn correctly once upstream forwards it, and leaves
	// the intent on the options for the `diag.rt_prepare_ok` line to report.
	record.serviceTier = FAST_TIER;
}

function statusLine(ctx: ExtensionContext): string {
	const state = fastEnabled() ? "on" : "off";
	const where = sessionFast === undefined && process.env[CODEX_FAST_ENV] !== undefined ? ` (from ${CODEX_FAST_ENV})` : "";
	const model = ctx.model;
	if (model === undefined) return `Codex Fast mode: ${state}${where}.`;
	return isCodexTarget(model)
		? `Codex Fast mode: ${state}${where} — this process's Codex requests run ${model.provider}/${model.id}.`
		: `Codex Fast mode: ${state}${where} — ${model.provider}/${model.id} is not a Codex model, so nothing changes until you switch.`;
}

export function registerCodexFast(pi: ExtensionAPI): void {
	pi.registerCommand("fast", {
		description: "Codex Fast mode (service_tier=priority) for this pi process: /fast [on|off|status]",
		handler: async (args: string | undefined, ctx: ExtensionContext) => {
			const action = (args ?? "").trim().toLowerCase() || "toggle";
			if (action === "status") {
				ctx.ui.notify(statusLine(ctx), "info");
				return;
			}
			if (action !== "on" && action !== "off" && action !== "toggle") {
				ctx.ui.notify(`/fast takes on, off or status (or nothing, which toggles); got "${action}".`, "warning");
				return;
			}
			setFast(action === "toggle" ? !fastEnabled() : action === "on");
			// Fast mode doubles the subscription usage a Codex turn spends, so the
			// confirmation says which model it will apply to.
			ctx.ui.notify(`${statusLine(ctx)}${fastEnabled() ? " Turns cost about 2.5x the subscription usage." : ""}`, "info");
		},
	});
}
