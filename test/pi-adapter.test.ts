import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerPiProviders } from "../src/pi-adapter.ts";

const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
const notices: { message: string; level: string }[] = [];
const calls: string[] = [];
let errors: string[] = [];
const engine = {
	agentDir: mkdtempSync(join(tmpdir(), "pma-adapter-")),
	dynamicProviders: [],
	accountProviders: [],
	definitions: [],
	syncAccounts: async () => {
		calls.push("syncAccounts");
	},
	refresh: async (options: { force?: boolean }) => {
		assert.deepEqual(options, { force: true });
		calls.push("refresh");
		return { errors };
	},
};
const binding = registerPiProviders(
	{
		registerCommand: (name: string, command: { handler: (args: string, ctx: never) => Promise<void> }) => commands.set(name, command),
		registerProvider: () => undefined,
		unregisterProvider: () => undefined,
	} as never,
	engine as never,
);
const ctx = {
	modelRegistry: { getRegisteredProviderIds: () => [] },
	ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
} as never;
for (const name of ["anthropic-account-providers", "codex-account-providers"]) {
	for (const failed of [true, false]) {
		errors = failed ? ["fixture-account: catalog unavailable; retained last good or built-in metadata"] : [];
		calls.length = 0;
		notices.length = 0;
		await commands.get(name)!.handler("", ctx);
		assert.deepEqual(calls, ["syncAccounts", "refresh", "syncAccounts"]);
		assert.deepEqual(notices, [{ message: failed ? errors[0] : "Account providers refreshed.", level: failed ? "warning" : "info" }]);
	}
}
await binding.stop();
console.log("ok: Pi adapter compatibility refresh commands report discovery errors");
