import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { watch, statSync, type FSWatcher } from "node:fs";
import type { AccountStore } from "@narumitw/pi-accounts/src/accounts.ts";
import { PmaEngine } from "./core/engine.ts";
import { readRoutes, RouteRouter, saveRoute, parseTarget } from "./core/routes.ts";
import { createCallerKey } from "./gateway/access.ts";
import { startGateway, type GatewayHandle } from "./gateway/server.ts";
import { logError } from "./debug-log.ts";

// Pi-web can retain registered provider objects across sessions. Their shared core must outlive
// any one session; only watchers/listeners below belong to the extension instance.
const engines = new Map<string, PmaEngine>();
export function sharedEngine(store?: AccountStore): PmaEngine {
	const dir = getAgentDir();
	let engine = engines.get(dir);
	if (!engine) {
		engine = new PmaEngine(dir, { store });
		engines.set(dir, engine);
	}
	return engine;
}
export function registerPiProviders(
	pi: ExtensionAPI,
	engine: PmaEngine,
	options: { families?: string[]; skipNativeAnthropic?: () => boolean; commands?: boolean; networkOnBootstrap?: boolean } = {},
) {
	const router = new RouteRouter(engine);
	let registered = new Set<string>();
	let watcher: FSWatcher | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let gateway: GatewayHandle | undefined;
	let starting: Promise<GatewayHandle> | undefined;
	let lifecycle = 0;
	let debounce: ReturnType<typeof setTimeout> | undefined;
	let context: ExtensionContext | undefined;
	let syncing: Promise<void> | undefined;
	let stopped = false;
	let lastRefresh = Date.now();
	let snapshot = "";
	const fileSnapshot = () =>
		["pi-accounts.json", "pi-multi-account-routes.json"]
			.map((name) => {
				try {
					const s = statSync(`${engine.agentDir}/${name}`);
					return `${s.ino}:${s.mtimeMs}:${s.size}`;
				} catch {
					return "missing";
				}
			})
			.join("|");
	function enabled(id: string): boolean {
		const family = engine.canonicalProvider(id);
		return (
			process.env.PI_MULTI_ACCOUNT_ALIASES !== "0" &&
			(!options.families || options.families.includes(family)) &&
			!(family === "xai" && process.env.PI_MULTI_ACCOUNT_XAI_ALIASES === "0") &&
			!(id === "anthropic" && options.skipNativeAnthropic?.())
		);
	}
	function publish(ctx?: ExtensionContext): void {
		const wanted = new Set<string>();
		if (!options.families)
			for (const provider of engine.dynamicProviders) {
				if (provider.id === "anthropic" && options.skipNativeAnthropic?.()) continue;
				wanted.add(provider.id);
				pi.registerProvider(provider);
			}
		for (const provider of engine.accountProviders)
			if (enabled(provider.id)) {
				wanted.add(provider.id);
				pi.registerProvider(provider);
			}
		for (const id of registered) if (!wanted.has(id) && !(id === "anthropic" && options.skipNativeAnthropic?.())) pi.unregisterProvider(id);
		if (ctx)
			for (const id of ctx.modelRegistry.getRegisteredProviderIds()) {
				const family = ["anthropic", "codex", "xai", "copilot"].find((prefix) => id.startsWith(`${prefix}-`));
				if (
					family &&
					(!options.families ||
						options.families.includes(family === "codex" ? "openai-codex" : family === "copilot" ? "github-copilot" : family)) &&
					!wanted.has(id)
				)
					pi.unregisterProvider(id);
			}
		registered = wanted;
		if (options.commands !== false) {
			const routes = readRoutes(engine.agentDir).routes;
			pi.registerProvider(router.provider(routes));
		}
	}
	async function sync(ctx?: ExtensionContext, refresh = false): Promise<void> {
		if (ctx) context = ctx;
		if (syncing) return syncing;
		return (syncing = (async () => {
			await engine.syncAccounts();
			if (context)
				for (const id of context.modelRegistry.getRegisteredProviderIds()) {
					if (id === "pma" || engine.accountProviders.some((p) => p.id === id) || id === "anthropic") continue;
					const provider = context.modelRegistry.getProvider?.(id);
					if (provider) engine.importProvider(provider);
				}
			if (refresh) {
				await engine.refresh();
				lastRefresh = Date.now();
			}
			if (!stopped) publish(context);
		})().finally(() => {
			syncing = undefined;
		}));
	}
	function watchStore(ctx: ExtensionContext): void {
		stopped = false;
		context = ctx;
		if (timer) return;
		try {
			watcher = watch(engine.agentDir, (_event, file) => {
				if (!file || !["pi-accounts.json", "pi-multi-account-routes.json"].includes(String(file))) return;
				if (debounce) clearTimeout(debounce);
				debounce = setTimeout(() => {
					if (!stopped)
						void sync(undefined, true).catch(() => logError("catalog.sync_failed", { detail: "Retained previous model registrations" }));
				}, 200);
			});
		} catch {
			/* The periodic refresh also catches missed filesystem events. */
		}
		snapshot = fileSnapshot();
		timer = setInterval(() => {
			const next = fileSnapshot();
			if (stopped || (next === snapshot && Date.now() - lastRefresh < 15 * 60_000)) return;
			snapshot = next;
			void sync(undefined, true).catch(() => logError("catalog.sync_failed", { detail: "Retained previous model registrations" }));
		}, 2000);
		timer.unref?.();
	}
	async function closeGateway(): Promise<void> {
		lifecycle++;
		const pending = starting;
		const owned = gateway;
		gateway = undefined;
		await owned?.close();
		if (pending) await (await pending.catch(() => undefined))?.close();
	}
	async function stop(): Promise<void> {
		stopped = true;
		watcher?.close();
		watcher = undefined;
		if (timer) clearInterval(timer);
		timer = undefined;
		if (debounce) clearTimeout(debounce);
		debounce = undefined;
		await closeGateway();
		context = undefined;
	}
	if (options.commands !== false) {
		for (const name of ["anthropic-account-providers", "codex-account-providers"])
			pi.registerCommand(name, {
				description: "Refresh named-account providers (compatibility alias)",
				handler: async (_args, ctx) => {
					await engine.syncAccounts();
					const result = await engine.refresh({ force: true });
					await sync(ctx);
					ctx.ui.notify(
						result.errors.length ? result.errors.join("\n") : "Account providers refreshed.",
						result.errors.length ? "warning" : "info",
					);
				},
			});
		pi.registerCommand("pma-models", {
			description: "Refresh the live subscription model catalogs",
			handler: async (_args, ctx) => {
				await engine.syncAccounts();
				const result = await engine.refresh({ force: true });
				await sync(ctx);
				ctx.ui.notify(
					result.errors.length ? result.errors.join("\n") : "Model catalogs refreshed.",
					result.errors.length ? "warning" : "info",
				);
			},
		});
		pi.registerCommand("routes", {
			description: "List routes, or /routes add <id> <provider[@account]/model>...",
			handler: async (args, ctx) => {
				const [action, id, ...targets] = args.trim().split(/\s+/);
				if (action === "add") {
					const parsed = targets.map(parseTarget);
					await saveRoute(engine.agentDir, { id, mode: "order", targets: parsed, translate: true });
					await sync(ctx);
				}
				const routes = readRoutes(engine.agentDir).routes;
				ctx.ui.notify(
					routes.length
						? routes
								.map(
									(r) =>
										`${r.id} (${r.mode}): ${r.targets.map((t) => `${t.provider}${t.account ? `@${t.account}` : ""}/${t.model}`).join(" → ")}`,
								)
								.join("\n")
						: "No routes. Add one with /routes add daily codex/gpt-6.2-sol xai/grok-4.7",
					"info",
				);
			},
		});
		pi.registerCommand("gateway", {
			description: "Optional HTTP listener: /gateway start [port], stop, status, key <name> [routes...]",
			handler: async (args, ctx) => {
				const [action = "status", value, ...scopes] = args.trim().split(/\s+/);
				if (action === "start") {
					if (stopped) throw new Error("This Pi session has ended");
					if (!gateway) {
						const generation = lifecycle;
						starting ??= (async () => {
							await sync(ctx);
							if (stopped || generation !== lifecycle) throw new Error("Gateway startup cancelled by session shutdown or stop");
							const handle = await startGateway(engine, { port: value === undefined ? undefined : Number(value) }, router);
							if (stopped || generation !== lifecycle) {
								await handle.close();
								throw new Error("Gateway startup cancelled by session shutdown or stop");
							}
							gateway = handle;
							return handle;
						})().finally(() => {
							starting = undefined;
						});
						await starting;
					}
				} else if (action === "stop") {
					await closeGateway();
				} else if (action === "key") {
					if (!ctx.hasUI) throw new Error("Create keys with the standalone CLI when no private UI is available");
					const created = await createCallerKey(engine.agentDir, value ?? "client", { routes: scopes.length ? scopes : ["*"] });
					await ctx.ui.editor("Copy this gateway key now (not saved in chat)", created.secret);
					ctx.ui.notify(`Created key ${created.key.id}; only its hash is stored.`, "info");
					return;
				} else if (action !== "status" && action !== "")
					throw new Error("Use /gateway start [port], stop, status, or key <name> [routes...]");
				ctx.ui.notify(
					gateway
						? `Gateway: ${gateway.url} (this Pi session owns it)`
						: "This session has no HTTP listener. Pure extension operation is unchanged; standalone serve may run separately.",
					"info",
				);
			},
		});
	}
	return {
		engine,
		router,
		bootstrap: async () => {
			await engine.initialize({ network: options.networkOnBootstrap !== false && process.env.PI_OFFLINE !== "1" });
			publish();
		},
		sync: (ctx: ExtensionContext) => sync(ctx),
		watchStore,
		stop,
	};
}
