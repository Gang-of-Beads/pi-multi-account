/**
 * Per-account `anthropic-<name>` provider aliases.
 *
 * Each alias clones pi's native Anthropic catalogue but binds to exactly one
 * named account, so `/model` can pin a session to an account instead of
 * following the single stored "active" account.
 */
import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { AccountStore } from "@narumitw/pi-accounts/src/accounts.ts";
import { builtinProviders, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { anthropicAdapter } from "./adapters.ts";
import { applyUserAgentOverride, buildUserAgent } from "./billing.ts";
import { credentialSummary, logDebug, logError } from "./debug-log.ts";
import { errorMessage } from "./errors.ts";
import { isCredentialSuspect, REFRESH_SKEW_MS, refreshAccountCredential } from "./refresh.ts";
import { storeObserver } from "./store-watch.ts";

export const ALIAS_PREFIX = "anthropic-";

type ProviderModel = ProviderModelConfig & Record<string, unknown>;

/** Registration surface used by the entrypoint and by the account menus. */
export interface AliasRegistry {
	/** Register aliases before any session exists, so early model resolution sees them. */
	bootstrap(): Promise<void>;
	/** Re-register aliases and drop the ones whose account is gone. */
	sync(ctx: ExtensionContext): Promise<void>;
}

/** Account name bound to an `anthropic-<account>` provider id, if any. */
export function aliasAccountName(providerId: string | undefined): string | undefined {
	if (!providerId || !providerId.startsWith(ALIAS_PREFIX)) return undefined;
	const name = providerId.slice(ALIAS_PREFIX.length);
	return name.length > 0 ? name : undefined;
}

export function registerAccountAliasProviders(
	pi: ExtensionAPI,
	store: AccountStore,
): AliasRegistry {
	if (process.env.PI_MULTI_ACCOUNT_ALIASES === "0") {
		return {
			bootstrap: async () => undefined,
			sync: async (_ctx) => undefined,
		};
	}

	let models: ProviderModel[] = [];

	async function bootstrap(): Promise<void> {
		const state = await store.readProviderAsync("anthropic");
		models = builtinAnthropicModels();
		for (const name of Object.keys(state.accounts)) {
			registerAliasProvider(pi, store, `${ALIAS_PREFIX}${name}`, models);
		}
	}

	async function sync(ctx: ExtensionContext): Promise<void> {
		const state = await store.readProviderAsync("anthropic");
		models = readAnthropicModels(ctx);
		const current = new Set(
			Object.keys(state.accounts).map((name) => `${ALIAS_PREFIX}${name}`),
		);

		// Unregister stale aliases. Critical after /reload: the runtime keeps
		// providers registered by the previous extension instance (module state
		// resets but the provider registry persists), so aliases of deleted
		// accounts would otherwise linger in /model forever.
		for (const id of ctx.modelRegistry.getRegisteredProviderIds()) {
			if (id.startsWith(ALIAS_PREFIX) && !current.has(id)) {
				pi.unregisterProvider(id);
			}
		}

		for (const name of Object.keys(state.accounts)) {
			registerAliasProvider(pi, store, `${ALIAS_PREFIX}${name}`, models);
		}
	}
	pi.registerCommand("anthropic-account-providers", {
		description: "Refresh Anthropic named-account providers shown by /model",
		handler: async (_args, ctx) => {
			await sync(ctx);
			const state = await store.readProviderAsync("anthropic");
			const names = Object.keys(state.accounts).map((name) => `${ALIAS_PREFIX}${name}`).sort();
			ctx.ui.notify(
				names.length > 0 ? `Registered: ${names.join(", ")}` : "No named Anthropic accounts found.",
				"info",
			);
		},
	});

	return { bootstrap, sync };
}

function builtinAnthropicModels(): ProviderModel[] {
	return getBuiltinModels("anthropic").map(({ provider: _provider, baseUrl: _baseUrl, ...model }) => ({
		...model,
	})) as ProviderModel[];
}

function registerAliasProvider(
	pi: ExtensionAPI,
	store: AccountStore,
	id: string,
	models: ProviderModel[],
): void {
	const accountName = id.startsWith(ALIAS_PREFIX) ? id.slice(ALIAS_PREFIX.length) : id;
	const baseProvider = builtinProviders().find((provider) => provider.id === "anthropic");
	if (!baseProvider) throw new Error("Pi's built-in Anthropic provider is unavailable.");
	const aliasModels = models.map((model) => ({
		...model,
		api: model.api!,
		provider: id,
		baseUrl: "https://api.anthropic.com",
	}));
	// Wrap the caller's fetch so the wire UA matches the billing header's
	// cc_version: pi-ai merges its own bare `claude-cli/<version>` UA inside
	// the SDK client, after every header hook pi offers, so the fetch wrapper
	// is the only point where the final headers can be corrected. The
	// provider-level `headers` below never reaches the wire (kept for
	// forward-compatibility with pi versions that consume it).
	const uaFixFetch = (realFetch: typeof fetch): typeof fetch => async (input, init) => {
		const fixedInit = init ? { ...init, headers: new Headers(init.headers ?? undefined) } : { headers: new Headers() };
		applyUserAgentOverride(fixedInit.headers as Headers);
		return realFetch(input, fixedInit as RequestInit);
	};
	pi.unregisterProvider(id);
	pi.registerProvider({
		id,
		name: id,
		baseUrl: "https://api.anthropic.com",
		headers: { "user-agent": buildUserAgent() },
		// Hand pi the raw `sk-ant-oat…` access token as the apiKey rather than a
		// pre-built Authorization header: pi's Anthropic adapter switches into
		// Claude Code / OAuth mode by *inspecting the key* (isOAuthToken), and that
		// mode is what sends Bearer auth, the `claude-code-20250219` +
		// `oauth-2025-04-20` betas, the Claude Code identity system block and
		// Claude-Code tool names. With a header-only credential the adapter takes
		// the plain API-key path, so subscription billing injection never fires and
		// the request is billed as pay-as-you-go extra usage.
		auth: {
			apiKey: {
				name: `${id} account token`,
				async check({ signal }) {
					signal.throwIfAborted();
					const state = await store.readProviderAsync("anthropic");
					const credential = state.accounts[accountName];
					if (!credential || credential.type !== "oauth") return undefined;
					return {
						type: "api_key",
						source: `pi-accounts:${accountName}`,
					};
				},
				async resolve({ signal }) {
					signal.throwIfAborted();
					const state = await store.readProviderAsync("anthropic");
					storeObserver("anthropic").observe(state, `alias.resolve:${accountName}`);
					let credential = state.accounts[accountName];
					if (!credential || credential.type !== "oauth") {
						logError("alias.unresolved", { provider: id, account: accountName, reason: "no stored oauth credential" });
						return undefined;
					}
					// A rejected token is refreshed even before it expires; otherwise every
					// request on this alias keeps sending the token the provider revoked.
					const suspect = isCredentialSuspect("anthropic", accountName);
					if (suspect || credential.expires <= Date.now() + REFRESH_SKEW_MS) {
						try {
							credential = await refreshAccountCredential(
								store,
								anthropicAdapter(),
								accountName,
								credential,
								Date.now(),
								{ force: suspect },
							);
						} catch (error) {
							logError("alias.refresh_failed", {
								provider: id,
								account: accountName,
								suspect,
								detail: errorMessage(error),
							});
							throw error;
						}
					}
					signal.throwIfAborted();
					// The one line that answers "which account did this request bill to?".
					logDebug("request.credential", {
						provider: id,
						account: accountName,
						storedActive: state.active,
						credential: credentialSummary(credential),
					});
					return {
						auth: { apiKey: credential.access },
						source: `pi-accounts:${accountName}`,
					};
				},
			},
		},
		getModels: () => aliasModels,
		...(baseProvider.filterModels
			? {
					filterModels: (providerModels, credential) =>
						baseProvider.filterModels?.(providerModels as any, credential) ?? providerModels,
			  }
			: {}),
		stream: (model, context, options) =>
			baseProvider.stream(model as never, context, {
				...(options as Record<string, unknown>),
				fetch: uaFixFetch(
					typeof (options as { fetch?: typeof fetch } | undefined)?.fetch === "function"
						? (options as { fetch: typeof fetch }).fetch
						: globalThis.fetch,
				),
			} as never),
		streamSimple: (model, context, options) =>
			baseProvider.streamSimple(model as never, context, {
				...(options as Record<string, unknown>),
				fetch: uaFixFetch(
					typeof (options as { fetch?: typeof fetch } | undefined)?.fetch === "function"
						? (options as { fetch: typeof fetch }).fetch
						: globalThis.fetch,
				),
			} as never),
	});
}

function readAnthropicModels(ctx: ExtensionContext): ProviderModel[] {
	return ctx.modelRegistry
		.getAvailable()
		.filter((model) => model.provider === "anthropic")
		.map(({ provider: _provider, baseUrl: _baseUrl, ...model }) => ({ ...model })) as ProviderModel[];
}
