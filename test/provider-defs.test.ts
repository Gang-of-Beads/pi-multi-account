import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	addProviderDef,
	checkProviderDefinition,
	definitionToProvider,
	parseProviderDefs,
	providerDefsPath,
	readProviderDefs,
	removeProviderDef,
	saveProviderDefs as _save,
} from "../src/core/provider-defs.ts";
import { PmaEngine } from "../src/core/engine.ts";

const dir = mkdtempSync(join(tmpdir(), "pma-provider-defs-"));
const definition = {
	id: "relay",
	api: "openai-completions",
	baseUrl: "https://relay.example/v1",
	auth: { kind: "env", env: "RELAY_KEY" },
	models: [{ id: "gpt-x", context: 64_000, maxTokens: 4_096 }],
};

test("a definition is validated field by field, and a typo is a load error", () => {
	assert.deepEqual(checkProviderDefinition(definition).models[0], { id: "gpt-x", context: 64_000, maxTokens: 4_096, input: ["text"] });
	const bad: [unknown, RegExp][] = [
		[{ ...definition, id: "Anthropic" }, /id must match/],
		[{ ...definition, id: "anthropic" }, /built in/],
		[{ ...definition, api: "grpc" }, /api must be one of/],
		[{ ...definition, baseUrl: "relay.example" }, /baseUrl must be an http/],
		[{ ...definition, auth: { kind: "key" } }, /auth must be/],
		[{ ...definition, auth: { kind: "env", env: "relay key" } }, /auth must be/],
		[{ ...definition, models: [] }, /models must be a non-empty list/],
		[{ ...definition, models: [{ id: "a", context: 10 }] }, /context must be an integer/],
		[{ ...definition, models: [{ id: "a" }, { id: "a" }] }, /duplicate id/],
		[{ ...definition, models: [{ id: "a", input: ["audio"] }] }, /input must be/],
	];
	for (const [value, message] of bad) assert.throws(() => checkProviderDefinition(value), message);
});

test("definitions persist 0600, refuse a duplicate, and are removable", async () => {
	await addProviderDef(dir, definition);
	assert.equal(statSync(providerDefsPath(dir)).mode & 0o777, 0o600);
	await assert.rejects(addProviderDef(dir, definition), /already exists/);
	assert.deepEqual(readProviderDefs(dir).providers.map((p) => p.id), ["relay"]);
	assert.equal(await removeProviderDef(dir, "relay"), true);
	assert.equal(await removeProviderDef(dir, "relay"), false);
	assert.deepEqual(readProviderDefs(dir).providers, []);
});

test("an unreadable file fails closed instead of routing to the wrong endpoint", () => {
	const file = providerDefsPath(dir);
	rmSync(file, { force: true });
	assert.deepEqual(readProviderDefs(dir).providers, []);
	_save(dir, { version: 1, providers: [checkProviderDefinition(definition)] });
	assert.match(readFileSync(file, "utf8"), /"version": 1/);
	assert.throws(() => parseProviderDefs({ version: 2, providers: [] }), /version 1/);
	assert.throws(() => parseProviderDefs({ version: 1, providers: [definition, definition] }), /share an id/);
});

test("a definition becomes a provider Pi and the gateway can use", async () => {
	if (!readProviderDefs(dir).providers.length) await addProviderDef(dir, definition);
	const engine = new PmaEngine(dir);
	const provider = engine.models.getProvider("relay");
	assert.ok(provider);
	assert.deepEqual(provider.getModels().map((m) => m.id), ["gpt-x"]);
	assert.equal(provider.getModels()[0]?.baseUrl, "https://relay.example/v1");
	// The env key decides whether it is configured at all; `checkAuth` answers the check's shape.
	delete process.env.RELAY_KEY;
	assert.equal(await engine.models.checkAuth("relay"), undefined);
	process.env.RELAY_KEY = "sk-test";
	assert.deepEqual(await engine.models.checkAuth("relay"), { type: "api_key", source: "provider-def:relay" });
	assert.ok((await engine.models.getAvailable()).some((m) => m.provider === "relay" && m.id === "gpt-x"));
	const built = definitionToProvider(checkProviderDefinition({ ...definition, auth: { kind: "key", key: "sk-inline" } }));
	assert.equal(built.auth.apiKey?.name, "relay key");
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
