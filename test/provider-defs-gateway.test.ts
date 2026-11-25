/**
 * A defined provider, end to end over real sockets: a local server stands in for
 * a relay, the definition points at it, and the gateway's answer must come from
 * there — the same path a user's relay takes, with nothing special-cased.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addProviderDef } from "../src/core/provider-defs.ts";
import { PmaEngine } from "../src/core/engine.ts";
import { saveRoute } from "../src/core/routes.ts";
import { createCallerKey } from "../src/gateway/access.ts";
import { startGateway } from "../src/gateway/server.ts";

process.env.PI_OFFLINE = "1";
process.env.PI_MULTI_ACCOUNT_LOG = "0";

const dir = mkdtempSync(join(tmpdir(), "pma-defined-provider-"));
const seen: { authorization?: string; tenant?: string; model?: unknown }[] = [];
let mode: "ok" | "fail" = "ok";

const upstream: Server = createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
	req.on("end", () => {
		const body = JSON.parse(raw) as { model?: unknown; stream?: boolean };
		seen.push({ authorization: req.headers.authorization, tenant: req.headers["x-relay-tenant"] as string | undefined, model: body.model });
		if (mode === "fail") {
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "relay exploded" } }));
			return;
		}
		const completion = {
			id: "c1", object: "chat.completion", created: 1, model: body.model,
			choices: [{ index: 0, message: { role: "assistant", content: "hello from the relay" }, finish_reason: "stop" }],
			usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
		};
		if (body.stream !== true) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(completion));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "hello from " }, finish_reason: null }] })}\n\n`);
		res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { content: "the relay" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
});

await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => { resolve(); }));
const port = (upstream.address() as { port: number }).port;

await addProviderDef(dir, {
	id: "relay",
	api: "openai-completions",
	baseUrl: `http://127.0.0.1:${port}/v1`,
	auth: { kind: "key", key: "sk-relay-secret" },
	headers: { "x-relay-tenant": "team-a" },
	models: [{ id: "relay-mini", context: 32_000, maxTokens: 4_096 }],
});
await saveRoute(dir, { id: "daily", mode: "order", targets: [{ provider: "relay", model: "relay-mini" }], translate: true });

const engine = new PmaEngine(dir);
const key = await createCallerKey(dir, "client", { routes: ["*"] });
const handle = await startGateway(engine, { port: 0, timeoutMs: 10_000 });

const post = (body: object) =>
	fetch(`${handle.url}/v1/chat/completions`, {
		method: "POST",
		headers: { authorization: `Bearer ${key.secret}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});

test("the gateway serves a defined provider through its own endpoint", async () => {
	const response = await post({ model: "daily", stream: false, messages: [{ role: "user", content: "hi" }] });
	const text = await response.text();
	assert.equal(response.status, 200, `${text}\nseen=${JSON.stringify(seen)}`);
	assert.match(text, /hello from the relay/);
	assert.deepEqual(seen.at(-1), { authorization: "Bearer sk-relay-secret", tenant: "team-a", model: "relay-mini" });
});

test("a streaming request is relayed as one, and the definition's header reaches the wire", async () => {
	const response = await post({ model: "daily", stream: true, messages: [{ role: "user", content: "hi" }] });
	const text = await response.text();
	assert.equal(response.status, 200, text);
	// Native passthrough: the upstream's own chunks, split across two events as it sent them.
	assert.match(text, /"content":"hello from "/);
	assert.match(text, /"content":"the relay"/);
	assert.match(text, /data: \[DONE\]/);
});

test("a failing upstream keeps its meaning and the answer names it", async () => {
	mode = "fail";
	const response = await post({ model: "daily", stream: false, messages: [{ role: "user", content: "hi" }] });
	assert.ok(response.status >= 500, `status ${String(response.status)}`);
	assert.match(await response.text(), /relay exploded|upstream/i);
	mode = "ok";
});

test("an unknown model on the definition is refused, not guessed", async () => {
	const response = await post({ model: "relay/relay-large", stream: false, messages: [{ role: "user", content: "hi" }] });
	assert.equal(response.status, 404);
});

test.after(async () => {
	await handle.close();
	await new Promise<void>((resolve) => { upstream.close(() => { resolve(); }); });
	rmSync(dir, { recursive: true, force: true });
});
