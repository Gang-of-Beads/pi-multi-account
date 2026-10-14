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
	claimedCliVersion,
	CLI_VERSION_MIN_ENV,
	getCliVersion,
	getEntrypoint,
	injectBillingHeader,
	isCliVersion,
	withShapingOnPayload,
	registerBillingLayer,
	resetClaudeVersionCache,
	versionInUserAgent,
} from "../src/billing.ts";

// A developer's own ANTHROPIC_USER_AGENT would decide both the UA and the
// claimed version; clear it so every assertion here is deterministic.
const savedUserAgent = process.env.ANTHROPIC_USER_AGENT;
delete process.env.ANTHROPIC_USER_AGENT;

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

	// A floor above the pin so the resolved version provably differs from
	// CC_VERSION; otherwise on a claude-less box getCliVersion()===CC_VERSION
	// and a header hardcoding the pin is indistinguishable from the resolver.
	process.env[CLI_VERSION_MIN_ENV] = "99.0.0";

	const first = injectBillingHeader(payload);
	assert.ok(first, "a stealth payload gets the billing header");
	const system = first!.system as Array<{ text: string }>;
	assert.match(system[0]!.text, /^x-anthropic-billing-header: cc_version=\d/);
	assert.equal(system[1]!.text, identity, "the identity block stays after the billing header");

	// The billing header and the user-agent must claim the same resolved
	// version; that agreement is the point of the whole layer. The floor above
	// moves the resolved version off the pin, so either side falling back to
	// CC_VERSION fails here.
	const claimed = /cc_version=([^;]+)/.exec(system[0]!.text)?.[1]?.replace(/\.[0-9a-f]{3}$/, "");
	assert.equal(claimed, getCliVersion(), "the header claims the resolved version");
	assert.notEqual(getCliVersion(), CC_VERSION, "the injected floor moves the claim off the pin");
	assert.equal(
		buildUserAgent(),
		`claude-cli/${claimed} (external, ${getEntrypoint()})`,
		"the user-agent claims the same version as cc_version",
	);

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
	// Computed from a pristine copy: injectBillingHeader mutates the payload in place.
	const pristineMessages = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
	assert.equal(
		system[0]!.text,
		buildBillingHeaderValue(pristineMessages as never, getCliVersion(), "sdk-cli"),
		"the injected header matches buildBillingHeaderValue for the same input",
	);

	// The format itself is pinned, independent of this machine's claude.
	assert.match(
		buildBillingHeaderValue(pristineMessages as never, "2.1.300", "sdk-cli"),
		/^x-anthropic-billing-header: cc_version=2\.1\.300\.[0-9a-f]{3}; cc_entrypoint=sdk-cli; cch=[0-9a-f]{5};$/,
		"a known version formats as cc_version=<version>.<suffix> with a cch",
	);

	delete process.env[CLI_VERSION_MIN_ENV];
}

// The provider-call payload hook: it must chain whatever hook the caller already
// set (pi's agent loop supplies `before_provider_request` that way) and still
// shape, because compaction calls the provider stream with no hook at all.
// The third case is the narrow one: the payload is already billed, so this pins
// the early return rather than re-running the shaper. Real idempotency of the
// shaper itself is asserted in anthropic-shape.test.ts.
{
	const calls: string[] = [];
	const composed = withShapingOnPayload(((payload: any) => {
		calls.push("outer");
		return { ...payload, seen: true };
	}) as never);
	const payload: any = {
		model: "claude-opus-5-5",
		system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
		messages: [{ role: "user", content: "hi" }],
	};
	const out = (await composed(payload)) as any;
	assert.deepEqual(calls, ["outer"], "the caller's hook still runs");
	assert.equal(out.seen, true, "and its result is kept");
	assert.match(out.system[0].text, /^x-anthropic-billing-header: /, "the header is injected into the chained result");

	// With no hook at all - the compaction case - shaping still happens.
	const solo = (await withShapingOnPayload(undefined)(payload)) as any;
	assert.match(solo.system[0].text, /^x-anthropic-billing-header: /, "shaping works without a caller hook");

	// Both routes may run for one payload; the second pass is a no-op.
	const twice = (await withShapingOnPayload(undefined)(solo)) as any;
	assert.equal(twice.system.length, solo.system.length, "shaping is idempotent across both routes");
}

// Request shaping on the OAuth path: pi prose goes, the transcript's transcribed
// reasoning goes, `cch` describes what actually ships, and API-key/Copilot
// payloads are left alone.
{
	const identity = "You are Claude Code, Anthropic's official CLI for Claude.";
	const piPrompt = [
		"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files.",
		"<tools>\n- read: Read a file\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n</tools>",
		"<docs>\nPi documentation (read only when the user asks about pi itself, its SDK):\n- Main documentation: /pi/README.md\n</docs>",
	].join("\n\n");
	const transcript = "<conversation>\n[User]: fix\n\n[Assistant thinking]: the bug is here\n\n[Assistant]: done\n</conversation>";

	const payload: any = {
		model: "claude-opus-5-5",
		// pi sends the whole prompt after the identity block, and a summarization
		// request replaces it with the summarizer prompt.
		system: [{ type: "text", text: identity }, { type: "text", text: piPrompt }],
		messages: [
			{ role: "user", content: [{ type: "text", text: transcript }] },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "system", content: [{ type: "text", text: 'Updated system prompt section "tools":\n\n<tools>\nx\n\nIn addition to the tools above, keep going.\n</tools>' }] },
		],
	};

	assert.ok(injectBillingHeader(payload), "a stealth payload is shaped");
	const system = payload.system as Array<{ text: string }>;

	// system[] keeps its shape (billing header prepended), rather than being
	// collapsed and relocated into the first user message.
	assert.equal(system.length, 3, "the prompt stays in system[] as its own block");
	assert.match(system[0]!.text, /^x-anthropic-billing-header: cc_version=\d/);
	assert.equal(system[1]!.text, identity, "the identity block is untouched");
	assert.ok(system[2]!.text.startsWith("You are an expert coding assistant.\n"), "pi's preamble is replaced");
	assert.ok(!system[2]!.text.includes("In addition to the tools above"), "the tools filler is dropped");
	assert.ok(!system[2]!.text.includes("<docs>"), "pi's docs section is dropped");

	// The user turn keeps the transcript's other segments but loses the reasoning.
	const firstUser = payload.messages[0].content[0] as { text: string };
	assert.ok(!firstUser.text.includes("[Assistant thinking]: "), "transcribed reasoning is stripped");
	assert.ok(firstUser.text.includes("[User]: fix"), "the rest of the transcript is intact");

	// The deduped system update is shaped through the second route too.
	const update = payload.messages[2].content[0] as { text: string };
	assert.ok(!update.text.includes("In addition to the tools above"), "a mid-conversation section update is shaped");

	// `cch` must describe the stripped text: computed from the payload's own first
	// user message after the strip, so computing it before the strip would fail here.
	const cchOf = (text: string): string =>
		buildBillingHeaderValue([{ role: "user", content: [{ type: "text", text }] }] as never, getCliVersion(), "sdk-cli").match(/cch=([0-9a-f]+)/)![1];
	assert.equal(system[0]!.text.match(/cch=([0-9a-f]+)/)![1], cchOf(firstUser.text), "cch is computed after the strip");
	assert.notEqual(firstUser.text, transcript, "the strip really changed the hashed input");
	assert.notEqual(cchOf(firstUser.text), cchOf(transcript), "cch describes the stripped text, not the original");

	// pi sends content-less `role: "system"` messages to carry a per-message
	// effort. They have no section to shape and must not be dropped with the
	// empty-after-shaping updates.
	{
		const effort: any = {
			model: "claude-opus-5-5",
			system: [{ type: "text", text: identity }],
			messages: [
				{ role: "user", content: "hi" },
				{ role: "system", content: [], output_config: { effort: "high" } },
				{ role: "system", content: [{ type: "text", text: 'Removed system prompt section "docs".' }] },
			],
		};
		injectBillingHeader(effort);
		assert.equal(effort.messages.length, 2, "the empty-after-shaping update is dropped and the content-less effort message survives");
		assert.deepEqual(effort.messages[1].output_config, { effort: "high" }, "with its effort intact");
		assert.ok(!JSON.stringify(effort.messages).includes("Removed system prompt section"), "the shaped-away removal notice is removed");
	}

	// A payload with no pi prose and no marker is only given the header.
	const minimal: any = {
		model: "claude-opus-5-5",
		system: [{ type: "text", text: identity }],
		messages: [{ role: "user", content: "hello" }],
	};
	injectBillingHeader(minimal);
	assert.equal((minimal.system as unknown[]).length, 2, "nothing to shape leaves the payload alone");

	// Escape hatch: shaping off, the billing header still goes out. The switch is
	// about the request shape, not about billing - and it must not take the header
	// with it, or an OAuth request falls back to the extra-usage lane.
	process.env.PI_MULTI_ACCOUNT_SHAPE = "0";
	try {
		const unshaped: any = {
			model: "claude-opus-5-5",
			system: [{ type: "text", text: identity }, { type: "text", text: piPrompt }],
			messages: [{ role: "user", content: [{ type: "text", text: transcript }] }],
		};
		assert.ok(injectBillingHeader(unshaped), "shaping off still injects");
		assert.match((unshaped.system[0] as { text: string }).text, /^x-anthropic-billing-header: /, "the header is still first");
		assert.equal(unshaped.system.length, 3, "nothing was dropped");
		assert.ok((unshaped.system[2] as { text: string }).text.startsWith("You are an expert coding assistant operating inside pi"), "PI_MULTI_ACCOUNT_SHAPE=0 keeps pi's prompt");
		assert.ok((unshaped.messages[0].content[0] as { text: string }).text.includes("[Assistant thinking]: "), "PI_MULTI_ACCOUNT_SHAPE=0 keeps the reasoning");
	} finally {
		delete process.env.PI_MULTI_ACCOUNT_SHAPE;
	}

	// `system` is normally blocks, but Anthropic also accepts a bare string; a
	// shaped string entry has to be written back, not computed and dropped.
	{
		const bare: any = {
			model: "claude-opus-5-5",
			system: [identity, piPrompt],
			messages: [{ role: "user", content: "hi" }],
		};
		injectBillingHeader(bare);
		assert.equal(typeof bare.system[2], "string", "a string entry stays a string");
		assert.ok(bare.system[2].startsWith("You are an expert coding assistant.\n"), "and it is the shaped one");
		assert.ok(!bare.system[2].includes("<docs>"), "the string entry really was shaped");
	}

	// A `role: "system"` message with string content takes the same rules, and one
	// whose every framed part shaped away is dropped rather than sent empty.
	{
		const stringy: any = {
			model: "claude-opus-5-5",
			system: [{ type: "text", text: identity }],
			messages: [
				{ role: "user", content: "hi" },
				{ role: "system", content: 'Updated system prompt section "tools":\n\n<tools>\nx\n\nIn addition to the tools above, keep going.\n</tools>' },
				{ role: "system", content: 'Removed system prompt section "docs".' },
				{ role: "system", content: [] },
			],
		};
		injectBillingHeader(stringy);
		const texts = stringy.messages.map((m: any) => (typeof m.content === "string" ? m.content : ""));
		assert.ok(!texts.some((t: string) => t.includes("In addition to the tools above")), "a string system update is shaped");
		assert.equal(stringy.messages.length, 3, "the unforwardable docs removal is dropped");
		assert.ok(Array.isArray(stringy.messages[2].content) && stringy.messages[2].content.length === 0, "the content-less effort message is kept");
	}
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

	// The floor policy is pure: the highest valid floor wins, garbage is dropped.
	assert.equal(claimedCliVersion(), CC_VERSION, "no floor beats the pin");
	assert.equal(claimedCliVersion("1.0.0", "9.9.8"), "9.9.8", "the highest floor wins");
	assert.equal(claimedCliVersion("9.9", "junk"), CC_VERSION, "only wire-shaped floors count");
	assert.equal(isCliVersion("2.1.296"), true);
	assert.equal(isCliVersion("2.1"), false, "two components is not a version we send");
	assert.equal(versionInUserAgent("claude-cli/9.9.9 (external, cli)"), "9.9.9");
	assert.equal(versionInUserAgent("node"), undefined, "a UA naming no version decides nothing");

	// An independent literal for the pin: the gateway answers anything under
	// 2.1.280 for claude-opus-5-5 with claude_code_version_too_old, which is the
	// incident this whole module exists for. A pin that drops below it fails here.
	const [major, minor, patch] = CC_VERSION.split(".").map(Number);
	assert.ok(
		major! * 1_000_000 + minor! * 1_000 + patch! >= 2_001_280,
		`CC_VERSION ${CC_VERSION} is below the 2.1.280 model minimum`,
	);

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

	// An exact user-agent is the last word, and cc_version follows it: an
	// override that names a version cannot desync the two.
	process.env.ANTHROPIC_USER_AGENT = "claude-cli/9.9.12 (external, cli)";
	assert.equal(getCliVersion(), "9.9.12", "an exact user-agent fixes the claimed version");
	assert.equal(buildUserAgent(), "claude-cli/9.9.12 (external, cli)");
	assert.equal(versionInUserAgent(buildUserAgent()), getCliVersion(), "the UA and cc_version agree");

	// A user-agent that names no claude-cli version leaves the floors in charge.
	process.env.ANTHROPIC_USER_AGENT = "my-agent/1.0";
	assert.equal(getCliVersion(), "9.9.11", "the floors still decide");
	assert.equal(buildUserAgent(), "my-agent/1.0", "a no-version override passes through verbatim");
	assert.ok(
		versionInUserAgent(buildUserAgent()) !== getCliVersion(),
		"a no-version override leaves cc_version on the floors",
	);
	delete process.env.ANTHROPIC_USER_AGENT;

	delete process.env[CLI_VERSION_MIN_ENV];
	rmSync(fakeBin, { recursive: true });
	process.env.PATH = savedPath;
	resetClaudeVersionCache();
}

function makeDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-ma-test-"));
}

if (savedUserAgent !== undefined) process.env.ANTHROPIC_USER_AGENT = savedUserAgent;

console.log("ok: UA override in place, gating and idempotency, version floors, header format, request shaping");
