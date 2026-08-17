import assert from "node:assert/strict";
import { AccountStore } from "@narumitw/pi-accounts/src/account-store.ts";
import { InMemoryAccountStorageBackend } from "@narumitw/pi-accounts/src/storage.ts";
import { parseNameList } from "./names.ts";
import { importClaudeAccounts } from "./subscription-import.ts";

const detected = (label: string, tier: string) => ({
	client: "claude-code" as const,
	label,
	source: "keychain",
	credentials: { accessToken: "sk-ant-oat01-x", refreshToken: "sk-ant-ort01-x", expiresAt: Date.now() + 3_600_000, subscriptionType: tier },
});

assert.deepEqual(parseNameList("work, personal"), ["work", "personal"]);
assert.deepEqual(parseNameList(undefined), []);

// User-chosen names win.
let store = new AccountStore(new InMemoryAccountStorageBackend());
let imported = await importClaudeAccounts(store, [detected("a@x.com", "max"), detected("b@x.com", "pro")], ["work", "personal"]);
assert.deepEqual(imported, ["work", "personal"]);
assert.deepEqual(Object.keys((await store.readProviderAsync("anthropic")).accounts), ["work", "personal"]);
assert.equal((await store.readProviderAsync("anthropic")).active, "work");

// Blank slots fall back to generated names, chosen names still honored.
store = new AccountStore(new InMemoryAccountStorageBackend());
imported = await importClaudeAccounts(store, [detected("a@x.com", "max"), detected("b@x.com", "pro")], ["", "personal"]);
assert.deepEqual(imported, ["cc-max", "personal"]);

// No names at all keeps the legacy generated naming.
store = new AccountStore(new InMemoryAccountStorageBackend());
imported = await importClaudeAccounts(store, [detected("a@x.com", "max"), detected("b@x.com", "pro")], []);
assert.deepEqual(imported, ["cc-max", "cc-pro"]);

// Invalid names are rejected rather than silently mangled.
store = new AccountStore(new InMemoryAccountStorageBackend());
await assert.rejects(() => importClaudeAccounts(store, [detected("a@x.com", "max")], ["bad name!"]), /Invalid account name/);

console.log("ok: import naming");
