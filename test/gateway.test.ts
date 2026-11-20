import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type Provider, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { PmaEngine } from "../src/core/engine.ts";
import { saveRoute, type Route } from "../src/core/routes.ts";
import { createCallerKey, revokeCallerKey } from "../src/gateway/access.ts";
import { startGateway } from "../src/gateway/server.ts";
process.env.PI_OFFLINE = "1";
process.env.PI_MULTI_ACCOUNT_LOG = "0";
const dir = mkdtempSync(join(tmpdir(), "pma-http-v1-"));
const requests: { host: string; body: Record<string, unknown>; headers: Headers }[] = [];
let phase = "normal";
let translatedContext: Context | undefined;
let translatedCalls = 0;
let releaseStreams: () => void = () => undefined;
let streamGate = Promise.resolve();
let upstreamAborted: () => void = () => undefined;
const partial =
	'data: {"type":"response.created","response":{"id":"resp_fixture","status":"in_progress"}}\n\ndata: {"type":"response.output_text.delta","delta":"你好🙂"}\n\n';
const terminal =
	'data: {"type":"response.completed","response":{"id":"resp_fixture","object":"response","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"你好🙂"}]}],"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n';
const failed = 'data: {"type":"error","error":{"message":"never expose fixture-upstream-token"}}\n\n';
function nativeStream(first: string, last: string, signal: AbortSignal, hold = false): Response {
	let sent = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(Buffer.from(first));
			signal.addEventListener(
				"abort",
				() => {
					upstreamAborted();
					try {
						controller.error(new Error("fixture aborted"));
					} catch {}
				},
				{ once: true },
			);
		},
		async pull(controller) {
			if (sent) return;
			sent = true;
			if (hold) await streamGate;
			if (signal.aborted) return;
			controller.enqueue(Buffer.from(last));
			controller.close();
		},
	});
	return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}
const mockFetch = (async (url, init) => {
	const host = new URL(String(url)).hostname;
	const body = JSON.parse(String(init?.body));
	const headers = new Headers(init?.headers);
	requests.push({ host, body, headers });
	assert.equal(init?.redirect, "error");
	assert.equal(headers.get("authorization"), "Bearer fixture-provider-key");
	if (phase === "timeout")
		return await new Promise<Response>((_resolve, reject) =>
			init?.signal?.addEventListener(
				"abort",
				() => {
					upstreamAborted();
					reject(new Error("timed out"));
				},
				{ once: true },
			),
		);
	if (phase === "all-429") return new Response("fixture-upstream-token", { status: 429, headers: { "retry-after": "7" } });
	if (host === "first.test") {
		if (phase === "429") return new Response("fixture-upstream-token", { status: 429 });
		if (phase === "400") return new Response("fixture-upstream-token", { status: 400 });
		if (phase === "prelude-error") return nativeStream('data: {"type":"response.created"}\n\n', failed, init!.signal!);
		if (phase === "partial-error") return nativeStream(partial, failed, init!.signal!);
		if (phase === "truncated") return nativeStream(partial, "", init!.signal!);
		if (phase === "bad-json") return new Response("not JSON", { headers: { "content-type": "application/json" } });
	}
	if (body.stream === true) return nativeStream(partial, terminal, init!.signal!, phase === "parallel" || phase === "cancel");
	return Response.json({
		object: "response",
		id: "resp_fixture",
		model: body.model,
		status: "completed",
		output: [{ type: "reasoning", encrypted_content: "opaque_fixture_blob" }],
		usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
	});
}) as typeof fetch;
function provider(id: string): Provider {
	const model = {
		id: "m",
		name: "M",
		provider: id,
		api: "openai-responses" as const,
		baseUrl: `http://${id}.test/v1`,
		reasoning: true,
		input: ["text" as const],
		contextWindow: 10000,
		maxTokens: 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const stream: Provider["streamSimple"] = (_model, context, options) => {
		translatedCalls++;
		translatedContext = context;
		const output = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			provider: id,
			model: "m",
			api: model.api,
			timestamp: 0,
			content: [{ type: "text", text: "translated" }],
			stopReason: "stop",
			usage: {
				input: 3,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 4,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		void (async () => {
			await options?.onResponse?.({ status: 200, headers: {} }, model);
			output.push({ type: "start", partial: message });
			output.push({ type: "text_start", contentIndex: 0, partial: message });
			output.push({ type: "text_delta", contentIndex: 0, delta: "translated", partial: message });
			output.push({ type: "text_end", contentIndex: 0, content: "translated", partial: message });
			output.push({ type: "done", reason: "stop", message });
			output.end();
		})();
		return output;
	};
	return {
		id,
		name: id,
		auth: { apiKey: { name: id, resolve: async () => ({ auth: { apiKey: "fixture-provider-key" } }) } },
		getModels: () => [model],
		stream: stream as Provider["stream"],
		streamSimple: stream,
	};
}
const engine = new PmaEngine(dir, { providers: [provider("first"), provider("second")] });
await engine.initialize({ network: false });
const route: Route = {
	id: "daily",
	mode: "order",
	targets: [
		{ provider: "first", model: "m" },
		{ provider: "second", model: "m" },
	],
	translate: true,
};
await saveRoute(dir, route);
await saveRoute(dir, { ...route, id: "strict", translate: false });
const client = await createCallerKey(dir, "client", { routes: ["daily"], maxConcurrent: 32 });
const admin = await createCallerKey(dir, "admin", { admin: true, maxConcurrent: 32 });
let handle = await startGateway(engine, { port: 0, fetch: mockFetch, timeoutMs: 5000, maxBodyBytes: 4096 });
const post = (body: object, token = client.secret, path = "/v1/responses", extras: RequestInit = {}) =>
	fetch(`${handle.url}${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
		...extras,
	});
const input = { model: "daily", input: "hello" };
try {
	assert.equal((await fetch(`${handle.url}/healthz`)).status, 200);
	assert.equal((await post(input, "not-a-key")).status, 401);
	assert.equal(
		(
			await post(input, client.secret, "/v1/responses", {
				headers: { authorization: `Bearer ${client.secret}`, origin: "https://hostile.test", "content-type": "application/json" },
			})
		).status,
		403,
	);
	assert.equal((await post({ ...input, model: "strict" })).status, 403);
	const models = (await (await fetch(`${handle.url}/v1/models`, { headers: { authorization: `Bearer ${client.secret}` } })).json()) as {
		data: { id: string }[];
	};
	assert.deepEqual(
		models.data.map((m) => m.id),
		["daily"],
		"the model list respects key scopes",
	);
	assert.equal((await fetch(`${handle.url}/stats`, { headers: { authorization: `Bearer ${client.secret}` } })).status, 403);
	assert.equal((await post({ ...input, input: "x".repeat(5000) })).status, 413);
	assert.equal((await post(input, client.secret, "/v1/responses", { body: "invalid JSON" })).status, 400);
	assert.equal(requests.length, 0, "rejected requests never reach a provider");
	await assert.rejects(startGateway(engine, { port: 0 }), /already owns/, "one owner per agent dir, even on another port");
	{
		const response = await post({
			...input,
			opaque_field: "preserve-me",
			previous_response_id: "resp_native",
			tools: [{ type: "private-tool" }],
		});
		assert.equal(response.status, 200);
		const result = (await response.json()) as { output: { encrypted_content: string }[] };
		assert.equal(result.output[0].encrypted_content, "opaque_fixture_blob");
		assert.equal(requests.at(-1)!.body.opaque_field, "preserve-me");
		assert.equal(requests.at(-1)!.body.previous_response_id, "resp_native");
		assert.equal(translatedCalls, 0, "same-protocol requests never pass through lossy normalization");
		assert.ok(!requests.at(-1)!.headers.get("authorization")!.includes(client.secret));
	}
	{
		requests.length = 0;
		phase = "429";
		const response = await post({ ...input, stream: true });
		const wire = await response.text();
		assert.equal(response.status, 200);
		assert.deepEqual(
			requests.map((r) => r.host),
			["first.test", "second.test"],
		);
		assert.ok(wire.includes("你好🙂"));
		assert.ok(!wire.includes("fixture-upstream-token"));
		requests.length = 0;
		phase = "prelude-error";
		const before = await post({ ...input, stream: true });
		assert.ok((await before.text()).includes("response.completed"));
		assert.equal(requests.length, 2, "200 with a failed stream can fall back before output");
		for (const broken of ["partial-error", "truncated"]) {
			requests.length = 0;
			phase = broken;
			const partialResponse = await post({ ...input, stream: true });
			const partialWire = await partialResponse.text();
			assert.equal(requests.length, 1, "no replay after output");
			assert.ok(partialWire.includes("你好🙂"));
			assert.ok(!partialWire.includes("fixture-upstream-token"));
			assert.ok(partialWire.includes("error"));
		}
		requests.length = 0;
		phase = "400";
		assert.equal((await post(input)).status, 400);
		assert.equal(requests.length, 1, "400 is not retried");
		requests.length = 0;
		phase = "all-429";
		const limited = await post(input);
		assert.equal(limited.status, 429);
		assert.equal(limited.headers.get("retry-after"), "7");
		assert.equal(requests.length, 2);
		assert.ok(!(await limited.text()).includes("fixture-upstream-token"));
		requests.length = 0;
		phase = "bad-json";
		assert.equal((await post(input)).status, 200);
		assert.equal(requests.length, 2, "invalid 200 JSON is not treated as success");
	}
	{
		phase = "normal";
		const response = await post(
			{ model: "daily", messages: [{ role: "user", content: "hi" }], stream: true },
			client.secret,
			"/v1/chat/completions",
		);
		const wire = await response.text();
		assert.equal(response.status, 200);
		assert.ok(wire.includes("translated"));
		assert.ok(wire.includes("[DONE]"));
		assert.equal(translatedContext?.messages.at(-1)?.role, "user");
		const messages = await post(
			{ model: "daily", messages: [{ role: "user", content: "hi" }], max_tokens: 100 },
			client.secret,
			"/v1/messages",
		);
		assert.equal(messages.status, 200);
		assert.equal(((await messages.json()) as { type: string }).type, "message");
		assert.equal(
			(await post({ model: "strict", messages: [{ role: "user", content: "hi" }] }, admin.secret, "/v1/chat/completions")).status,
			400,
		);
		assert.equal(
			(
				await post(
					{ model: "daily", messages: [{ role: "user", content: "hi" }], response_format: { type: "json_schema" } },
					client.secret,
					"/v1/chat/completions",
				)
			).status,
			400,
		);
	}
	{
		requests.length = 0;
		await saveRoute(dir, { ...route, targets: [...route.targets].reverse() });
		await (await post(input)).text();
		assert.equal(requests[0].host, "second.test", "config reload affects the next request without restarting a listener");
		await saveRoute(dir, route);
		const limited = await createCallerKey(dir, "limited", { routes: ["daily"], dailyTokens: 1 });
		requests.length = 0;
		assert.equal((await post(input, limited.secret)).status, 429);
		assert.equal(requests.length, 0);
	}
	{
		phase = "parallel";
		streamGate = new Promise<void>((resolve) => {
			releaseStreams = resolve;
		});
		const responses = await Promise.all(Array.from({ length: 20 }, () => post({ ...input, stream: true }, admin.secret)));
		assert.ok(responses.every((r) => r.status === 200));
		const stats = (await (await fetch(`${handle.url}/stats`, { headers: { authorization: `Bearer ${admin.secret}` } })).json()) as {
			keys: { id: string; inFlight: number }[];
		};
		assert.equal(stats.keys.find((k) => k.id === admin.key.id)?.inFlight, 20);
		releaseStreams();
		const wires = await Promise.all(responses.map((r) => r.text()));
		assert.ok(wires.every((w) => w.includes("response.completed")));
		phase = "normal";
		const after = (await (await fetch(`${handle.url}/stats`, { headers: { authorization: `Bearer ${admin.secret}` } })).json()) as {
			keys: { inFlight: number; reserved: number }[];
		};
		assert.ok(after.keys.every((k) => k.inFlight === 0 && k.reserved === 0));
	}
	{
		phase = "cancel";
		streamGate = new Promise<void>((resolve) => {
			releaseStreams = resolve;
		});
		const aborted = new Promise<void>((resolve) => {
			upstreamAborted = resolve;
		});
		const controller = new AbortController();
		const response = await post({ ...input, stream: true }, admin.secret, "/v1/responses", { signal: controller.signal });
		const reading = response.text().catch(() => "cancelled");
		controller.abort();
		await reading;
		await aborted;
		releaseStreams();
		await new Promise<void>((resolve) => setImmediate(resolve));
		phase = "normal";
		const after = (await (await fetch(`${handle.url}/stats`, { headers: { authorization: `Bearer ${admin.secret}` } })).json()) as {
			keys: { inFlight: number; reserved: number }[];
		};
		assert.ok(
			after.keys.every((k) => k.inFlight === 0 && k.reserved === 0),
			"aborting one client releases its reservation",
		);
	}
	await revokeCallerKey(dir, client.key.id);
	assert.equal((await post(input)).status, 401);
	const ledger = readFileSync(join(dir, "pi-multi-account-usage.jsonl"), "utf8");
	assert.ok(ledger.trim().split("\n").length >= 30);
	assert.ok(!ledger.includes(client.secret));
	assert.ok(!ledger.includes("fixture-provider-key"));
	assert.ok(!ledger.includes("fixture-upstream-token"));
	phase = "cancel";
	streamGate = new Promise<void>((resolve) => {
		releaseStreams = resolve;
	});
	const shuttingDown = await post({ ...input, stream: true }, admin.secret);
	const draining = shuttingDown.text().catch(() => "closed");
	await handle.close();
	await draining;
	releaseStreams();
	const last = JSON.parse(readFileSync(join(dir, "pi-multi-account-usage.jsonl"), "utf8").trim().split("\n").at(-1)!);
	assert.equal(last.status, 499, "shutdown records the cancelled in-flight call before closing the ledger");
	assert.equal(last.estimated, true);
	await handle.close();
	phase = "timeout";
	handle = await startGateway(engine, { port: 0, fetch: mockFetch, timeoutMs: 50 });
	const timeout = await post(input, admin.secret);
	assert.equal(timeout.status, 504);
	assert.ok(!(await timeout.text()).includes("fixture-provider-key"));
} finally {
	releaseStreams();
	await handle.close();
}
assert.equal(JSON.parse(readFileSync(join(dir, "pi-multi-account-gateway-owner.json"), "utf8")), null);
console.log(
	"ok: HTTP gateway (real sockets, native preservation, translation, auth, limits, failover, 20 concurrent streams, abort, timeout, reload, shutdown)",
);
