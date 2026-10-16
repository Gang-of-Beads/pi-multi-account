/**
 * Codex Fast mode: the payload tier the extension adds around the known pi gap
 * (pi-ai's buildBaseOptions drops `serviceTier` before the adapter reads it,
 * earendil-works/pi#11040), and the `/fast` command that turns it on.
 *
 * The assertions are the ones that would have caught the two ways this can be
 * wrong: applying to a provider that ignores the field, and swallowing another
 * extension's payload hook on the way.
 */
import assert from "node:assert/strict";
import { applyCodexFast, fastEnabled, isCodexTarget, registerCodexFast, setFast } from "../src/codex-fast.ts";

const codex = { api: "openai-codex-responses", provider: "codex-work" };
const anthropic = { api: "anthropic-messages", provider: "anthropic" };

// --- the environment switch -------------------------------------------------

delete process.env.PI_MULTI_ACCOUNT_CODEX_FAST;
assert.equal(fastEnabled(), false, "off unless asked for");

const untouched = {};
applyCodexFast(untouched, codex);
assert.deepEqual(untouched, {}, "off leaves the request alone");

process.env.PI_MULTI_ACCOUNT_CODEX_FAST = "1";
assert.equal(fastEnabled(), true, "the env value turns it on");

// --- what it does to a request ---------------------------------------------

const seen: string[] = [];
const options: Record<string, unknown> = {
	onPayload: async (payload: unknown) => {
		seen.push("previous");
		return { ...(payload as Record<string, unknown>), untouched_by_pi: true };
	},
};
applyCodexFast(options, codex);
assert.equal(options.serviceTier, "priority", "mirrored on the options for the day pi forwards it");

const body = (await (options.onPayload as (p: unknown) => Promise<unknown>)({ model: "gpt-5.6-sol" }, codex)) as Record<
	string,
	unknown
>;
assert.equal(body.service_tier, "priority", "the tier reaches the payload");
assert.equal(body.model, "gpt-5.6-sol", "the rest of the payload is left alone");
assert.equal(body.untouched_by_pi, true, "the previous payload hook still ran and its result is kept");
assert.deepEqual(seen, ["previous"], "the previous hook ran exactly once");

// A hook that returns nothing (pi's own default) must still get the field.
const bare: Record<string, unknown> = {};
applyCodexFast(bare, codex);
const bareBody = (await (bare.onPayload as (p: unknown) => Promise<unknown>)({ model: "x" }, codex)) as Record<string, unknown>;
assert.equal(bareBody.service_tier, "priority", "a payload with no previous hook is used as-is");

// --- where it applies -------------------------------------------------------

assert.equal(isCodexTarget(codex), true);
assert.equal(isCodexTarget({ provider: "openai-codex" }), true, "pi's own codex login");
assert.equal(isCodexTarget({ provider: "codex" }), true, "the active-account alias");
assert.equal(isCodexTarget(undefined), false);
assert.equal(isCodexTarget(anthropic), false);

const otherApi: Record<string, unknown> = { onPayload: async () => ({ keep: true }) };
const keptHook = otherApi.onPayload;
applyCodexFast(otherApi, anthropic);
assert.equal(otherApi.onPayload, keptHook, "another provider keeps its own payload hook");
assert.equal(otherApi.serviceTier, undefined);

// --- the command ------------------------------------------------------------

const notes: [string, string][] = [];
let command: { handler: (args: string | undefined, ctx: unknown) => Promise<void> } | undefined;
registerCodexFast({
	registerCommand: (_name: string, definition: never) => {
		command = definition;
	},
} as never);
assert.ok(command, "/fast is registered");

const ctx = {
	ui: { notify: (message: string, kind: string) => notes.push([kind, message]) },
	model: { provider: "codex-work", id: "gpt-5.6-sol" },
};
const run = (args: string | undefined) => (command as NonNullable<typeof command>).handler(args, ctx);

delete process.env.PI_MULTI_ACCOUNT_CODEX_FAST;
await run("status");
assert.equal(notes.at(-1)?.[1], "Codex Fast mode: off — this process's Codex requests run codex-work/gpt-5.6-sol.", "an unset env is not blamed for the default");
process.env.PI_MULTI_ACCOUNT_CODEX_FAST = "1";

await run("status");
assert.match(notes.at(-1)?.[1] ?? "", /Fast mode: on/, "status reports the state");
assert.match(notes.at(-1)?.[1] ?? "", /\(from PI_MULTI_ACCOUNT_CODEX_FAST\)/, "a set env is named as the source");
assert.equal(notes.at(-1)?.[0], "info");

await run("off");
assert.equal(fastEnabled(), false);
assert.match(notes.at(-1)?.[1] ?? "", /Fast mode: off/);
assert.doesNotMatch(notes.at(-1)?.[1] ?? "", /from/, "the session flag is not attributed to the env");

await run(undefined);
assert.equal(fastEnabled(), true, "a bare /fast toggles");
await run("on");
assert.match(notes.at(-1)?.[1] ?? "", /2\.5x/, "the cost is named");

await run("banana");
assert.equal(notes.at(-1)?.[0], "warning", "an unknown argument warns");
assert.equal(fastEnabled(), true, "and changes nothing");
assert.match(notes.at(-1)?.[1] ?? "", /on, off or status/, "and says what it takes");

// The check above cannot see an argument that wrongly turns fast *on*, because it
// is already on; run it again from off.
await run("off");
await run("banana");
assert.equal(fastEnabled(), false, "a stray argument cannot turn it on either");

// A session that is not on Codex says so instead of pretending it applies.
const foreign = { ui: { notify: (message: string) => notes.push(["info", message]) }, model: { provider: "anthropic", id: "claude-opus-5-5" } };
await (command as NonNullable<typeof command>).handler("status", foreign);
assert.match(notes.at(-1)?.[1] ?? "", /not a Codex model/);

// The session flag outranks the environment, so /fast off works with the env set.
setFast(false);
assert.equal(fastEnabled(), false);
setFast(true);
assert.equal(fastEnabled(), true);

delete process.env.PI_MULTI_ACCOUNT_CODEX_FAST;
console.log("codex-fast.test.ts ok");
