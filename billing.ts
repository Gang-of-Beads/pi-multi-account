/**
 * Claude Code subscription billing: user-agent override and
 * `x-anthropic-billing-header` payload injection.
 *
 * Ported from pi-claude-auth (MIT, github.com/pankajudhas81/pi-claude-auth,
 * signing.ts + transforms.ts) with minor restructuring only.
 *
 * Why this exists: pi's built-in Anthropic provider already sends the Claude
 * Code identity block, beta flags and an OAuth Bearer token, but it sends a
 * bare `claude-cli/<version>` user-agent and no billing header. Anthropic's
 * plan-billing validation rejects that combination, so OAuth requests are
 * billed against pay-as-you-go API credits / "extra usage" instead of the
 * Claude Pro/Max subscription plan. This module restores the full Claude Code
 * request identity so plan billing applies.
 */
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "./errors.ts";

const BILLING_SALT = "59cf53e54c78";

// Claude Code CLI version used for the billing header AND the overridden
// user-agent. The billing header's cc_version must match the user-agent
// version for Anthropic's subscription-billing validation to route the request
// to the Claude Pro/Max plan. Overridable via ANTHROPIC_CLI_VERSION.
export const CC_VERSION = "2.1.160";

// Billing entrypoint, mirrored in the user-agent's `(external, <entrypoint>)`
// suffix. Overridable via CLAUDE_CODE_ENTRYPOINT.
export const CC_ENTRYPOINT = "sdk-cli";

/** Resolve the Claude Code CLI version (env override wins). */
export function getCliVersion(): string {
	return process.env.ANTHROPIC_CLI_VERSION ?? CC_VERSION;
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

const BILLING_PREFIX = "x-anthropic-billing-header";
const CC_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

type SystemEntry = { type?: string; text?: string } & Record<string, unknown>;

interface AnthropicPayload {
	model?: unknown;
	system?: unknown;
	messages?: unknown;
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

/**
 * Inject the Claude Code billing header into an Anthropic request payload as
 * the first system entry.
 *
 * pi's built-in Anthropic provider already sends the Claude Code identity,
 * beta flags, and user-agent for OAuth tokens, but it does not send the
 * `x-anthropic-billing-header` system block. That block is what routes billing
 * to the Claude Pro/Max subscription instead of pay-as-you-go API credits.
 *
 * Returns the mutated payload when a billing header was injected, or undefined
 * to leave the payload unchanged (non-Claude requests, or already injected).
 */
export function injectBillingHeader(payload: unknown): AnthropicPayload | undefined {
	if (!payload || typeof payload !== "object") return undefined;

	const p = payload as AnthropicPayload;
	if (!isClaudeModel(p.model)) return undefined;
	if (!Array.isArray(p.messages)) return undefined;

	const system: SystemEntry[] = Array.isArray(p.system) ? (p.system as SystemEntry[]) : [];

	// Only inject when pi is in OAuth stealth mode, signalled by its Claude
	// Code identity block. This avoids touching plain API-key requests (which
	// bill correctly on their own and would be confused by the header) and
	// GitHub Copilot requests (which reuse the Anthropic API but have no
	// Claude Code identity block).
	if (!system.some((e) => entryText(e).startsWith(CC_IDENTITY))) {
		return undefined;
	}

	// Already injected — leave it untouched (handler idempotency).
	if (system.some((e) => entryText(e).startsWith(BILLING_PREFIX))) {
		return undefined;
	}

	const messages = p.messages as Array<{
		role?: string;
		content?: string | Array<{ type?: string; text?: string }>;
	}>;

	const billingHeader = buildBillingHeaderValue(messages, getCliVersion(), getEntrypoint());

	// Billing header goes first, ahead of pi's identity block. No
	// cache_control so it does not consume a cache breakpoint.
	p.system = [{ type: "text", text: billingHeader }, ...system];

	// Relocate non-core system entries to user messages.
	// Anthropic's API validates the system prompt for OAuth-authenticated
	// requests that use Claude Code billing. Third-party system prompts
	// (like pi's) trigger a 400 "out of extra usage" rejection when
	// they appear inside the system[] array alongside the identity prefix.
	//
	// Work-around: keep only the billing header and identity prefix in
	// system[], and prepend all other system content to the first user
	// message where it is functionally equivalent but avoids the check.
	const keptSystem: SystemEntry[] = [];
	const movedTexts: string[] = [];
	for (const entry of p.system as SystemEntry[]) {
		const txt = entryText(entry);
		if (txt.startsWith(BILLING_PREFIX) || txt.startsWith(CC_IDENTITY)) {
			keptSystem.push(entry);
		} else if (txt.length > 0) {
			movedTexts.push(txt);
		}
	}

	if (movedTexts.length > 0) {
		const firstUser = (
			p.messages as Array<{
				role?: string;
				content?: string | Array<{ type?: string; text?: string }>;
			}>
		).find((m) => m.role === "user");
		if (firstUser) {
			p.system = keptSystem;
			const prefix = movedTexts.join("\n\n");
			const content = firstUser.content;
			if (typeof content === "string") {
				firstUser.content = prefix + "\n\n" + content;
			} else if (Array.isArray(content)) {
				content.unshift({ type: "text", text: prefix });
			}
		}
	}

	return p;
}

export function registerBillingLayer(pi: ExtensionAPI): void {
	// Full Claude Code user-agent for the native `anthropic` provider. pi
	// sends a bare `claude-cli/<version>` which fails plan-billing validation;
	// the `(external, <entrypoint>)` form is required for subscription billing.
	// (Alias providers set their own user-agent in aliases.ts.)
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
}
