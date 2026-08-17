/**
 * The `/accounts` menu: login, re-login, switch, rename, remove.
 *
 * This replaces pi-accounts' own command so re-login and rename can be offered
 * explicitly instead of forcing a same-name replace flow.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { AccountStore, DEFAULT_PI_LOGIN_LABEL, parseAccountName } from "@narumitw/pi-accounts/src/accounts.ts";
import { defineOwn, defineOwnMap, getOwnCredential, normalizeStoredCredential } from "@narumitw/pi-accounts/src/account-store.ts";
import { loginWithOAuthUI, type AccountProviderAdapter, type AccountProviderId } from "@narumitw/pi-accounts/src/oauth.ts";
import { redactTokenText } from "@narumitw/pi-accounts/src/runtime-auth.ts";
import { preserveCredentialMetadata } from "./adapters.ts";
import { ALIAS_PREFIX, aliasAccountName, type AliasRegistry } from "./aliases.ts";
import { errorMessage } from "./errors.ts";
import { isDefaultPiLoginName } from "./names.ts";
import { REFRESH_SKEW_MS, refreshAccountCredential, type BackgroundRefreshLoop } from "./refresh.ts";
import { updateBillingStatus } from "./session-state.ts";

export function registerAccountsCommandOverride(
	pi: ExtensionAPI,
	store: AccountStore,
	providers: readonly AccountProviderAdapter[],
	aliases: AliasRegistry,
	refreshLoop: Pick<BackgroundRefreshLoop, "refreshNow">,
): void {
	const adapterMap = new Map<AccountProviderId, AccountProviderAdapter>(
		providers.map((provider) => [provider.id, provider]),
	);

	pi.registerCommand("accounts", {
		description: "Manage provider OAuth accounts, including re-login for existing accounts",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/accounts requires interactive UI (TUI or RPC mode).", "error");
				return;
			}

			const states = await readProviderStates(store, providers);
			const hasAnyStoredAccount = states.some((state) => Object.keys(state.accounts).length > 0);
			const actions = [
				"Login new account",
				...(hasAnyStoredAccount
					? [
						"Re-login existing account",
						"Switch active account",
						"Rename account",
						"Remove account",
					]
					: []),
			];
			const action = await ctx.ui.select(formatAccountsOverview(ctx, states), actions);
			if (!action) return;

			switch (action) {
				case "Login new account":
					await loginNewAccount(ctx, store, adapterMap, states, aliases, refreshLoop);
					return;
				case "Re-login existing account":
					await reloginExistingAccount(ctx, store, adapterMap, states, aliases, refreshLoop);
					return;
				case "Switch active account":
					await switchStoredAccount(ctx, store, adapterMap, states, aliases, refreshLoop);
					return;
				case "Rename account":
					await renameStoredAccount(pi, ctx, store, adapterMap, states, aliases, refreshLoop);
					return;
				case "Remove account":
					await removeStoredAccount(ctx, store, adapterMap, states, aliases, refreshLoop);
					return;
			}
		},
	});
}

type ProviderState = {
	adapter: AccountProviderAdapter;
	active?: string;
	accounts: Record<string, OAuthCredential>;
};

async function readProviderStates(
	store: AccountStore,
	providers: readonly AccountProviderAdapter[],
): Promise<ProviderState[]> {
	const states: ProviderState[] = [];
	for (const provider of providers) {
		const state = await store.readProviderAsync(provider.id);
		states.push({ adapter: provider, active: state.active, accounts: state.accounts });
	}
	return states;
}

function formatAccountsOverview(ctx: ExtensionCommandContext, states: readonly ProviderState[]): string {
	const lines = [
		"Accounts",
		"",
		`Current model: ${formatCurrentModel(ctx)}`,
		"",
		"Active accounts:",
		...states.map((state) => `  ${state.adapter.displayName}: ${state.active ?? "default"}`),
		"",
		"Saved accounts:",
		...states.flatMap((state) => {
			const names = Object.keys(state.accounts).sort();
			return names.length > 0
				? names.map((name) => `  ${state.adapter.displayName}: ${name}${state.active === name ? " (active)" : ""}`)
				: [`  ${state.adapter.displayName}: (none)`];
		}),
		"",
		"Choose an action:",
	];
	return lines.join("\n");
}

function formatCurrentModel(ctx: ExtensionCommandContext): string {
	if (!ctx.model) return "(none)";
	return `${ctx.model.provider} / ${ctx.model.id}`;
}

async function selectProviderState(
	ctx: ExtensionCommandContext,
	states: readonly ProviderState[],
	title: string,
	filter: (state: ProviderState) => boolean = () => true,
): Promise<ProviderState | undefined> {
	const options = states.filter(filter);
	if (options.length === 0) return undefined;
	const labels = options.map((state) => {
		const count = Object.keys(state.accounts).length;
		return `${state.adapter.displayName} · active ${state.active ?? "default"} · ${count} saved`;
	});
	const selected = await ctx.ui.select(title, labels);
	if (!selected) return undefined;
	return options[labels.indexOf(selected)];
}

async function selectStoredAccountName(
	ctx: ExtensionCommandContext,
	state: ProviderState,
	title: string,
	includeDefault = false,
): Promise<string | undefined> {
	const names = Object.keys(state.accounts).sort();
	const labels = [
		...(includeDefault ? [`${DEFAULT_PI_LOGIN_LABEL}${state.active ? "" : " (active)"}`] : []),
		...names.map((name) => `${name}${state.active === name ? " (active)" : ""}`),
	];
	if (labels.length === 0) return undefined;
	const selected = await ctx.ui.select(title, labels);
	if (!selected) return undefined;
	if (selected.startsWith(DEFAULT_PI_LOGIN_LABEL)) return DEFAULT_PI_LOGIN_LABEL;
	return selected.replace(/ \(active\)$/, "");
}

async function loginNewAccount(
	ctx: ExtensionCommandContext,
	store: AccountStore,
	adapterMap: ReadonlyMap<AccountProviderId, AccountProviderAdapter>,
	states: readonly ProviderState[],
	aliases: AliasRegistry,
	refreshLoop: Pick<BackgroundRefreshLoop, "refreshNow">,
): Promise<void> {
	const state = await selectProviderState(ctx, states, "Select provider for new login");
	if (!state) return;
	const name = await ctx.ui.input(`Name this ${state.adapter.displayName} account:`, "work");
	if (name === undefined) return;
	await runOauthLogin(ctx, store, adapterMap, state.adapter.id, name, aliases, refreshLoop, false);
}

async function reloginExistingAccount(
	ctx: ExtensionCommandContext,
	store: AccountStore,
	adapterMap: ReadonlyMap<AccountProviderId, AccountProviderAdapter>,
	states: readonly ProviderState[],
	aliases: AliasRegistry,
	refreshLoop: Pick<BackgroundRefreshLoop, "refreshNow">,
): Promise<void> {
	const state = await selectProviderState(
		ctx,
		states,
		"Select provider to re-login",
		(candidate) => Object.keys(candidate.accounts).length > 0,
	);
	if (!state) {
		ctx.ui.notify("No saved accounts to re-login.", "info");
		return;
	}
	const accountName = await selectStoredAccountName(
		ctx,
		state,
		`Select ${state.adapter.displayName} account to re-login`,
	);
	if (!accountName) return;
	await runOauthLogin(ctx, store, adapterMap, state.adapter.id, accountName, aliases, refreshLoop, true);
}

async function runOauthLogin(
	ctx: ExtensionCommandContext,
	store: AccountStore,
	adapterMap: ReadonlyMap<AccountProviderId, AccountProviderAdapter>,
	providerId: AccountProviderId,
	nameArg: string,
	aliases: AliasRegistry,
	refreshLoop: Pick<BackgroundRefreshLoop, "refreshNow">,
	replaceExpected: boolean,
): Promise<void> {
	const adapter = adapterMap.get(providerId);
	if (!adapter) throw new Error(`Unsupported account provider: ${providerId}`);
	const parsed = parseAccountName(nameArg);
	if (!parsed.ok) {
		ctx.ui.notify(parsed.error, "warning");
		return;
	}
	if (isDefaultPiLoginName(parsed.name)) {
		ctx.ui.notify('"default" is reserved for Pi\'s built-in login.', "warning");
		return;
	}
	const existingState = await store.readProviderAsync(providerId);
	const exists = !!getOwnCredential(existingState.accounts, parsed.name);
	if (exists) {
		const confirmed = await ctx.ui.confirm(
			replaceExpected ? "Re-login account" : "Replace account",
			replaceExpected
				? `${adapter.displayName} account "${parsed.name}" will re-run OAuth and replace the saved tokens. Continue?`
				: `${adapter.displayName} account "${parsed.name}" already exists. Replace it?`,
		);
		if (!confirmed) return;
	} else if (replaceExpected) {
		ctx.ui.notify(`${adapter.displayName} account "${parsed.name}" was not found.`, "warning");
		return;
	}

	ctx.ui.notify(
		`${replaceExpected ? "Re-running" : "Starting"} ${adapter.displayName} login for "${parsed.name}".`,
		"info",
	);
	try {
		const credential = preserveCredentialMetadata(
			(existingState.accounts[parsed.name] as OAuthCredential | undefined) ?? ({
				type: "oauth",
				access: "",
				refresh: "",
				expires: 0,
			} as OAuthCredential),
			normalizeStoredCredential(
				await loginWithOAuthUI(ctx, adapter, new AbortController().signal),
				parsed.name,
			),
		);
		await store.updateProvider(providerId, (state) => ({
			active: parsed.name,
			accounts: defineOwn(state.accounts, parsed.name, credential),
		}));
		await afterAccountMutation(ctx, store, adapterMap, aliases, refreshLoop);
		ctx.ui.notify(
			`${replaceExpected ? "Re-logged in" : "Logged in"} ${adapter.displayName} account "${parsed.name}".`,
			"info",
		);
	} catch (error) {
		ctx.ui.notify(`${adapter.displayName} login failed: ${redactTokenText(errorMessage(error))}`, "error");
	}
}

async function switchStoredAccount(
	ctx: ExtensionCommandContext,
	store: AccountStore,
	adapterMap: ReadonlyMap<AccountProviderId, AccountProviderAdapter>,
	states: readonly ProviderState[],
	aliases: AliasRegistry,
	refreshLoop: Pick<BackgroundRefreshLoop, "refreshNow">,
): Promise<void> {
	const state = await selectProviderState(
		ctx,
		states,
		"Select provider to switch",
		(candidate) => Object.keys(candidate.accounts).length > 0,
	);
	if (!state) {
		ctx.ui.notify("No saved accounts to switch.", "info");
		return;
	}
	const target = await selectStoredAccountName(
		ctx,
		state,
		`Select active ${state.adapter.displayName} account`,
		true,
	);
	if (!target) return;
	const adapter = adapterMap.get(state.adapter.id);
	if (!adapter) throw new Error(`Unsupported account provider: ${state.adapter.id}`);
	if (target === DEFAULT_PI_LOGIN_LABEL) {
		await store.updateProvider(adapter.id, (current) => ({ ...current, active: undefined }));
		await afterAccountMutation(ctx, store, adapterMap, aliases, refreshLoop);
		ctx.ui.notify(`Using default Pi ${adapter.displayName} login now.`, "info");
		return;
	}
	let switched = false;
	await store.updateProvider(adapter.id, (current) => {
		if (!getOwnCredential(current.accounts, target)) return current;
		switched = true;
		return { ...current, active: target };
	});
	if (!switched) {
		ctx.ui.notify(`${adapter.displayName} account "${target}" was not found.`, "warning");
		return;
	}
	await afterAccountMutation(ctx, store, adapterMap, aliases, refreshLoop);
	ctx.ui.notify(`Activated ${adapter.displayName} account "${target}" now.`, "info");
}

/**
 * Rename a stored account, e.g. an auto-imported `cc-max` to `work`. The
 * `anthropic-<name>` alias follows the new name after the alias re-sync, and a
 * session currently pinned to the old alias is moved to the new one.
 */
async function renameStoredAccount(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	store: AccountStore,
	adapterMap: ReadonlyMap<AccountProviderId, AccountProviderAdapter>,
	states: readonly ProviderState[],
	aliases: AliasRegistry,
	refreshLoop: Pick<BackgroundRefreshLoop, "refreshNow">,
): Promise<void> {
	const state = await selectProviderState(
		ctx,
		states,
		"Select provider to rename in",
		(candidate) => Object.keys(candidate.accounts).length > 0,
	);
	if (!state) {
		ctx.ui.notify("No saved accounts to rename.", "info");
		return;
	}
	const accountName = await selectStoredAccountName(
		ctx,
		state,
		`Select ${state.adapter.displayName} account to rename`,
	);
	if (!accountName) return;
	const adapter = adapterMap.get(state.adapter.id);
	if (!adapter) throw new Error(`Unsupported account provider: ${state.adapter.id}`);

	const answer = await ctx.ui.input(`New name for "${accountName}":`, accountName);
	const requested = (answer ?? "").trim();
	if (requested.length === 0 || requested === accountName) return;
	const parsed = parseAccountName(requested);
	if (!parsed.ok) {
		ctx.ui.notify(parsed.error, "warning");
		return;
	}
	if (isDefaultPiLoginName(parsed.name)) {
		ctx.ui.notify('"default" is reserved for Pi\'s built-in login.', "warning");
		return;
	}

	let failure: string | undefined;
	await store.updateProvider(adapter.id, (current) => {
		const credential = getOwnCredential(current.accounts, accountName);
		if (!credential) {
			failure = `${adapter.displayName} account "${accountName}" was not found.`;
			return current;
		}
		if (getOwnCredential(current.accounts, parsed.name)) {
			failure = `${adapter.displayName} account "${parsed.name}" already exists.`;
			return current;
		}
		const accounts = defineOwnMap(current.accounts);
		delete accounts[accountName];
		return {
			active: current.active === accountName ? parsed.name : current.active,
			accounts: defineOwn(accounts, parsed.name, credential),
		};
	});
	if (failure) {
		ctx.ui.notify(failure, "warning");
		return;
	}

	// Keep a session that is pinned to the old alias working by moving it to the
	// renamed one; the old alias id is about to be unregistered.
	const pinned = aliasAccountName(ctx.model?.provider);
	const movedModelId = adapter.id === "anthropic" && pinned === accountName ? ctx.model?.id : undefined;

	await afterAccountMutation(ctx, store, adapterMap, aliases, refreshLoop);

	if (movedModelId) {
		const renamedModel = ctx.modelRegistry.find(`${ALIAS_PREFIX}${parsed.name}`, movedModelId);
		if (renamedModel) await pi.setModel(renamedModel);
	}
	ctx.ui.notify(`Renamed ${adapter.displayName} account "${accountName}" to "${parsed.name}".`, "info");
}

async function removeStoredAccount(
	ctx: ExtensionCommandContext,
	store: AccountStore,
	adapterMap: ReadonlyMap<AccountProviderId, AccountProviderAdapter>,
	states: readonly ProviderState[],
	aliases: AliasRegistry,
	refreshLoop: Pick<BackgroundRefreshLoop, "refreshNow">,
): Promise<void> {
	const state = await selectProviderState(
		ctx,
		states,
		"Select provider to remove from",
		(candidate) => Object.keys(candidate.accounts).length > 0,
	);
	if (!state) {
		ctx.ui.notify("No saved accounts to remove.", "info");
		return;
	}
	const accountName = await selectStoredAccountName(
		ctx,
		state,
		`Select ${state.adapter.displayName} account to remove`,
	);
	if (!accountName) return;
	const adapter = adapterMap.get(state.adapter.id);
	if (!adapter) throw new Error(`Unsupported account provider: ${state.adapter.id}`);
	const confirmed = await ctx.ui.confirm(
		"Remove account",
		`Remove ${adapter.displayName} account "${accountName}"?`,
	);
	if (!confirmed) return;
	let removed = false;
	await store.updateProvider(adapter.id, (current) => {
		if (!getOwnCredential(current.accounts, accountName)) return current;
		removed = true;
		const accounts = defineOwnMap(current.accounts);
		delete accounts[accountName];
		return { active: current.active === accountName ? undefined : current.active, accounts };
	});
	if (!removed) {
		ctx.ui.notify(`${adapter.displayName} account "${accountName}" was not found.`, "warning");
		return;
	}
	await afterAccountMutation(ctx, store, adapterMap, aliases, refreshLoop);
	ctx.ui.notify(`Removed ${adapter.displayName} account "${accountName}".`, "info");
}

async function afterAccountMutation(
	ctx: ExtensionCommandContext,
	store: AccountStore,
	adapterMap: ReadonlyMap<AccountProviderId, AccountProviderAdapter>,
	aliases: AliasRegistry,
	refreshLoop: Pick<BackgroundRefreshLoop, "refreshNow">,
): Promise<void> {
	await refreshLoop.refreshNow();
	try {
		await aliases.sync(ctx);
	} catch (error) {
		ctx.ui.notify(`Account providers were not loaded: ${errorMessage(error)}`, "warning");
	}
	await syncCurrentProviderRuntimeIfPossible(ctx, store, adapterMap);
	await updateBillingStatus(store, ctx);
}

async function syncCurrentProviderRuntimeIfPossible(
	ctx: ExtensionCommandContext,
	store: AccountStore,
	adapterMap: ReadonlyMap<AccountProviderId, AccountProviderAdapter>,
): Promise<void> {
	const providerId = toSupportedProviderId(ctx.model?.provider);
	if (!providerId) return;
	const adapter = adapterMap.get(providerId);
	if (!adapter) return;
	const runtime = (ctx.modelRegistry as unknown as {
		runtime?: {
			setRuntimeApiKey?: (providerId: string, apiKey: string) => Promise<void>;
			removeRuntimeApiKey?: (providerId: string) => Promise<void>;
		};
	}).runtime;
	if (!runtime) return;

	const state = await store.readProviderAsync(providerId);
	if (!state.active) {
		await runtime.removeRuntimeApiKey?.(providerId);
		return;
	}
	let credential = state.accounts[state.active];
	if (!credential) return;
	if (credential.expires <= Date.now() + REFRESH_SKEW_MS) {
		credential = await refreshAccountCredential(store, adapter, state.active, credential);
	}
	const auth = await adapter.oauth.toAuth(credential);
	if (auth.apiKey) {
		await runtime.setRuntimeApiKey?.(providerId, auth.apiKey);
	}
}

function toSupportedProviderId(value: string | undefined): AccountProviderId | undefined {
	return value === "anthropic" || value === "github-copilot" || value === "openai-codex"
		? value
		: undefined;
}
