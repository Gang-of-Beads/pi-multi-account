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
	CLI_VERSION_MIN_ENV,
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

	// The hook can see the same payload again; a second pass is a no-op.
	const headerText = system[0]!.text;
	assert.equal(
		injectBillingHeader(payload),
		undefined,
		"a second injection on the same payload is skipped",
	);
	assert.equal(system[0]!.text, headerText, "the existing billing header is left untouched");

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
		buildBillingHeaderValue(pristineMessages as never, getCliVersion(), "sdk-cli"),
		"the injected header matches buildBillingHeaderValue for the same input",
	);
}

// Version resolution: every source is a floor, and the highest one is claimed.
{
	resetClaudeVersionCache();
	const fakeBin = makeDir();
	const savedPath = process.env.PATH;
	const claudeOnPath = (version: string): void => {
		writeFileSync(join(fakeBin, "claude"), `#!/bin/sh\necho "${version} (Claude Code)"\n`, {
			mode: 0o755,
		});
		resetClaudeVersionCache();
	};

	delete process.env[CLI_VERSION_MIN_ENV];

	// No claude on PATH: the pin is the claim.
	process.env.PATH = fakeBin;
	resetClaudeVersionCache();
	assert.equal(getCliVersion(), CC_VERSION, "without a local claude the pin is the claim");

	// A newer local claude raises it.
	process.env.PATH = `${fakeBin}:${savedPath}`;
	claudeOnPath("9.9.9");
	assert.equal(getCliVersion(), "9.9.9", "a newer local claude raises the claim");

	// Memoized: a second call must not re-probe (remove the fake and check).
	rmSync(join(fakeBin, "claude"));
	assert.equal(getCliVersion(), "9.9.9", "the probe result is memoized");

	// An outdated local claude must not lower the claim: the gateway enforces a
	// per-model minimum (claude_code_version_too_old).
	claudeOnPath("2.1.217");
	assert.equal(getCliVersion(), CC_VERSION, "an older local claude does not lower the claim");

	// The env floor raises the claim, and only raises it.
	rmSync(join(fakeBin, "claude"));
	process.env[CLI_VERSION_MIN_ENV] = "9.9.10";
	assert.equal(getCliVersion(), "9.9.10", "the env floor raises the claim above the pin");

	process.env[CLI_VERSION_MIN_ENV] = "2.0.0";
	assert.equal(getCliVersion(), CC_VERSION, "an env floor below the pin loses instead of downgrading");

	process.env[CLI_VERSION_MIN_ENV] = "9.9";
	assert.equal(getCliVersion(), CC_VERSION, "a malformed env floor is ignored, not put on the wire");

	process.env[CLI_VERSION_MIN_ENV] = "9.9.9";
	claudeOnPath("9.9.11");
	assert.equal(getCliVersion(), "9.9.11", "the highest floor wins");

	delete process.env[CLI_VERSION_MIN_ENV];
	rmSync(fakeBin, { recursive: true });
	process.env.PATH = savedPath;
	resetClaudeVersionCache();
}

function makeDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-ma-test-"));
}

console.log("ok: UA override in place, gating and idempotency, billing header injection");
