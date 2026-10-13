/**
 * The Codex catalog cache and what a load may do with it.
 *
 * PI WEB's session daemon freezes providers after load, so the codex aliases must register their
 * real windows at load, from a cache. A load must never refresh a token: a refresh rotates the
 * shared refresh token, which only the locked background sweep may do. Everything here runs in a
 * temporary agent dir with a fake fetch; nothing touches the network or the real account store.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "pi-multi-account-codex-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_OFFLINE;
delete process.env.CODEX_CLIENT_VERSION_MIN;

const catalogModule = await import("../src/codex-catalog.ts");
const { CODEX_CLIENT_VERSION, CODEX_VERSION_MIN_ENV, catalogCacheFile, codexClientVersion, readCachedCatalogs, resetCodexVersionCache, writeCachedCatalogs } = catalogModule;
const { registerCodexAliasProviders } = await import("../src/codex-aliases.ts");

function token(accountId: string): string {
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url");
	return `header.${payload}.signature`;
}

// The cache: missing, corrupt and junk entries read as "no catalog", never as junk windows.
{
	const file = join(agentDir, "cache-a.json");
	assert.equal(readCachedCatalogs(file).size, 0, "a missing cache is empty");
	writeFileSync(file, "{ not json");
	assert.equal(readCachedCatalogs(file).size, 0, "a corrupt cache is empty");
	writeFileSync(file, JSON.stringify({ accounts: { good: { windows: { "gpt-6.1-sol": 872000, bad: -1, worse: "x" } }, empty: { windows: { bad: 0 } } } }));
	const read = readCachedCatalogs(file);
	assert.deepEqual([...read.keys()], ["good"], "an account with no usable window is dropped");
	assert.deepEqual([...read.get("good")!.windows], [["gpt-6.1-sol", 872000]], "only positive integer windows survive");

	await writeCachedCatalogs(new Map([["other", { accountId: "other", windows: new Map([["gpt-6-sol", 872000]]) }]]), file);
	assert.deepEqual([...readCachedCatalogs(file).keys()].sort(), ["good", "other"], "a write merges into the cache");
	await writeCachedCatalogs(new Map(), file);
	assert.equal(readCachedCatalogs(file).size, 2, "an empty write leaves the cache alone");
	assert.equal(readdirSync(agentDir).filter((name) => name.endsWith(".tmp")).length, 0, "no temp file is left behind");
}

// The claimed Codex version: every source is a floor and the highest one wins.
{
	const fakeBin = mkdtempSync(join(tmpdir(), "codex-bin-"));
	const savedPath = process.env.PATH;
	process.env.PATH = fakeBin;
	resetCodexVersionCache();
	assert.equal(codexClientVersion(), CODEX_CLIENT_VERSION, "without a local codex the pin is the claim");
	process.env[CODEX_VERSION_MIN_ENV] = "0.170.0";
	assert.equal(codexClientVersion(), "0.170.0", "a higher env floor raises the claim");
	process.env[CODEX_VERSION_MIN_ENV] = "0.163";
	assert.equal(codexClientVersion(), CODEX_CLIENT_VERSION, "a malformed env floor is ignored");
	delete process.env[CODEX_VERSION_MIN_ENV];
	writeFileSync(join(fakeBin, "codex"), "#!/bin/sh\necho 'codex-cli 0.199.0'\n", { mode: 0o755 });
	resetCodexVersionCache();
	assert.equal(codexClientVersion(), "0.199.0", "a newer local codex raises the claim");
	process.env.PATH = savedPath;
	resetCodexVersionCache();
}

// A load: cached accounts register their windows, an uncached one is fetched once, and an
// account whose token is about to expire is neither refreshed nor fetched.
{
	const hour = 60 * 60 * 1000;
	writeFileSync(
		join(agentDir, "pi-accounts.json"),
		JSON.stringify({
			providers: {
				"openai-codex": {
					active: "cached",
					accounts: {
						cached: { type: "oauth", access: token("acct-cached"), refresh: "r1", expires: Date.now() + hour },
						fresh: { type: "oauth", access: token("acct-fresh"), refresh: "r2", expires: Date.now() + hour },
						expiring: { type: "oauth", access: token("acct-expiring"), refresh: "r3", expires: Date.now() + 60_000 },
					},
				},
			},
		}),
	);
	await writeCachedCatalogs(new Map([["acct-cached", { accountId: "acct-cached", windows: new Map([["gpt-6.1-sol", 872000]]) }]]), catalogCacheFile());

	const requests: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request) => {
		requests.push(String(input));
		return new Response(JSON.stringify({ models: [{ slug: "gpt-6.1-sol", context_window: 500000, max_context_window: 872000 }] }), { status: 200 });
	}) as typeof fetch;

	const registered = new Map<string, { getModels: () => Array<{ id: string; contextWindow: number }> }>();
	const pi = {
		registerProvider: (provider: { id: string; getModels: () => Array<{ id: string; contextWindow: number }> }) => registered.set(provider.id, provider),
		unregisterProvider: (id: string) => registered.delete(id),
		registerCommand: () => undefined,
	};
	await registerCodexAliasProviders(pi as never).bootstrap();
	globalThis.fetch = realFetch;

	const windowOf = (id: string) => registered.get(id)?.getModels().find((model) => model.id === "gpt-6.1-sol")?.contextWindow;
	assert.equal(requests.filter((url) => url.includes("/oauth/token")).length, 0, "a load never refreshes a token");
	assert.equal(requests.filter((url) => url.includes("/codex/models")).length, 1, "only the uncached account with a live token is fetched");
	assert.equal(windowOf("codex-cached"), 872000, "a cached account registers its cached window");
	assert.equal(windowOf("codex-fresh"), 872000, "a fetched account registers its fetched window");
	assert.notEqual(windowOf("codex-expiring"), 872000, "an expiring account keeps the base window until a later sync");
	assert.ok(readCachedCatalogs(catalogCacheFile()).has("acct-fresh"), "the fetched catalog is cached for the next load");
	assert.ok(existsSync(catalogCacheFile()));
}

console.log("codex-catalog-cache: ok");
