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
 *     (disable with PI_MULTI_ACCOUNT_AUTO_IMPORT=0). Interactive sessions ask
 *     for the account alias instead of inventing `cc-max`/`cc-pro` names;
 *     headless runs fall back to generated names, or to the comma-separated
 *     PI_MULTI_ACCOUNT_AUTO_IMPORT_NAMES list. Also available manually via
 *     `/sub-import` and `/sub-accounts` (subscription-agnostic names so other
 *     subscription clients can be added later), and accounts can be renamed
 *     later from `/accounts`.
 *   - Registers `anthropic-<name>` provider aliases so every named account
 *     shows up directly in the `/model` picker and stays selected as
 *     `anthropic-<name>/<model>` — the footer and `/model` therefore keep
 *     showing which account a session talks to
 *     (disable with PI_MULTI_ACCOUNT_ALIASES=0).
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import accountsExtension, {
	AccountStore,
	DEFAULT_PI_LOGIN_LABEL,
	parseAccountName,
} from "@narumitw/pi-accounts/src/accounts.ts";
import {
	defineOwn,
	defineOwnMap,
	getOwnCredential,
	normalizeStoredCredential,
} from "@narumitw/pi-accounts/src/account-store.ts";
import {
	createBuiltinProviderAdapters,
	loginWithOAuthUI,
	type AccountProviderAdapter,
	type AccountProviderId,
} from "@narumitw/pi-accounts/src/oauth.ts";
import { redactTokenText } from "@narumitw/pi-accounts/src/runtime-auth.ts";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
const refreshFailures = new Map<string, string>();

/**
 * Runs currently in flight in this process, across every session.
 *
 * Anthropic *rotates* OAuth tokens: a successful refresh mints a new access
 * token and invalidates the previous one, which the provider then reports as
 * `"OAuth access token has been revoked."` rather than as an expiry. A long
 * agentic turn resolves its credential once, at `before_agent_start`, so
 * refreshing the account that turn is using pulls the token out from under an
 * in-flight request and fails it mid-run.
 *
 * The background sweep therefore leaves the *active* account alone while any
 * run is in flight. Idle accounts carry no in-flight request and stay eligible,
 * which is the whole point of the sweep. Module scope, not session scope: pi
 * loads this extension once per session, and a run in one session uses the same
 * credential file as every other.
 */
let inFlightRunCount = 0;

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
	const refreshLoop = acquireBackgroundRefreshLoop(store, providers);

	// Bracket every run so the sweep can leave the credential it is using alone.
	// Counted rather than boolean: one process hosts many sessions, and their
	// runs overlap freely.
	let runInFlight = false;
	pi.on("agent_start", () => {
		if (runInFlight) return;
		runInFlight = true;
		inFlightRunCount += 1;
	});
	const releaseRun = (): void => {
		if (!runInFlight) return;
		runInFlight = false;
		inFlightRunCount = Math.max(0, inFlightRunCount - 1);
	};
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

	// Part 4 — interactive account manager override with explicit re-login.
	registerAccountsCommandOverride(pi, store, providers, aliases, refreshLoop);

	// Part 5 — subscription account import commands (/sub-accounts, /sub-import).
	registerClaudeImportCommands(pi, store, aliases, refreshLoop);

	// Status footer: show the active Anthropic account and billing mode.
	pi.on("session_start", async (_event, ctx) => {
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
		await restoreAliasSelection(pi, store, ctx);
		await syncActiveAccountToSelectedAlias(store, ctx);
		await updateBillingStatus(store, ctx);
	});

	// Selecting `anthropic-<account>/<model>` stays selected: the alias resolves
	// its own account credential per request, so the session keeps talking to the
	// account the user picked and /model plus the footer keep showing which one.
	// The stored active account is still pointed at it so the canonical
	// `anthropic` provider and /accounts agree with the last explicit choice.
	pi.on("model_select", async (event, ctx) => {
		if (event.model.provider.startsWith(ALIAS_PREFIX)) {
			await syncActiveAccountToSelectedAlias(store, ctx);
		}
		await updateBillingStatus(store, ctx);
	});

	pi.on("session_shutdown", async () => {
		// A session torn down mid-run must not leave the sweep permanently
		// convinced that a run is still in flight.
		releaseRun();
		refreshLoop.stop();
	});
}

function createPatchedProviders(): AccountProviderAdapter[] {
	return createBuiltinProviderAdapters().map((provider) => ({
		...provider,
		oauth: {
			...provider.oauth,
			refresh: async (credential, signal) => {
				try {
					return preserveCredentialMetadata(
						credential,
						await provider.oauth.refresh(credential, signal ?? new AbortController().signal),
					);
				} catch (error) {
					throw sanitizeRefreshError(provider.id, undefined, error);
				}
			},
		},
	}));
}

/**
 * One sweep per process, shared by every session.
 *
 * pi loads this extension once per session, so a per-session timer would mean N
 * sweeps of a single credential file. Each sweep can rotate tokens, and every
 * needless rotation is another chance to invalidate a token some other session
 * is about to use, so the sweep is deduplicated here and stopped only when the
 * last session shuts down.
 */
let sharedRefreshLoop: BackgroundRefreshLoop | undefined;
let refreshLoopUsers = 0;

interface BackgroundRefreshLoop {
	start(): void;
	stop(): void;
	refreshNow(): Promise<void>;
}

function acquireBackgroundRefreshLoop(
	store: AccountStore,
	providers: readonly AccountProviderAdapter[],
): BackgroundRefreshLoop {
	refreshLoopUsers += 1;
	sharedRefreshLoop ??= createBackgroundRefreshLoop(store, providers);
	const loop = sharedRefreshLoop;
	return {
		start: () => { loop.start(); },
		refreshNow: () => loop.refreshNow(),
		stop() {
			refreshLoopUsers = Math.max(0, refreshLoopUsers - 1);
			if (refreshLoopUsers > 0) return;
			loop.stop();
			sharedRefreshLoop = undefined;
		},
	};
}

function createBackgroundRefreshLoop(
	store: AccountStore,
	providers: readonly AccountProviderAdapter[],
): BackgroundRefreshLoop {
	let timer: NodeJS.Timeout | undefined;
	let running: Promise<void> | undefined;

	const refreshNow = async (): Promise<void> => {
		if (running) return running;
		running = (async () => {
			try {
				// Read the counter at sweep time, not at loop construction: a run may
				// start or finish between ticks.
				await refreshExpiringAccounts(store, providers, { protectActiveAccount: inFlightRunCount > 0 });
			} catch {
				// Background refresh is best-effort; request-time auth still reports actionable errors.
			} finally {
				running = undefined;
			}
		})();
		return running;
	};

	return {
		start() {
			if (timer) return;
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

export async function refreshExpiringAccounts(
	store: AccountStore,
	providers: readonly AccountProviderAdapter[],
	options: { protectActiveAccount: boolean } = { protectActiveAccount: false },
): Promise<void> {
	const now = Date.now();
	for (const provider of providers) {
		let state;
		try {
			state = await store.readProviderAsync(provider.id);
		} catch {
			continue;
		}
		for (const [accountName, credential] of Object.entries(state.accounts)) {
			if (credential.expires > now + REFRESH_SKEW_MS) continue;
			// Refreshing rotates the token and invalidates the current one. The
			// active account is the one an in-flight run already resolved, so
			// rotating it now would fail that run mid-flight with a revoked-token
			// error. pi-accounts refreshes it at the next `before_agent_start`
			// anyway, which is a safe moment because no request is outstanding.
			if (options.protectActiveAccount && state.active === accountName) continue;
			try {
				await refreshStoredCredential(store, provider, accountName, credential, now);
				clearRefreshFailure(provider.id, accountName);
			} catch (error) {
				recordRefreshFailure(provider.id, accountName, error);
			}
		}
	}
}

function refreshFailureKey(providerId: string, accountName: string): string {
	return `${providerId}:${accountName}`;
}

function recordRefreshFailure(providerId: string, accountName: string, error: unknown): void {
	refreshFailures.set(refreshFailureKey(providerId, accountName), conciseRefreshFailure(error));
}

function clearRefreshFailure(providerId: string, accountName: string): void {
	refreshFailures.delete(refreshFailureKey(providerId, accountName));
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

function registerAccountsCommandOverride(
	pi: ExtensionAPI,
	store: AccountStore,
	providers: readonly AccountProviderAdapter[],
	aliases: { sync(ctx: ExtensionContext): Promise<unknown> },
	refreshLoop: { refreshNow(): Promise<void> },
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
	aliases: { sync(ctx: ExtensionContext): Promise<unknown> },
	refreshLoop: { refreshNow(): Promise<void> },
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
	aliases: { sync(ctx: ExtensionContext): Promise<unknown> },
	refreshLoop: { refreshNow(): Promise<void> },
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
	aliases: { sync(ctx: ExtensionContext): Promise<unknown> },
	refreshLoop: { refreshNow(): Promise<void> },
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
	aliases: { sync(ctx: ExtensionContext): Promise<unknown> },
	refreshLoop: { refreshNow(): Promise<void> },
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
	aliases: { sync(ctx: ExtensionContext): Promise<unknown> },
	refreshLoop: { refreshNow(): Promise<void> },
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
	aliases: { sync(ctx: ExtensionContext): Promise<unknown> },
	refreshLoop: { refreshNow(): Promise<void> },
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
	aliases: { sync(ctx: ExtensionContext): Promise<unknown> },
	refreshLoop: { refreshNow(): Promise<void> },
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
		credential = await refreshStoredCredential(store, adapter, state.active, credential);
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

function isDefaultPiLoginName(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return (
		normalized === "default" ||
		normalized === "--default" ||
		normalized === DEFAULT_PI_LOGIN_LABEL.toLowerCase()
	);
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
		api: model.api!,
		provider: id,
		baseUrl: "https://api.anthropic.com",
	}));
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
					let credential = state.accounts[accountName];
					if (!credential || credential.type !== "oauth") return undefined;
					if (credential.expires <= Date.now() + REFRESH_SKEW_MS) {
						credential = await refreshCredential(store, accountName, credential);
					}
					signal.throwIfAborted();
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
		try {
			refreshed = preserveCredentialMetadata(latest, await oauth.refresh(latest, new AbortController().signal));
			clearRefreshFailure("anthropic", accountName);
		} catch (error) {
			recordRefreshFailure("anthropic", accountName, error);
			throw sanitizeRefreshError("anthropic", accountName, error);
		}
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
		try {
			refreshed = await provider.oauth.refresh(latest, new AbortController().signal);
			clearRefreshFailure(provider.id, accountName);
		} catch (error) {
			recordRefreshFailure(provider.id, accountName, error);
			throw sanitizeRefreshError(provider.id, accountName, error);
		}
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

/** Exported for tests; the extension entrypoint is the default export. */
export async function importClaudeAccounts(
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
		const failedAccounts = Object.keys(state.accounts).filter((accountName) =>
			refreshFailures.has(refreshFailureKey("anthropic", accountName)),
		);
		// Prefer the account bound to the selected alias: that is the account this
		// session actually authenticates as, regardless of the stored active one.
		const sessionAccount = aliasAccountName(ctx.model?.provider);
		const account = sessionAccount ?? state.active;
		if (account) {
			const warning = failedAccounts.length > 0
				? ` · ${failedAccounts.length} account${failedAccounts.length === 1 ? "" : "s"} need re-login`
				: "";
			const label = sessionAccount ? `${ALIAS_PREFIX}${sessionAccount}` : `anthropic: ${account}`;
			ctx.ui.setStatus(BILLING_STATUS_KEY, `${label} · subscription billing${warning}`);
		} else {
			ctx.ui.setStatus(BILLING_STATUS_KEY, undefined);
		}
	} catch {
		// Non-fatal; accounts may be mid-write.
	}
}

/**
 * Drop a persisted `anthropic-<account>` defaultProvider only when that account
 * no longer exists. Alias selections are meant to survive restarts; a dangling
 * alias is not, because nothing will ever register that provider id again.
 */
async function pruneStaleAliasDefaultProvider(store: AccountStore): Promise<void> {
	const settingsPath = join(process.env.HOME ?? "", ".pi", "agent", "settings.json");
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
	} catch {
		return;
	}
	const provider = typeof parsed.defaultProvider === "string" ? parsed.defaultProvider : undefined;
	const accountName = provider?.startsWith(ALIAS_PREFIX) ? provider.slice(ALIAS_PREFIX.length) : undefined;
	if (!accountName) return;
	const anthropicState = await store.readProviderAsync("anthropic");
	if (anthropicState.accounts[accountName]) return;
	parsed.defaultProvider = "anthropic";
	await writeFile(settingsPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

/**
 * Point the stored active account at the alias this session selected, so
 * `/accounts`, the canonical `anthropic` provider, and any other extension
 * reading the store agree with the last explicit choice. The alias itself does
 * not depend on this: it always resolves its own bound account.
 */
async function syncActiveAccountToSelectedAlias(store: AccountStore, ctx: ExtensionContext): Promise<void> {
	const accountName = aliasAccountName(ctx.model?.provider);
	if (!accountName) return;
	const state = await store.readProviderAsync("anthropic");
	if (!state.accounts[accountName]) {
		ctx.ui.notify(`Anthropic account "${accountName}" is unavailable. Re-add it with /accounts.`, "error");
		return;
	}
	if (state.active === accountName) return;
	await store.updateProviderAsync("anthropic", async (current) =>
		current.accounts[accountName] ? { ...current, active: accountName } : current,
	);
}

/**
 * Re-pin a session to the `anthropic-<account>` alias it is supposed to use.
 *
 * pi resolves the initial model (settings default, or the model restored from a
 * session) *before* an alias provider can report configured auth: alias
 * providers are registered natively, and native registration only marks a
 * provider "configured" after an async availability refresh. pi therefore falls
 * back to a plain `anthropic/...` model and the account pin is silently lost.
 * Restoring it here, once aliases are synced, is what makes an alias selection
 * survive restarts and `--continue`.
 *
 * An explicit `--model` / `--models` / `--provider` on the command line always
 * wins, and a session already sitting on an alias is left alone.
 */
async function restoreAliasSelection(
	pi: ExtensionAPI,
	store: AccountStore,
	ctx: ExtensionContext,
): Promise<void> {
	if (!ctx.model) return;
	if (aliasAccountName(ctx.model.provider)) return;
	if (hasCliModelOverride()) return;

	// A session that already recorded a model selection owns its choice; only a
	// session with no selection at all falls back to the settings default.
	const recorded = recordedSessionModel(ctx);
	if (recorded?.kind === "explicit") return;
	const desired = recorded?.model ?? (await desiredAliasFromSettings());
	if (!desired) return;
	if (desired.provider === ctx.model.provider && desired.modelId === ctx.model.id) return;

	const accountName = aliasAccountName(desired.provider);
	if (!accountName) return;
	const state = await store.readProviderAsync("anthropic");
	if (!state.accounts[accountName]) return;

	const model =
		ctx.modelRegistry.find(desired.provider, desired.modelId) ??
		ctx.modelRegistry.find(desired.provider, ctx.model.id);
	if (!model) return;
	await pi.setModel(model);
}

/** True when the user pinned a model on the command line. */
function hasCliModelOverride(): boolean {
	return process.argv
		.slice(2)
		.some((arg) => /^--(model|models|provider)(=|$)/.test(arg));
}

/**
 * Latest model selection recorded in the session being restored.
 *
 * `alias` means the session was last pinned to an `anthropic-<account>` model
 * and should go back to it. `explicit` means the last selection was a normal
 * provider, which must be respected instead of re-applying a settings default.
 */
function recordedSessionModel(
	ctx: ExtensionContext,
): { kind: "alias"; model: { provider: string; modelId: string } } | { kind: "explicit" } | undefined {
	let last: { provider: string; modelId: string } | undefined;
	try {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "model_change") last = { provider: entry.provider, modelId: entry.modelId };
		}
	} catch {
		return undefined;
	}
	if (!last) return undefined;
	return last.provider.startsWith(ALIAS_PREFIX) ? { kind: "alias", model: last } : { kind: "explicit" };
}

/** Alias model persisted as the settings default, if any. */
async function desiredAliasFromSettings(): Promise<{ provider: string; modelId: string } | undefined> {
	const settingsPath = join(process.env.HOME ?? "", ".pi", "agent", "settings.json");
	try {
		const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
		const provider = typeof parsed.defaultProvider === "string" ? parsed.defaultProvider : undefined;
		const modelId = typeof parsed.defaultModel === "string" ? parsed.defaultModel : undefined;
		if (!provider?.startsWith(ALIAS_PREFIX) || !modelId) return undefined;
		return { provider, modelId };
	} catch {
		return undefined;
	}
}

/** Account name bound to an `anthropic-<account>` provider id, if any. */
function aliasAccountName(providerId: string | undefined): string | undefined {
	if (!providerId || !providerId.startsWith(ALIAS_PREFIX)) return undefined;
	const name = providerId.slice(ALIAS_PREFIX.length);
	return name.length > 0 ? name : undefined;
}

/** Exported for tests; parses PI_MULTI_ACCOUNT_AUTO_IMPORT_NAMES-style lists. */
export function parseNameList(value: string | undefined): string[] {
	return (value ?? "")
		.split(/[,\s]+/)
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/**
 * Ask the user to name each detected subscription account before importing it.
 * Falls back to generated names when there is no dialog-capable UI, or when the
 * user leaves an answer empty.
 */
async function runInteractiveImport(
	store: AccountStore,
	ctx: ExtensionContext,
	detected: SubscriptionAccount[],
): Promise<void> {
	const state = await store.readProviderAsync("anthropic");
	if (Object.keys(state.accounts).length > 0 || state.active) return;

	if (!ctx.hasUI) {
		const imported = await importClaudeAccounts(store, detected, []);
		if (imported.length > 0) {
			ctx.ui.notify(`Imported subscription account(s): ${imported.join(", ")}. Rename them in /accounts.`, "info");
		}
		return;
	}

	const summary = detected
		.map((account) => {
			const tier = account.credentials.subscriptionType ? ` (${account.credentials.subscriptionType})` : "";
			return `  ${account.label}${tier} — ${account.source}`;
		})
		.join("\n");
	const confirmed = await ctx.ui.confirm(
		"Import subscription accounts",
		`Found ${detected.length} Claude Code account(s):\n${summary}\n\n` +
			"Import them into pi as named Anthropic accounts? Each one shows up in /model as anthropic-<name>.",
	);
	if (!confirmed) {
		ctx.ui.notify(
			"Skipped. Import later with /sub-import, or set PI_MULTI_ACCOUNT_AUTO_IMPORT=0 to stop asking.",
			"info",
		);
		return;
	}

	const names = await promptAccountNames(ctx, detected);
	const imported = await importClaudeAccounts(store, detected, names);
	if (imported.length > 0) {
		ctx.ui.notify(
			`Imported: ${imported.join(", ")}. Select one per session in /model (anthropic-${imported[0]}/…), ` +
				"or rename it later in /accounts.",
			"info",
		);
	}
}

/** Prompt once per detected account for the alias name to store it under. */
async function promptAccountNames(
	ctx: ExtensionContext,
	detected: SubscriptionAccount[],
): Promise<string[]> {
	const names: string[] = [];
	const taken = new Set<string>();
	for (const [index, account] of detected.entries()) {
		const suggestion = baseImportName(account);
		const tier = account.credentials.subscriptionType ? ` (${account.credentials.subscriptionType})` : "";
		let name = "";
		for (;;) {
			const answer = await ctx.ui.input(
				`Alias for ${account.label}${tier} [${index + 1}/${detected.length}] — blank uses "${suggestion}"`,
				suggestion,
			);
			const candidate = (answer ?? "").trim();
			if (candidate.length === 0) break; // blank or cancelled → generated name
			const parsed = parseAccountName(candidate);
			if (!parsed.ok) {
				ctx.ui.notify(parsed.error, "warning");
				continue;
			}
			if (isDefaultPiLoginName(parsed.name)) {
				ctx.ui.notify('"default" is reserved for Pi\'s built-in login.', "warning");
				continue;
			}
			if (taken.has(parsed.name)) {
				ctx.ui.notify(`"${parsed.name}" was already used for another account.`, "warning");
				continue;
			}
			name = parsed.name;
			taken.add(parsed.name);
			break;
		}
		names.push(name);
	}
	// importClaudeAccounts() generates a name for every empty slot.
	return names;
}

function conciseRefreshFailure(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const payloadMatch = message.match(/body=(\{.*\})/s);
	if (payloadMatch) {
		try {
			const payload = JSON.parse(payloadMatch[1]) as { error?: unknown; error_description?: unknown };
			if (typeof payload.error === "string" && typeof payload.error_description === "string") {
				return `${payload.error} (${payload.error_description})`;
			}
			if (typeof payload.error === "string") return payload.error;
		} catch {
			// Fall through to plain-text cleanup.
		}
	}

	if (/invalid_grant/i.test(message) && /Refresh token not found or invalid/i.test(message)) {
		return "invalid_grant (refresh token not found or invalid)";
	}

	return message
		.replace(/; stack=.*$/s, "")
		.replace(/^Anthropic token refresh request failed\.\s*/i, "")
		.replace(/^Token exchange request failed\.\s*/i, "")
		.replace(/^OAuth refresh failed\.\s*/i, "")
		.replace(/\burl=https?:\/\/[^;]+;?\s*/gi, "")
		.replace(/\bdetails=/gi, "")
		.replace(/\s+/g, " ")
		.trim();
}

function sanitizeRefreshError(providerId: string, accountName: string | undefined, error: unknown): Error {
	const subject = accountName ? `${providerId} account "${accountName}"` : `${providerId} account`;
	const detail = conciseRefreshFailure(error) || "refresh failed";
	const guidance = /invalid_grant/i.test(detail) ? " Re-login this account in /accounts." : "";
	return new Error(`${subject} refresh failed: ${detail}.${guidance}`.replace(/\.\s*\./g, "."));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}