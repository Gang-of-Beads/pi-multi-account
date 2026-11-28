/**
 * The shape a request takes is a choice, not a property of the vendor: a route
 * target (`provider/model:api`) or a definition's model may name it, and the
 * same upstream is then asked that protocol.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addProviderDef } from "../src/core/provider-defs.ts";
import { PmaEngine } from "../src/core/engine.ts";
import { parseTarget } from "../src/core/routes.ts";

const dir = mkdtempSync(join(tmpdir(), "pma-protocol-switch-"));

test("a target names the shape it is served on", () => {
	assert.deepEqual(parseTarget("relay/model:openai-responses"), { provider: "relay", model: "model", api: "openai-responses" });
	assert.deepEqual(parseTarget("relay@work/model"), { provider: "relay", account: "work", model: "model" });
	assert.throws(() => parseTarget("relay/model:grpc"), /api|Invalid target/);
});

test("the route override reaches the resolved model, the provider default without it", async () => {
	await addProviderDef(dir, {
		id: "relay",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:9/v1",
		auth: { kind: "none" },
		models: [{ id: "switchable", context: 8_000, maxTokens: 1_000 }],
	});
	const engine = new PmaEngine(dir);
	assert.equal(engine.resolve({ provider: "relay", model: "switchable" }).model.api, "openai-completions");
	assert.equal(engine.resolve({ provider: "relay", model: "switchable", api: "anthropic-messages" }).model.api, "anthropic-messages");
});

test("a model may pin its own shape in the definition", async () => {
	await addProviderDef(dir, {
		id: "two-face",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:9/v1",
		auth: { kind: "none" },
		models: [
			{ id: "as-chat", context: 8_000, maxTokens: 1_000 },
			{ id: "as-messages", api: "anthropic-messages", context: 8_000, maxTokens: 1_000 },
		],
	});
	const engine = new PmaEngine(dir);
	assert.equal(engine.resolve({ provider: "two-face", model: "as-chat" }).model.api, "openai-completions");
	assert.equal(engine.resolve({ provider: "two-face", model: "as-messages" }).model.api, "anthropic-messages");
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
