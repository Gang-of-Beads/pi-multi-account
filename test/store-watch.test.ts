process.env.PI_MULTI_ACCOUNT_LOG = "0";

import assert from "node:assert/strict";
import { describeChange, diffSnapshots, drainForeignChanges, formatForeignChange, snapshotProviderState, StoreObserver, summarizeForeignChanges } from "../src/store-watch.ts";

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
observer.expectSelfChange("refresh personal");
assert.deepEqual(
	observer.observe({ ...stateA, active: "personal", accounts: { ...stateA.accounts, personal: credential("k") } }, "test"),
	[],
	"the announced token is ours, not a foreign writer's",
);
assert.deepEqual(drainForeignChanges(), []);

// The announcement is consumed by the very next read even when that read shows no
// difference (a write that lost the store lock, a token that came back unchanged):
// left armed it would swallow the *next* foreign change instead.
observer.expectSelfChange("refresh personal");
assert.deepEqual(
	observer.observe({ ...stateA, active: "personal", accounts: { ...stateA.accounts, personal: credential("k") } }, "test"),
	[],
	"a read with no difference still consumes the announcement",
);
const leaked = observer.observe(
	{ ...stateA, active: "work", accounts: { ...stateA.accounts, personal: credential("z") } },
	"test",
);
assert.deepEqual(
	leaked.map((c) => c.kind).sort(),
	["active_account", "token_rotated"],
	"a stale announcement no longer swallows the next foreign change",
);
assert.equal(drainForeignChanges().length, 2);

// Only the announced account is self: an unrelated rotation in the same read is
// still reported rather than dropped along with it.
observer.expectSelfChange("refresh merchant");
const mixed = observer.observe(
	{ ...stateA, active: "work", accounts: { merchant: credential("e"), personal: credential("y") } },
	"test",
);
assert.deepEqual(mixed.map((c) => c.account ?? c.kind), ["personal"], "only the announced account is treated as self");
assert.deepEqual(drainForeignChanges().map((c) => c.account ?? c.kind), ["personal"]);

assert.equal(
	describeChange({ kind: "active_account", from: "merchant", to: "personal" }),
	"active account changed merchant → personal",
);

// The description stays the plain fact, with no cause appended by anyone: when it
// carried "(by another process)" and the caller added the same phrase, the row
// read "was rotated by another process (by another process)".
assert.equal(
	describeChange({ kind: "token_rotated", account: "personal" }),
	'token for "personal" was rotated',
);

// ...and the notice the caller builds adds only the prefix and the log path, so the
// phrase appears once — or, now, not at all.
assert.equal(
	formatForeignChange({ text: 'token for "personal" was rotated' }, "/tmp/x.log"),
	'Anthropic accounts: token for "personal" was rotated. See /tmp/x.log.',
);

// One sweep after a rotation finds the same thing for every account at once.
// Reporting per change put three identical rows in the transcript, which read as
// one error reported three times.
assert.deepEqual(summarizeForeignChanges([
	{ kind: "token_rotated", account: "personal" },
	{ kind: "token_rotated", account: "merchant" },
	{ kind: "token_rotated", account: "work" },
]), [
	{ text: 'tokens for "personal", "merchant" and "work" were rotated', level: "info" },
]);

assert.deepEqual(summarizeForeignChanges([{ kind: "token_rotated", account: "personal" }]), [
	{ text: 'token for "personal" was rotated', level: "info" },
]);

// An active account change keeps its own line and its warning level; it decides
// which account the next request bills to.
assert.deepEqual(summarizeForeignChanges([
	{ kind: "token_rotated", account: "personal" },
	{ kind: "active_account", from: "personal", to: "work" },
	{ kind: "token_rotated", account: "work" },
]), [
	{ text: 'token for "personal" was rotated', level: "info" },
	{ text: "active account changed personal → work", level: "warning" },
	{ text: 'token for "work" was rotated', level: "info" },
]);

assert.deepEqual(summarizeForeignChanges([
	{ kind: "account_added", account: "a" },
	{ kind: "account_added", account: "b" },
	{ kind: "account_removed", account: "c" },
]), [
	{ text: 'accounts "a" and "b" were added', level: "info" },
	{ text: 'account "c" was removed', level: "info" },
]);

assert.deepEqual(summarizeForeignChanges([]), []);

console.log("ok: store watch");
