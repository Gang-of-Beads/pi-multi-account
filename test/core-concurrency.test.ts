import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
process.env.PI_MULTI_ACCOUNT_LOG = "0";
const { LocklessReadAccountStore } = await import("../src/account-store.ts");
const { refreshAccountCredential } = await import("../src/refresh.ts");
const dir = mkdtempSync(join(tmpdir(), "pma-refresh-v1-"));
const file = join(dir, "pi-accounts.json");
const expired = { type: "oauth" as const, access: "fixture-expired", refresh: "fixture-refresh", expires: 1 };
const fresh = { type: "oauth" as const, access: "fixture-new", refresh: "fixture-refresh-new", expires: Date.now() + 3_600_000 };
const seed = () =>
	writeFileSync(file, JSON.stringify({ version: 1, providers: { anthropic: { active: "work", accounts: { work: expired } } } }));
{
	seed();
	const store = new LocklessReadAccountStore(file);
	let rotations = 0;
	const adapter = {
		id: "anthropic",
		oauth: {
			refresh: async () => {
				rotations++;
				return fresh;
			},
		},
	} as never;
	const results = await Promise.all(
		Array.from({ length: 30 }, (_, i) => refreshAccountCredential(store, adapter, "work", expired, Date.now(), { force: i % 2 === 0 })),
	);
	assert.equal(rotations, 1, "force/due callers share one rotation, not two flights");
	assert.ok(results.every((c) => c.access === fresh.access));
	assert.equal(JSON.parse(readFileSync(file, "utf8")).providers.anthropic.accounts.work.refresh, fresh.refresh);
}
{
	seed();
	let rotations = 0;
	const adapter = {
		id: "anthropic",
		oauth: {
			refresh: async () => {
				rotations++;
				return fresh;
			},
		},
	} as never;
	await Promise.all(
		[new LocklessReadAccountStore(file), new LocklessReadAccountStore(file)].map((store) =>
			refreshAccountCredential(store, adapter, "work", expired),
		),
	);
	assert.equal(rotations, 1, "separate store instances serialize the network rotation via the per-account lock");
}
{
	seed();
	let calls = 0;
	const upstream = createServer((_req, res) => {
		calls++;
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(fresh));
	});
	await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
	const address = upstream.address() as { port: number };
	const workers = Array.from({ length: 2 }, () => {
		const child = spawn(
			process.execPath,
			[fileURLToPath(new URL("./fixtures/refresh-worker.mjs", import.meta.url)), dir, `http://127.0.0.1:${address.port}`],
			{ stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PI_MULTI_ACCOUNT_LOG: "0" } },
		);
		let output = "";
		let errors = "";
		child.stderr.on("data", (b) => {
			errors += b;
		});
		const ready = new Promise<void>((resolve, reject) => {
			child.stdout.on("data", (b) => {
				output += b;
				if (output.includes("ready\n")) resolve();
			});
			child.once("error", reject);
			child.once("exit", (code) => {
				if (!output.includes("ready\n")) reject(new Error(`Worker exited ${code}: ${errors.slice(-500)}`));
			});
		});
		const done = new Promise<void>((resolve, reject) => {
			child.once("exit", (code) =>
				code === 0 && output.includes("done\n") ? resolve() : reject(new Error(`Worker exited ${code}: ${errors.slice(-500)}`)),
			);
		});
		return { child, ready, done };
	});
	try {
		await Promise.all(workers.map((w) => w.ready));
		for (const w of workers) w.child.stdin.end("go\n");
		await Promise.all(workers.map((w) => w.done));
		assert.equal(calls, 1, "two real OS processes never reuse a rotating refresh token concurrently");
	} finally {
		for (const w of workers) if (w.child.exitCode === null) w.child.kill("SIGKILL");
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
	}
}
console.log("ok: refresh concurrency (30 callers, force/due, separate stores, real child processes)");
