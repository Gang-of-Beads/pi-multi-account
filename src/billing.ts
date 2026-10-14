/**
 * Claude Code subscription billing: user-agent override,
 * `x-anthropic-billing-header` payload injection, and the request shaping that
 * keeps the payload from looking like third-party harness traffic.
 *
 * Ported from pi-claude-auth (MIT, github.com/pankajudhas81/pi-claude-auth,
 * signing.ts + transforms.ts) with minor restructuring only; the shaping in
 * anthropic-shape.ts is ported in spirit from gotgenes/pi-anthropic-auth (MIT).
 *
 * Why the billing header exists: pi's built-in Anthropic provider already sends
 * the Claude Code identity block, beta flags and an OAuth Bearer token, but it
 * sends a bare `claude-cli/<version>` user-agent and no billing header.
 * Anthropic's plan-billing validation rejects that combination, so OAuth
 * requests are billed against pay-as-you-go API credits / "extra usage" instead
 * of the Claude Pro/Max subscription plan. This module restores the full Claude
 * Code request identity so plan billing applies.
 *
 * Why the shaping exists: Anthropic's server-side classifier verdicts a request
 * on its payload content, and answers a pi-shaped one with either the misleading
 * `400 You're out of extra usage` or the `reasoning_extraction` refusal
 * ("reverse engineering or duplicating model outputs"). See anthropic-shape.ts for
 * what is shaped and for the measurements behind it.
 */
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	shapeSystemPromptText,
	shapeSystemUpdateText,
	stripTranscribedThinking,
	textifyErrorToolResult,
	TRANSCRIPT_THINKING_MARKER,
} from "./anthropic-shape.ts";
import { highestVersion, isCliVersion, probeCliVersion } from "./cli-version.ts";
import { logDebug } from "./debug-log.ts";
import { errorMessage } from "./errors.ts";

const BILLING_SALT = "59cf53e54c78";

// Lowest Claude Code CLI version this extension will ever claim, in the billing
// header's cc_version AND the overridden user-agent. The two must agree for
// Anthropic's subscription-billing validation to route the request to the
// Claude Pro/Max plan.
//
// Every source is a floor, so the highest one applies. The gateway enforces a
// per-model client minimum (claude-opus-5-5 answers a lower claim with
// claude_code_version_too_old: "version 2.1.280 or newer is required"), so a
// claim below the model's minimum cannot reach it at all.
//
// Kept at the latest published @anthropic-ai/claude-code release, following the
// actively maintained opencode-claude-auth (griffinmartin) model-config: a stale
// version string is also one of the client-fingerprint signals Anthropic's
// "reverse engineering or duplicating model outputs" enforcement keys on (see
// opencode-claude-auth #188 and opencode-anthropic-auth #80, Apr 2026). Bump
// when a release lands.
export const CC_VERSION = "2.1.296";

/**
 * Raise the claimed version without waiting for a release.
 *
 * Named MIN because it is a floor, not an override: a value below the pin or
 * below a locally installed claude is not a downgrade request, it is a floor
 * that lost. Set `ANTHROPIC_USER_AGENT` instead when the user-agent string
 * itself matters; the version it names then becomes cc_version too, so the two
 * cannot disagree.
 */
export const CLI_VERSION_MIN_ENV = "ANTHROPIC_CLI_VERSION_MIN";

// Billing entrypoint, mirrored in the user-agent's `(external, <entrypoint>)`
// suffix. Overridable via CLAUDE_CODE_ENTRYPOINT.
export const CC_ENTRYPOINT = "sdk-cli";

// undefined = probed and not found; null = not probed yet. Memoized because
// getCliVersion() runs on every request and a `claude --version` spawn per
// request would be absurd.
let detectedClaudeVersion: string | undefined | null = null;

export { isCliVersion };

/**
 * Version of a locally installed Claude Code CLI, if one exists.
 *
 * A real install is the best version source there is: the gateway checks the
 * claimed version against a per-model minimum (claude-opus-5-5 rejects < 2.1.280
 * with claude_code_version_too_old), and a machine with the genuine CLI has a
 * version the gateway certainly accepts. No CLI on PATH, or a probe that
 * misbehaves, resolves to undefined and the pin applies.
 */
export function detectClaudeVersion(): string | undefined {
	if (detectedClaudeVersion !== null) return detectedClaudeVersion;
	detectedClaudeVersion = probeCliVersion("claude");
	return detectedClaudeVersion;
}

/** Test hook: forget the memoized probe result. */
export function resetClaudeVersionCache(): void {
	detectedClaudeVersion = null;
}

/**
 * The version to claim: the highest floor that applies.
 *
 * No source can lower another, so an outdated local claude, a stale env floor or
 * a lagging pin only loses a comparison instead of dragging the claim below a
 * model's minimum. A malformed floor is dropped rather than put on the wire.
 */
export function claimedCliVersion(...floors: Array<string | undefined>): string {
	return highestVersion(CC_VERSION, ...floors);
}

/** The version a complete user-agent override names, if it names one. */
export function versionInUserAgent(userAgent: string | undefined): string | undefined {
	if (!userAgent) return undefined;
	const named = /\bclaude-cli\/([^\s(]+)/.exec(userAgent)?.[1];
	return isCliVersion(named) ? named : undefined;
}

/**
 * Resolve the claimed version.
 *
 * `ANTHROPIC_USER_AGENT` wins outright: it already fixes the user-agent string,
 * and the billing header's cc_version has to agree with it. Otherwise the pin,
 * `ANTHROPIC_CLI_VERSION_MIN` and a local claude are all floors and the highest
 * one is claimed.
 */
export function getCliVersion(): string {
	return (
		versionInUserAgent(process.env.ANTHROPIC_USER_AGENT) ??
		claimedCliVersion(process.env[CLI_VERSION_MIN_ENV], detectClaudeVersion())
	);
}

/** Resolve the billing entrypoint (env override wins). */
export function getEntrypoint(): string {
	return process.env.CLAUDE_CODE_ENTRYPOINT ?? CC_ENTRYPOINT;
}

/**
 * Build the Claude Code user-agent string. pi sends a bare
 * `claude-cli/<version>`; Anthropic's plan-billing validation expects the full
 * `claude-cli/<version> (external, <entrypoint>)` form, so we override it.
 */
export function buildUserAgent(): string {
	return (
		process.env.ANTHROPIC_USER_AGENT ??
		`claude-cli/${getCliVersion()} (external, ${getEntrypoint()})`
	);
}

interface Message {
	role?: string;
	content?: string | Array<{ type?: string; text?: string }>;
}

/**
 * Extract text from the first user message's first text block.
 * Mirrors Claude Code's billing-header input selection: find the first message
 * with role "user", then return the text of its first text content block.
 */
export function extractFirstUserMessageText(messages: Message[]): string {
	const userMsg = messages.find((m) => m.role === "user");
	if (!userMsg) return "";
	const content = userMsg.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const textBlock = content.find((b) => b.type === "text");
		if (textBlock && textBlock.type === "text" && textBlock.text) {
			return textBlock.text;
		}
	}
	return "";
}

/** Compute cch: first 5 hex characters of SHA-256(messageText). */
export function computeCch(messageText: string): string {
	return createHash("sha256").update(messageText).digest("hex").slice(0, 5);
}

/**
 * Compute the 3-char version suffix.
 * Samples characters at indices 4, 7, 20 from the message text (padding with
 * "0" when the message is shorter), then hashes with the billing salt and
 * version string.
 */
export function computeVersionSuffix(messageText: string, version: string): string {
	const sampled = [4, 7, 20]
		.map((i) => (i < messageText.length ? messageText[i] : "0"))
		.join("");
	const input = `${BILLING_SALT}${sampled}${version}`;
	return createHash("sha256").update(input).digest("hex").slice(0, 3);
}

/**
 * Build the complete billing header string for insertion into system[0].
 * Format: x-anthropic-billing-header: cc_version=V.S; cc_entrypoint=E; cch=H;
 */
export function buildBillingHeaderValue(
	messages: Message[],
	version: string,
	entrypoint: string,
): string {
	const text = extractFirstUserMessageText(messages);
	const suffix = computeVersionSuffix(text, version);
	const cch = computeCch(text);
	return (
		`x-anthropic-billing-header: ` +
		`cc_version=${version}.${suffix}; ` +
		`cc_entrypoint=${entrypoint}; ` +
		`cch=${cch};`
	);
}

/**
 * The provider-call options with the shaping payload hook attached, in place.
 *
 * Unconditional, even with `PI_MULTI_ACCOUNT_SHAPE=0`: that switch turns off the
 * *shaping*, which `injectBillingHeader` reads itself. Gating here would also drop
 * the billing header on this route - and this route is the only one a compaction
 * request has.
 *
 * Callers are the `prepareRequest` patch in index.ts (every provider, every host,
 * compaction included) and the alias stream wrapper in aliases.ts; the pool's
 * stream wrapper calls `withShapingOnPayload` directly instead, building a fresh
 * per-attempt options literal.
 */
export function attachShaping(options: unknown): Record<string, unknown> {
	const record = (options ?? {}) as Record<string, unknown>;
	record.onPayload = withShapingOnPayload(record.onPayload as never);
	return record;
}

const BILLING_PREFIX = "x-anthropic-billing-header";
const CC_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Set `PI_MULTI_ACCOUNT_SHAPE=0` to leave pi's request shape alone (billing header still applies). */
export const SHAPING_ENV = "PI_MULTI_ACCOUNT_SHAPE";

/** Marks pi's summarization system prompt, so a debug line can say what the request was. */
const SUMMARIZER_ANCHOR = "You are a context summarization assistant.";

/** Whether request shaping (prompt de-fingerprinting + thinking strip) is on. */
export function shapingEnabled(): boolean {
	const value = process.env[SHAPING_ENV];
	return !(value === "0" || value?.toLowerCase() === "off" || value?.toLowerCase() === "false");
}

type SystemEntry = { type?: string; text?: string } & Record<string, unknown>;

interface AnthropicPayload {
	model?: unknown;
	system?: unknown;
	messages?: unknown;
}

/**
 * Anthropic rejects a non-text block inside an errored `tool_result`; see
 * anthropic-shape.ts for the shape and the measurement.
 */
function textifyErrorToolResults(messages: Message[]): number {
	let count = 0;
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (textifyErrorToolResult(block as Record<string, unknown>)) count += 1;
		}
	}
	return count;
}

function isClaudeModel(model: unknown): model is string {
	return typeof model === "string" && model.toLowerCase().includes("claude");
}

function entryText(entry: unknown): string {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry === "object") {
		const text = (entry as { text?: unknown }).text;
		if (typeof text === "string") return text;
	}
	return "";
}

/** Shape every pi-authored system block in place, dropping blocks that shape away. */
function shapeSystem(system: Array<SystemEntry | string>): { shaped: number; dropped: number } {
	let shaped = 0;
	let dropped = 0;
	for (let index = system.length - 1; index >= 0; index -= 1) {
		const entry = system[index]!;
		const text = entryText(entry);
		// The injected billing header and the identity line are not pi prose.
		if (text.length === 0 || text.startsWith(BILLING_PREFIX) || text.startsWith(CC_IDENTITY)) continue;
		const next = shapeSystemPromptText(text);
		if (next.length === 0) {
			system.splice(index, 1);
			dropped += 1;
		} else if (next !== text) {
			// `system` is normally blocks, but Anthropic also accepts a bare string.
			if (typeof entry === "string") system[index] = next;
			else (entry as { text: string }).text = next;
			shaped += 1;
		}
	}
	return { shaped, dropped };
}

/**
 * Shape mid-conversation system messages and strip transcribed reasoning.
 *
 * pi re-sends changed prompt sections as `role: "system"` messages on models
 * that accept them, and puts every summarization transcript in a user message;
 * both carry pi prose that the leading-prompt rules would otherwise miss.
 */
function shapeMessages(messages: Message[]): { droppedUpdates: number; stripped: number } {
	let droppedUpdates = 0;
	let stripped = 0;
	const shaped: Message[] = [];
	for (const message of messages) {
		if (message.role === "system") {
			// An update whose every part shaped away is noise. An empty `content` is
			// not one of those: pi sends content-less system messages to carry a
			// per-message effort, and dropping them would run the request at the wrong
			// effort level.
			if (Array.isArray(message.content)) {
				const blocks = message.content.flatMap((block) => {
					if (block.type !== "text" || typeof block.text !== "string") return [block];
					const text = shapeSystemUpdateText(block.text);
					return text === undefined ? [] : [{ ...block, text }];
				});
				if (blocks.length === 0 && message.content.length > 0) {
					droppedUpdates += 1;
					continue;
				}
				message.content = blocks;
				shaped.push(message);
				continue;
			}
			if (typeof message.content === "string") {
				const text = shapeSystemUpdateText(message.content);
				if (text === undefined) {
					droppedUpdates += 1;
					continue;
				}
				message.content = text;
				shaped.push(message);
				continue;
			}
		}
		if (Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type !== "text" || typeof block.text !== "string") continue;
				const result = stripTranscribedThinking(block.text);
				block.text = result.text;
				stripped += result.removed;
			}
		} else if (typeof message.content === "string") {
			const result = stripTranscribedThinking(message.content);
			message.content = result.text;
			stripped += result.removed;
		}
		shaped.push(message);
	}
	messages.length = 0;
	messages.push(...shaped);
	return { droppedUpdates, stripped };
}

/**
 * Prepare one Anthropic OAuth request: inject the Claude Code billing header as
 * the first system entry, shape the pi prose out of it, strip transcribed
 * reasoning, and fix the shapes Anthropic rejects outright.
 *
 * Three jobs under one entry point because they share the same gate (an OAuth
 * request) and the same ordering constraint (`cch` describes the first user
 * message, so every message edit has to land before the header is computed).
 *
 * pi's built-in Anthropic provider already sends the Claude Code identity,
 * beta flags, and user-agent for OAuth tokens, but it does not send the
 * `x-anthropic-billing-header` system block. That block is what routes billing
 * to the Claude Pro/Max subscription instead of pay-as-you-go API credits.
 *
 * Returns the mutated payload when it changed anything: the billing header was
 * injected, or an errored tool_result was rewritten on an already-billed
 * request (normalization runs before the idempotency return). Returns
 * undefined for non-Claude requests or an already-billed payload with nothing
 * to normalize, leaving it unchanged.
 */
export function injectBillingHeader(payload: unknown): AnthropicPayload | undefined {
	if (!payload || typeof payload !== "object") return undefined;

	const p = payload as AnthropicPayload;
	if (!isClaudeModel(p.model)) return undefined;
	if (!Array.isArray(p.messages)) return undefined;

	const system: Array<SystemEntry | string> = Array.isArray(p.system) ? (p.system as SystemEntry[]) : [];

	// Only inject when pi is in OAuth stealth mode, signalled by its Claude
	// Code identity block. This avoids touching plain API-key requests (which
	// bill correctly on their own and would be confused by the header) and
	// GitHub Copilot requests (which reuse the Anthropic API but have no
	// Claude Code identity block).
	if (!system.some((e) => entryText(e).startsWith(CC_IDENTITY))) {
		return undefined;
	}

	const messages = p.messages as Message[];

	// Deliberately outside the PI_MULTI_ACCOUNT_SHAPE gate: this one is validity,
	// not de-fingerprinting — without it Anthropic rejects the whole request, and a
	// user turning the switch off to debug should not also lose the 400 fix.
	const errorToolResults = textifyErrorToolResults(messages);

	// Run before the idempotency return, so a payload that already carries the
	// header still gets normalized.
	if (system.some((e) => entryText(e).startsWith(BILLING_PREFIX))) {
		return errorToolResults > 0 ? p : undefined;
	}

	let changed: Record<string, number> = { errorToolResults };
	if (shapingEnabled()) {
		// Order matters: the `cch` hash describes the first user message, so the
		// transcript strip has to land before the header is computed.
		// Read the marker before shaping removes it. Why a zero-strip line is worth
		// keeping at all: a summarization request carries a different system prompt and
		// a different message list from a normal turn, so "the strip did not fire" has
		// to be tellable apart from "there was nothing to strip".
		const lookedLikeTranscript = messages.some((message) =>
			typeof message.content === "string"
				? message.content.includes(TRANSCRIPT_THINKING_MARKER)
				: (message.content ?? []).some((block) => (block.text ?? "").includes(TRANSCRIPT_THINKING_MARKER)),
		);
		changed = {
			...changed,
			...shapeMessages(messages),
			...shapeSystem(system),
			summary: system.some((entry) => entryText(entry).includes(SUMMARIZER_ANCHOR)) ? 1 : 0,
			hadThinkingMarker: lookedLikeTranscript ? 1 : 0,
		};
	}
	if (Object.values(changed).some((value) => value > 0)) {
		logDebug("shape.request", { ...changed, model: p.model as string });
	}

	const billingHeader = buildBillingHeaderValue(messages, getCliVersion(), getEntrypoint());

	// Billing header goes first, ahead of pi's identity block. No
	// cache_control so it does not consume a cache breakpoint.
	p.system = [{ type: "text", text: billingHeader }, ...system];

	return p;
}

/**
 * Add the shaping payload hook to one provider call's options, keeping any hook
 * the caller already set.
 *
 * Why this exists on top of `before_provider_request`: that hook is driven by
 * pi's *agent loop* (`onPayload`), and compaction does not run through it — it
 * calls the provider stream directly with its own options. Measured on pi 1.1.0:
 * every `/compact` summarization request reached the wire with no billing header
 * and no shaping, which is precisely the request the refusal fires on. A provider
 * -level `onPayload` is the seam that covers both routes, and shaping is
 * idempotent, so the two routes may both run for one payload.
 */
export function withShapingOnPayload(
	onPayload: ((payload: unknown, model?: unknown) => unknown) | undefined,
): (payload: unknown, model?: unknown) => unknown {
	return (payload, model) => {
		const next = onPayload?.(payload, model);
		// A synchronous `before_provider_request` returns the payload; an async one
		// returns a promise. Both are supported, so resolve only when needed.
		if (next instanceof Promise) {
			return next.then((resolved) => shapeOrSame(resolved ?? payload));
		}
		return shapeOrSame((next as unknown) ?? payload);
	};
}

function shapeOrSame(payload: unknown): unknown {
	try {
		return injectBillingHeader(payload) ?? payload;
	} catch (error) {
		console.warn("pi-multi-account: request preparation failed:", errorMessage(error));
		return payload;
	}
}

export function registerBillingLayer(pi: ExtensionAPI): void {
	// Full Claude Code user-agent for the native `anthropic` provider. pi
	// sends a bare `claude-cli/<version>` which fails plan-billing validation;
	// the `(external, <entrypoint>)` form is required for subscription billing.
	// (Alias providers set their own user-agent in aliases.ts.)
	// `headers` only, deliberately: registering `stream`/`streamSimple` here makes
	// this layer a second claimant of the `anthropic` id, and on a host that
	// composes providers once (pi-web) it can win over the pool's registration -
	// which silently takes the aggregate out of the request path, so a 429 on one
	// account stops failing over at all. Measured: pi-web went from 1377 pooled
	// requests to 0. The payload hook is attached in index.ts's `prepareRequest`
	// patch instead, which fires for every provider and for compaction.
	pi.registerProvider("anthropic", {
		headers: { "user-agent": buildUserAgent() },
	});

	// Inject the x-anthropic-billing-header system block. Only fires for
	// Claude-model OAuth payloads that already carry the "You are Claude
	// Code…" identity block — plain API-key and Copilot requests are skipped.
	pi.on("before_provider_request", (event) => {
		try {
			const updated = injectBillingHeader(event.payload);
			if (updated) return updated;
		} catch (error) {
			console.warn("pi-multi-account: billing header injection failed:", errorMessage(error));
		}
		return undefined;
	});

	// Pi 0.85 invokes this after assembling the final request headers. Native
	// Anthropic requests do not use the aliases/pools fetch wrappers below.
	pi.on("before_provider_headers", (event, ctx) => {
		if (ctx.model?.provider !== "anthropic") return;
		const ua = event.headers["user-agent"];
		if (typeof ua === "string" && ua.startsWith("claude-cli/")) {
			event.headers["user-agent"] = buildUserAgent();
		}
	});
}

/**
 * In-place user-agent override for OAuth stealth requests.
 *
 * Mutates the given Headers. Only rewrites a UA that pi-ai's OAuth client
 * itself produced (`claude-cli/<version>`), so non-Anthropic or API-key
 * requests pass through untouched, and an already-current UA is left alone
 * so the override is idempotent.
 *
 * Callers use this from a request-time fetch wrapper (the pool's and the
 * aliases' captureFetch) rather than from `before_provider_headers`: that hook
 * runs before the SDK's header merge, so on the pooled providers it sees an
 * empty header object and has nothing to rewrite - only the native `anthropic`
 * hook sees a UA there, and it checks `ctx.model.provider` itself. The fetch
 * wrapper runs after the merge and is scoped to exactly the OAuth requests this
 * extension authenticates.
 */
export function applyUserAgentOverride(headers: Headers): void {
	const ua = headers.get("user-agent");
	if (typeof ua !== "string" || !ua.startsWith("claude-cli/")) return;
	const full = buildUserAgent();
	if (ua === full) return;
	headers.set("user-agent", full);
}
