/**
 * Billing-layer behavior: the user-agent override that keeps the wire UA in
 * sync with the billing header's cc_version, and the header injection's
 * gating (only OAuth stealth payloads, idempotent).
 *
 * Why the UA override exists at all: pi's request path assembles headers from
 * model-level definitions and caller options only, so the provider-level
 * `headers` registration never reaches the wire — every Anthropic OAuth
 * request went out with pi-ai's built-in bare `claude-cli/2.1.75`, which does
 * not match the billing header's cc_version. The override hooks the one
 * supported point (before_provider_headers) where the merged headers can
 * still be mutated.
 */
import assert from "node:assert/strict";
import { applyUserAgentOverride, buildBillingHeaderValue, buildUserAgent, injectBillingHeader } from "./billing.ts";

const FULL_UA = buildUserAgent();

// A claude-cli/* UA (pi-ai's OAuth default or any older version) is replaced
// with the full current form.
{
	const headers = new Headers({ "user-agent": "claude-cli/2.1.75", "x-app": "cli" });
	applyUserAgentOverride(headers);
	assert.equal(headers.get("user-agent"), FULL_UA, "bare/old OAuth UA is rewritten in place");
	assert.equal(headers.get("x-app"), "cli", "other headers are untouched");
}

// Idempotent: an already-current UA is left alone.
{
	const headers = new Headers({ "user-agent": FULL_UA });
	applyUserAgentOverride(headers);
	assert.equal(headers.get("user-agent"), FULL_UA);
}

// Non-Anthropic agents pass through untouched: API-key requests, Copilot,
// Codex, and requests with no UA at all.
for (const ua of ["node", "GitHub Copilot", "codex-cli/1.0", undefined]) {
	const headers = new Headers(ua ? { "user-agent": ua } : {});
	applyUserAgentOverride(headers);
	assert.equal(
		headers.get("user-agent") ?? undefined,
		ua,
		`a ${ua === undefined ? "missing" : "non-claude-cli"} UA is not rewritten`,
	);
}

// Billing header injection: only OAuth stealth payloads (Claude model + the
// Claude Code identity block), and only once.
{
	const identity = "You are Claude Code, Anthropic's official CLI for Claude.";
	const payload = {
		model: "claude-haiku-4-5",
		system: [{ type: "text", text: identity }, { type: "text", text: "be brief" }],
		messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
	};

	const first = injectBillingHeader(payload);
	assert.ok(first, "a stealth payload gets the billing header");
	const system = first!.system as Array<{ text: string }>;
	assert.match(system[0]!.text, /^x-anthropic-billing-header: cc_version=\d/);
	assert.equal(system[1]!.text, identity, "the identity block stays after the billing header");

	// Non-stealth payloads are skipped: no identity block, non-Claude model.
	assert.equal(
		injectBillingHeader({ model: "claude-haiku-4-5", system: [{ type: "text", text: "plain" }], messages: [] }),
		undefined,
		"no identity block → no injection",
	);
	assert.equal(
		injectBillingHeader({ model: "gpt-5.5", system: [{ type: "text", text: identity }], messages: [] }),
		undefined,
		"non-Claude model → no injection",
	);

	// The header value is deterministic for the same first user message.
	// Computed from a pristine copy: injectBillingHeader mutates the payload
	// in place (non-core system text moves into the first user message).
	const pristineMessages = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
	assert.equal(
		system[0]!.text,
		buildBillingHeaderValue(pristineMessages as never, "2.1.217", "sdk-cli"),
		"the injected header matches buildBillingHeaderValue for the same input",
	);
}

console.log("ok: UA override in place, gating and idempotency, billing header injection");
