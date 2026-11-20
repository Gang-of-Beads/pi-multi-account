import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PmaEngine } from "../src/core/engine.ts";
import { registerPiProviders } from "../src/pi-adapter.ts";
process.env.PI_OFFLINE = "1";
process.env.PI_MULTI_ACCOUNT_LOG = "0";
const dir = mkdtempSync(join(tmpdir(), "pma-entrypoint-v1-"));
{
	const providers = new Map<string, unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
	const notices: string[] = [];
	let shownSecret = "";
	const pi = {
		registerProvider: (p: { id: string }) => providers.set(p.id, p),
		unregisterProvider: (id: string) => providers.delete(id),
		registerCommand: (name: string, c: { handler: (args: string, ctx: never) => Promise<void> }) => commands.set(name, c),
	};
	const engine = new PmaEngine(dir, { providers: [] });
	const binding = registerPiProviders(pi as never, engine, { networkOnBootstrap: false });
	await binding.bootstrap();
	const ctx = {
		hasUI: true,
		modelRegistry: { getRegisteredProviderIds: () => [...providers.keys()], getProvider: () => undefined },
		ui: {
			notify: (m: string) => notices.push(m),
			editor: async (_title: string, secret: string) => {
				shownSecret = secret;
				return undefined;
			},
		},
	} as never;
	assert.ok(commands.has("pma-models") && commands.has("routes") && commands.has("gateway"));
	assert.ok(providers.has("pma"), "routes use Pi's provider registration API");
	assert.equal(
		existsSync(join(dir, "pi-multi-account-gateway-owner.json")),
		false,
		"loading a pure extension never starts or claims a listener",
	);
	await commands.get("gateway")!.handler("key test-client", ctx);
	assert.match(shownSecret, /^pmak_/);
	assert.ok(
		notices.every((n) => !n.includes(shownSecret)),
		"a caller secret never enters notifications or chat",
	);
	await commands.get("gateway")!.handler("start 0", ctx);
	const url = notices.at(-1)!.match(/http:\/\/127\.0\.0\.1:\d+/)![0];
	assert.equal((await fetch(`${url}/healthz`)).status, 200);
	binding.watchStore(ctx);
	await binding.stop();
	await binding.stop();
	await assert.rejects(fetch(`${url}/healthz`));
	assert.equal(JSON.parse(readFileSync(join(dir, "pi-multi-account-gateway-owner.json"), "utf8")), null);
}
{
	// Shutdown or stop while the listener is still starting must not leave an orphan listener behind.
	const data = mkdtempSync(join(tmpdir(), "pma-entrypoint-race-"));
	const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
	const binding = registerPiProviders(
		{
			registerProvider: () => undefined,
			unregisterProvider: () => undefined,
			registerCommand: (n: string, c: never) => commands.set(n, c),
		} as never,
		new PmaEngine(data, { providers: [] }),
		{ networkOnBootstrap: false },
	);
	await binding.bootstrap();
	const ctx = {
		hasUI: true,
		modelRegistry: { getRegisteredProviderIds: () => [], getProvider: () => undefined },
		ui: { notify: () => undefined, editor: async () => undefined },
	} as never;
	const starting = commands
		.get("gateway")!
		.handler("start 0", ctx)
		.then(() => "resolved" as const)
		.catch(() => "cancelled" as const);
	const stopping = binding.stop();
	assert.equal(await starting, "cancelled", "a startup interrupted by shutdown reports that it did not stay up");
	await stopping;
	const owner = join(data, "pi-multi-account-gateway-owner.json");
	assert.ok(
		!existsSync(owner) || JSON.parse(readFileSync(owner, "utf8")) === null,
		"an interrupted startup never leaves a live owner behind",
	);
	await assert.rejects(commands.get("gateway")!.handler("start 0", ctx), /ended/);
	await binding.stop();
}
{
	const cli = fileURLToPath(new URL("../bin/pi-multi-account.mjs", import.meta.url));
	const data = mkdtempSync(join(tmpdir(), "pma-standalone-v1-"));
	const child = spawn(process.execPath, [cli, "serve", "--agent-dir", data, "--port", "0"], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, HOME: data, PI_CODING_AGENT_DIR: data, PI_OFFLINE: "1" },
	});
	let output = "";
	let errors = "";
	child.stderr.on("data", (b) => {
		errors += b;
	});
	const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
	const started = new Promise<string>((resolve, reject) => {
		child.stdout.on("data", (b) => {
			output += b;
			const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
			if (url) resolve(url);
		});
		child.once("error", reject);
		child.once("exit", (code) => reject(new Error(`Standalone exited ${code}: ${errors.slice(-600)}`)));
	});
	try {
		const url = await started;
		assert.equal((await fetch(`${url}/healthz`)).status, 200);
		assert.equal((await fetch(`${url}/v1/models`)).status, 401);
		assert.ok(!output.includes("pmak_"), "serve never prints or auto-mints a credential");
		child.kill("SIGTERM");
		assert.equal(await exited, 0);
		assert.equal(JSON.parse(readFileSync(join(data, "pi-multi-account-gateway-owner.json"), "utf8")), null);
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
}
console.log("ok: Pi adapter and standalone CLI (explicit listeners, private key UI, ownership, shutdown)");
