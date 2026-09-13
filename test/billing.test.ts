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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyUserAgentOverride,
	buildBillingHeaderValue,
	buildUserAgent,
	CC_VERSION,
	getCliVersion,
	injectBillingHeader,
	registerBillingLayer,
	resetClaudeVersionCache,
} from "../src/billing.ts";

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

// The final-header hook fixes the native provider too; aliases and pools have
// their own fetch wrappers because they replace the provider stream.
{
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	registerBillingLayer({
		registerProvider: () => undefined,
		on: (name: string, handler: (event: any, ctx: any) => unknown) => handlers.set(name, handler),
	} as never);
	const headers: Record<string, string> = { "user-agent": "claude-cli/2.1.75" };
	await handlers.get("before_provider_headers")!({ headers }, { model: { provider: "anthropic" } });
	assert.equal(headers["user-agent"], FULL_UA, "native Anthropic OAuth gets the final UA override");
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
		buildBillingHeaderValue(pristineMessages as never, "2.1.251", "sdk-cli"),
		"the injected header matches buildBillingHeaderValue for the same input",
	);
}

// Version resolution: env override > detected local claude > pinned fallback.
{
	resetClaudeVersionCache();
	const fakeBin = makeDir();
	writeFileSync(join(fakeBin, "claude"), "#!/bin/sh\necho \"2.3.4 (Claude Code)\"\n", {
		mode: 0o755,
	});
	const withPath = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };

	// No env, fake claude on PATH -> the detected version wins.
	delete process.env.ANTHROPIC_CLI_VERSION;
	const savedPath = process.env.PATH;
	process.env.PATH = `${fakeBin}:${savedPath}`;
	assert.equal(getCliVersion(), "2.3.4", "a locally installed claude is auto-detected");

	// Memoized: a second call must not re-probe (remove the fake and check).
	rmSync(join(fakeBin, "claude"));
	assert.equal(getCliVersion(), "2.3.4", "the probe result is memoized");

	// Env override beats everything.
	process.env.ANTHROPIC_CLI_VERSION = "9.9.9";
	resetClaudeVersionCache();
	assert.equal(getCliVersion(), "9.9.9", "ANTHROPIC_CLI_VERSION wins over detection");

	// No env, no claude on PATH -> pinned fallback.
	delete process.env.ANTHROPIC_CLI_VERSION;
	process.env.PATH = `${fakeBin}`; // nothing else findable
	resetClaudeVersionCache();
	assert.equal(getCliVersion(), CC_VERSION, "without a local claude the fallback applies");

	process.env.PATH = savedPath;
	rmSync(fakeBin, { recursive: true });
	resetClaudeVersionCache();
}

function makeDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-ma-test-"));
}

console.log("ok: UA override in place, gating and idempotency, billing header injection");
