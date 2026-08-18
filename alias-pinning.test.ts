/**
 * An `anthropic-<account>` alias pins one session, and pinning one session must
 * not change what every other session uses.
 *
 * The alias resolves its own bound account regardless of the stored `active`
 * one, so writing `active` buys nothing for the session doing the choosing --
 * but it does decide which account the canonical `anthropic` provider sends,
 * for every other session on the machine. A session that merely *opened* on a
 * pinned model was enough to move it, and an unrelated session mid-request
 * could then fail with a 401 from an account it never chose.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "pi-multi-account-pin-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_MULTI_ACCOUNT_AUTO_IMPORT = "0";
process.env.PI_MULTI_ACCOUNT_BACKGROUND_REFRESH = "0";

const accountsFile = join(agentDir, "pi-accounts.json");
const credential = (token: string) => ({
	type: "oauth" as const,
	access: `sk-ant-oat-${token}`,
	refresh: `${token}-refresh`,
	// Far future: nothing here should attempt a refresh.
	expires: 4102444800000,
});

writeFileSync(
	accountsFile,
	`${JSON.stringify(
		{
			version: 1,
			providers: {
				anthropic: {
					active: "alpha",
					accounts: { alpha: credential("alpha"), beta: credential("beta") },
				},
			},
		},
		null,
		2,
	)}\n`,
	"utf8",
);

const { AccountStore } = await import("@narumitw/pi-accounts/src/accounts.ts");
const { reportPinnedAliasAccount } = await import("./session-state.ts");

const store = new AccountStore();

const ctx = {
	model: { provider: "anthropic-beta", id: "claude-fable-5" },
	ui: {
		notify: () => undefined,
	},
} as unknown as Parameters<typeof reportPinnedAliasAccount>[1];

await reportPinnedAliasAccount(store, ctx);

const active = (JSON.parse(readFileSync(accountsFile, "utf8")) as {
	providers: { anthropic: { active?: string } };
}).providers.anthropic.active;

assert.equal(
	active,
	"alpha",
	"selecting an alias must leave the machine-wide active account alone; " +
		"the alias already resolves its own account, and rewriting this makes " +
		"one session's choice change what every other session sends",
);

console.log("alias pinning: selecting an alias leaves the active account alone");
