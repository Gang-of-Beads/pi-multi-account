import { readFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseArgs } from "node:util";
import { PmaEngine } from "./core/engine.ts";
import { readRoutes, saveRoute, parseTarget } from "./core/routes.ts";
import { addProviderDef, readProviderDefs, removeProviderDef } from "./core/provider-defs.ts";
import { readJson } from "./core/storage.ts";
import { createCallerKey, revokeCallerKey, keysPath } from "./gateway/access.ts";
import { startGateway } from "./gateway/server.ts";

const HELP = `pi-multi-account
  serve [--host 127.0.0.1] [--port 8787]     Start the optional HTTP gateway
  models [refresh]                          List or refresh account models
  route add <id> <provider/model[:api]>...   Save an ordered route (api: anthropic-messages | openai-completions | openai-responses)
  provider list                             List user-defined providers (never keys)
  provider add [<file|->]                    Add one from JSON (file, stdin, or as the next argument)
  provider remove <id>                       Delete a definition
  route list                               List routes (edit JSON for other modes)
  key create <name> [route...] [--admin]     Print a new key once; default scope: *
  key list                                 List key metadata, never secrets
  key revoke <id>                           Revoke a key

Shared data directory: Pi's agent dir, or --agent-dir <path>.
The gateway never executes tools or starts an agent session.
`;
export async function main(argv: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			host: { type: "string" },
			port: { type: "string" },
			"agent-dir": { type: "string" },
			admin: { type: "boolean" },
			help: { type: "boolean" },
		},
	});
	const [command, action, ...rest] = positionals;
	if (values["agent-dir"]) process.env.PI_CODING_AGENT_DIR = values["agent-dir"];
	const dir = getAgentDir();
	if (!command || values.help) {
		process.stdout.write(HELP);
		return;
	}
	if (command === "key") {
		if (action === "create") {
			const [name, ...routes] = rest;
			const { secret } = await createCallerKey(dir, name ?? "client", { routes: routes.length ? routes : ["*"], admin: values.admin });
			process.stdout.write(`${secret}\n`);
		} else if (action === "revoke" && rest[0]) await revokeCallerKey(dir, rest[0]);
		else if (action === "list") {
			const file = readJson<{ keys: { id: string; name: string; routes: string[]; expires?: number }[] }>(keysPath(dir), { keys: [] });
			process.stdout.write(
				`${JSON.stringify(
					file.keys.map(({ id, name, routes, expires }) => ({ id, name, routes, expires })),
					null,
					2,
				)}\n`,
			);
		} else throw new Error("Use key create <name> [route...], key list, or key revoke <id>");
		return;
	}
	if (command === "provider") {
		if (action === "list") {
			const file = readProviderDefs(dir);
			process.stdout.write(
				`${JSON.stringify(
					file.providers.map(({ id, name, api, baseUrl, models, auth }) => ({ id, name, api, baseUrl, models: models.length, auth: auth.kind })),
					null,
					2,
				)}\n`,
			);
		} else if (action === "remove" && rest[0]) {
			if (!(await removeProviderDef(dir, rest[0]))) throw new Error(`no provider "${rest[0]}"`);
			process.stdout.write(`removed ${rest[0]}\n`);
		} else if (action === "add") {
			// From a file, stdin (`-`), or the argument itself: the definition is JSON, pasted whole when inline.
			const readStdin = async (): Promise<string> =>
				process.stdin.isTTY ? "" : new Promise<string>((resolve) => {
					let text = "";
					process.stdin.on("data", (chunk: Buffer) => { text += chunk.toString(); });
					process.stdin.on("end", () => { resolve(text); });
				});
			const input = rest.join(" ");
			const text = (input === "-" || input === "" ? await readStdin() : input.startsWith("{") ? input : readFileSync(input, "utf8")).trim();
			if (!text) throw new Error("provider add needs a definition: a file path, - for stdin, or the JSON itself");
			const added = await addProviderDef(dir, JSON.parse(text) as unknown);
			process.stdout.write(`added ${added.id} (${added.api}, ${added.models.length} models)\n`);
		} else throw new Error("Use provider list, provider add <file|->, or provider remove <id>");
		return;
	}
	if (command === "route") {
		if (action === "add") {
			const [id, ...inputs] = rest;
			const targets = inputs.map(parseTarget);
			await saveRoute(dir, { id, mode: "order", targets, translate: true });
		} else if (action !== "list") throw new Error("Use route add <id> <provider[@account]/model[:api]>... or route list");
		process.stdout.write(`${JSON.stringify(readRoutes(dir), null, 2)}\n`);
		return;
	}
	const engine = new PmaEngine(dir);
	await engine.initialize({ network: command === "serve" || action === "refresh", timeoutMs: 8000 });
	if (command === "models") {
		const models = await engine.models.getAvailable();
		process.stdout.write(`${models.map((m) => `${m.provider}/${m.id}`).join("\n")}\n`);
		return;
	}
	if (command !== "serve") throw new Error(`Unknown command: ${command}`);
	readRoutes(dir); // A malformed route table must not silently expose another set of routes.
	const handle = await startGateway(engine, { host: values.host, port: values.port === undefined ? undefined : Number(values.port) });
	process.stdout.write(`pi-multi-account gateway listening on ${handle.url}\n`);
	let refreshing = false;
	const interval = setInterval(() => {
		if (!refreshing) {
			refreshing = true;
			void engine
				.syncAccounts()
				.then(() => engine.refresh())
				.catch(() => undefined)
				.finally(() => {
					refreshing = false;
				});
		}
	}, 15 * 60_000);
	await new Promise<void>((resolve) => {
		const done = () => {
			process.off("SIGTERM", done);
			process.off("SIGINT", done);
			resolve();
		};
		process.once("SIGTERM", done);
		process.once("SIGINT", done);
	});
	clearInterval(interval);
	await handle.close();
}
