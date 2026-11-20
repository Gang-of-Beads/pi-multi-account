import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalog, parseModels, catalogKey, fetchJson, CODEX_FLOOR, clientVersion } from "../src/core/catalog.ts";
import type { Model, Api } from "@earendil-works/pi-ai";
process.env.PI_MULTI_ACCOUNT_LOG = "0";
const dir = () => mkdtempSync(join(tmpdir(), "pma-catalog-v1-"));
const baseline: Model<Api>[] = [
	{
		id: "old",
		name: "Old",
		provider: "openai-codex",
		api: "openai-codex-responses",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		contextWindow: 272000,
		maxTokens: 8192,
		cost: { input: 4, output: 20, cacheRead: 1, cacheWrite: 0 },
		compat: { supportsTemperature: false },
	},
];
const body = {
	models: [
		{
			slug: "gpt-6.2-sol",
			display_name: "GPT 6.2 Sol",
			max_context_window: 872000,
			context_window: 272000,
			supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "xhigh" }],
			input_modalities: ["text", "image"],
		},
		{ slug: "hidden", visibility: "hide" },
		{ slug: "gpt-6.2-sol" },
		{ slug: "bad\nname" },
		null,
	],
};
{
	const parsed = parseModels("openai-codex", body, baseline);
	assert.deepEqual(
		parsed.map((m) => m.id),
		["gpt-6.2-sol"],
	);
	assert.equal(parsed[0].contextWindow, 872000);
	assert.equal(parsed[0].api, "openai-codex-responses");
	assert.deepEqual(parsed[0].input, ["text", "image"]);
	assert.equal(parsed[0].thinkingLevelMap?.xhigh, "xhigh");
	assert.equal(parsed[0].thinkingLevelMap?.medium, null);
	assert.equal(parsed[0].cost.input, 0, "unknown prices are not copied from a sibling");
	assert.equal(parsed[0].compat, undefined, "new models never inherit unverified protocol flags");
	const enriched = parseModels("openai-codex", body, [], {
		"gpt-6.2-sol": { cost: { input: 2, output: 12 }, limit: { context: 1000000, output: 128000 } },
	});
	assert.equal(enriched[0].cost.input, 2);
	assert.equal(enriched[0].maxTokens, 128000);
	assert.equal(enriched[0].contextWindow, 872000, "the vendor's account-specific limit wins over models.dev");
	assert.throws(() => parseModels("xai", {}, []), /no list/);
	assert.deepEqual(parseModels("xai", { data: [{ id: "text-embedding-3" }, { id: "abc", capabilities: { type: "embeddings" } }] }, []), []);
}
{
	delete process.env.PI_OFFLINE;
	let calls = 0;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const mock = (async (url, init) => {
		calls++;
		assert.equal(init?.redirect, "error");
		assert.match(String(url), /client_version=\d+\.\d+\.\d+/);
		assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-token");
		await gate;
		return Response.json(body);
	}) as typeof fetch;
	const path = dir();
	const catalog = new ModelCatalog(path, mock);
	const one = catalog.discover("openai-codex", "account-one", { apiKey: "fixture-token" }, baseline, { signal: AbortSignal.timeout(2000) });
	const two = catalog.discover("openai-codex", "account-one", { apiKey: "fixture-token" }, baseline, { signal: AbortSignal.timeout(2000) });
	release();
	const entries = await Promise.all([one, two]);
	assert.equal(calls, 1, "concurrent discovery of one account shares one request");
	assert.equal(entries[0], entries[1]);
	assert.ok(!readFileSync(catalog.path, "utf8").includes("fixture-token"), "cache never persists a credential");
	assert.ok(!readFileSync(catalog.path, "utf8").includes("account-one"), "cache keys contain hashes, not private account identities");
	const cached = new ModelCatalog(path, (async () => {
		throw new Error("network must not be used for a fresh cache");
	}) as typeof fetch);
	assert.equal(
		(await cached.discover("openai-codex", "account-one", {}, [], { signal: AbortSignal.timeout(2000) })).models[0].id,
		"gpt-6.2-sol",
	);
	await assert.rejects(
		cached.discover("openai-codex", "account-one", {}, [], { signal: AbortSignal.timeout(2000), force: true }),
		/network/,
	);
	assert.equal(
		cached.get(catalogKey("openai-codex", "account-one"))?.models[0].id,
		"gpt-6.2-sol",
		"a failed refresh never clears the last good list",
	);
	process.env.PI_OFFLINE = "1";
	assert.equal(
		(await cached.discover("openai-codex", "account-one", {}, [], { signal: AbortSignal.timeout(2000), force: true })).models.length,
		1,
	);
	assert.deepEqual(
		(await cached.discover("openai-codex", "new-identity", {}, baseline, { signal: AbortSignal.timeout(2000) })).models.map((m) => m.id),
		["old"],
		"an unrelated account cannot inherit another account's entitlements",
	);
	delete process.env.PI_OFFLINE;
}
{
	const path = dir();
	const mock = (async () => Response.json(body)) as typeof fetch;
	await Promise.all([
		new ModelCatalog(path, mock).discover("openai-codex", "one", {}, [], { signal: AbortSignal.timeout(2000) }),
		new ModelCatalog(path, mock).discover("openai-codex", "two", {}, [], { signal: AbortSignal.timeout(2000) }),
	]);
	const saved = new ModelCatalog(path);
	assert.ok(saved.get(catalogKey("openai-codex", "one")));
	assert.ok(saved.get(catalogKey("openai-codex", "two")), "cross-instance cache writes merge instead of losing an account");
}
{
	const path = dir();
	writeFileSync(
		join(path, "pi-multi-account-catalog.json"),
		JSON.stringify({
			version: 1,
			entries: {},
			metadata: {
				at: Date.now(),
				data: { anthropic: { models: { "claude-vendor": { limit: { context: 200000 } }, "claude-metadata-only": {} } } },
			},
		}),
	);
	let fail = false;
	const mock = (async (url) => {
		assert.equal(String(url), "https://api.anthropic.com/v1/models?limit=1000");
		return fail ? new Response("rate limited", { status: 429 }) : Response.json({ data: [{ id: "claude-vendor" }] });
	}) as typeof fetch;
	const catalog = new ModelCatalog(path, mock);
	const key = catalogKey("anthropic", "account-one");
	const entry = await catalog.discover("anthropic", "account-one", {}, [], { signal: AbortSignal.timeout(2000) });
	assert.deepEqual(
		entry.models.map((m) => m.id),
		["claude-vendor"],
	);
	assert.equal(entry.models[0].contextWindow, 200000, "public metadata still enriches vendor-confirmed models");
	const before = readFileSync(catalog.path);
	fail = true;
	await assert.rejects(
		catalog.discover("anthropic", "account-one", {}, [], { signal: AbortSignal.timeout(2000), force: true }),
		/Catalog request failed \(429\)/,
	);
	const cached = new ModelCatalog(path, mock);
	assert.deepEqual(
		cached.get(key)?.models.map((m) => m.id),
		["claude-vendor"],
		"metadata-only IDs never enter the account cache",
	);
	assert.equal(cached.get(key)?.at, entry.at, "a failed refresh preserves the last successful discovery timestamp");
	await assert.rejects(
		cached.discover("anthropic", "first-failure", {}, [], { signal: AbortSignal.timeout(2000) }),
		/Catalog request failed \(429\)/,
	);
	assert.equal(cached.get(catalogKey("anthropic", "first-failure")), undefined, "first failed discovery creates no account entry");
	assert.deepEqual(readFileSync(catalog.path), before, "failed discoveries leave the persisted vendor snapshot unchanged");
}
{
	let cancelled = false;
	const oversized = new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(Buffer.alloc(128));
			},
			cancel() {
				cancelled = true;
			},
		}),
	);
	await assert.rejects(fetchJson("https://example.test/models", {}, (async () => oversized) as typeof fetch, 32), /too large/);
	assert.equal(cancelled, true);
	await assert.rejects(fetchJson("https://example.test/models", {}, (async () => new Response("not json")) as typeof fetch), SyntaxError);
	await assert.rejects(
		fetchJson("https://example.test/models", {}, (async () => new Response("denied", { status: 403 })) as typeof fetch),
		/403/,
	);
}
{
	let version = "0.777.0";
	let calls = 0;
	const catalog = new ModelCatalog(dir(), (async (url) => {
		calls++;
		return String(url).includes("registry.npmjs.org")
			? Response.json({ version })
			: String(url).includes("grok-build")
				? new Response("1.0.13")
				: Response.json({ openai: { models: { foo: { name: "Foo", reasoning: true } } } });
	}) as typeof fetch);
	await catalog.refreshPublic(AbortSignal.timeout(2000));
	assert.equal(clientVersion("openai-codex"), "0.777.0");
	assert.equal((catalog.metadata("openai-codex").foo as { name: string }).name, "Foo");
	assert.ok(CODEX_FLOOR.startsWith("0."));
	const before = calls;
	version = "0.888.0";
	await catalog.refreshPublic(AbortSignal.timeout(2000));
	assert.equal(calls, before, "fresh public metadata is neither fetched nor rewritten");
	await catalog.refreshPublic(AbortSignal.timeout(2000), true);
	assert.ok(calls > before);
	assert.equal(clientVersion("openai-codex"), "0.888.0", "an explicit refresh bypasses version TTLs without a plugin release");
}
console.log("ok: shared catalogs (discovery, metadata, account isolation, concurrency, offline, bounds)");
