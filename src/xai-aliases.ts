/**
 * `xai` and `xai-<account>` provider aliases, so `/accounts`-managed SuperGrok / X Premium
 * accounts appear in `/model` next to pi's native provider.
 *
 * xAI's API is OpenAI-shaped (`openai-responses`) and pi-ai already carries the whole login: a
 * device-code flow with the `grok-cli:access` scope and a refresh that takes the refresh token.
 *
 * Two things differ from pi's own `xai` provider, and both come from the subscription:
 *
 * - A subscription token is refused by `api.x.ai` (`personal-team-blocked:spending-limit`, "you
 *   need a Grok subscription"), so the aliases talk to the Grok CLI proxy the subscription is
 *   for: `cli-chat-proxy.grok.com`. An API-key user is unaffected — that is pi's own provider,
 *   which these aliases shadow only when an account is stored.
 * - That proxy refuses a request that does not name a recent Grok CLI (`426`, "your Grok CLI
 *   version (none) is outdated"), so `x-grok-client-version` rides every request. The floor
 *   rises with `PI_MULTI_ACCOUNT_GROK_CLI_VERSION`, the same shape as the Claude Code claim.
 *
 * The store is watched, because `/accounts` usually runs in another session and the refresh
 * sweep rewrites the file underneath a live one.
 */
import { watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { AccountStore } from "@narumitw/pi-accounts/src/accounts.ts";
import { builtinProviders, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { accountsFile } from "./codex-shared.ts";
import { highestVersion } from "./cli-version.ts";
import { xaiAdapter } from "./adapters.ts";
import { credentialSummary, logDebug, logError, logInfo } from "./debug-log.ts";
import { errorMessage } from "./errors.ts";
import { isCredentialSuspect, REFRESH_SKEW_MS, refreshAccountCredential } from "./refresh.ts";
import { storeObserver } from "./store-watch.ts";

const PROVIDER = "xai";
export const XAI_ACTIVE_ALIAS = "xai";
export const XAI_ALIAS_PREFIX = "xai-";
const BASE_URL = "https://cli-chat-proxy.grok.com/v1";
/** Lowest Grok CLI the proxy accepts; a newer one may be named through the env var. */
const GROK_CLIENT_VERSION = "1.0.13";
const GROK_CLIENT_VERSION_ENV = "PI_MULTI_ACCOUNT_GROK_CLI_VERSION";

type AliasModel = ProviderModelConfig;

function aliasIds(names: readonly string[]): string[] {
	return [...names].map((name) => `${XAI_ALIAS_PREFIX}${name}`).sort();
}

function accountNameOf(providerId: string): string | undefined {
	return providerId === XAI_ACTIVE_ALIAS
		? undefined
		: providerId.startsWith(XAI_ALIAS_PREFIX)
			? providerId.slice(XAI_ALIAS_PREFIX.length)
			: undefined;
}

function grokClientVersion(): string {
	return highestVersion(GROK_CLIENT_VERSION, process.env[GROK_CLIENT_VERSION_ENV]);
}

export function registerXaiAliasProviders(pi: ExtensionAPI, store: AccountStore) {
	// The one switch that hides per-account aliases everywhere; the xAI-specific name is an
	// addition, not a second concept.
	if (process.env.PI_MULTI_ACCOUNT_ALIASES === "0" || process.env.PI_MULTI_ACCOUNT_XAI_ALIASES === "0") {
		return { bootstrap: async () => undefined, sync: async (_ctx: ExtensionContext) => undefined, watchStore: () => undefined, stop: () => undefined };
	}
	const found = builtinProviders().find((provider) => provider.id === PROVIDER);
	if (found === undefined) throw new Error("pi-multi-account: pi's built-in xAI provider is unavailable.");
	const baseProvider = found;
	const nativeStream = baseProvider.stream.bind(baseProvider);
	const nativeStreamSimple = baseProvider.streamSimple.bind(baseProvider);

	let models: AliasModel[] = [];
	let liveCtx: ExtensionContext | undefined;
	let watcher: FSWatcher | undefined;
	let poll: ReturnType<typeof setInterval> | undefined;
	let debounce: ReturnType<typeof setTimeout> | undefined;
	/** What the last sync registered, so the 2s poll only re-registers a real change. */
	let fingerprint = "";

	function registeredIds(ctx: ExtensionContext): string[] {
		return ctx.modelRegistry
			.getRegisteredProviderIds()
			.filter((id) => id === XAI_ACTIVE_ALIAS || id.startsWith(XAI_ALIAS_PREFIX))
			.sort();
	}

	/**
	 * Which provider ids the store wants: one pinned alias per account, plus the active-account
	 * alias when there is an active account to follow.
	 */
	function wantedIds(state: { active?: string; accounts: Record<string, unknown> }): string[] {
		const wanted = new Set(aliasIds(Object.keys(state.accounts)));
		if (state.active !== undefined && state.accounts[state.active] !== undefined) wanted.add(XAI_ACTIVE_ALIAS);
		return [...wanted];
	}

	async function resolveCredential(accountName: string, providerId: string, signal?: AbortSignal) {
		signal?.throwIfAborted();
		const state = await store.readProviderAsync(PROVIDER);
		storeObserver(PROVIDER).observe(state, `xai-alias:${accountName}`);
		let credential = state.accounts[accountName];
		if (!credential || credential.type !== "oauth") {
			logError("xai.alias_unresolved", { provider: providerId, account: accountName, reason: "no stored oauth credential" });
			return undefined;
		}
		const suspect = isCredentialSuspect(PROVIDER, accountName);
		if (suspect || credential.expires <= Date.now() + REFRESH_SKEW_MS) {
			credential = await refreshAccountCredential(store, xaiAdapter(), accountName, credential, Date.now(), { force: suspect });
		}
		signal?.throwIfAborted();
		logDebug("xai.alias_credential", { provider: providerId, account: accountName, credential: credentialSummary(credential) });
		return credential;
	}

	function registerAlias(providerId: string): void {
		const pinned = accountNameOf(providerId);
		// The provider id and base URL belong on every model: pi's resolver reads
		// `model.provider` off the list the provider hands it.
		// The version header has to sit on the models: pi's provider-level `headers` never reach
		// the wire, while pi-ai merges `model.headers` into the request.
		const aliasModels = models.map((model) => ({
			...model,
			provider: providerId,
			baseUrl: BASE_URL,
			headers: { ...model.headers, "x-grok-client-version": grokClientVersion() },
		}));
		pi.unregisterProvider(providerId);
		pi.registerProvider({
			id: providerId,
			name: providerId,
			baseUrl: BASE_URL,

			auth: {
				apiKey: {
					name: `${providerId} account token`,
					async check({ signal }) {
						signal.throwIfAborted();
						const state = await store.readProviderAsync(PROVIDER);
						const name = pinned ?? state.active;
						const credential = name === undefined ? undefined : state.accounts[name];
						if (!credential || credential.type !== "oauth") return undefined;
						return { type: "api_key", source: `pi-accounts:${name}` };
					},
					async resolve({ signal }) {
						const state = await store.readProviderAsync(PROVIDER);
						const name = pinned ?? state.active;
						if (name === undefined) return undefined;
						const credential = state.accounts[name];
						if (!credential || credential.type !== "oauth") return undefined;
						try {
							const resolved = await resolveCredential(name, providerId, signal);
							return resolved ? { auth: { apiKey: resolved.access }, source: `pi-accounts:${name}` } : undefined;
						} catch (error) {
							logError("xai.alias_refresh_failed", { provider: providerId, account: name, detail: errorMessage(error) });
							throw error;
						}
					},
				},
			},
			getModels: () => aliasModels as never,
			// The base provider's own model filter, forwarded as-is: it is what hides a model an
			// account cannot reach. Typed loosely because the alias's model records differ from pi's.
			filterModels: (providerModels: never, credential: never) =>
				baseProvider.filterModels?.(providerModels, credential) ?? providerModels,
			stream: nativeStream as never,
			streamSimple: nativeStreamSimple as never,
		});
	}

	/** Drop the aliases of accounts that are gone, then register the wanted ones. */
	function sweep(ctx: ExtensionContext, wanted: readonly string[]): void {
		for (const id of registeredIds(ctx)) {
			if (!wanted.includes(id)) pi.unregisterProvider(id);
		}
		for (const id of wanted) registerAlias(id);
	}

	async function sync(ctx: ExtensionContext): Promise<void> {
		// Take the live catalogue from the registry rather than the builtin list: a model pi
		// knows about but the builtin list has dropped must survive on the alias.
		const live = ctx.modelRegistry.getAll().filter((model) => model.provider === PROVIDER);
		if (live.length > 0) models = live.map(({ provider: _provider, baseUrl: _baseUrl, ...model }) => ({ ...model })) as AliasModel[];
		const state = await store.readProviderAsync(PROVIDER);
		const wanted = wantedIds(state);
		sweep(ctx, wanted);
		fingerprint = stateFingerprint(state);
		logInfo("xai.aliases_synced", { providers: wanted.length, accounts: Object.keys(state.accounts).length });
	}

	function stateFingerprint(state: { active?: string; accounts: Record<string, { access?: string } | undefined> }): string {
		const accounts = Object.entries(state.accounts)
			.map(([name, credential]) => `${name}:${credential?.access?.slice(-8) ?? "-"}`)
			.sort();
		return `${state.active ?? ""}|${accounts.join(",")}`;
	}

	const changed = (): void => {
		if (liveCtx === undefined) return;
		// The poll fires every 2s; a re-registration per tick would churn provider ids.
		const ctx = liveCtx;
		void (async () => {
			// The poll fires every 2s; a re-registration per tick would churn provider ids, so
			// only a changed store gets that far.
			if (stateFingerprint(await store.readProviderAsync(PROVIDER)) === fingerprint) return;
			await sync(ctx);
		})().catch((error: unknown) => {
			logError("xai.resync_failed", { detail: errorMessage(error) });
		});
	};

	function watchStore(ctx: ExtensionContext): void {
		liveCtx = ctx;
		if (watcher !== undefined || poll !== undefined) return;
		try {
			watcher = watch(dirname(accountsFile()), () => {
				if (debounce !== undefined) clearTimeout(debounce);
				debounce = setTimeout(changed, 200);
			});
		} catch {
			// No directory watch (odd filesystem): the interval below still catches it.
		}
		poll = setInterval(changed, 2000);
		poll.unref?.();
	}

	function stop(): void {
		watcher?.close();
		watcher = undefined;
		if (poll !== undefined) clearInterval(poll);
		poll = undefined;
		if (debounce !== undefined) clearTimeout(debounce);
		debounce = undefined;
		liveCtx = undefined;
	}

	return {
		/**
		 * Register before any session exists, like the other aliases: a host that freezes
		 * providers after load never sees a later re-registration.
		 */
		bootstrap: async () => {
			const state = await store.readProviderAsync(PROVIDER);
			models = getBuiltinModels(PROVIDER).map(({ provider: _provider, baseUrl: _baseUrl, ...model }) => ({ ...model })) as AliasModel[];
			for (const id of wantedIds(state)) registerAlias(id);
		},
		sync,
		watchStore,
		stop,
	};
}

