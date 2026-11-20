import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.PI_MULTI_ACCOUNT_LOG = "0";
const dir = mkdtempSync(join(tmpdir(), "pma-safety-v1-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_MULTI_ACCOUNT_POOLS_FILE = join(dir, "pools.json");
const { ModelCatalog, catalogKey, parseModels } = await import("../src/core/catalog.ts");
const { upsertPool, addAccountToPool, deletePool, poolsFilePath } = await import("../src/pools-store.ts");
const { GatewayUsage } = await import("../src/gateway/access.ts");
const { readRoutes, saveRoute, RouteRouter } = await import("../src/core/routes.ts");
const { PmaEngine } = await import("../src/core/engine.ts");
{
	writeFileSync(poolsFilePath(), "{ broken");
	assert.throws(() => upsertPool({ name: "daily", accounts: "all" }), /refusing/);
	assert.throws(() => addAccountToPool("daily", "work"), /refusing/);
	assert.throws(() => deletePool("daily"), /refusing/);
	assert.equal(readFileSync(poolsFilePath(), "utf8"), "{ broken", "all pool mutations preserve a corrupt file for repair");
	const path = join(dir, "pi-multi-account-routes.json");
	writeFileSync(path, "{ broken");
	assert.throws(() => readRoutes(dir));
	await assert.rejects(saveRoute(dir, { id: "daily", mode: "order", targets: [{ provider: "xai", model: "grok" }] }));
	assert.equal(readFileSync(path, "utf8"), "{ broken");
}
{
	const data = mkdtempSync(join(tmpdir(), "pma-cache-recovery-"));
	const path = join(data, "pi-multi-account-catalog.json");
	writeFileSync(path, "broken cache");
	const catalog = new ModelCatalog(data, (async () => Response.json({ models: [{ slug: "new" }] })) as typeof fetch);
	await catalog.discover("openai-codex", "one", { apiKey: "fixture-secret" }, [], { signal: AbortSignal.timeout(2000) });
	assert.equal(
		new ModelCatalog(data).get(catalogKey("openai-codex", "one"))?.models[0].id,
		"new",
		"only a disposable cache is recoverable by overwriting invalid JSON",
	);
	const watching = new ModelCatalog(data);
	await catalog.discover("openai-codex", "two", {}, [], { signal: AbortSignal.timeout(2000) });
	assert.equal(
		watching.get(catalogKey("openai-codex", "two"))?.models[0].id,
		"new",
		"a retained provider sees another instance's published snapshot",
	);
}
{
	const data = mkdtempSync(join(tmpdir(), "pma-ledger-corruption-"));
	const path = join(data, "pi-multi-account-usage.jsonl");
	for (const contents of ["{ interrupted", "bad\n", "{}\n"]) {
		writeFileSync(path, contents);
		const usage = new GatewayUsage(data);
		try {
			await assert.rejects(usage.restore(), /ledger/i);
		} finally {
			usage.close();
		}
		assert.equal(readFileSync(path, "utf8"), contents, "corruption is never treated as zero historical usage");
	}
}
{
	const engine = new PmaEngine(mkdtempSync(join(tmpdir(), "pma-deleted-route-")), { providers: [] });
	await engine.initialize({ network: false });
	const message = await new RouteRouter(engine).stream(undefined, { messages: [] }).result();
	assert.equal(message.stopReason, "error");
}
{
	const models = parseModels(
		"github-copilot",
		{
			data: [
				{
					id: "claude-new",
					supported_endpoints: ["/v1/messages"],
					capabilities: { type: "chat", supports: { vision: true }, limits: { max_prompt_tokens: 200000, max_output_tokens: 32000 } },
				},
			],
		},
		[],
	);
	assert.equal(models[0].api, "anthropic-messages");
	assert.equal(models[0].contextWindow, 200000);
	assert.equal(models[0].maxTokens, 32000);
	assert.ok(models[0].input.includes("image"));
}
{
	const data = mkdtempSync(join(tmpdir(), "pma-native-identity-"));
	const path = join(data, "auth.json");
	const base = {
		id: "fallback",
		name: "Fallback",
		provider: "xai",
		api: "openai-responses",
		baseUrl: "https://api.x.ai/v1",
		reasoning: false,
		input: ["text"],
		contextWindow: 10000,
		maxTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const provider = {
		id: "xai",
		name: "xAI",
		getModels: () => [base],
		auth: {
			apiKey: {
				name: "key",
				resolve: async ({ credential }: { credential?: { key?: string } }) =>
					credential?.key ? { auth: { apiKey: credential.key } } : undefined,
			},
		},
		stream: () => {
			throw new Error("not called");
		},
		streamSimple: () => {
			throw new Error("not called");
		},
	};
	const mock = (async (url, init) =>
		String(url).endsWith("/models")
			? Response.json({ data: [{ id: new Headers(init?.headers).get("authorization")?.endsWith("-A") ? "model-A" : "model-B" }] })
			: Response.json({})) as typeof fetch;
	writeFileSync(path, JSON.stringify({ xai: { type: "api_key", key: "fixture-native-A" } }));
	const engine = new PmaEngine(data, { providers: [provider as never], fetch: mock });
	await engine.initialize({ network: false });
	await engine.refresh({ force: true });
	assert.ok(engine.models.getModel("xai", "model-A"));
	writeFileSync(path, JSON.stringify({ xai: { type: "api_key", key: "fixture-native-B" } }));
	assert.equal(
		engine.models.getModel("xai", "model-A"),
		undefined,
		"changing a native login cannot inherit the previous login's live models",
	);
	await engine.refresh({ force: true });
	assert.ok(engine.models.getModel("xai", "model-B"));
	assert.ok(!readFileSync(engine.catalog.path, "utf8").includes("fixture-native-"));
}
console.log(
	"ok: storage safety (corrupt config preserved, cache recovery, retained readers, ledger fail-closed, removed routes, Copilot capabilities, native identity isolation)",
);
