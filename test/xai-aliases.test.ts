/**
 * The xAI aliases.
 *
 * Three things here were each a silent failure once, so each has an assertion: a subscription
 * token is refused by `api.x.ai` and only the Grok CLI proxy answers it, that proxy refuses a
 * request without a client version, and pi's resolver crashes unless every model carries its
 * provider id.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "pi-multi-account-xai-"));
delete process.env.PI_CODING_AGENT_DIR;
process.env.PI_MULTI_ACCOUNT_LOG = "0";

import { AccountStore } from "@narumitw/pi-accounts/src/account-store.ts";
import { InMemoryAccountStorageBackend } from "@narumitw/pi-accounts/src/storage.ts";
import { registerXaiAliasProviders } from "../src/xai-aliases.ts";

const store = new AccountStore(new InMemoryAccountStorageBackend());
const HOUR = 60 * 60 * 1000;
await store.updateProviderAsync("xai", async () => ({
	active: "work",
	accounts: {
		work: { type: "oauth" as const, access: "access-work", refresh: "refresh-work", expires: Date.now() + 4 * HOUR },
		home: { type: "oauth" as const, access: "access-home", refresh: "refresh-home", expires: Date.now() + 4 * HOUR },
	},
}));

type Registered = {
	id: string;
	baseUrl?: string;
	getModels?: () => Array<Record<string, unknown>>;
	stream?: unknown;
	auth: {
		apiKey: {
			resolve: (args: { signal: AbortSignal }) => Promise<{ auth: { apiKey: string }; source: string } | undefined>;
		};
	};
};
const registered = new Map<string, Registered>();
const removed: string[] = [];
const pi = {
	registerProvider: (provider: Registered) => registered.set(provider.id, provider),
	unregisterProvider: (id: string) => {
		removed.push(id);
		registered.delete(id);
	},
} as never;

const aliases = registerXaiAliasProviders(pi, store);
await aliases.bootstrap();

// One alias per account, plus the active-account alias that follows the store.
assert.deepEqual([...registered.keys()].sort(), ["xai", "xai-home", "xai-work"]);

// Each alias resolves its own account's token, never whichever account is active.
const { signal } = new AbortController();
assert.equal((await registered.get("xai-work")!.auth.apiKey.resolve({ signal }))?.auth.apiKey, "access-work");
assert.equal((await registered.get("xai-home")!.auth.apiKey.resolve({ signal }))?.auth.apiKey, "access-home", "a pinned alias ignores the active account");
assert.equal((await registered.get("xai")!.auth.apiKey.resolve({ signal }))?.auth.apiKey, "access-work", "the active alias follows the store");

const work = registered.get("xai-work")!;
assert.equal(work.baseUrl, "https://cli-chat-proxy.grok.com/v1", "the subscription host, not api.x.ai");

const models = work.getModels?.() ?? [];
assert.ok(models.length > 0, "the account's models are offered");
for (const model of models) {
	assert.equal(model.provider, "xai-work", `${String(model.id)} carries its provider, or pi's resolver throws`);
	assert.equal(model.baseUrl, "https://cli-chat-proxy.grok.com/v1");
	const headers = model.headers as Record<string, string> | undefined;
	// The proxy answers 426 "your Grok CLI version (none) is outdated" without this.
	assert.match(headers?.["x-grok-client-version"] ?? "", /^\d+\.\d+\.\d+$/, `${String(model.id)} names a client version`);
}
assert.equal(typeof work.stream, "function", "the alias streams through pi's provider");

// The env var may raise the claimed version, never lower it.
process.env.PI_MULTI_ACCOUNT_GROK_CLI_VERSION = "1.4.2";
await aliases.bootstrap();
const raised = (registered.get("xai-work")!.getModels?.() ?? [])[0] as { headers: Record<string, string> };
assert.equal(raised.headers["x-grok-client-version"], "1.4.2");

process.env.PI_MULTI_ACCOUNT_GROK_CLI_VERSION = "tin";
await aliases.bootstrap();
const noted = (registered.get("xai-work")!.getModels?.() ?? [])[0] as { headers: Record<string, string> };
assert.equal(noted.headers["x-grok-client-version"], "1.0.13", "a malformed floor is dropped");

// Losing an account takes its alias with it on the next sync.
const fakeCtx = {
	modelRegistry: {
		getAll: () => [],
		getRegisteredProviderIds: () => [...registered.keys()],
	},
} as never;
await store.updateProviderAsync("xai", async (state) => ({ ...state, accounts: { work: state.accounts.work! } }));
await aliases.sync(fakeCtx);
assert.deepEqual([...registered.keys()].sort(), ["xai", "xai-work"], "the removed account's alias is gone");
assert.ok(removed.includes("xai-home"));

aliases.stop();
console.log("xai-aliases.test.ts ok");
