/**
 * pi-multi-account — multi-account OAuth switching + Claude subscription billing.
 *
 * This file is wiring only; each capability lives in its own module:
 *
 *   adapters.ts             patched pi-accounts provider adapters
 *   refresh.ts              background refresh sweep + single-credential refresh
 *   aliases.ts              `anthropic-<account>` providers shown by /model
 *   pool.ts                 aggregate pool runtime: failover + cooldowns
 *   pools-store.ts          user-defined pool definitions (name + accounts)
 *   pool-commands.ts        /pools, /pool-create, /pool-add/-remove/-delete
 *   accounts-menu.ts        /accounts (login, re-login, switch, rename, remove)
 *   subscription-import.ts  /sub-accounts, /sub-import, first-run import
 *   session-state.ts        which account a session uses + footer status
 *   billing.ts              Claude Code user-agent and billing-header injection
 *   names.ts, errors.ts     small shared helpers
 *
 * What it does:
 *
 * 1. Named subscription OAuth accounts for anthropic / github-copilot /
 *    openai-codex, managed through `/accounts` (via `@narumitw/pi-accounts`).
 * 2. Claude subscription billing: whenever an Anthropic OAuth token
 *    (`sk-ant-oat…`) is used, requests carry the full Claude Code user-agent and
 *    the `x-anthropic-billing-header` system block, so usage is billed to the
 *    Claude Pro/Max plan instead of pay-as-you-go API credits.
 *
 * Extras:
 *   - User-defined aggregate pools: /pool-create names a provider that tries
 *     its accounts in order and fails over automatically on 429/401/403/5xx,
 *     with a per-account cooldown honoring `retry-after`. A pool named
 *     `anthropic` overrides the native provider (disable pool registration
 *     with PI_MULTI_ACCOUNT_FAILOVER=0).
 *   - Auto-imports Claude Code accounts found in the macOS Keychain or
 *     `~/.claude/.credentials.json` when the account store is empty
 *     (disable with PI_MULTI_ACCOUNT_AUTO_IMPORT=0). Interactive sessions ask
 *     for the account alias instead of inventing `cc-max`/`cc-pro` names;
 *     headless runs fall back to generated names, or to the comma-separated
 *     PI_MULTI_ACCOUNT_AUTO_IMPORT_NAMES list. Accounts can be renamed later
 *     from `/accounts`.
 *   - Registers `anthropic-<name>` provider aliases so every named account
 *     shows up in `/model` and stays selected as `anthropic-<name>/<model>`
 *     (disable with PI_MULTI_ACCOUNT_ALIASES=0).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AccountStore } from "@narumitw/pi-accounts/src/accounts.ts";
import { registerAccountsCommandOverride } from "./accounts-menu.ts";
import { anthropicAdapter, patchedProviders } from "./adapters.ts";
import { ALIAS_PREFIX, registerAccountAliasProviders } from "./aliases.ts";
import { registerBillingLayer } from "./billing.ts";
import { credentialSummary, logDebug, logError, logInfo, logLevel, logPath } from "./debug-log.ts";
import { installAbortDiagnostics } from "./abort-diagnostics.ts";
import { errorMessage } from "./errors.ts";
import { parseNameList } from "./names.ts";
import {
	acquireBackgroundRefreshLoop,
	markCredentialSuspect,
	markRunFinished,
	markRunStarted,
} from "./refresh.ts";
import { createPoolRuntime, drainPoolNotices, isPoolProvider, lastPoolAccount } from "./pool.ts";
import { registerPoolCommands } from "./pool-commands.ts";
import { activeAnthropicToken, isAnthropicProvider, stripRefusedBoundsInTools } from "./provider-schema.ts";import { readPools } from "./pools-store.ts";
import { describeChange, drainForeignChanges, storeObserver } from "./store-watch.ts";
import {
	healActiveAccount,
	pruneStaleAliasDefaultProvider,
	restoreAliasSelection,
	reportPinnedAliasAccount,
	updateBillingStatus,
	warnAboutStoredNativeOAuth,
} from "./session-state.ts";
import {
	importClaudeAccounts,
	registerClaudeImportCommands,
	runInteractiveImport,
} from "./subscription-import.ts";
import { detectSubscriptionAccounts, type SubscriptionAccount } from "./subscription-credentials.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
	const store = new AccountStore();
	const providers = patchedProviders();
	anthropicAdapter(); // Fail fast if pi-accounts stops shipping the Anthropic adapter.
	const refreshLoop = acquireBackgroundRefreshLoop(store, providers);

	// User-defined aggregate pools (/pool-create): each registers a provider
	// named by the user that fails over across its accounts. No pool exists
	// until the user creates one, so the default behavior is unchanged.
	// Bootstrap registers stored definitions immediately — like the aliases,
	// before any model resolution — because `pi -p --model <pool>/…` resolves
	// the model before the first session_start.
	const poolRuntime = createPoolRuntime(pi, store);
	try {
		for (const definition of readPools()) {
			poolRuntime.registerPool(definition);
		}
	} catch (error) {
		console.warn("pi-multi-account: pool bootstrap failed:", errorMessage(error));
	}

	// One startup line per process makes it possible to tell which installation
	// wrote the lines that follow — the host or a container sharing this home
	// directory — which is the difference between "my token expired" and "another
	// installation rotated my token away".
	installAbortDiagnostics();

	// Last-resort forensics: the CLI's one-shot path streams at the API level, so
	// an auth or beta-header mistake there is otherwise invisible - the command
	// just sits there. Logs the outcome of any request to Anthropic.
	{
		const globalFetch = globalThis.fetch;
		const marker = globalFetch as { __pmaWrapped?: boolean };
		if (typeof globalFetch === "function" && marker.__pmaWrapped !== true) {
			const wrapped = async (input: unknown, init?: unknown): Promise<unknown> => {
				const url = typeof input === "string" ? input : String((input as { url?: string } | undefined)?.url ?? input);
				const response = await (globalFetch as (a: unknown, b?: unknown) => Promise<unknown>).call(globalThis, input, init);
				if (url.includes("api.anthropic.com")) {
					const status = (response as { status?: number }).status;
					let detail = "";
					try {
						const copy = (response as { clone?: () => { text: () => Promise<string> } }).clone?.();
						detail = copy === undefined ? "" : (await copy.text()).slice(0, 220);
					} catch { detail = ""; }
					logInfo("diag.http", { url: url.replace(/\?.*/u, ""), status, detail });
				}
				return response;
			};
			Object.assign(wrapped, { __pmaWrapped: true });
			globalThis.fetch = wrapped as typeof globalThis.fetch;
		}
	}

	logInfo("extension.loaded", {
		cwd: process.cwd(),
		home: process.env.HOME,
		logLevel: logLevel(),
		backgroundRefresh: process.env.PI_MULTI_ACCOUNT_BACKGROUND_REFRESH !== "0",
		aliases: process.env.PI_MULTI_ACCOUNT_ALIASES !== "0",
	});

	/**
	 * Tell the user when another process changed the shared account store.
	 *
	 * Silence here is what made a switched active account look like a random
	 * failure: the session kept its model label and started billing (or failing)
	 * as a different account.
	 */
	const reportForeignStoreChanges = (ctx: { ui: { notify: (message: string, level: "info" | "warning" | "error") => void } }): void => {
		for (const change of drainForeignChanges()) {
			ctx.ui.notify(
				`Anthropic accounts: ${describeChange(change)} (by another process). See ${logPath()}.`,
				change.kind === "active_account" ? "warning" : "info",
			);
		}
	};

	// Bracket every run so the sweep can leave the credential it is using alone.
	// Counted rather than boolean: one process hosts many sessions, and their
	// runs overlap freely.
	let runInFlight = false;
	pi.on("agent_start", () => {
		if (runInFlight) return;
		runInFlight = true;
		markRunStarted();
	});
	const releaseRun = (): void => {
		if (!runInFlight) return;
		runInFlight = false;
		markRunFinished();
	};
	/**
	 * Treat a rejected token as a reason to refresh, not just as a failed request.
	 *
	 * A revoked Anthropic token dies *before* its stored expiry — that is what
	 * happens when a second installation refreshes the same rotating credential —
	 * so the expiry-driven sweep has no reason to touch it and every subsequent
	 * request fails the same way. Marking the account here makes the next sweep
	 * refresh it regardless of the stored expiry, so it either heals itself or
	 * reports an honest "needs re-login".
	 */
	pi.on("after_provider_response", (event, ctx) => {
		const providerId = ctx.model?.provider;
		if (!providerId) return;
		const isPool = isPoolProvider(providerId);
		if (!isPool && providerId !== "anthropic" && !providerId.startsWith(ALIAS_PREFIX)) return;
		if (event.status < 400) {
			logDebug("response.ok", { provider: providerId, status: event.status });
		} else {
			void (async () => {
				try {
					const state = await store.readProviderAsync("anthropic");
					const account = isPool
						? lastPoolAccount(providerId)
						: providerId.startsWith(ALIAS_PREFIX)
							? providerId.slice(ALIAS_PREFIX.length)
							: state.active;
					logError("response.rejected", {
						provider: providerId,
						status: event.status,
						account,
						requestId: event.headers["request-id"] ?? event.headers["x-request-id"],
						credential: account ? credentialSummary(state.accounts[account]) : undefined,
					});
					if (!account) return;
					if (event.status === 401) {
						markCredentialSuspect("anthropic", account, `provider answered 401 for ${providerId}`);
						ctx.ui.notify(
							`Anthropic account "${account}" was rejected (401). Refreshing its token; ` +
								`if this repeats, re-login that account in /accounts.`,
							"warning",
						);
					}
				} catch (error) {
					logError("response.rejected_handler_failed", { detail: errorMessage(error) });
				}
			})();
		}
		// Failovers observed mid-stream (where no UI context exists) are shown
		// here, on the first provider response of the session afterwards.
		for (const notice of drainPoolNotices()) {
			ctx.ui.notify(notice.message, notice.level);
		}
	});

	pi.on("agent_end", () => {
		releaseRun();
		// The run is over, so rotating now is safe and keeps a long idle stretch
		// from starting with a stale token.
		void refreshLoop.refreshNow();
	});

	// A persisted `anthropic-<account>` defaultProvider is the point of the
	// aliases, so it is kept. Only prune it when the account behind it is gone,
	// which would otherwise leave startup pointing at a provider that can never
	// be registered again.
	try {
		await pruneStaleAliasDefaultProvider(store);
	} catch (error) {
		console.warn("pi-multi-account: settings default-provider check failed:", errorMessage(error));
	}

	// Zero-friction bootstrap: if no Anthropic account has been added yet,
	// import the accounts Claude Code already knows about. Interactive sessions
	// get to name the accounts themselves (deferred to session_start, where a UI
	// context exists); headless runs import immediately with generated names, or
	// with PI_MULTI_ACCOUNT_AUTO_IMPORT_NAMES when it is set.
	let pendingImport: SubscriptionAccount[] = [];
	if (process.env.PI_MULTI_ACCOUNT_AUTO_IMPORT !== "0") {
		try {
			const state = await store.readProviderAsync("anthropic");
			if (Object.keys(state.accounts).length === 0 && !state.active) {
				const detected = detectSubscriptionAccounts();
				const envNames = parseNameList(process.env.PI_MULTI_ACCOUNT_AUTO_IMPORT_NAMES);
				if (detected.length > 0 && envNames.length === 0 && process.stdout.isTTY) {
					// Ask for names on the first interactive session instead of
					// inventing cc-max/cc-pro behind the user's back.
					pendingImport = detected;
				} else if (detected.length > 0) {
					const imported = await importClaudeAccounts(store, detected, envNames);
					if (imported.length > 0) {
						console.log(
							`pi-multi-account: auto-imported subscription account(s): ${imported.join(", ")}. ` +
								"Rename or manage them with /accounts, import again with /sub-import " +
								"(PI_MULTI_ACCOUNT_AUTO_IMPORT=0 disables this, " +
								"PI_MULTI_ACCOUNT_AUTO_IMPORT_NAMES=work,personal names them).",
						);
					}
				}
			}
		} catch (error) {
			console.warn("pi-multi-account: auto-import failed:", errorMessage(error));
		}
	}

	// Heal FIRST, before pi-accounts' own session_start handler runs: if the
	// active account was deleted (pi-accounts clears `active` without a
	// fallback), the runtime stops injecting any Anthropic credential and pi
	// hides the provider from /model. Auto-activate the first account instead.
	pi.on("session_start", async () => {
		try {
			await healActiveAccount(store);
		} catch (error) {
			console.warn("pi-multi-account: active-account heal failed:", errorMessage(error));
		}
	});

	// pi-accounts' extension is deliberately NOT registered: its runtime
	// credential injection for `anthropic` is silently dropped by pi-web's
	// frozen global provider policy, its read-back check then fails closed,
	// and `turn_start` aborts the turn before any request (the 2026-09-15
	// outage). The pool resolves credentials per request and answers pi's
	// configured-check via its own auth.apiKey, so the injection is redundant.
	// The store stays (library import above); /accounts is overridden by
	// registerAccountsCommandOverride. Re-add only if a non-anthropic
	// pi-accounts provider is ever needed.

	// Claude subscription billing (billing.ts).
	registerBillingLayer(pi);

	// Per-account provider aliases in the /model picker (aliases.ts). Registered
	// here, before any session exists, so early model resolution can see them.
	const aliases = registerAccountAliasProviders(pi, store);
	await aliases.bootstrap();

	// Account manager with explicit re-login and rename (accounts-menu.ts).
	registerAccountsCommandOverride(pi, store, providers, aliases, refreshLoop);

	// Subscription import commands (subscription-import.ts).
	registerClaudeImportCommands(pi, store, aliases, refreshLoop);

	// Aggregate pool management (pool-commands.ts).
	const poolSync = registerPoolCommands(pi, store, poolRuntime);


	// Per-session startup: finish a deferred import, sync aliases, re-pin the
	// session's account, then report it in the footer.
	// Forensics at the death point: pi's own prepareRequest (getAuth → stream).
	// Wrapped once per runtime instance; logs entry, getAuth outcome, and throw.
	pi.on("session_start", async (_event, ctx) => {
		try {
			// pi 0.87's CLI sends without ever calling a provider stream, so the
			// strip in the pool's wrapper cannot cover `pi -p --model
			// anthropic/...`; the prompt's tool declarations are built from the
			// registered definitions after this hook, so sweeping them here does.
			if (isAnthropicProvider(ctx.model?.provider) || ctx.model === undefined) {
				const removed = stripRefusedBoundsInTools(pi.getAllTools());
				if (removed > 0) logInfo("schema.bounds_stripped_tools", { provider: ctx.model?.provider, removed });
			}
			// The key, not just the status: pi 0.87's one-shot CLI streams at the API
			// level and only consults the resolved key, so a pooled request there
			// lives or dies on this value being the OAuth token (sent as a bearer)
			// rather than the placeholder that only exists to satisfy the
			// configured-provider check.
			const token = activeAnthropicToken();
			const runtime = (ctx.modelRegistry as unknown as { runtime?: { setRuntimeApiKey?: (providerId: string, apiKey: string) => Promise<void> } }).runtime;
			if (token !== undefined && runtime?.setRuntimeApiKey !== undefined) {
				await runtime.setRuntimeApiKey("anthropic", token);
			}
		} catch (error) {
			logError("schema.bounds_strip_failed", { detail: errorMessage(error) });
		}
		try {
			const rt = ctx.modelRegistry as unknown as {
				__pmaPrepareWrapped?: boolean;
				prepareRequest?: (model: { provider: string; id: string }, options?: { signal?: AbortSignal }) => Promise<unknown>;
				getAuth?: (...args: unknown[]) => Promise<unknown>;
			};
			const target = (rt as { runtime?: typeof rt }).runtime ?? rt;
			logInfo("diag.pma_runtime_shape", { targetKeys: Object.keys(target).join(","), registryKeys: Object.keys(ctx.modelRegistry).join(","), hasModels: (target as { models?: unknown }).models !== undefined });
			if (target && !target.__pmaPrepareWrapped && typeof target.prepareRequest === "function") {
				target.__pmaPrepareWrapped = true;
				const origPrepare = target.prepareRequest;
				const origGetAuth = target.getAuth;
				const sigInfo = (s?: AbortSignal) => ({
					hasSignal: s !== undefined,
					aborted: s?.aborted ?? null,
					reason: s?.aborted ? String((s.reason as { message?: string })?.message ?? s.reason).slice(0, 120) : undefined,
				});
				if (typeof origGetAuth === "function") {
					target.getAuth = async function (this: unknown, ...args: unknown[]) {
						const t0 = Date.now();
						const arg0 = args[0] as { provider?: string } | string;
						const providerId = typeof arg0 === "string" ? arg0 : arg0?.provider;
						const sig = (args[1] as { signal?: AbortSignal } | undefined)?.signal;
						try {
							const r = await origGetAuth.apply(this, args);
							logInfo("diag.rt_getAuth", { provider: providerId, ok: r !== undefined, elapsedMs: Date.now() - t0, ...sigInfo(sig) });
							return r;
						} catch (error) {
							logError("diag.rt_getAuth_threw", { provider: providerId, elapsedMs: Date.now() - t0, detail: errorMessage(error), ...sigInfo(sig) });
							throw error;
						}
					};
				}
				target.prepareRequest = async function (this: unknown, model, options) {
					const t0 = Date.now();
					const sig = options?.signal;
					logInfo("diag.rt_prepare_entered", { provider: model?.provider, model: model?.id, ...sigInfo(sig) });
					if (sig && !sig.aborted) {
						sig.addEventListener("abort", () => {
							logInfo("diag.rt_turn_signal_aborted", {
								provider: model?.provider,
								elapsedMs: Date.now() - t0,
								reason: String((sig.reason as { message?: string })?.message ?? sig.reason).slice(0, 120),
								stack: (new Error().stack ?? "").split("\n").slice(1, 10).join(" | ").slice(0, 700),
							});
						}, { once: true });
					}
					try {
						const r = await origPrepare.call(this, model, options);
						const prepared = r as { options?: { apiKey?: unknown; env?: unknown }; apiKey?: unknown } | undefined;
						const key = prepared?.options?.apiKey ?? prepared?.apiKey;
						logInfo("diag.rt_prepare_ok", {
							provider: model?.provider,
							elapsedMs: Date.now() - t0,
							shape: Object.keys((prepared ?? {}) as object).join(","),
							keyKind: typeof key === "string" ? (key.includes("sk-ant-oat") ? "oauth-token" : key.slice(0, 14)) : typeof key,
						});
						return r;
					} catch (error) {
						logError("diag.rt_prepare_threw", { provider: model?.provider, elapsedMs: Date.now() - t0, detail: errorMessage(error), ...sigInfo(sig) });
						throw error;
					}
				};
				logInfo("diag.rt_prepare_wrapped", { viaRuntimeField: (rt as { runtime?: unknown }).runtime !== undefined });
			} else {
				logInfo("diag.rt_prepare_not_wrapped", { hasPrepare: typeof target?.prepareRequest, keys: Object.getOwnPropertyNames(Object.getPrototypeOf(rt ?? {})).slice(0, 25) });
			}
		} catch (error) {
			logError("diag.rt_prepare_wrap_failed", { detail: errorMessage(error) });
		}
		if (pendingImport.length > 0) {
			const detected = pendingImport;
			pendingImport = [];
			try {
				await runInteractiveImport(store, ctx, detected);
			} catch (error) {
				console.warn("pi-multi-account: interactive import failed:", errorMessage(error));
			}
		}
		await refreshLoop.refreshNow();
		refreshLoop.start();
		try {
			await aliases.sync(ctx);
		} catch (error) {
			console.error(`pi-multi-account: account providers were not loaded: ${errorMessage(error)}`);
			ctx.ui.notify(`Account providers were not loaded: ${errorMessage(error)}`, "warning");
		}
		try {
			await poolSync.sync(ctx);
		} catch (error) {
			console.error(`pi-multi-account: aggregate pools were not loaded: ${errorMessage(error)}`);
			ctx.ui.notify(`Aggregate pools were not loaded: ${errorMessage(error)}`, "warning");
		}
		await restoreAliasSelection(pi, store, ctx);
		await reportPinnedAliasAccount(store, ctx);
		await warnAboutStoredNativeOAuth(store, ctx);
		await updateBillingStatus(store, ctx);
		reportForeignStoreChanges(ctx);
	});

	// Every turn re-reads the store, so this is where a session finds out that
	// something outside it changed which account it is about to talk to.
	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			storeObserver("anthropic").observe(await store.readProviderAsync("anthropic"), "turn.start");
		} catch (error) {
			logError("turn.store_read_failed", { detail: errorMessage(error) });
		}
		// Forensics: what pi itself sees for this turn's provider, in this
		// session's runtime, right before it resolves auth and calls stream.
		try {
			const providerId = ctx.model?.provider;
			if (providerId) {
				const reg = ctx.modelRegistry;
				const provider = reg.getProvider(providerId);
				const native = reg.getRegisteredNativeProvider(providerId);
				const config = reg.getRegisteredProviderConfig(providerId);
				let authResult: unknown;
				let authError: string | undefined;
				try {
					const a = await reg.getProviderAuth(providerId);
					authResult = a ? { type: (a as { type?: string }).type, source: (a as { source?: string }).source, hasKey: Boolean((a as { auth?: { apiKey?: string } }).auth?.apiKey) } : null;
				} catch (error) {
					authError = errorMessage(error);
				}
				logInfo("diag.turn_provider_view", {
					provider: providerId,
					model: ctx.model?.id,
					modelFound: reg.find(providerId, ctx.model?.id ?? "") !== undefined,
					hasConfiguredAuth: ctx.model ? reg.hasConfiguredAuth(ctx.model) : null,
					authStatus: reg.getProviderAuthStatus(providerId),
					providerName: provider?.name,
					providerAuthKeys: provider ? Object.keys((provider as { auth?: object }).auth ?? {}) : null,
					providerHasStream: typeof (provider as { stream?: unknown })?.stream === "function",
					providerHasStreamSimple: typeof (provider as { streamSimple?: unknown })?.streamSimple === "function",
					nativeRegistered: native !== undefined,
					nativeName: native?.name,
					configRegistered: config !== undefined,
					configKeys: config ? Object.keys(config) : null,
					authResult,
					authError,
				});
			}
		} catch (error) {
			logError("diag.turn_provider_view_failed", { detail: errorMessage(error) });
		}
		await updateBillingStatus(store, ctx);
		reportForeignStoreChanges(ctx);
		return undefined;
	});

	// Selecting `anthropic-<account>/<model>` stays selected: the alias resolves
	// its own account credential per request, so the session keeps talking to the
	// account the user picked and /model plus the footer keep showing which one.
	// The stored active account is still pointed at it so the canonical
	// `anthropic` provider and /accounts agree with the last explicit choice.
	pi.on("model_select", async (event, ctx) => {
		logInfo("model.selected", {
			model: `${event.model.provider}/${event.model.id}`,
			previous: event.previousModel ? `${event.previousModel.provider}/${event.previousModel.id}` : undefined,
			source: event.source,
		});
		if (event.model.provider.startsWith(ALIAS_PREFIX)) {
			await reportPinnedAliasAccount(store, ctx);
		}
		await updateBillingStatus(store, ctx);
		reportForeignStoreChanges(ctx);
	});

	pi.on("session_shutdown", async () => {
		// A session torn down mid-run must not leave the sweep permanently
		// convinced that a run is still in flight.
		releaseRun();
		refreshLoop.stop();
	});
}
