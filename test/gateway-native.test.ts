import assert from "node:assert/strict";
import { nativeRequest, relayNative, UpstreamFailure } from "../src/gateway/native.ts";
import type { PmaEngine, ResolvedTarget } from "../src/core/engine.ts";
const access = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.signature`;
const engine = { auth: async () => ({ apiKey: access }), rejected: async () => undefined } as unknown as PmaEngine;
const codex: ResolvedTarget = {
	provider: "openai-codex",
	account: "work",
	model: {
		id: "gpt-new",
		name: "New",
		provider: "codex-work",
		api: "openai-codex-responses",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		contextWindow: 100000,
		maxTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
};
const responseObject = {
	id: "resp_fixture",
	output: [{ type: "reasoning", encrypted_content: "opaque_fixture" }],
	usage: { input_tokens: 3, output_tokens: 2 },
};
const wire = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "OK" })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: responseObject })}\n\n`;
for (const streaming of [true, false]) {
	let outgoing: Record<string, unknown> | undefined;
	const response = await nativeRequest(
		engine,
		codex,
		"responses",
		{ model: "route", input: "hi", stream: streaming, opaque_field: "keep" },
		AbortSignal.timeout(2000),
		(async (_url, init) => {
			outgoing = JSON.parse(String(init?.body));
			const headers = new Headers(init?.headers);
			assert.equal(headers.get("chatgpt-account-id"), "fixture-account");
			assert.equal(headers.get("authorization"), `Bearer ${access}`);
			assert.equal(headers.get("cookie"), null, "caller cookies are never forwarded");
			assert.equal(init?.redirect, "error");
			return new Response(Buffer.from(wire)); // A real Codex response can omit Content-Type entirely.
		}) as typeof fetch,
		{ authorization: "Bearer caller-key-must-not-go-upstream", cookie: "private-cookie" },
	);
	assert.equal(outgoing?.stream, true);
	assert.equal(outgoing?.store, false);
	assert.equal(outgoing?.opaque_field, "keep");
	assert.equal(response.headers.get("content-type"), "text/event-stream");
	let committed: boolean | undefined;
	const chunks: Uint8Array[] = [];
	const usage = await relayNative(response, {
		streaming,
		signal: AbortSignal.timeout(2000),
		commit: (sse) => {
			committed = sse;
		},
		write: async (chunk) => {
			chunks.push(chunk);
		},
	});
	assert.equal(committed, streaming);
	assert.equal(usage.tokens, 5);
	if (streaming) assert.equal(Buffer.concat(chunks).toString(), wire, "the inferred SSE content type does not rewrite provider events");
	else
		assert.deepEqual(
			JSON.parse(Buffer.concat(chunks).toString()),
			responseObject,
			"a nonstream client receives the final native Responses object",
		);
}
{
	const auth = { auth: async () => ({ apiKey: "sk-ant-oat-fixture" }) } as unknown as PmaEngine;
	const target: ResolvedTarget = {
		...codex,
		provider: "anthropic",
		model: { ...codex.model, id: "claude-fixture", provider: "anthropic-work", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
	};
	const messages = [
		{ role: "assistant", content: [{ type: "thinking", thinking: "fixture", signature: "signed-fixture" }] },
		{ role: "user", content: "hi" },
	];
	await nativeRequest(
		auth,
		target,
		"messages",
		{ messages, max_tokens: 100, opaque_field: { sealed: "keep" } },
		AbortSignal.timeout(2000),
		(async (_url, init) => {
			const headers = new Headers(init?.headers);
			const body = JSON.parse(String(init?.body));
			assert.equal(headers.get("x-app"), "cli");
			assert.equal(headers.get("anthropic-dangerous-direct-browser-access"), "true");
			assert.ok(headers.get("anthropic-beta")?.includes("oauth-2025-04-20"));
			assert.ok(headers.get("anthropic-beta")?.includes("caller-beta"));
			assert.equal(headers.get("x-api-key"), null);
			assert.equal(headers.get("authorization"), "Bearer sk-ant-oat-fixture");
			assert.deepEqual(body.messages, messages, "native signed thinking remains unchanged");
			assert.deepEqual(body.opaque_field, { sealed: "keep" });
			assert.ok(JSON.stringify(body.system).includes("x-anthropic-billing-header"));
			return Response.json({ content: [], usage: { input_tokens: 1, output_tokens: 0 } });
		}) as typeof fetch,
		{ "anthropic-beta": "caller-beta", "x-api-key": "caller-key-must-not-go-upstream" },
	);
}
{
	const response = new Response("credential-or-prompt-must-not-leak", { status: 429, headers: { "retry-after": "17" } });
	await assert.rejects(
		relayNative(response, { streaming: false, signal: AbortSignal.timeout(2000), commit: () => undefined, write: async () => undefined }),
		(e: unknown) => {
			assert.ok(e instanceof UpstreamFailure);
			assert.equal(e.status, 429);
			assert.equal(e.retryAfter, 17);
			assert.ok(!e.message.includes("must-not-leak"));
			return true;
		},
	);
	const controller = new AbortController();
	controller.abort();
	let calls = 0;
	await assert.rejects(
		nativeRequest(engine, codex, "responses", { input: "hi" }, controller.signal, (async () => {
			calls++;
			return Response.json({});
		}) as typeof fetch),
	);
	assert.equal(calls, 0, "an already-cancelled request never contacts the provider");
	await assert.rejects(
		nativeRequest(engine, codex, "responses", { input: "hi", store: true }, AbortSignal.timeout(2000)),
		/does not support/,
	);
}
console.log(
	"ok: native wire regressions (missing Codex Content-Type, nonstream gather, Claude OAuth headers, opaque fields, quota propagation, cancellation)",
);
