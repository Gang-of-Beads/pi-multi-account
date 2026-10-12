import assert from "node:assert/strict";
import test from "node:test";
import { logProviderResponse } from "../src/response-log.ts";

/**
 * pi-web B32: the diagnostic fetch wrappers read a streaming reply to its end before returning it,
 * so no provider streamed. Logging must leave the response readable while its body is still open.
 */
test("a streaming response stays readable chunk by chunk after it is logged", async () => {
	let push: (text: string) => void = () => undefined;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			push = (text) => { controller.enqueue(new TextEncoder().encode(text)); };
		},
	});
	const response = new Response(body, { status: 200 });
	const logged: Record<string, unknown>[] = [];

	logProviderResponse(response, { url: "https://example.test/v1" }, (_event, fields) => { logged.push(fields); });
	push("data: first\n\n");
	const reader = response.body?.getReader();
	const first = await reader?.read();

	assert.equal(new TextDecoder().decode(first?.value), "data: first\n\n");
	assert.deepEqual(logged, [{ url: "https://example.test/v1", status: 200 }]);
	await reader?.cancel();
});

test("an error response is logged with its body, read from a clone", async () => {
	const response = new Response(JSON.stringify({ error: "overloaded" }), { status: 529 });
	const logged = await new Promise<Record<string, unknown>>((resolve) => {
		logProviderResponse(response, { url: "https://example.test/v1" }, (_event, fields) => { resolve(fields); });
	});

	assert.deepEqual(logged, { url: "https://example.test/v1", status: 529, body: "{\"error\":\"overloaded\"}" });
	assert.equal(await response.text(), "{\"error\":\"overloaded\"}");
});

// Both fetch wrappers see the same request; the response must be logged once.
test("the same response is logged once, whichever wrapper sees it first", () => {
	const url = "https://api.anthropic.com/v1/messages";
	// Either wrapper may see the response first; the first one logs it, the other stays quiet.
	for (const [first, second] of [
		[{ url, ms: 12 }, { url }],
		[{ url }, { url, ms: 12 }],
	]) {
		const response = new Response("ok", { status: 200 });
		const lines: Record<string, unknown>[] = [];
		const log = (_event: string, fields: Record<string, unknown>): void => { lines.push(fields); };

		logProviderResponse(response, first, log);
		logProviderResponse(response, second, log);

		assert.equal(lines.length, 1, "one request, one line");
		assert.deepEqual(lines[0], { ...first, status: 200 }, "first wrapper wins");
	}
});

// The guard is per response, not per URL: two sequential calls are two lines.
test("a different response for the same URL is logged again", () => {
	const lines: Record<string, unknown>[] = [];
	const log = (_event: string, fields: Record<string, unknown>): void => { lines.push(fields); };

	logProviderResponse(new Response("ok", { status: 200 }), { url: "https://api.anthropic.com/v1/messages" }, log);
	logProviderResponse(new Response("ok", { status: 200 }), { url: "https://api.anthropic.com/v1/messages" }, log);

	assert.equal(lines.length, 2);
});

// The guard is shared, but the error branch is async: the second wrapper's 529 must stay quiet.
test("the same error response is logged once", async () => {
	const response = new Response(JSON.stringify({ error: "overloaded" }), { status: 529 });
	const lines: Record<string, unknown>[] = [];
	const log = (_event: string, fields: Record<string, unknown>): void => { lines.push(fields); };

	logProviderResponse(response, { url: "https://api.anthropic.com/v1/messages", ms: 12 }, log);
	logProviderResponse(response, { url: "https://api.anthropic.com/v1/messages" }, log);
	await new Promise((resolve) => setTimeout(resolve, 5));

	assert.equal(lines.length, 1, "one request, one line");
	assert.deepEqual(lines[0], { url: "https://api.anthropic.com/v1/messages", ms: 12, status: 529, body: "{\"error\":\"overloaded\"}" });
});

// A daemon loads one module instance per session, so the guard has to be shared.
test("the dedupe guard lives on globalThis, not in module state", () => {
	const shared = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-multi-account.loggedResponses")];
	assert.ok(shared instanceof WeakSet, "a second module instance reaches the same set");
});
