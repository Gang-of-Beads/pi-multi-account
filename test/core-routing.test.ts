import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type Provider, type Model, type Api, type AssistantMessage } from "@earendil-works/pi-ai";
import { PmaEngine } from "../src/core/engine.ts";
import { RouteRouter, saveRoute, readRoutes, validateRoutes, parseTarget, type Route } from "../src/core/routes.ts";
process.env.PI_OFFLINE = "1";
process.env.PI_MULTI_ACCOUNT_LOG = "0";
const dir = mkdtempSync(join(tmpdir(), "pma-routing-v1-"));
assert.deepEqual(parseTarget("anthropic@*/claude-new"), { provider: "anthropic", account: "*", model: "claude-new" });
assert.deepEqual(parseTarget("custom/namespace/model"), { provider: "custom", model: "namespace/model" });
assert.throws(() => parseTarget("broken"));
assert.throws(() => parseTarget("anthropic@one@two/model"));
const calls: string[] = [];
const model = (id: string): Model<Api> => ({
	id: "m",
	name: "M",
	provider: id,
	api: "openai-completions",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
const message = (id: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text: id }],
	api: "openai-completions",
	provider: id,
	model: "m",
	timestamp: Date.now(),
	stopReason: "stop",
	usage: {
		input: 3,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 5,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});
function provider(id: string, status: number, emitted = false): Provider {
	const stream: Provider["streamSimple"] = (_model, _context, options) => {
		calls.push(id);
		const output = createAssistantMessageEventStream();
		const m = message(id);
		void (async () => {
			await options?.onResponse?.({ status, headers: {} }, model(id));
			output.push({ type: "start", partial: m });
			if (emitted) {
				output.push({ type: "text_start", contentIndex: 0, partial: m });
				output.push({ type: "text_delta", contentIndex: 0, delta: id, partial: m });
			}
			if (status !== 200 || emitted)
				output.push({ type: "error", reason: "error", error: { ...m, stopReason: "error", errorMessage: `status ${status}` } });
			else {
				output.push({ type: "text_start", contentIndex: 0, partial: m });
				output.push({ type: "text_delta", contentIndex: 0, delta: id, partial: m });
				output.push({ type: "text_end", contentIndex: 0, content: id, partial: m });
				output.push({ type: "done", reason: "stop", message: m });
			}
			output.end();
		})();
		return output;
	};
	return {
		id,
		name: id,
		auth: { apiKey: { name: id, resolve: async () => ({ auth: { apiKey: "test" } }) } },
		getModels: () => [model(id)],
		stream: stream as Provider["stream"],
		streamSimple: stream,
	};
}
const engine = new PmaEngine(dir, {
	providers: [provider("bad", 429), provider("good", 200), provider("invalid", 400), provider("partial", 200, true)],
});
await engine.initialize({ network: false });
const router = new RouteRouter(engine);
const route: Route = {
	id: "daily",
	mode: "order",
	targets: [
		{ provider: "bad", model: "m" },
		{ provider: "good", model: "m" },
	],
};
const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 0 }] };
{
	const events = [];
	const stream = router.stream(route, context, { sessionId: "session-a" });
	for await (const e of stream) events.push(e);
	assert.deepEqual(calls, ["bad", "good"]);
	assert.equal(events.filter((e) => e.type === "start").length, 1, "failed attempts never leak start events");
	assert.equal(events.filter((e) => e.type === "error").length, 0);
	assert.equal(events.at(-1)?.type, "done");
	calls.length = 0;
	await router.stream(route, context, { sessionId: "session-a" }).result();
	assert.deepEqual(calls, ["good"], "the conversation sticks to its successful account");
	calls.length = 0;
	await router.stream(route, context, { sessionId: "another-session" }).result();
	assert.deepEqual(calls, ["bad", "good"], "one session's affinity does not redirect another");
}
{
	calls.length = 0;
	const invalid = {
		...route,
		id: "validation",
		targets: [
			{ provider: "invalid", model: "m" },
			{ provider: "good", model: "m" },
		],
	};
	assert.equal((await router.stream(invalid, context).result()).stopReason, "error");
	assert.deepEqual(calls, ["invalid"], "schema validation errors are not retried against another account");
	calls.length = 0;
	const partial = {
		...route,
		id: "partial",
		targets: [
			{ provider: "partial", model: "m" },
			{ provider: "good", model: "m" },
		],
	};
	assert.equal((await router.stream(partial, context).result()).stopReason, "error");
	assert.deepEqual(calls, ["partial"], "no replay after content was emitted");
	calls.length = 0;
	const controller = new AbortController();
	controller.abort();
	assert.equal((await router.stream(route, context, { signal: controller.signal }).result()).stopReason, "aborted");
	assert.equal(calls.length, 0);
}
{
	const rotate = { ...route, id: "rotate", mode: "rotate" as const };
	assert.equal((await router.candidates(rotate))[0].provider, "bad");
	assert.equal((await router.candidates(rotate))[0].provider, "good");
	const weighted: Route = {
		...route,
		id: "weighted",
		mode: "weighted",
		targets: [
			{ provider: "bad", model: "m", weight: 3 },
			{ provider: "good", model: "m", weight: 1 },
		],
	};
	const counts: Record<string, number> = {};
	for (let i = 0; i < 40; i++) {
		const p = (await router.candidates(weighted))[0].provider;
		counts[p] = (counts[p] ?? 0) + 1;
	}
	assert.deepEqual(counts, { bad: 30, good: 10 });
	const usage = { ...route, id: "usage", mode: "usage" as const };
	router.succeeded(usage, usage.targets[0], undefined, 100);
	assert.equal((await router.candidates(usage))[0].provider, "good");
}
{
	await saveRoute(dir, route);
	await saveRoute(dir, { ...route, mode: "rotate" });
	assert.equal(readRoutes(dir).routes.length, 1);
	assert.equal(readRoutes(dir).routes[0].mode, "rotate");
	await Promise.all(Array.from({ length: 10 }, (_, i) => saveRoute(dir, { ...route, id: `parallel-${i}` })));
	assert.equal(readRoutes(dir).routes.length, 11, "concurrent route edits do not lose updates");
	assert.throws(() => validateRoutes({ version: 1, routes: [route, route] }), /duplicate/);
	assert.throws(
		() => validateRoutes({ version: 1, routes: [{ ...route, targets: [{ provider: "bad", model: "m", weight: -1 }] }] }),
		/Invalid target/,
	);
	assert.throws(() => validateRoutes({ version: 1, routes: [{ ...route, mode: "smart" }] }), /Invalid/);
}
console.log("ok: shared routes (failover boundary, affinity, cancellation, scheduling, atomic writes)");
