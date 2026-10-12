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
import { type ContextCatalog, accountIdOf, applyContextWindows, errorDetail, fetchContextCatalog } from "./codex-catalog.ts";
import {
	ACTIVE_ALIAS_ID,
	ALIAS_PREFIX,
	BASE_URL,
	NATIVE_PROVIDER,
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

	async function fetchCatalogs(ctx: ExtensionContext): Promise<Map<string, ContextCatalog>> {
		const catalogs = new Map<string, ContextCatalog>();
		if (/^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? "")) return catalogs;
		const state = readCodexState();
		await Promise.all(
			codexAliasIds(state).map(async (id) => {
				const found = accountFor(state, id);
				if (!found) return;
				try {
					const catalog = await fetchContextCatalog((await freshCredential(found.credential)).access ?? "");
					catalogs.set(catalog.accountId, catalog);
				} catch (error) {
					ctx.ui.notify(
						`Codex account "${found.name}": using base context windows; ${errorDetail(error)}`,
						"warning",
					);
				}
			}),
		);
		return catalogs;
	}

	async function sync(ctx: ExtensionContext): Promise<void> {
		const live = ctx.modelRegistry.getAll().filter((model) => model.provider === NATIVE_PROVIDER);
		if (live.length > 0) {
			models = live.map(({ provider: _provider, baseUrl: _baseUrl, ...model }) => ({ ...model })) as AliasModel[];
		}
		const generation = ++syncGeneration;
		sweepStaleAliases(ctx, wantedIds(readCodexState()));
		const catalogs = await fetchCatalogs(ctx);
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

	return {
		bootstrap: async () => {
			for (const id of wantedIds(readCodexState())) registerAlias(id);
		},
		sync,
		watchStore,
		stop,
	};
}
