import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileAccountStorageBackend } from "@narumitw/pi-accounts/src/storage.ts";
import lockfile from "proper-lockfile";
import { LocklessReadAccountStore } from "../src/account-store.ts";

/**
 * Every pi process sharing HOME (pi-web daemons, the TUI, subagents,
 * background tasks) read the account store under its exclusive write lock.
 * Under that contention a model request died with "account store unreadable:
 * Lock file is already being held". Writes are atomic renames, so a read must
 * not wait for another process's lock at all.
 */
test("reading the store does not wait for another process's write lock", async () => {
	const file = join(mkdtempSync(join(tmpdir(), "pi-multi-account-read-lock-")), "pi-accounts.json");
	writeFileSync(
		file,
		JSON.stringify({ version: 1, providers: { anthropic: { active: "a", accounts: { a: { type: "oauth", access: "x", refresh: "r", expires: 1 } } } } }),
		{ mode: 0o600 },
	);
	const store = new LocklessReadAccountStore(file, new FileAccountStorageBackend(file));
	const release = await lockfile.lock(file, { realpath: false });
	try {
		const read = store.readProviderAsync("anthropic");
		const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2000).unref());
		const state = await Promise.race([read, timeout]);
		assert.notEqual(state, "timeout", "read blocked on the held lock");
		assert.equal(state === "timeout" ? undefined : state.active, "a");
	} finally {
		await release();
	}
});

test("a corrupt store still fails loudly", async () => {
	const file = join(mkdtempSync(join(tmpdir(), "pi-multi-account-read-lock-")), "pi-accounts.json");
	writeFileSync(file, "{not json", { mode: 0o600 });
	const store = new LocklessReadAccountStore(file, new FileAccountStorageBackend(file));
	await assert.rejects(store.readProviderAsync("anthropic"));
});

test("a store path that is a symlink or not a file is refused, not read", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-multi-account-read-lock-"));
	const target = join(dir, "elsewhere.json");
	writeFileSync(target, JSON.stringify({ version: 1, providers: {} }), { mode: 0o600 });
	const linked = join(dir, "pi-accounts.json");
	symlinkSync(target, linked);
	const folder = join(dir, "folder.json");
	mkdirSync(folder);
	await assert.rejects(new LocklessReadAccountStore(linked, new FileAccountStorageBackend(linked)).readProviderAsync("anthropic"), /regular file/);
	await assert.rejects(new LocklessReadAccountStore(folder, new FileAccountStorageBackend(folder)).readProviderAsync("anthropic"), /regular file/);
});

test("a missing store reads as empty", async () => {
	const file = join(mkdtempSync(join(tmpdir(), "pi-multi-account-read-lock-")), "pi-accounts.json");
	const store = new LocklessReadAccountStore(file, new FileAccountStorageBackend(file));
	assert.deepEqual(Object.keys((await store.readProviderAsync("anthropic")).accounts), []);
});
