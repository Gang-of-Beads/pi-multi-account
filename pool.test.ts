/**
 * Pool behavior: ordering, cooldowns, definition expansion, and end-to-end
 * failover through a stub provider whose requests go through the fetch the
 * pool injects — the same channel the real Anthropic SDK would use, so status
 * capture is exercised too. Pool definitions are user-created
 * (/pool-create), so registration is driven by explicit definitions here.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pi-multi-account-pool-home-"));
process.env.HOME = home;
const logFile = join(home, "pool.log");
process.env.PI_MULTI_ACCOUNT_LOG = "info";
process.env.PI_MULTI_ACCOUNT_LOG_FILE = logFile;

import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AccountStore } from "@narumitw/pi-accounts/src/account-store.ts";
import type { AccountProviderAdapter } from "@narumitw/pi-accounts/src/oauth.ts";
import { InMemoryAccountStorageBackend } from "@narumitw/pi-accounts/src/storage.ts";
import {
	createAssistantMessageEventStream,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { isCredentialSuspect, resetSuspectCredentialsForTesting } from "./refresh.ts";
import {
	createPoolRuntime,
	drainPoolNotices,
	isFailoverEligible,
	isPoolProvider,
	lastPoolAccount,
	planAccountOrder,
	poolFirstPick,
	poolsEnabled,
	resetPoolStateForTesting,
	type BaseStreamHost,
} from "./pool.ts";
import {
	checkPoolName,
	deletePool,
	expandPoolAccounts,
	NATIVE_POOL_NAME,
	readPools,
	resetPoolsFileForTesting,
	upsertPool,
} from "./pools-store.ts";

/** Log entries of one kind, read back from the file the extension actually writes. */
function logEvents(event: string): Record<string, unknown>[] {
	let raw: string;
	try {
		raw = readFileSync(logFile, "utf8");
	} catch {
		return [];
	}
	return raw
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((entry) => entry.event === event);
}

const HOUR = 60 * 60 * 1000;

/** A refresh adapter no test expects to reach: every runtime gets one injected. */
let unexpectedRefreshes = 0;
const testAdapter = {
	id: "anthropic",
	displayName: "Anthropic",
	oauth: {
		refresh: async () => {
			unexpectedRefreshes += 1;
			throw new Error("unexpected refresh in test");
		},
	},
} as unknown as AccountProviderAdapter;

async function makeStore(active: string, names: string[]): Promise<AccountStore> {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	const accounts: Record<string, { type: "oauth"; access: string; refresh: string; expires: number }> = {};
	for (const [index, name] of names.entries()) {
		accounts[name] = { type: "oauth", access: `access-${name}`, refresh: `refresh-${name}`, expires: Date.now() + 4 * HOUR + index };
	}
	await store.updateProviderAsync("anthropic", async () => ({ active, accounts }));
	return store;
}

// ---------------------------------------------------------------------------
// Pool definitions (pools-store.ts)
// ---------------------------------------------------------------------------

resetPoolsFileForTesting();
assert.deepEqual(readPools(), [], "a missing file means no pools");

// Name rules: pool ids are user-chosen provider ids, so they must stay clear
// of the per-account alias prefix and be sane provider-id material.
assert.equal(checkPoolName("claude-pool").ok, true);
assert.equal(checkPoolName("Anthropic_All.1").ok, true);
assert.equal(checkPoolName("anthropic-work").ok, false, "the anthropic- prefix belongs to per-account aliases");
assert.equal(checkPoolName("anthropic").ok, true, "the native override is an explicit, allowed choice");
assert.equal(checkPoolName("").ok, false);
assert.equal(checkPoolName("a/b").ok, false);
assert.equal(NATIVE_POOL_NAME, "anthropic");

// Definitions persist and replace by name.
upsertPool({ name: "work-pool", accounts: ["work", "personal"] });
upsertPool({ name: "everything", accounts: "all" });
assert.deepEqual(readPools().map((pool) => pool.name), ["work-pool", "everything"]);
upsertPool({ name: "work-pool", accounts: ["personal"] });
assert.deepEqual(readPools(), [{ name: "work-pool", accounts: ["personal"] }, { name: "everything", accounts: "all" }]);
assert.equal(deletePool("work-pool"), true);
assert.equal(deletePool("work-pool"), false);
assert.deepEqual(readPools().map((pool) => pool.name), ["everything"]);
resetPoolsFileForTesting();

// Expansion: "all" follows the store (active first), explicit lists keep
// their order and silently drop accounts that have vanished.
{
	const store = await makeStore("b", ["a", "b", "c"]);
	const state = await store.readProviderAsync("anthropic");
	assert.deepEqual(
		expandPoolAccounts({ name: "p", accounts: "all" }, Object.keys(state.accounts), state.active),
		["b", "a", "c"],
	);
	assert.deepEqual(
		expandPoolAccounts({ name: "p", accounts: ["c", "a", "gone"] }, Object.keys(state.accounts), state.active),
		["c", "a"],
	);
}
resetPoolsFileForTesting();

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// Order: the definition fixes the order, the rotation cursor fixes the start.
// Accounts before the cursor still get tried, after the ones behind it, so a
// request only fails when every account failed.
resetPoolStateForTesting();
assert.deepEqual(planAccountOrder(["a", "b", "c"]), ["a", "b", "c"], "no cursor keeps the definition order");
assert.deepEqual(planAccountOrder(["a", "b", "c"], "b"), ["b", "c", "a"], "the cursor rotates the list");
assert.deepEqual(planAccountOrder(["a", "b", "c"], "a"), ["a", "b", "c"], "a cursor on the first entry is a no-op");
assert.deepEqual(planAccountOrder(["a", "b", "c"], "gone"), ["a", "b", "c"], "an unknown cursor is ignored");
assert.deepEqual(planAccountOrder([], "a"), [], "an empty pool stays empty");

// Status classification.
assert.equal(isFailoverEligible(429), true);
assert.equal(isFailoverEligible(401), true);
assert.equal(isFailoverEligible(529), true);
assert.equal(isFailoverEligible(400), false, "a bad request is not worth another account");
assert.equal(isFailoverEligible(undefined), false);

// ---------------------------------------------------------------------------
// Failover through a stub provider
// ---------------------------------------------------------------------------

interface FakeStep {
	status: number;
	retryAfter?: string;
	/** Text streamed before the response completes; omitted = request-level failure. */
	text?: string;
	/** Fail *after* content was streamed: must not be retried. */
	errorAfterContent?: string;
}

interface FakeOptions {
	fetch: typeof fetch;
	signal?: AbortSignal;
	apiKey?: string;
}

/**
 * A provider stub that performs its "request" through the fetch the pool
 * injects, exactly like the Anthropic SDK does: the scripted responses are
 * what the injected fetch returns, and the stub reacts to their status the
 * way pi-ai reacts to the SDK result — non-2xx becomes an error event before
 * any content, 2xx streams the scripted text and completes.
 */
function makeFakeProvider(script: FakeStep[]): BaseStreamHost & { requests: FakeOptions[] } {
	const requests: FakeOptions[] = [];
	const responseFor = (step: FakeStep): Response => {
		const headers = new Headers({ "content-type": "application/json" });
		if (step.retryAfter !== undefined) headers.set("retry-after", step.retryAfter);
		return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), {
			status: step.status,
			headers,
		});
	};
	const runStep = (options: FakeOptions): AssistantMessageEventStream => {
		const step = script[Math.min(requests.length - 1, script.length - 1)]!;
		const stream = createAssistantMessageEventStream();
		void (async () => {
			// The pool wraps the caller's fetch; this call is the "HTTP request",
			// served from the script — never from the network.
			const response = await options.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" });
			void options.signal;
			if (response.status >= 400) {
				stream.push({
					type: "error",
					reason: "error",
					error: {
						role: "assistant",
						content: [],
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						stopReason: "error",
						errorMessage: `${response.status} {"type":"error","error":{"type":"rate_limit_error"}}`,
						timestamp: Date.now(),
					},
				} as unknown as AssistantMessageEvent);
				stream.end();
				return;
			}
			const message = {
				role: "assistant",
				content: [{ type: "text", text: step.text ?? "" }],
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: Date.now(),
			};
			if (step.errorAfterContent !== undefined) {
				stream.push({ type: "start", partial: message } as unknown as AssistantMessageEvent);
				stream.push({ type: "text_start", contentIndex: 0, partial: message } as unknown as AssistantMessageEvent);
				stream.push({
					type: "error",
					reason: "error",
					error: { ...message, stopReason: "error", errorMessage: step.errorAfterContent },
				} as unknown as AssistantMessageEvent);
				stream.end();
				return;
			}
			stream.push({ type: "start", partial: message } as unknown as AssistantMessageEvent);
			stream.push({ type: "text_start", contentIndex: 0, partial: message } as unknown as AssistantMessageEvent);
			stream.push({ type: "done", reason: "stop", message } as unknown as AssistantMessageEvent);
			stream.end();
		})();
		return stream;
	};
	return {
		// A minimal but well-formed provider object: the pool spreads it into
		// the registration, so the id must be present.
		id: "anthropic",
		name: "Anthropic (stub)",
		auth: {},
		getModels: () => [],
		// The scripted transport: tests pass this as the caller's fetch, so the
		// pool's capture wrapper wraps it and the stub never touches the network.
		fetch: (async (_input: unknown, _init?: unknown) => {
			const step = script[Math.min(requests.length - 1, script.length - 1)]!;
			return responseFor(step);
		}) as typeof fetch,
		requests,
		stream: (_model: never, _context: never, options: never) => {
			requests.push(options as unknown as FakeOptions);
			return runStep(options as unknown as FakeOptions);
		},
		streamSimple: (_model: never, _context: never, options: never) => {
			requests.push(options as unknown as FakeOptions);
			return runStep(options as unknown as FakeOptions);
		},
	} as unknown as BaseStreamHost & { requests: FakeOptions[] };
}

function stubPi(): { pi: ExtensionAPI; providers: Record<string, Record<string, unknown>>; unregistered: string[] } {
	const providers: Record<string, Record<string, unknown>> = {};
	const unregistered: string[] = [];
	const pi = {
		// Handles both registration forms: a full provider object and the
		// string + config pair.
		registerProvider: (idOrProvider: string | Record<string, unknown>, config?: Record<string, unknown>) => {
			if (typeof idOrProvider === "string") {
				providers[idOrProvider] = { ...(providers[idOrProvider] ?? {}), ...config };
			} else {
				const id = String(idOrProvider.id);
				providers[id] = { ...(providers[id] ?? {}), ...idOrProvider };
			}
		},
		unregisterProvider: (name: string) => {
			unregistered.push(name);
			delete providers[name];
		},
	} as unknown as ExtensionAPI;
	return { pi, providers, unregistered };
}

async function collect(stream: AssistantMessageEventStream): Promise<{ events: AssistantMessageEvent[]; result: unknown }> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, result: await stream.result() };
}

function modelName(): never {
	return { id: "claude-opus-5", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://api.anthropic.com" } as never;
}

resetSuspectCredentialsForTesting();
resetPoolStateForTesting();
resetPoolsFileForTesting();
{
	// A user-defined pool named anything (not "anthropic") registers a fresh
	// provider under that name.
	const store = await makeStore("personal", ["personal", "work"]);
	const fake = makeFakeProvider([
		{ status: 429, retryAfter: "1" },
		{ status: 200, text: "hello from work" },
	]);
	const { pi, providers } = stubPi();
	const runtime = createPoolRuntime(pi, store, { baseProvider: fake, refreshAdapter: testAdapter });
	// Persist then register, the way /pool-create does: poolFirstPick reads the
	// stored definition to answer "who serves the next request".
	upsertPool({ name: "team", accounts: ["personal", "work"] });
	runtime.registerPool({ name: "team", accounts: ["personal", "work"] });

	const registered = providers["team"]!;
	assert.ok(registered, "the pool registers a provider under the user's name");
	assert.equal(typeof registered.stream, "function", "with a stream override");
	assert.equal(typeof registered.streamSimple, "function", "…and streamSimple");
	assert.equal(isPoolProvider("team"), true, "the pool provider id is discoverable");

	const { events, result } = await collect((registered.stream as BaseStreamHost["stream"])(modelName(), {}, { fetch: fake.fetch }));
	const done = events.at(-1) as { type: string; message?: { content: Array<{ text?: string }> } };
	assert.equal(done.type, "done");
	assert.equal(done.message?.content[0]?.text, "hello from work");
	assert.deepEqual(
		events.map((event) => event.type),
		["start", "text_start", "done"],
		"the failed attempt's error event never reaches the caller",
	);
	assert.equal((result as { content: Array<{ text?: string }> }).content[0]?.text, "hello from work");
	assert.equal(lastPoolAccount(), "work", "the pool reports which account served the request");
	assert.equal(lastPoolAccount("team"), "work", "…and reports it per pool, so two pools cannot cross-report");
	assert.equal(lastPoolAccount("other-pool"), undefined, "a pool that never ran reports nothing");

	const notices = drainPoolNotices();
	assert.equal(notices.length, 1);
	assert.match(notices[0]!.message, /Pool "team": account "personal" failed \(429\); retrying with "work"/);
	// The rotation moved to the account that answered; nothing is scheduled,
	// nothing expires.
	assert.equal(poolFirstPick("team", await store.readProviderAsync("anthropic")), "work", "rotation now starts at work");

	// The next request starts there instead of retrying the failed account.
	await collect((registered.stream as BaseStreamHost["stream"])(modelName(), {}, { fetch: fake.fetch }));
	assert.equal(fake.requests[0]?.apiKey, "access-personal", "the first attempt used the first pool account");
	assert.equal(fake.requests[1]?.apiKey, "access-work", "failover used the second pool account");
	assert.equal(fake.requests[2]?.apiKey, "access-work", "the next request starts with the account that worked");
	assert.equal(fake.requests.length, 3, "and does not re-try the failed account first");

	// Unregistration removes the provider and the pool-provider marking.
	runtime.unregisterPool("team");
	assert.deepEqual(providers["team"], undefined);
	assert.equal(isPoolProvider("team"), false);
}
resetSuspectCredentialsForTesting();
resetPoolStateForTesting();
resetPoolsFileForTesting();

{
	// The pool only tries its own accounts, in definition order — an "all"
	// pool follows the store with the active account leading.
	const store = await makeStore("personal", ["personal", "work", "spare"]);
	const fake = makeFakeProvider([{ status: 200, text: "ok" }]);
	const { pi, providers } = stubPi();
	const runtime = createPoolRuntime(pi, store, { baseProvider: fake, refreshAdapter: testAdapter });
	runtime.registerPool({ name: "only-work", accounts: ["work", "personal"] });
	const registered = providers["only-work"]!;
	await collect((registered.stream as BaseStreamHost["stream"])(modelName(), {}, { fetch: fake.fetch }));
	assert.equal(fake.requests[0]?.apiKey, "access-work", "an explicit list keeps its order, whatever the active account");
	assert.equal(fake.requests.length, 1, "success on the first pick ends the request");

	runtime.registerPool({ name: "everything", accounts: "all" });
	const everything = providers["everything"]!;
	await collect((everything.stream as BaseStreamHost["stream"])(modelName(), {}, { fetch: fake.fetch }));
	assert.equal(fake.requests[1]?.apiKey, "access-personal", "an all-pool starts with the stored active account");
}
resetPoolStateForTesting();
resetPoolsFileForTesting();

{
	// A 401 marks the credential suspect, so the next resolution refreshes it.
	const store = await makeStore("personal", ["personal", "work"]);
	const refreshCalls: string[] = [];
	const adapter = {
		id: "anthropic",
		displayName: "Anthropic",
		oauth: {
			refresh: async (credential: { access: string }) => {
				refreshCalls.push(credential.access);
				return { type: "oauth" as const, access: `${credential.access}-r`, refresh: "r2", expires: Date.now() + 8 * HOUR };
			},
		},
	} as unknown as AccountProviderAdapter;
	// Both accounts fail: the pool reports the last provider error honestly.
	const fake = makeFakeProvider([
		{ status: 401 },
		{ status: 429 },
	]);
	const { pi, providers } = stubPi();
	const runtime = createPoolRuntime(pi, store, { baseProvider: fake, refreshAdapter: adapter });
	runtime.registerPool({ name: "team", accounts: "all" });
	const registered = providers["team"]!;

	const { events } = await collect((registered.stream as BaseStreamHost["stream"])(modelName(), {}, { fetch: fake.fetch }));
	const error = events.at(-1) as { type: string; error: { errorMessage: string } };
	assert.equal(error.type, "error");
	assert.match(error.error.errorMessage, /^429 /, "the last provider error is forwarded");

	assert.equal(isCredentialSuspect("anthropic", "personal"), true, "a 401 marks the credential for refresh");

	// Rotation moved past the 401'd account, so the next request would start at
	// "work". Reset the cursor to prove the other half of the contract: when the
	// rotation does come back around, the suspect credential is refreshed first
	// rather than replayed.
	resetPoolStateForTesting();
	const secondFake = makeFakeProvider([{ status: 200, text: "recovered" }]);
	const { pi: pi2, providers: providers2 } = stubPi();
	const runtime2 = createPoolRuntime(pi2, store, { baseProvider: secondFake, refreshAdapter: adapter });
	runtime2.registerPool({ name: "team", accounts: "all" });
	const registered2 = providers2["team"]!;
	const { result } = await collect((registered2.stream as BaseStreamHost["stream"])(modelName(), {}, { fetch: secondFake.fetch }));
	assert.equal((result as { content: Array<{ text?: string }> }).content[0]?.text, "recovered");
	assert.deepEqual(refreshCalls, ["access-personal"], "the suspect credential was refreshed before use");
	assert.equal(lastPoolAccount(), "personal", "the refreshed account served the request");
}
resetSuspectCredentialsForTesting();
resetPoolStateForTesting();
resetPoolsFileForTesting();

{
	// An error after content was streamed is forwarded as-is: retrying could
	// duplicate or diverge partial output.
	const store = await makeStore("personal", ["personal", "work"]);
	const fake = makeFakeProvider([{ status: 200, text: "partial", errorAfterContent: "connection reset" }]);
	const { pi, providers } = stubPi();
	const runtime = createPoolRuntime(pi, store, { baseProvider: fake, refreshAdapter: testAdapter });
	runtime.registerPool({ name: "team", accounts: "all" });
	const registered = providers["team"]!;

	const { events } = await collect((registered.stream as BaseStreamHost["stream"])(modelName(), {}, { fetch: fake.fetch }));
	assert.deepEqual(events.map((event) => event.type), ["start", "text_start", "error"]);
	assert.equal(fake.requests.length, 1, "no second attempt after content was forwarded");
	assert.deepEqual(drainPoolNotices(), [], "no failover happened, so nothing is queued");
}
resetPoolStateForTesting();
resetPoolsFileForTesting();

{
	// A 400 is a request problem, not an account problem: no failover.
	const store = await makeStore("personal", ["personal", "work"]);
	const fake = makeFakeProvider([{ status: 400 }]);
	const { pi, providers } = stubPi();
	const runtime = createPoolRuntime(pi, store, { baseProvider: fake, refreshAdapter: testAdapter });
	runtime.registerPool({ name: "team", accounts: "all" });
	const registered = providers["team"]!;
	const { events } = await collect((registered.stream as BaseStreamHost["stream"])(modelName(), {}, { fetch: fake.fetch }));
	assert.equal(fake.requests.length, 1, "a bad request is not retried on another account");
	assert.equal((events.at(-1) as { type: string }).type, "error");
}
resetPoolStateForTesting();
resetPoolsFileForTesting();

{
	// streamSimple is wrapped too, and an empty pool fails honestly.
	const store = await makeStore("personal", []);
	const fake = makeFakeProvider([{ status: 200, text: "simple" }]);
	const { pi, providers } = stubPi();
	const runtime = createPoolRuntime(pi, store, { baseProvider: fake, refreshAdapter: testAdapter });
	runtime.registerPool({ name: "team", accounts: "all" });
	const registered = providers["team"]!;
	const { events } = await collect((registered.streamSimple as BaseStreamHost["streamSimple"])(modelName(), {}, { fetch: fake.fetch }));
	const error = events.at(-1) as { type: string; error: { errorMessage: string } };
	assert.equal(error.type, "error");
	assert.match(error.error.errorMessage, /no usable accounts/);
	assert.equal(fake.requests.length, 0, "nothing to try, nothing was tried");
}
resetPoolStateForTesting();
resetPoolsFileForTesting();

{
	// REGRESSION: the native-override pool must NOT advertise OAuth auth.
	//
	// pi resolves a provider credential before it calls stream, and a stored
	// credential wins there. Inheriting the native provider's auth.oauth made a
	// stale `/login anthropic` credential reachable, and a dead one failed every
	// request with invalid_grant before a single pooled account was tried.
	const store = await makeStore("personal", ["personal"]);
	const fake = makeFakeProvider([{ status: 200, text: "native pool" }]);
	const { pi, providers } = stubPi();
	const runtime = createPoolRuntime(pi, store, { baseProvider: fake, refreshAdapter: testAdapter });
	runtime.registerPool({ name: NATIVE_POOL_NAME, accounts: "all" });
	const auth = (providers["anthropic"] as { auth?: Record<string, unknown> }).auth ?? {};
	assert.equal("oauth" in auth, false, "the pool must not offer an auth method it never uses");
	assert.equal(typeof auth.apiKey, "object", "…and must offer its own api-key resolution instead");
}
resetPoolStateForTesting();
resetPoolsFileForTesting();

{
	// A pool literally named "anthropic" overrides the native provider object.
	const store = await makeStore("personal", ["personal"]);
	const fake = makeFakeProvider([{ status: 200, text: "native pool" }]);
	const { pi, providers } = stubPi();
	const runtime = createPoolRuntime(pi, store, { baseProvider: fake, refreshAdapter: testAdapter });
	runtime.registerPool({ name: NATIVE_POOL_NAME, accounts: "all" });
	const registered = providers["anthropic"]!;
	assert.ok(registered, "the native id is taken over by the pool");
	assert.equal(typeof registered.stream, "function");
	await collect((registered.stream as BaseStreamHost["stream"])(modelName(), {}, { fetch: fake.fetch }));
	assert.equal(fake.requests[0]?.apiKey, "access-personal");
	assert.equal(lastPoolAccount(), "personal");
}
resetPoolStateForTesting();
resetPoolsFileForTesting();

{
	// PI_MULTI_ACCOUNT_FAILOVER=0 disables pool registration entirely.
	process.env.PI_MULTI_ACCOUNT_FAILOVER = "0";
	try {
		assert.equal(poolsEnabled(), false);
		const store = await makeStore("personal", ["personal"]);
		const fake = makeFakeProvider([{ status: 200, text: "native" }]);
		const { pi, providers } = stubPi();
		const runtime = createPoolRuntime(pi, store, { baseProvider: fake, refreshAdapter: testAdapter });
		runtime.registerPool({ name: "team", accounts: "all" });
		assert.equal(providers["team"], undefined, "nothing is registered when pools are disabled");
		assert.deepEqual(runtime.registeredPoolNames(), []);
	} finally {
		delete process.env.PI_MULTI_ACCOUNT_FAILOVER;
	}
}
resetPoolStateForTesting();
resetPoolsFileForTesting();

// The footer needs an account to show before the first request of a session:
// poolFirstPick answers "who serves the next request" from the definition and
// the current cooldowns, without making one.
resetPoolStateForTesting();
resetPoolsFileForTesting();
{
	const store = await makeStore("merchant", ["personal", "merchant", "work"]);
	const state = await store.readProviderAsync("anthropic");
	assert.equal(poolFirstPick("nope", state), undefined, "an unknown pool has no pick");

	upsertPool({ name: "anthropic", accounts: "all" });
	assert.equal(poolFirstPick("anthropic", state), "merchant", "an all-pool leads with the stored active account");

	upsertPool({ name: "ordered", accounts: ["work", "personal"] });
	assert.equal(poolFirstPick("ordered", state), "work", "an explicit pool leads with its first entry");
}
resetPoolStateForTesting();
resetPoolsFileForTesting();

assert.equal(unexpectedRefreshes, 0, "no test scenario should reach for a token refresh");
console.log("ok: pool definitions, rotation order, failover, no-retry-after-content, disable switch");
