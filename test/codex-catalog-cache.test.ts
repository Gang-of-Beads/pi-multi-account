/** Legacy window caches remain readable; the new shared cache also retains newly discovered IDs. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const agentDir = mkdtempSync(join(tmpdir(), "pi-multi-account-codex-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_MULTI_ACCOUNT_LOG = "0";
process.env.PI_OFFLINE = "1";
delete process.env.CODEX_CLIENT_VERSION_MIN;
const {
	CODEX_CLIENT_VERSION,
	CODEX_VERSION_MIN_ENV,
	catalogCacheFile,
	codexClientVersion,
	readCachedCatalogs,
	resetCodexVersionCache,
	writeCachedCatalogs,
} = await import("../src/codex-catalog.ts");
const { registerCodexAliasProviders } = await import("../src/codex-aliases.ts");
const { ModelCatalog } = await import("../src/core/catalog.ts");
function token(accountId: string): string {
	return `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.signature`;
}
{
	const file = join(agentDir, "cache-a.json");
	assert.equal(readCachedCatalogs(file).size, 0);
	writeFileSync(file, "{ not json");
	assert.equal(readCachedCatalogs(file).size, 0);
	writeFileSync(
		file,
		JSON.stringify({ accounts: { good: { windows: { "gpt-6.1-sol": 872000, bad: -1, worse: "x" } }, empty: { windows: { bad: 0 } } } }),
	);
	assert.deepEqual([...readCachedCatalogs(file).get("good")!.windows], [["gpt-6.1-sol", 872000]]);
	await writeCachedCatalogs(new Map([["other", { accountId: "other", windows: new Map([["gpt-6-sol", 872000]]) }]]), file);
	assert.deepEqual([...readCachedCatalogs(file).keys()].sort(), ["good", "other"]);
	await writeCachedCatalogs(new Map(), file);
	assert.equal(readCachedCatalogs(file).size, 2);
	assert.equal(readdirSync(agentDir).filter((name) => name.endsWith(".tmp")).length, 0);
}
{
	const fakeBin = mkdtempSync(join(tmpdir(), "codex-bin-"));
	const savedPath = process.env.PATH;
	process.env.PATH = fakeBin;
	resetCodexVersionCache();
	assert.equal(codexClientVersion(), CODEX_CLIENT_VERSION);
	process.env[CODEX_VERSION_MIN_ENV] = "0.999.0";
	assert.equal(codexClientVersion(), "0.999.0");
	process.env[CODEX_VERSION_MIN_ENV] = "0.163";
	assert.equal(codexClientVersion(), CODEX_CLIENT_VERSION);
	delete process.env[CODEX_VERSION_MIN_ENV];
	writeFileSync(join(fakeBin, "codex"), "#!/bin/sh\necho 'codex-cli 0.999.1'\n", { mode: 0o755 });
	resetCodexVersionCache();
	assert.equal(codexClientVersion(), "0.999.1");
	process.env.PATH = savedPath;
	resetCodexVersionCache();
}
{
	const hour = 3_600_000;
	const accounts = {
		cached: { type: "oauth", access: token("acct-cached"), refresh: "r1", expires: Date.now() + hour },
		fresh: { type: "oauth", access: token("acct-fresh"), refresh: "r2", expires: Date.now() + hour },
		expiring: { type: "oauth", access: token("acct-expiring"), refresh: "r3", expires: Date.now() + 60_000 },
	};
	writeFileSync(
		join(agentDir, "pi-accounts.json"),
		JSON.stringify({ version: 1, providers: { "openai-codex": { active: "cached", accounts } } }),
	);
	await writeCachedCatalogs(
		new Map([["acct-cached", { accountId: "acct-cached", windows: new Map([["gpt-6.1-sol", 872000]]) }]]),
		catalogCacheFile(),
	);
	delete process.env.PI_OFFLINE;
	const catalog = new ModelCatalog(agentDir, (async () =>
		Response.json({ models: [{ slug: "gpt-6.2-sol", context_window: 272000, max_context_window: 872000 }] })) as typeof fetch);
	await catalog.discover("openai-codex", "fresh:acct-fresh", {}, [], { signal: AbortSignal.timeout(2000) });
	process.env.PI_OFFLINE = "1";
	const registered = new Map<string, { getModels: () => { id: string; contextWindow: number }[] }>();
	const registry = registerCodexAliasProviders({
		registerProvider: (p: { id: string; getModels: () => { id: string; contextWindow: number }[] }) => registered.set(p.id, p),
		unregisterProvider: (id: string) => registered.delete(id),
	} as never);
	const legacyCatalogBefore = readFileSync(catalogCacheFile());
	const accountsBefore = readFileSync(join(agentDir, "pi-accounts.json"));
	await registry.bootstrap();
	assert.deepEqual(readFileSync(catalogCacheFile()), legacyCatalogBefore, "bootstrap preserves legacy catalog bytes");
	assert.deepEqual(readFileSync(join(agentDir, "pi-accounts.json")), accountsBefore, "bootstrap preserves account file bytes");
	const windowOf = (id: string, model = "gpt-6.1-sol") =>
		registered
			.get(id)
			?.getModels()
			.find((m) => m.id === model)?.contextWindow;
	assert.equal(windowOf("codex-cached"), 872000, "the old cache remains usable without migration or account writes");
	assert.equal(windowOf("codex-fresh", "gpt-6.2-sol"), 872000, "new IDs survive offline bootstrap");
	assert.notEqual(windowOf("codex-expiring"), 872000);
	assert.ok(existsSync(catalogCacheFile()));
	const original = globalThis.fetch;
	const requests: string[] = [];
	globalThis.fetch = (async (url) => {
		requests.push(String(url));
		throw new Error("network down");
	}) as typeof fetch;
	await registry.sync({ modelRegistry: { getRegisteredProviderIds: () => [...registered.keys()] } } as never);
	assert.equal(requests.length, 0, "an offline sync neither fetches models nor rotates a token");
	delete process.env.PI_OFFLINE;
	const { expiring: _expiring, ...live } = accounts;
	writeFileSync(
		join(agentDir, "pi-accounts.json"),
		JSON.stringify({ version: 1, providers: { "openai-codex": { active: "cached", accounts: live } } }),
	);
	// The core captures fetch when constructed; replace it in this test with an explicit failure.
	const { PmaEngine } = await import("../src/core/engine.ts");
	const failing = new PmaEngine(agentDir, { fetch: globalThis.fetch });
	await failing.initialize({ network: false });
	const failures = await failing.refresh({ force: true });
	assert.equal(requests.filter((u) => u.includes("/oauth/token")).length, 0);
	assert.equal(failures.errors.filter((e) => e.startsWith("codex-")).length, 2);
	assert.equal(failing.models.getModel("codex-cached", "gpt-6.1-sol")?.contextWindow, 872000);
	assert.equal(failing.models.getModel("codex-fresh", "gpt-6.2-sol")?.contextWindow, 872000);
	globalThis.fetch = original;
	await registry.stop();
}
console.log("codex-catalog-cache: ok");
