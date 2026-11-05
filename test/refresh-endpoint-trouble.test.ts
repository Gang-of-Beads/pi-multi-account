/**
 * An endpoint that will not renew a token is not a bad token.
 *
 * Reported from a Termux install travelling abroad: `getaddrinfo ENOTFOUND
 * platform.claude.com` on one request threw out of both accounts' refreshes, the
 * pool reported "every account failed to resolve a credential. Check /accounts.",
 * and the tokens in the store still had most of an hour of life. The same shape
 * appears with `403 Request not allowed`, which the token endpoint returns when it
 * dislikes the client rather than the credential.
 *
 * `refreshAccountCredential` now keeps serving a still-valid token through those,
 * and still fails loudly for a real rejection (`invalid_grant`, `401`) so a
 * re-login is asked for when one is actually needed.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_MULTI_ACCOUNT_LOG = "0";
process.env.PI_MULTI_ACCOUNT_LOG_FILE = join(mkdtempSync(join(tmpdir(), "pi-multi-account-endpoint-")), "extension.log");

import { AccountStore } from "@narumitw/pi-accounts/src/account-store.ts";
import type { AccountProviderAdapter } from "@narumitw/pi-accounts/src/oauth.ts";
import { InMemoryAccountStorageBackend } from "@narumitw/pi-accounts/src/storage.ts";
import { isEndpointTrouble } from "../src/errors.ts";
import {
	accountsNeedingRelogin,
	isCredentialSuspect,
	markCredentialSuspect,
	REFRESH_SKEW_MS,
	refreshAccountCredential,
	refreshFailureDetail,
	resetRefreshFailuresForTesting,
	resetSuspectCredentialsForTesting,
} from "../src/refresh.ts";

const MINUTE = 60 * 1000;

/** The classifier, on the shapes actually seen in the reporters' logs. */
const trouble = [
	"anthropic account refresh failed: TypeError: fetch failed; cause=Error: getaddrinfo ENOTFOUND platform.claude.com; code=ENOTFOUND; errno=-3007.",
	"anthropic account refresh failed: Error: HTTP request failed. status=403; body={ \"error\": { \"type\": \"forbidden\", \"message\": \"Request not allowed\" } }.",
	"HTTP request failed. status=429",
	"HTTP request failed. status=503",
	"fetch failed",
];
for (const detail of trouble) assert.equal(isEndpointTrouble(detail), true, `endpoint trouble: ${detail.slice(0, 40)}`);

const credentialTrouble = [
	"body={ \"error\": \"invalid_grant\", \"error_description\": \"Refresh token not found or invalid\" }",
	"HTTP request failed. status=401",
];
for (const detail of credentialTrouble) assert.equal(isEndpointTrouble(detail), false, `credential: ${detail.slice(0, 40)}`);

function adapterThatFailsWith(message: string): AccountProviderAdapter {
	return {
		id: "anthropic",
		displayName: "Anthropic",
		oauth: {
			refresh: async () => {
				throw new Error(message);
			},
		},
	} as unknown as AccountProviderAdapter;
}

/** A store holding one token that expires at `expires` (absolute). */
async function storeExpiringAt(expires: number): Promise<{ store: AccountStore; held: { access: string; refresh: string; expires: number } }> {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	const held = { access: "access-held", refresh: "refresh-held", expires };
	await store.updateProviderAsync("anthropic", async () => ({
		active: "personal",
		accounts: { personal: { type: "oauth" as const, ...held } },
	}));
	return { store, held };
}

/** A store holding one token that expires in `expiresInMs`. */
async function storeWith(expiresInMs: number): Promise<{ store: AccountStore; held: { access: string; refresh: string; expires: number } }> {
	return storeExpiringAt(Date.now() + expiresInMs);
}

const NETWORK = "anthropic account refresh failed: TypeError: fetch failed; cause=Error: getaddrinfo ENOTFOUND platform.claude.com";

// --- a token with life left survives the outage -----------------------------

resetRefreshFailuresForTesting();
resetSuspectCredentialsForTesting();
let { store } = await storeWith(REFRESH_SKEW_MS - MINUTE); // inside the skew: a refresh is due
let resolved = await refreshAccountCredential(store, adapterThatFailsWith(NETWORK), "personal", {
	type: "oauth",
	access: "access-held",
	refresh: "refresh-held",
	expires: Date.now() + REFRESH_SKEW_MS - MINUTE,
});
assert.equal(resolved.access, "access-held", "the still-valid token is served through the outage");
assert.equal(refreshFailureDetail("anthropic", "personal"), undefined, "an unreachable endpoint is not a re-login");
assert.deepEqual(accountsNeedingRelogin("anthropic", ["personal"]), [], "so the footer does not send the user to /accounts");

// A 403 from the endpoint is the same story: the token still works against the API.
resetRefreshFailuresForTesting();
({ store } = await storeWith(REFRESH_SKEW_MS - MINUTE));
resolved = await refreshAccountCredential(
	store,
	adapterThatFailsWith('HTTP request failed. status=403; body={ "error": { "type": "forbidden", "message": "Request not allowed" } }'),
	"personal",
	{ type: "oauth", access: "access-held", refresh: "refresh-held", expires: Date.now() + REFRESH_SKEW_MS - MINUTE },
);
assert.equal(resolved.access, "access-held");
assert.equal(refreshFailureDetail("anthropic", "personal"), undefined);

// A 5xx that answers with a bare OAuth code body still carries no verdict on the token.
resetRefreshFailuresForTesting();
({ store } = await storeWith(REFRESH_SKEW_MS - MINUTE));
resolved = await refreshAccountCredential(
	store,
	adapterThatFailsWith('HTTP request failed. status=500; body={"error":"server_error"}'),
	"personal",
	{ type: "oauth", access: "access-held", refresh: "refresh-held", expires: Date.now() + REFRESH_SKEW_MS - MINUTE },
);
assert.equal(resolved.access, "access-held");
assert.equal(refreshFailureDetail("anthropic", "personal"), undefined);

// --- an expired token still fails, so the caller can fail over --------------

resetRefreshFailuresForTesting();
({ store } = await storeWith(-MINUTE));
await assert.rejects(
	refreshAccountCredential(store, adapterThatFailsWith(NETWORK), "personal", {
		type: "oauth",
		access: "access-held",
		refresh: "refresh-held",
		expires: Date.now() - MINUTE,
	}),
	/ENOTFOUND/,
	"an expired token nobody could renew is a failure",
);
assert.match(refreshFailureDetail("anthropic", "personal") ?? "", /ENOTFOUND/, "and it is reported");

// The defer/throw boundary is on the caller's clock, not the wall clock: a token
// expiring exactly now has nothing left to serve.
resetRefreshFailuresForTesting();
let boundaryNow = Date.now();
({ store } = await storeExpiringAt(boundaryNow));
await assert.rejects(
	refreshAccountCredential(store, adapterThatFailsWith(NETWORK), "personal", {
		type: "oauth",
		access: "access-held",
		refresh: "refresh-held",
		expires: boundaryNow,
	}, boundaryNow),
	/ENOTFOUND/,
	"a token expiring exactly at `now` is already gone",
);

// Same, for a caller whose clock lags the wall clock: the token is expired on
// the caller's clock even though a few seconds remain by the wall clock.
resetRefreshFailuresForTesting();
boundaryNow = Date.now() - MINUTE;
({ store } = await storeExpiringAt(boundaryNow - 30_000));
await assert.rejects(
	refreshAccountCredential(store, adapterThatFailsWith(NETWORK), "personal", {
		type: "oauth",
		access: "access-held",
		refresh: "refresh-held",
		expires: boundaryNow - 30_000,
	}, boundaryNow),
	/ENOTFOUND/,
	"a token expired on the caller's clock is a failure",
);

// One millisecond past `now` is still life: it is deferred, not failed.
resetRefreshFailuresForTesting();
boundaryNow = Date.now() - MINUTE;
({ store } = await storeExpiringAt(boundaryNow + 1));
resolved = await refreshAccountCredential(
	store,
	adapterThatFailsWith(NETWORK),
	"personal",
	{ type: "oauth", access: "access-held", refresh: "refresh-held", expires: boundaryNow + 1 },
	boundaryNow,
);
assert.equal(resolved.access, "access-held", "a token with life on the caller's clock is deferred");
assert.equal(refreshFailureDetail("anthropic", "personal"), undefined);

// --- a real rejection is never masked by a live token -----------------------

resetRefreshFailuresForTesting();
resetSuspectCredentialsForTesting();
({ store } = await storeWith(REFRESH_SKEW_MS - MINUTE));
await assert.rejects(
	refreshAccountCredential(
		store,
		adapterThatFailsWith('body={ "error": "invalid_grant", "error_description": "Refresh token not found or invalid" }'),
		"personal",
		{ type: "oauth", access: "access-held", refresh: "refresh-held", expires: Date.now() + REFRESH_SKEW_MS - MINUTE },
	),
	/invalid_grant/,
	"a revoked refresh token must still ask for a re-login",
);
assert.deepEqual(accountsNeedingRelogin("anthropic", ["personal"]), ["personal"]);
assert.match(refreshFailureDetail("anthropic", "personal") ?? "", /invalid_grant/);

// A token the provider already rejected (suspect, so a forced refresh) that also
// cannot be renewed keeps its mark: the sweep clears it before the attempt, so a
// silent deferral would let the next request trust the dead token again.
resetRefreshFailuresForTesting();
resetSuspectCredentialsForTesting();
({ store } = await storeWith(REFRESH_SKEW_MS - MINUTE));
markCredentialSuspect("anthropic", "personal", "provider answered 401");
resolved = await refreshAccountCredential(
	store,
	adapterThatFailsWith(NETWORK),
	"personal",
	{ type: "oauth", access: "access-held", refresh: "refresh-held", expires: Date.now() + REFRESH_SKEW_MS - MINUTE },
	Date.now(),
	{ force: true },
);
assert.equal(resolved.access, "access-held", "a forced refresh is deferred, not fatal");
assert.equal(isCredentialSuspect("anthropic", "personal"), true, "and the rejection stays on record");
assert.equal(refreshFailureDetail("anthropic", "personal"), undefined, "while it is still not a re-login");

// A successful refresh clears it as before, so the mark cannot outlive the outage.
resetSuspectCredentialsForTesting();
assert.equal(isCredentialSuspect("anthropic", "personal"), false);
console.log("refresh-endpoint-trouble.test.ts ok");
