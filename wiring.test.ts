/**
 * Loads the extension against a stub host and asserts the wiring the debug log
 * depends on: the events it subscribes to, the commands it registers, and the
 * fact that a startup line actually reaches the log file.
 *
 * A logger that silently writes nowhere is worse than no logger, so this test
 * reads the file back instead of trusting the call.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pi-multi-account-home-"));
const logFile = join(home, "extension.log");
process.env.HOME = home;
process.env.PI_MULTI_ACCOUNT_LOG = "debug";
process.env.PI_MULTI_ACCOUNT_LOG_FILE = logFile;
// A stub host has no keychain flow to complete, and no accounts to import.
process.env.PI_MULTI_ACCOUNT_AUTO_IMPORT = "0";

const { default: extension } = await import("./index.ts");

const events: string[] = [];
const commands: string[] = [];
const pi = {
	on: (event: string) => {
		events.push(event);
	},
	registerCommand: (name: string) => {
		commands.push(name);
	},
	registerProvider: () => undefined,
	unregisterProvider: () => undefined,
	setModel: async () => undefined,
} as unknown as Parameters<typeof extension>[0];

await extension(pi);

// The diagnosis relies on these three: a rejected response marks the credential,
// a turn boundary re-reads the store, and a model switch records the account.
for (const event of ["after_provider_response", "before_agent_start", "model_select", "agent_start", "agent_end"]) {
	assert.ok(events.includes(event), `extension must subscribe to ${event}`);
}
assert.ok(commands.includes("accounts"), "/accounts must still be registered");
assert.ok(commands.includes("pool-create"), "/pool-create must be registered (user-defined aggregate pools)");
assert.ok(commands.includes("pools"), "/pools must be registered");
assert.ok(commands.includes("pool-delete"), "/pool-delete must be registered");
// Diagnostics are a log file, not a user-facing surface.
assert.ok(!commands.includes("account-log"), "the debug log must not add a command");

const written = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
const startup = written.find((entry) => entry.event === "extension.loaded");
assert.ok(startup, "loading the extension must leave a startup line in the log");
assert.equal(startup.logLevel, "debug");
assert.equal(typeof startup.pid, "number");
assert.equal(typeof startup.rt, "string", "each process needs its own id to be told apart in a shared log");

console.log("ok: extension wiring + log sink");
