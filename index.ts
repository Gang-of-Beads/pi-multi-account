/**
 * pi-multi-account — multi-account switching + Claude subscription billing.
 *
 * Combines two capabilities:
 *
 * 1. pi-accounts capability (`@narumitw/pi-accounts`): named subscription
 *    OAuth accounts for anthropic / github-copilot / openai-codex, managed
 *    through the `/accounts` menu. Switch accounts at runtime; the active
 *    account's OAuth token is applied to provider requests on every turn.
 *
 * 2. Claude Code subscription billing (pi-claude-auth style): whenever an
 *    Anthropic OAuth token (`sk-ant-oat…`) is used, requests are sent with the
 *    full Claude Code user-agent (`claude-cli/<v> (external, <entrypoint>)`)
 *    and the `x-anthropic-billing-header` system block, so billing is routed
 *    to the Claude Pro/Max subscription plan instead of pay-as-you-go API
 *    credits / "extra usage".
 *
 * Extras:
 *   - Auto-imports Claude Code accounts found in the macOS Keychain or
 *     `~/.claude/.credentials.json` when the account store is empty
 *     (disable with PI_MULTI_ACCOUNT_AUTO_IMPORT=0). Also available manually
 *     via `/sub-import` and `/sub-accounts` (subscription-agnostic names so
 *     other subscription clients can be added later).
 *   - Registers `anthropic-<name>` provider aliases so every named account
 *     shows up directly in the `/model` picker
 *     (disable with PI_MULTI_ACCOUNT_ALIASES=0).
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import accountsExtension, { AccountStore, parseAccountName } from "@narumitw/pi-accounts/src/accounts.ts";
import {
	createBuiltinProviderAdapters,
	type AccountProviderAdapter,
} from "@narumitw/pi-accounts/src/oauth.ts";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { builtinProviders, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { buildUserAgent, injectBillingHeader } from "./billing.ts";
import {
	detectSubscriptionAccounts,
	type SubscriptionAccount,
} from "./subscription-credentials.ts";

const ALIAS_PREFIX = "anthropic-";
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const BACKGROUND_REFRESH_POLL_MS = 60 * 1000;
const BILLING_STATUS_KEY = "pi-multi-account";

type StoredClaudeCredential = OAuthCredential & {
	client?: "claude-code";
	source?: "claude-code";
	label?: string;
	subscriptionType?: string;
};

type ProviderModel = ProviderModelConfig & Record<string, unknown>;

export default async function (pi: ExtensionAPI): Promise<void> {
	const store = new AccountStore();
	const providers = createPatchedProviders();
	const anthropicProvider = providers.find((provider) => provider.id === "anthropic");
	if (!anthropicProvider) {
		throw new Error("pi-multi-account: missing Anthropic provider adapter.");
	}
	const refreshLoop = createBackgroundRefreshLoop(store, providers);

	// Zero-friction bootstrap: if no Anthropic account has been added yet,
	// import the accounts Claude Code already knows about. Runs inside the
	// factory so pi-accounts' session_start sync sees them immediately.
	if (process.env.PI_MULTI_ACCOUNT_AUTO_IMPORT !== "0") {
		try {
			const state = await store.readProviderAsync("anthropic");
			if (Object.keys(state.accounts).length === 0 && !state.active) {
				const detected = detectSubscriptionAccounts();
				if (detected.length > 0) {
					const imported = await importClaudeAccounts(store, detected, []);
					if (imported.length > 0) {
						console.log(
							`pi-multi-account: auto-imported subscription account(s): ${imported.join(", ")}. ` +
								"Manage with /accounts, import again with /sub-import (PI_MULTI_ACCOUNT_AUTO_IMPORT=0 disables this).",
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

	// Part 1 — pi-accounts: /accounts menu, store, runtime auth switching.
	//
	// Node 24's AbortSignal.any() throws when any entry is undefined. pi's
	// built-in Anthropic OAuth refresh currently accepts an optional signal, but
	// the underlying refresh helper assumes a concrete AbortSignal. pi-accounts
	// calls oauth.refresh() without a signal during session/account sync, which
	// can fail-closed the Anthropic provider before any network request is even
	// attempted. Wrap the Anthropic adapter so refresh always gets a real signal.
	accountsExtension(pi, { store, providers });

	// Part 2 — Claude subscription billing layer.
	registerBillingLayer(pi);

	// Part 3 — per-account provider aliases in the /model picker.
	const aliases = registerAccountAliasProviders(pi, store);
	await aliases.bootstrap();

	// Part 4 — subscription account import commands (/sub-accounts, /sub-import).
	registerClaudeImportCommands(pi, store, aliases, refreshLoop);

	// Status footer: show the active Anthropic account and billing mode.
	pi.on("session_start", async (_event, ctx) => {
		await refreshLoop.refreshNow();
		refreshLoop.start();
		try {
			await aliases.sync(ctx);
		} catch (error) {
			console.error(`pi-multi-account: account providers were not loaded: ${errorMessage(error)}`);
			ctx.ui.notify(`Account providers were not loaded: ${errorMessage(error)}`, "warning");
		}
		await updateBillingStatus(store, ctx);
	});

	pi.on("session_shutdown", async () => {
		refreshLoop.stop();
	});
}

function createPatchedProviders(): AccountProviderAdapter[] {
	return createBuiltinProviderAdapters().map((provider) => ({
		...provider,
		oauth: {
			...provider.oauth,
			refresh: async (credential, signal) =>
				preserveCredentialMetadata(
					credential,
					await provider.oauth.refresh(credential, signal ?? new AbortController().signal),
				),
		},
	}));
}

function createBackgroundRefreshLoop(
	store: AccountStore,
	providers: readonly AccountProviderAdapter[],
): { start(): void; stop(): void; refreshNow(): Promise<void> } {
	let timer: NodeJS.Timeout | undefined;
	let running: Promise<void> | undefined;

	const refreshNow = async (): Promise<void> => {
		if (running) return running;
		running = (async () => {
			try {
				await refreshExpiringAccounts(store, providers);
			} catch (error) {
				console.warn("pi-multi-account: background refresh failed:", errorMessage(error));
			} finally {
				running = undefined;
			}
		})();
		return running;
	};

	return {
		start() {
			if (timer) clearInterval(timer);
			timer = setInterval(() => {
				void refreshNow();
			}, BACKGROUND_REFRESH_POLL_MS);
			timer.unref?.();
		},
		stop() {
			if (!timer) return;
			clearInterval(timer);
			timer = undefined;
		},
		refreshNow,
	};
}

async function refreshExpiringAccounts(
	store: AccountStore,
	providers: readonly AccountProviderAdapter[],
): Promise<void> {
	const now = Date.now();
	for (const provider of providers) {
		let state;
		try {
			state = await store.readProviderAsync(provider.id);
		} catch (error) {
			console.warn(
				`pi-multi-account: failed to read ${provider.id} accounts for background refresh: ${errorMessage(error)}`,
			);
			continue;
		}
		for (const [accountName, credential] of Object.entries(state.accounts)) {
			if (credential.expires > now + REFRESH_SKEW_MS) continue;
			try {
				await refreshStoredCredential(store, provider, accountName, credential, now);
			} catch (error) {
				console.warn(
					`pi-multi-account: ${provider.id} account "${accountName}" background refresh failed: ${errorMessage(error)}`,
				);
			}
		}
	}
}

function preserveCredentialMetadata<T extends OAuthCredential>(
	previous: T,
	refreshed: OAuthCredential,
): T {
	return {
		...(previous as Record<string, unknown>),
		...(refreshed as Record<string, unknown>),
		type: "oauth",
	} as T;
}

// ---------------------------------------------------------------------------
// Part 2 — Claude subscription billing
// ---------------------------------------------------------------------------

function registerBillingLayer(pi: ExtensionAPI): void {
	// Full Claude Code user-agent for the native `anthropic` provider. pi
	// sends a bare `claude-cli/<version>` which fails plan-billing validation;
	// the `(external, <entrypoint>)` form is required for subscription billing.
	// (Alias providers set their own user-agent in registerAliasProvider.)
	pi.registerProvider("anthropic", {
		headers: { "user-agent": buildUserAgent() },
	});

	// Inject the x-anthropic-billing-header system block. Only fires for
	// Claude-model OAuth payloads that already carry the "You are Claude
	// Code…" identity block — plain API-key and Copilot requests are skipped.
	pi.on("before_provider_request", (event) => {
		try {
			const updated = injectBillingHeader(event.payload);
			if (updated) return updated;
		} catch (error) {
			console.warn("pi-multi-account: billing header injection failed:", errorMessage(error));
		}
		return undefined;
	});
}

// ---------------------------------------------------------------------------
// Part 3 — per-account provider aliases (anthropic-<name> in /model)
// ---------------------------------------------------------------------------

function registerAccountAliasProviders(
	pi: ExtensionAPI,
	store: AccountStore,
): { bootstrap(): Promise<void>; sync(ctx: ExtensionContext): Promise<void> } {
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
		provider: id,
		baseUrl: "https://api.anthropic.com",
	}));
	pi.unregisterProvider(id);
	pi.registerProvider({
		id,
		name: id,
		baseUrl: "https://api.anthropic.com",
		headers: { "user-agent": buildUserAgent() },
		auth: {
			apiKey: {
				name: `${id} account token`,
				async resolve({ signal }) {
					signal.throwIfAborted();
					const state = await store.readProviderAsync("anthropic");
					let credential = state.accounts[accountName];
					if (!credential || credential.type !== "oauth") return undefined;
					if (credential.expires <= Date.now() + REFRESH_SKEW_MS) {
						credential = await refreshCredential(store, accountName, credential);
					}
					signal.throwIfAborted();
					return {
						auth: { headers: { Authorization: `Bearer ${credential.access}` } },
						source: `pi-accounts:${accountName}`,
					};
				},
			},
		},
		getModels: () => aliasModels,
		...(baseProvider.filterModels ? { filterModels: (providerModels, credential) => baseProvider.filterModels?.(providerModels as any, credential) } : {}),
		stream: (model, context, options) => baseProvider.stream(model as any, context, options as any),
		streamSimple: (model, context, options) => baseProvider.streamSimple(model as any, context, options as any),
	});
}

function readAnthropicModels(ctx: ExtensionContext): ProviderModel[] {
	return ctx.modelRegistry
		.getAvailable()
		.filter((model) => model.provider === "anthropic")
		.map(({ provider: _provider, baseUrl: _baseUrl, ...model }) => ({ ...model })) as ProviderModel[];
}

async function refreshCredential(
	store: AccountStore,
	accountName: string,
	credential: OAuthCredential,
	now = Date.now(),
): Promise<OAuthCredential> {
	const oauth = builtinProviders().find((provider) => provider.id === "anthropic")?.auth.oauth;
	if (!oauth) throw new Error("Pi's built-in Anthropic OAuth provider is unavailable.");

	let refreshed = credential;
	await store.updateProviderAsync("anthropic", async (state) => {
		const latest = state.accounts[accountName];
		if (!latest || latest.type !== "oauth") {
			throw new Error(`Account "${accountName}" was removed while refreshing.`);
		}
		if (latest.expires > now + REFRESH_SKEW_MS) {
			refreshed = latest;
			return state;
		}
		refreshed = preserveCredentialMetadata(latest, await oauth.refresh(latest, new AbortController().signal));
		return {
			...state,
			accounts: Object.assign(Object.create(null), state.accounts, { [accountName]: refreshed }),
		};
	});
	return refreshed;
}

async function refreshStoredCredential(
	store: AccountStore,
	provider: AccountProviderAdapter,
	accountName: string,
	credential: OAuthCredential,
	now = Date.now(),
): Promise<OAuthCredential> {
	let refreshed = credential;
	await store.updateProviderAsync(provider.id, async (state) => {
		const latest = state.accounts[accountName];
		if (!latest || latest.type !== "oauth") {
			throw new Error(`Account "${accountName}" was removed while refreshing.`);
		}
		if (latest.expires > now + REFRESH_SKEW_MS) {
			refreshed = latest;
			return state;
		}
		refreshed = await provider.oauth.refresh(latest, new AbortController().signal);
		return {
			...state,
			accounts: Object.assign(Object.create(null), state.accounts, { [accountName]: refreshed }),
		};
	});
	return refreshed;
}

// ---------------------------------------------------------------------------
// Part 4 — subscription account import
// ---------------------------------------------------------------------------

function registerClaudeImportCommands(
	pi: ExtensionAPI,
	store: AccountStore,
	aliases: { sync(ctx: ExtensionContext): Promise<unknown> },
	refreshLoop: { refreshNow(): Promise<void> },
): void {
	pi.registerCommand("sub-accounts", {
		description: "List subscription accounts detected on this machine (currently Claude Code) and their import status",
		handler: async (_args, ctx) => {
			try {
				const detected = detectSubscriptionAccounts();
				if (detected.length === 0) {
					ctx.ui.notify(
						"No subscription accounts found. Run `claude` to authenticate first, or use /accounts to add an Anthropic account.",
						"info",
					);
					return;
				}
				const imported = await store.readProviderAsync("anthropic");
				const lines = detected.map((account) => {
					const importedName =
						Object.entries(imported.accounts).find(
							([, credential]) =>
								isClaudeCodeCredential(credential) &&
								credential.source === "claude-code" &&
								credential.label === account.label,
						)?.[0] ?? "not imported";
					const tier = account.credentials.subscriptionType
						? ` (${account.credentials.subscriptionType})`
						: "";
					const state = importedName === "not imported" ? "not imported" : `imported as ${importedName}`;
					return `- [${account.client}] ${account.label}${tier} (${account.source}) — ${state}`;
				});
				ctx.ui.notify(
					`Subscription accounts found:\n${lines.join("\n")}\n\nImport them with /sub-import.`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`Failed to read subscription accounts: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.registerCommand("sub-import", {
		description:
			"Import detected subscription accounts into pi-accounts as named Anthropic accounts (e.g. /sub-import cc-max cc-pro)",
		handler: async (args, ctx) => {
			try {
				const detected = detectSubscriptionAccounts();
				if (detected.length === 0) {
					ctx.ui.notify(
						"No subscription accounts found. Run `claude` to authenticate first.",
						"error",
					);
					return;
				}
				const names = args.trim().split(/\s+/).filter(Boolean);
				if (names.length > detected.length) {
					ctx.ui.notify(
						`You provided ${names.length} names but only ${detected.length} subscription account(s) were found.`,
						"warning",
					);
					return;
				}
				const imported = await importClaudeAccounts(store, detected, names);
				if (imported.length === 0) {
					await refreshLoop.refreshNow();
					ctx.ui.notify(
						"No new accounts to import (all detected accounts are already imported).",
						"info",
					);
					return;
				}
				await refreshLoop.refreshNow();
				await aliases.sync(ctx);
				await updateBillingStatus(store, ctx);
				ctx.ui.notify(
					`Imported: ${imported.join(", ")}\n\nActive account is applied on the next turn. Switch anytime with /accounts.`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`Import failed: ${errorMessage(error)}`, "error");
			}
		},
	});
}

async function healActiveAccount(store: AccountStore): Promise<void> {
	await store.updateProviderAsync("anthropic", async (state) => {
		if (state.active || Object.keys(state.accounts).length === 0) return state;
		const first = Object.keys(state.accounts)[0];
		return { ...state, active: first };
	});
}

async function importClaudeAccounts(
	store: AccountStore,
	detected: SubscriptionAccount[],
	requestedNames: string[],
): Promise<string[]> {
	const taken = new Set<string>();
	const state = await store.readProviderAsync("anthropic");
	for (const name of Object.keys(state.accounts)) taken.add(name);

	const imported: string[] = [];
	await store.updateProviderAsync("anthropic", async (current) => {
		const accounts = { ...current.accounts } as Record<string, StoredClaudeCredential>;
		let firstNewName: string | undefined;
		for (const [index, account] of detected.entries()) {
			let name = requestedNames[index];
			if (!name) {
				const base = baseImportName(account);
				name = base;
				for (let suffix = 2; taken.has(name); suffix += 1) name = `${base}-${suffix}`;
			}
			const parsed = parseAccountName(name);
			if (!parsed.ok) {
				throw new Error(`Invalid account name "${name}": ${parsed.error}`);
			}
			if (taken.has(parsed.name)) continue; // already imported

			accounts[parsed.name] = toStoredCredential(account);
			taken.add(parsed.name);
			imported.push(parsed.name);
			firstNewName ??= parsed.name;
		}
		return imported.length > 0
			? { active: current.active ?? firstNewName, accounts }
			: current;
	});
	return imported;
}

function toStoredCredential(account: SubscriptionAccount): StoredClaudeCredential {
	const credential: StoredClaudeCredential = {
		type: "oauth",
		client: account.client,
		access: account.credentials.accessToken,
		refresh: account.credentials.refreshToken,
		expires: account.credentials.expiresAt,
		source: "claude-code",
		label: account.label,
		...(account.credentials.subscriptionType
			? { subscriptionType: account.credentials.subscriptionType }
			: {}),
	};
	return credential;
}

function baseImportName(account: SubscriptionAccount): string {
	const tier = account.credentials.subscriptionType ?? "";
	if (tier === "max") return "cc-max";
	if (tier === "pro") return "cc-pro";
	return "cc";
}

function isClaudeCodeCredential(value: unknown): value is StoredClaudeCredential {
	return (
		!!value &&
		typeof value === "object" &&
		(value as { source?: unknown }).source === "claude-code"
	);
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

async function updateBillingStatus(store: AccountStore, ctx: ExtensionContext): Promise<void> {
	try {
		const state = await store.readProviderAsync("anthropic");
		if (state.active) {
			ctx.ui.setStatus(BILLING_STATUS_KEY, `anthropic: ${state.active} · subscription billing`);
		} else {
			ctx.ui.setStatus(BILLING_STATUS_KEY, undefined);
		}
	} catch (error) {
		// Non-fatal; accounts may be mid-write.
		console.warn("pi-multi-account: status update failed:", errorMessage(error));
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}