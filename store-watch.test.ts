process.env.PI_MULTI_ACCOUNT_LOG = "0";

import assert from "node:assert/strict";
import { describeChange, diffSnapshots, drainForeignChanges, snapshotProviderState, StoreObserver } from "./store-watch.ts";

const credential = (access: string, refresh = `${access}-r`) => ({ access, refresh, expires: 1 });

const stateA = { active: "merchant", accounts: { merchant: credential("a"), personal: credential("b") } };

// A snapshot carries fingerprints, never the secrets themselves.
const snapshot = snapshotProviderState(stateA);
assert.equal(snapshot.active, "merchant");
assert.equal(Object.keys(snapshot.access).length, 2);
assert.ok(!JSON.stringify(snapshot).includes("\"a\""));

// Switching the active account is reported with both ends of the move.
assert.deepEqual(
	diffSnapshots(snapshot, snapshotProviderState({ ...stateA, active: "personal" })),
	[{ kind: "active_account", from: "merchant", to: "personal" }],
);

// A token that changed without this process refreshing it is the signature of a
// second writer, and must be reported per account.
const rotated = diffSnapshots(
	snapshot,
	snapshotProviderState({ active: "merchant", accounts: { merchant: credential("a"), personal: credential("c") } }),
);
assert.equal(rotated.length, 1);
assert.equal(rotated[0].kind, "token_rotated");
assert.equal(rotated[0].account, "personal");

// Added and removed accounts are distinguishable from rotations.
assert.deepEqual(
	diffSnapshots(snapshot, snapshotProviderState({ active: "merchant", accounts: { merchant: credential("a") } })),
	[{ kind: "account_removed", account: "personal" }],
);
assert.deepEqual(
	diffSnapshots(
		snapshot,
		snapshotProviderState({ active: "merchant", accounts: { ...stateA.accounts, work: credential("d") } }),
	),
	[{ kind: "account_added", account: "work" }],
);

// The observer reports a change nobody in this process asked for...
const observer = new StoreObserver("anthropic");
assert.deepEqual(observer.observe(stateA, "test"), [], "first read is a baseline, not a change");
const foreign = observer.observe({ ...stateA, active: "personal" }, "test");
assert.equal(foreign.length, 1);
assert.equal(foreign[0].kind, "active_account");
assert.equal(drainForeignChanges().length, 1, "foreign changes are queued for the next session event");
assert.equal(drainForeignChanges().length, 0, "draining is destructive");

// ...and stays quiet about the writes this process announced.
observer.expectSelfChange("switch account");
assert.deepEqual(observer.observe({ ...stateA, active: "work" }, "test"), []);
assert.deepEqual(drainForeignChanges(), []);

assert.equal(
	describeChange({ kind: "active_account", from: "merchant", to: "personal" }),
	"active account changed merchant → personal",
);

console.log("ok: store watch");
