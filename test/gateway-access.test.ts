import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCallerKey, revokeCallerKey, authenticate, GatewayUsage, keysPath, permits } from "../src/gateway/access.ts";
const dir = mkdtempSync(join(tmpdir(), "pma-access-v1-"));
const { key, secret } = await createCallerKey(dir, "client", { routes: ["daily"], maxConcurrent: 1, dailyTokens: 1000, rpm: 3 });
const request = (headers: object) => ({ headers }) as never;
assert.equal(statSync(keysPath(dir)).mode & 0o777, 0o600);
assert.ok(!readFileSync(keysPath(dir), "utf8").includes(secret));
assert.equal(authenticate(dir, request({ authorization: `Bearer ${secret}` })).id, key.id);
assert.equal(authenticate(dir, request({ "x-api-key": secret })).id, key.id);
assert.equal(permits(key, "daily"), true);
assert.equal(permits(key, "other"), false);
for (const headers of [
	{},
	{ authorization: `Bearer ${secret.slice(0, -1)}X` },
	{ authorization: `Basic ${secret}` },
	{ authorization: `Bearer ${secret}`, "x-api-key": "different" },
	{ "x-api-key": [secret, secret] },
])
	assert.throws(
		() => authenticate(dir, request(headers)),
		(e: unknown) => (e as { status: number }).status === 401,
	);
{
	const usage = new GatewayUsage(dir);
	await usage.restore();
	const release = usage.reserve(key, 600);
	assert.throws(() => usage.reserve(key, 600), /Concurrent/);
	release({ route: "daily", input: 100, output: 50, tokens: 150, status: 200, ms: 1 });
	release({ route: "daily", input: 100, output: 50, tokens: 150, status: 200, ms: 1 });
	const stats = usage.stats() as { keys: { tokens: number; inFlight: number; reserved: number }[] };
	assert.equal(stats.keys[0].tokens, 150, "a release is idempotent");
	assert.equal(stats.keys[0].inFlight, 0);
	assert.equal(stats.keys[0].reserved, 0);
	assert.throws(() => usage.reserve(key, 900), /Daily token/);
	const second = usage.reserve(key, 100);
	second({ route: "daily", input: 0, output: 0, tokens: 0, status: 499, ms: 1 });
	const third = usage.reserve(key, 100);
	third({ route: "daily", input: 0, output: 0, tokens: 0, status: 400, ms: 1 });
	assert.throws(() => usage.reserve(key, 1), /rate limit/);
	usage.close();
	const restored = new GatewayUsage(dir);
	await restored.restore();
	assert.equal((restored.stats() as { keys: { tokens: number }[] }).keys[0].tokens, 150, "daily accounting survives restart");
	assert.throws(() => restored.reserve(key, 1), /rate limit/, "RPM accounting also survives restart");
	restored.close();
	const ledger = readFileSync(join(dir, "pi-multi-account-usage.jsonl"), "utf8");
	assert.equal(ledger.trim().split("\n").length, 3);
	assert.ok(!ledger.includes(secret));
}
{
	await revokeCallerKey(dir, key.id);
	assert.throws(() => authenticate(dir, request({ authorization: `Bearer ${secret}` })), /Invalid/);
	const expired = await createCallerKey(dir, "expired", { expires: Date.now() - 1000 });
	assert.throws(() => authenticate(dir, request({ "x-api-key": expired.secret })), /expired/);
	writeFileSync(keysPath(dir), "corrupt");
	await assert.rejects(createCallerKey(dir, "must-not-overwrite"));
	assert.equal(readFileSync(keysPath(dir), "utf8"), "corrupt");
}
{
	const other = mkdtempSync(join(tmpdir(), "pma-symlink-"));
	const target = join(other, "target");
	writeFileSync(target, '{"version":1,"keys":[]}');
	symlinkSync(target, keysPath(other));
	await assert.rejects(createCallerKey(other, "must-not-follow"));
	assert.equal(readFileSync(target, "utf8"), '{"version":1,"keys":[]}');
}
{
	const validDir = mkdtempSync(join(tmpdir(), "pma-invalid-limit-"));
	await createCallerKey(validDir, "valid");
	await assert.rejects(createCallerKey(validDir, "bad", { dailyTokens: -1 }), /^Error: Invalid key limit: dailyTokens$/);
}
console.log("ok: gateway access (hashes, scopes, expiry, revocation, private files, admission limits, restart)");
