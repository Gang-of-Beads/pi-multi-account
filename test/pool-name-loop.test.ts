import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * An empty name used to end the "new pool" flow from the accounts menu with a
 * warning and no pool. It now asks again; only cancelling the dialog leaves.
 * The command path (`/pool-create`) already looped, so this is the menu one.
 */
const dir = mkdtempSync(join(tmpdir(), "pi-multi-account-pool-name-"));
process.env.PI_MULTI_ACCOUNT_POOLS_FILE = join(dir, "pools.json");
const { createPoolFromAccount } = await import("../src/accounts-menu.ts");

function ctxWith(answers: (string | undefined)[]) {
	const asked: string[] = [];
	const notices: string[] = [];
	return {
		asked,
		notices,
		ctx: {
			hasUI: true,
			ui: {
				input: (_title: string, placeholder?: string) => {
					asked.push(placeholder ?? "");
					return Promise.resolve(answers.shift());
				},
				notify: (message: string) => { notices.push(message); },
			},
		},
	};
}

test("an empty name asks again instead of ending the flow", async () => {
	const { asked, notices, ctx } = ctxWith(["", "  ", "realme-pool"]);
	const created = await createPoolFromAccount(ctx as never, "realme", () => undefined);

	assert.equal(created, "realme-pool");
	assert.equal(asked.length, 3, "every rejected answer is asked again");
	assert.ok(notices.filter((message) => message === "A pool needs a name.").length === 2);
	const written = JSON.parse(readFileSync(process.env.PI_MULTI_ACCOUNT_POOLS_FILE!, "utf8"));
	assert.deepEqual(written.pools, [{ name: "realme-pool", accounts: ["realme"] }]);
});

test("a taken or refused name asks again too, and cancelling ends the flow", async () => {
	const { asked, notices, ctx } = ctxWith(["bad name", undefined]);
	const created = await createPoolFromAccount(ctx as never, "realme", () => undefined);

	assert.equal(created, undefined);
	assert.equal(asked.length, 2);
	assert.match(notices[0] ?? "", /may use letters/);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
