process.env.PI_MULTI_ACCOUNT_LOG = "0";

import assert from "node:assert/strict";
import { AccountStore } from "@narumitw/pi-accounts/src/account-store.ts";
import type { AccountProviderAdapter } from "@narumitw/pi-accounts/src/oauth.ts";
import { InMemoryAccountStorageBackend } from "@narumitw/pi-accounts/src/storage.ts";
import {
	acquireBackgroundRefreshLoop,
	isCredentialSuspect,
	markCredentialSuspect,
	markRunFinished,
	markRunStarted,
	refreshAccountCredential,
	resetSuspectCredentialsForTesting,
} from "./refresh.ts";

const HOUR = 60 * 60 * 1000;

let refreshCalls = 0;
let issued = 0;
const adapter = {
	id: "anthropic",
	displayName: "Anthropic",
	oauth: {
		refresh: async () => {
			refreshCalls += 1;
			issued += 1;
			return { type: "oauth" as const, access: `access-${issued}`, refresh: `refresh-${issued}`, expires: Date.now() + 8 * HOUR };
		},
	},
} as unknown as AccountProviderAdapter;

async function freshStore(): Promise<AccountStore> {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.updateProviderAsync("anthropic", async () => ({
		active: "personal",
		// Valid for hours: the expiry-driven sweep has no reason to touch it.
		accounts: { personal: { type: "oauth" as const, access: "access-0", refresh: "refresh-0", expires: Date.now() + 4 * HOUR } },
	}));
	return store;
}

const accessToken = async (store: AccountStore): Promise<string> =>
	(await store.readProviderAsync("anthropic")).accounts.personal!.access;

// A token that is not near expiry is left alone. This is the state a revoked
// credential used to be stuck in: dead, but not due for a refresh, so every
// request kept failing with the same 401.
resetSuspectCredentialsForTesting();
let store = await freshStore();
let loop = acquireBackgroundRefreshLoop(store, [adapter]);
await loop.refreshNow();
assert.equal(refreshCalls, 0);
assert.equal(await accessToken(store), "access-0");

// A 401 marks the credential, and the next sweep refreshes it despite the
// stored expiry — so the account heals before the next turn instead of failing
// identically forever.
markCredentialSuspect("anthropic", "personal", "provider answered 401");
assert.equal(isCredentialSuspect("anthropic", "personal"), true);
await loop.refreshNow();
assert.equal(refreshCalls, 1);
assert.equal(await accessToken(store), "access-1");
assert.equal(isCredentialSuspect("anthropic", "personal"), false, "one rejection must not cause a refresh loop");

// And it stays refreshed: with the suspicion cleared, the healthy token is not
// rotated again on the next tick.
await loop.refreshNow();
assert.equal(refreshCalls, 1);
loop.stop();

// A rejected *active* account is still protected while a run is in flight:
// rotating it there would break the request that is already outstanding.
resetSuspectCredentialsForTesting();
refreshCalls = 0;
store = await freshStore();
loop = acquireBackgroundRefreshLoop(store, [adapter]);
markCredentialSuspect("anthropic", "personal", "provider answered 401");
markRunStarted();
await loop.refreshNow();
assert.equal(refreshCalls, 0, "the in-flight run keeps its credential");
assert.equal(isCredentialSuspect("anthropic", "personal"), true, "suspicion survives until the account is refreshed");
markRunFinished();
await loop.refreshNow();
assert.equal(refreshCalls, 1, "the run is over, so the rejected token is replaced");
loop.stop();

// A forced refresh must not undo a token another writer just installed:
// re-refreshing that one would invalidate the credential that writer is using.
resetSuspectCredentialsForTesting();
refreshCalls = 0;
store = await freshStore();
const stale = { type: "oauth" as const, access: "access-stale", refresh: "refresh-stale", expires: Date.now() + 4 * HOUR };
const result = await refreshAccountCredential(store, adapter, "personal", stale, Date.now(), { force: true });
assert.equal(refreshCalls, 0);
assert.equal(result.access, "access-0", "the credential already in the store wins");

console.log("ok: revoked credentials are refreshed on rejection, not on expiry");
