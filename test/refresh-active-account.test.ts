/**
 * The account in use has no pin. A catalogue refresh used to walk only pinned
 * aliases, so the plain `anthropic` provider kept the list it had at open and a
 * newly published model never appeared — the PI WEB report behind this file.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PmaEngine } from "../src/core/engine.ts";

process.env.PI_OFFLINE = "";
const dir = mkdtempSync(join(tmpdir(), "pma-refresh-active-"));
const requested: string[] = [];

// One stored account, active, and an endpoint that lists a model the built-ins do not have.
writeFileSync(
	join(dir, "pi-accounts.json"),
	JSON.stringify({
		version: 1,
		providers: { anthropic: { active: "work", accounts: { work: { type: "oauth", access: "sk-ant-oat-x", refresh: "r", expires: Date.now() + 3_600_000 } } } },
	}),
);
const fetchStub = (async (input: RequestInfo | URL) => {
	const url = String(input);
	requested.push(url);
	if (url.includes("/v1/models"))
		return new Response(
			JSON.stringify({ data: [{ id: "claude-from-vendor-catalog", display_name: "Vendor", created_at: "2026-01-01T00:00:00Z", type: "model" }] }),
			{ headers: { "content-type": "application/json" } },
		);
	return new Response("{}", { headers: { "content-type": "application/json" } });
}) as typeof fetch;

test("refresh reaches the active, unpinned account", async () => {
	const engine = new PmaEngine(dir, { fetch: fetchStub });
	await engine.syncAccounts();
	assert.ok(engine.models.getProvider("anthropic"), "the active account is registered as the plain provider");

	await engine.refresh({ force: true, timeoutMs: 5_000 });
	// Before any listing: the refresh itself must have asked, not a later getAvailable().
	assert.ok(
		requested.some((url) => url.includes("api.anthropic.com/v1/models")),
		`refresh asked for the active account's catalogue; requested=${JSON.stringify(requested)}`,
	);
	const ids = (await engine.models.getAvailable()).map((m) => m.id);
	assert.ok(ids.includes("claude-from-vendor-catalog"), `the vendor's new model is available; got ${JSON.stringify(ids)}`);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
