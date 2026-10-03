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
