import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const logFile = join(mkdtempSync(join(tmpdir(), "pi-multi-account-contention-")), "extension.log");
process.env.PI_MULTI_ACCOUNT_LOG = "info";
process.env.PI_MULTI_ACCOUNT_LOG_FILE = logFile;

import assert from "node:assert/strict";
import test from "node:test";
import { AccountStore } from "@narumitw/pi-accounts/src/account-store.ts";
import type { AccountProviderAdapter } from "@narumitw/pi-accounts/src/oauth.ts";
import { InMemoryAccountStorageBackend } from "@narumitw/pi-accounts/src/storage.ts";
import { refreshAccountCredential, resetRefreshFailuresForTesting, resetSuspectCredentialsForTesting } from "../src/refresh.ts";

/**
 * pi-web runs every session - and every subagent - in one daemon, so a
 * rotation can point a dozen turns at the same expiring credential at once.
 * Each one used to take the account store's file lock; the waiters that ran
 * out of retries reported "Lock file is already being held" as an auth
 * failure, killing turns whose credential was fine.
 */
const HOUR = 60 * 60 * 1000;

function adapter(refresh: () => Promise<{ access: string }>): AccountProviderAdapter {
	return {
		id: "anthropic",
		label: "Anthropic",
		oauth: {
			async refresh() {
				const next = await refresh();
				return { type: "oauth" as const, access: next.access, refresh: "refresh-next", expires: Date.now() + 4 * HOUR };
			},
		},
	} as unknown as AccountProviderAdapter;
}

async function storeWithExpiringCredential(): Promise<AccountStore> {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.updateProviderAsync("anthropic", async () => ({
		active: "personal",
		accounts: { personal: { type: "oauth" as const, access: "stale", refresh: "refresh-0", expires: Date.now() + 1000 } },
	}));
	return store;
}

test("concurrent turns share one refresh instead of queueing on the store lock", async () => {
	resetSuspectCredentialsForTesting();
	resetRefreshFailuresForTesting();
	const store = await storeWithExpiringCredential();
	let refreshes = 0;
	const provider = adapter(async () => {
		refreshes += 1;
		await new Promise((resolve) => setTimeout(resolve, 20));
		return { access: `fresh-${String(refreshes)}` };
	});
	const stale = (await store.readProviderAsync("anthropic")).accounts.personal;
	assert.ok(stale && stale.type === "oauth");

	const results = await Promise.all(
		Array.from({ length: 8 }, () => refreshAccountCredential(store, provider, "personal", stale, Date.now())),
	);

	assert.equal(refreshes, 1, "eight turns must not run eight refreshes");
	for (const result of results) assert.equal(result.access, "fresh-1", "every caller gets the refreshed credential");
});

test("a held store lock answers with the stored credential rather than failing the turn", async () => {
	resetSuspectCredentialsForTesting();
	resetRefreshFailuresForTesting();
	const store = await storeWithExpiringCredential();
	// Another writer refreshed the account and still holds the lock: the write
	// fails, but the credential on disk is usable, which is the honest answer.
	await store.updateProviderAsync("anthropic", async (state) => ({
		...state,
		accounts: { personal: { type: "oauth" as const, access: "written-by-someone-else", refresh: "refresh-1", expires: Date.now() + 4 * HOUR } },
	}));
	const locked = new Error("Lock file is already being held");
	Reflect.set(locked, "code", "ELOCKED");
	const original = store.updateProviderAsync.bind(store);
	store.updateProviderAsync = () => Promise.reject(locked);

	const stale = { type: "oauth" as const, access: "stale", refresh: "refresh-0", expires: Date.now() + 1000 };
	const result = await refreshAccountCredential(store, adapter(() => Promise.resolve({ access: "never" })), "personal", stale, Date.now());

	assert.equal(result.access, "written-by-someone-else");
	store.updateProviderAsync = original;
});

test("a held store lock does not fail a refresh that already succeeded", async () => {
	resetSuspectCredentialsForTesting();
	resetRefreshFailuresForTesting();
	const store = await storeWithExpiringCredential();
	const locked = new Error("Lock file is already being held");
	Reflect.set(locked, "code", "ELOCKED");
	store.updateProviderAsync = () => Promise.reject(locked);

	const stale = { type: "oauth" as const, access: "stale", refresh: "refresh-0", expires: Date.now() + 1000 };
	const result = await refreshAccountCredential(store, adapter(() => Promise.resolve({ access: "fresh-after-lock" })), "personal", stale, Date.now());

	// The token is valid whether or not the file could be written; the round
	// trip happened outside the lock, so contention costs a record, not a turn.
	assert.equal(result.access, "fresh-after-lock");
});

test("the provider round trip does not happen under the store lock", async () => {
	resetSuspectCredentialsForTesting();
	resetRefreshFailuresForTesting();
	const store = await storeWithExpiringCredential();
	let lockedDuringRefresh = false;
	let inUpdate = false;
	const original = store.updateProviderAsync.bind(store);
	store.updateProviderAsync = async (providerId, mutator) => {
		inUpdate = true;
		try {
			return await original(providerId, mutator);
		} finally {
			inUpdate = false;
		}
	};
	const stale = { type: "oauth" as const, access: "stale", refresh: "refresh-0", expires: Date.now() + 1000 };

	await refreshAccountCredential(store, adapter(async () => {
		lockedDuringRefresh = inUpdate;
		await new Promise((resolve) => setTimeout(resolve, 5));
		return { access: "fresh" };
	}), "personal", stale, Date.now());

	assert.equal(lockedDuringRefresh, false, "a network call under the file lock is what starved every other process");
});
