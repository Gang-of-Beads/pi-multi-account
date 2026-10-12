/**
 * Probe: reports which provider ids a session can see, per turn.
 *
 * The scenario to reproduce: /accounts logs in a codex account into the shared store
 * *while a session is running*. The question is whether the running session starts
 * seeing `codex` / `codex-<name>` without a /reload.
 *
 * PROBE_MUTATE makes the probe write the store on the first turn, after every
 * session_start handler has run - exactly the shape of a change made by another actor
 * (a /accounts login in another session, or the refresh sweep rewriting a token).
 * Modes: `add` (a new account), `remove`, `switch` (a new account plus a new active).
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const LOG = process.env.PROBE_LOG ?? "/tmp/probe.log";
const STORE = join(homedir(), ".pi", "agent", "pi-accounts.json");

async function record(label: string, ctx: ExtensionContext): Promise<void> {
	const providers = [...new Set(ctx.modelRegistry.getAll().map((model) => model.provider))].sort();
	// Which account `codex` resolves to; only asked when registered, since unknown providers may throw.
	const active = providers.includes("codex") ? ((await ctx.modelRegistry.getProviderAuth("codex"))?.source ?? "NONE") : "NONE";
	appendFileSync(LOG, JSON.stringify({ label, turn: turns, providers, codex: providers.filter((p) => p.startsWith("codex")), active }) + "\n");
}

let turns = 0;
let mutated = false;

export default function (pi: ExtensionAPI): void {
	pi.on("turn_start", async (_event, ctx) => {
		turns += 1;
		const mode = process.env.PROBE_MUTATE ?? "none";
		if (mode !== "none" && turns === 1 && !mutated) {
			mutated = true;
			const store = JSON.parse(readFileSync(STORE, "utf8"));
			const account = { type: "oauth", access: "fake-access-token", refresh: "fake-refresh", expires: Date.now() + 3600_000 };
			if (mode === "add") store.providers["openai-codex"] = { active: "work2", accounts: { work2: account } };
			if (mode === "remove") delete store.providers["openai-codex"];
			if (mode === "switch") {
				const provider = store.providers["openai-codex"];
				provider.accounts.work3 = account;
				provider.active = "work3";
			}
			writeFileSync(STORE, JSON.stringify(store, null, 1));
			appendFileSync(LOG, JSON.stringify({ label: "store.mutated", mode, at: Date.now() }) + "\n");
		}
		await record("turn_start", ctx);
	});
	pi.on("turn_end", async (_event, ctx) => await record("turn_end", ctx));
	pi.on("agent_end", async (_event, ctx) => await record("agent_end", ctx));
}
