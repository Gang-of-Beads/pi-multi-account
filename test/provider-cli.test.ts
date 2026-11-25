import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "pma-provider-cli-"));
const run = (args: string[], stdin?: string) =>
	execFileSync(process.execPath, ["bin/pi-multi-account.mjs", ...args, "--agent-dir", dir], {
		encoding: "utf8",
		...(stdin === undefined ? {} : { input: stdin }),
	});
const definition = JSON.stringify({ id: "relay", api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", auth: { kind: "env", env: "RELAY_KEY" }, models: [{ id: "m" }] });

test("provider add takes the JSON inline and from stdin, and list never prints the key", () => {
	assert.match(run(["provider", "add", definition]), /added relay/);
	assert.match(run(["provider", "add", "-"], definition.replace("relay", "second")), /added second/);
	const listed = run(["provider", "list"]);
	assert.match(listed, /"id": "relay"/);
	assert.equal(listed.includes("sk-"), false);
	assert.throws(() => run(["provider", "remove", "missing"]), /no provider "missing"/);
	assert.match(run(["provider", "remove", "second"]), /removed second/);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
