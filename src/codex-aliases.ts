/**
 * `codex` and `codex-<account>` provider aliases, so /accounts-managed Codex accounts
 * appear in /model next to pi's native provider.
 *
 * Folded in from the standalone `codex-accounts` extension (2026-10-13). pi-multi-account
 * already stores these accounts, manages them through /accounts and refreshes them;
 * exposing them to /model here removes a second, unversioned extension that had to be
 * kept in step by hand.
 *
 * Each alias clones pi's native openai-codex provider (same chatgpt.com backend, same
 * models, same api) and resolves the stored access token per request. The backend derives
 * the `chatgpt-account-id` header from the token's own JWT claims, so requests bill to the
 * subscription exactly like pi's native Codex login.
 *
 * The store is watched, because /accounts usually runs in another session and the refresh
 * sweep rewrites the file underneath a live one: without that, a login only reached
 * /model at the next session start (the 2026-10-13 report, "logged in codex, no models").
 */
import { watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { builtinProviders, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
	type ContextCatalog,
	accountIdOf,
	applyContextWindows,
	errorDetail,
	fetchContextCatalog,
	readCachedCatalogs,
	writeCachedCatalogs,
} from "./codex-catalog.ts";
import {
	ACTIVE_ALIAS_ID,
	ALIAS_PREFIX,
	BASE_URL,
	NATIVE_PROVIDER,
	REFRESH_SKEW_MS,
	type CodexCredential,
	accountFor,
	accountsFile,
	codexAliasIds,
	freshCredential,
	readCodexState,
} from "./codex-shared.ts";
import { logError, logInfo } from "./debug-log.ts";

type AliasModel = ProviderModelConfig & Record<string, unknown>;

export interface CodexAliasRegistry {
	/** Register aliases before any session exists, so early model resolution sees them. */
	bootstrap(): Promise<void>;
	/** Re-register aliases and drop the ones whose account is gone. */
	sync(ctx: ExtensionContext): Promise<void>;
	/** Follow the store for the rest of the session (no /reload needed after a login). */
	watchStore(ctx: ExtensionContext): void;
	/** Stop watching. */
	stop(): void;
}

/** The codex slice of the store, small enough to compare on every check. */
function stateFingerprint(state: ReturnType<typeof readCodexState>): string {
	return JSON.stringify({
		active: state.active,
		names: Object.keys(state.accounts).sort(),
		tokens: Object.entries(state.accounts)
			.map(([name, credential]) => [name, credential.access?.slice(-16)])
			.sort(),
	});
}

/** How a catalog fetch gets its token. */
type CatalogToken = (credential: CodexCredential) => Promise<string | undefined>;

/**
 * At load no refresh may run: a refresh rotates the shared refresh token, and only the background
 * sweep may do that, behind its file lock (codex-shared.ts); a load also runs before that sweep and
 * nothing bounds a refresh request. A token about to expire is skipped instead, and the session-start
 * sync, which runs after the sweep, fills that account's cache for the next load.
 */
const tokenAtLoad: CatalogToken = (credential) =>
	Promise.resolve((credential.expires ?? 0) > Date.now() + REFRESH_SKEW_MS ? credential.access : undefined);

/** After the sweep a token is normally fresh; the in-memory refresh is the last resort it always was. */
const tokenAfterSweep: CatalogToken = async (credential) => (await freshCredential(credential)).access;

/** A load waits this long at most per uncached account; the session-start sync keeps the longer default. */
const CATALOG_TIMEOUT_AT_LOAD_MS = 3000;

export function registerCodexAliasProviders(pi: ExtensionAPI): CodexAliasRegistry {
	if (process.env.PI_MULTI_ACCOUNT_ALIASES === "0") {
		return {
			bootstrap: async () => undefined,
			sync: async () => undefined,
			watchStore: () => undefined,
			stop: () => undefined,
		};
	}

	const baseProvider = builtinProviders().find((provider) => provider.id === NATIVE_PROVIDER);
	if (!baseProvider) throw new Error("pi-multi-account: pi's built-in openai-codex provider is unavailable.");
	const nativeStream = baseProvider.stream.bind(baseProvider);
	const nativeStreamSimple = baseProvider.streamSimple.bind(baseProvider);

	let models: AliasModel[] = builtinCodexModels();
	let syncGeneration = 0;
	let watcher: FSWatcher | undefined;
	let poll: ReturnType<typeof setInterval> | undefined;
	let debounce: ReturnType<typeof setTimeout> | undefined;
	let liveCtx: ExtensionContext | undefined;
	let fingerprint = stateFingerprint(readCodexState());

	function builtinCodexModels(): AliasModel[] {
		return getBuiltinModels(NATIVE_PROVIDER).map(({ provider: _provider, baseUrl: _baseUrl, ...model }) => ({
			...model,
		})) as AliasModel[];
	}

	function registerAlias(id: string, catalog?: ContextCatalog): void {
		const fallbackModels = models.map((model) => ({ ...model, api: model.api!, provider: id, baseUrl: BASE_URL }));
		const catalogModels = catalog ? applyContextWindows(fallbackModels, catalog.windows) : fallbackModels;
		pi.unregisterProvider(id);
		pi.registerProvider({
			id,
			name: id,
			baseUrl: BASE_URL,
			auth: {
				apiKey: {
					name: `${id} account token`,
					async check({ signal }) {
						signal.throwIfAborted();
						return accountFor(readCodexState(), id) ? { type: "api_key", source: "pi-accounts" } : undefined;
					},
					async resolve({ signal }) {
						signal.throwIfAborted();
						const found = accountFor(readCodexState(), id);
						if (!found) return undefined;
						const credential = await freshCredential(found.credential);
						return { auth: { apiKey: credential.access }, source: `pi-accounts:${found.name}` };
					},
				},
			},
			getModels: () =>
				catalog && accountIdOf(accountFor(readCodexState(), id)?.credential.access) === catalog.accountId
					? catalogModels
					: fallbackModels,
			stream: nativeStream as never,
			streamSimple: nativeStreamSimple as never,
		});
	}

	function wantedIds(state: ReturnType<typeof readCodexState>): Set<string> {
		const wanted = new Set(codexAliasIds(state));
		if (accountFor(state, ACTIVE_ALIAS_ID)) wanted.add(ACTIVE_ALIAS_ID);
		return wanted;
	}

	function sweepStaleAliases(ctx: ExtensionContext, wanted: Set<string>): void {
		for (const id of ctx.modelRegistry.getRegisteredProviderIds()) {
			if ((id === ACTIVE_ALIAS_ID || id.startsWith(ALIAS_PREFIX)) && !wanted.has(id)) {
				pi.unregisterProvider(id);
			}
		}
	}

	/**
	 * Fetch the catalog of every stored account (or only those `known` has no catalog for) and
	 * remember the fresh ones for the next load. A failure keeps the cached or base windows and says
	 * so; an account the token policy declines is left to a later fetch.
	 */
	async function fetchCatalogs(
		warn: (message: string) => void,
		tokenFor: CatalogToken,
		options: { known?: ReadonlyMap<string, ContextCatalog>; timeoutMs?: number } = {},
	): Promise<Map<string, ContextCatalog>> {
		const known = options.known ?? new Map<string, ContextCatalog>();
		const catalogs = new Map<string, ContextCatalog>();
		if (/^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? "")) return catalogs;
		const state = readCodexState();
		await Promise.all(
			codexAliasIds(state).map(async (id) => {
				const found = accountFor(state, id);
				if (!found) return;
				const accountId = accountIdOf(found.credential.access);
				if (accountId !== undefined && known.has(accountId)) return;
				try {
					const access = await tokenFor(found.credential);
					if (access === undefined) return;
					const catalog = await fetchContextCatalog(access, fetch, options.timeoutMs);
					catalogs.set(catalog.accountId, catalog);
				} catch (error) {
					warn(`Codex account "${found.name}": using cached or base context windows; ${errorDetail(error)}`);
				}
			}),
		);
		await writeCachedCatalogs(catalogs).catch((error: unknown) => {
			logError("codex.catalog_cache_write_failed", { detail: errorDetail(error) });
		});
		return catalogs;
	}

	async function sync(ctx: ExtensionContext): Promise<void> {
		const live = ctx.modelRegistry.getAll().filter((model) => model.provider === NATIVE_PROVIDER);
		if (live.length > 0) {
			models = live.map(({ provider: _provider, baseUrl: _baseUrl, ...model }) => ({ ...model })) as AliasModel[];
		}
		const generation = ++syncGeneration;
		sweepStaleAliases(ctx, wantedIds(readCodexState()));
		const fetched = await fetchCatalogs((message) => ctx.ui.notify(message, "warning"), tokenAfterSweep);
		// Offline or a failed fetch keeps the cached windows bootstrap registered instead of reverting to 272k.
		const catalogs = new Map([...readCachedCatalogs(), ...fetched]);
		// A second sync may have started while the catalogs were in flight; only the newest
		// one may register, or a slow stale fetch would overwrite fresher metadata.
		if (generation !== syncGeneration) return;
		const current = readCodexState();
		const wanted = wantedIds(current);
		sweepStaleAliases(ctx, wanted);
		for (const id of wanted) {
			const accountId = accountIdOf(accountFor(current, id)?.credential.access);
			registerAlias(id, accountId ? catalogs.get(accountId) : undefined);
		}
		fingerprint = stateFingerprint(current);
		logInfo("codex.aliases_synced", { accounts: wanted.size });
	}

	const changed = (): void => {
		const next = stateFingerprint(readCodexState());
		if (next === fingerprint) return;
		if (liveCtx === undefined) {
			fingerprint = next;
			return;
		}
		void sync(liveCtx).catch((error: unknown) => {
			logError("codex.resync_failed", { detail: errorDetail(error) });
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
		// Belt for filesystems that miss watch events, and for the rename-replace /accounts does.
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

	// Escape hatch, kept from the standalone extension: the watch makes it rarely needed,
	// but a manual refresh is the first thing to reach for when /model looks wrong.
	pi.registerCommand("codex-account-providers", {
		description: "Refresh the codex-account providers shown by /model",
		handler: async (_args, ctx) => {
			await sync(ctx);
			const ids = ctx.modelRegistry
				.getRegisteredProviderIds()
				.filter((id) => id === ACTIVE_ALIAS_ID || id.startsWith(ALIAS_PREFIX))
				.sort();
			ctx.ui.notify(
				ids.length > 0 ? `Codex providers: ${ids.join(", ")}` : "No codex accounts found — add one with /accounts.",
				"info",
			);
		},
	});

	return {
		/**
		 * Register with the real windows before any session exists, as the Anthropic aliases do: a
		 * host that freezes providers after load never sees the session-start sync's re-registration.
		 * The cache answers at once; an account with no cached catalog is fetched here, once.
		 */
		bootstrap: async () => {
			const cached = readCachedCatalogs();
			const fetched = await fetchCatalogs((message) => logError("codex.catalog_bootstrap_failed", { detail: message }), tokenAtLoad, {
				known: cached,
				timeoutMs: CATALOG_TIMEOUT_AT_LOAD_MS,
			});
			const catalogs = new Map([...cached, ...fetched]);
			const state = readCodexState();
			for (const id of wantedIds(state)) {
				const accountId = accountIdOf(accountFor(state, id)?.credential.access);
				registerAlias(id, accountId ? catalogs.get(accountId) : undefined);
			}
		},
		sync,
		watchStore,
		stop,
	};
}
