/**
 * Session-level state: which account a session talks to, and what the footer
 * reports about it.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AccountStore } from "@narumitw/pi-accounts/src/accounts.ts";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ALIAS_PREFIX, aliasAccountName } from "./aliases.ts";
import { credentialSummary, logError, logInfo } from "./debug-log.ts";
import { errorMessage } from "./errors.ts";
import { isPoolProvider, lastPoolAccount, poolFirstPick, poolLabel } from "./pool.ts";
import { accountsNeedingRelogin } from "./refresh.ts";

const BILLING_STATUS_KEY = "pi-multi-account";

export async function updateBillingStatus(store: AccountStore, ctx: ExtensionContext): Promise<void> {
	try {
		const state = await store.readProviderAsync("anthropic");
		const failedAccounts = accountsNeedingRelogin("anthropic", Object.keys(state.accounts));
		// Prefer the account bound to the selected alias: that is the account this
		// session actually authenticates as, regardless of the stored active one.
		const sessionAccount = aliasAccountName(ctx.model?.provider);
		const poolName = !sessionAccount && isPoolProvider(ctx.model?.provider) ? ctx.model?.provider : undefined;
		// A pool picks its account per request, so before the first request of a
		// session there is no "current" account yet — fall back to the account it
		// would try next, so the footer never goes blank on a pool model.
		const poolAccount = poolName === undefined
			? undefined
			: (lastPoolAccount(poolName) ?? poolFirstPick(poolName, state));
		const account = sessionAccount ?? (poolName !== undefined ? poolAccount : state.active);
		if (account) {
			const warning = failedAccounts.length > 0
				? ` · ${failedAccounts.length} account${failedAccounts.length === 1 ? "" : "s"} need re-login`
				: "";
			// A pool provider serves whichever account answered; a pinned alias
			// reports its own account; the native provider names its first pick.
			const label = sessionAccount
				? `${ALIAS_PREFIX}${sessionAccount}`
				: poolName !== undefined
					? poolLabel(poolName, account)
					: `anthropic: ${account}`;
			ctx.ui.setStatus(BILLING_STATUS_KEY, `${label} · subscription billing${warning}`);
		} else {
			ctx.ui.setStatus(BILLING_STATUS_KEY, undefined);
		}
		// The account a session bills to is otherwise invisible once the footer
		// scrolls past, and it is the first thing to check after a surprise 401.
		logInfo("session.account", {
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			pinnedAccount: sessionAccount,
			storedActive: state.active,
			resolvedAccount: account,
			needsRelogin: failedAccounts,
			credential: account ? credentialSummary(state.accounts[account]) : undefined,
		});
	} catch (error) {
		// Non-fatal; accounts may be mid-write.
		logError("session.account_status_failed", { detail: errorMessage(error) });
	}
}

/**
 * Warn when pi's own stored Anthropic OAuth credential is still around.
 *
 * pi resolves a provider's credential before it calls stream, and a *stored*
 * credential beats everything except pi-accounts' runtime api key — which is
 * only installed once the account extension's session hooks have run. In the
 * window before that, a stale `/login anthropic` credential is what pi tries,
 * and a dead one fails the request with
 * `invalid_grant: Refresh token not found or invalid` even though every pooled
 * account is healthy. Dropping `auth.oauth` from the pool provider stops that
 * from being a crash, but a stored credential pi cannot use still makes
 * resolution return "not configured" in the same window.
 *
 * So: say it once, name the file, and give the exact command. Deliberately
 * does not delete anything — credentials are the user's.
 */
let warnedAboutStoredNativeCredential = false;

export async function warnAboutStoredNativeOAuth(store: AccountStore, ctx: ExtensionContext): Promise<void> {
	if (warnedAboutStoredNativeCredential) return;
	try {
		const state = await store.readProviderAsync("anthropic");
		if (Object.keys(state.accounts).length === 0) return; // nothing of ours to shadow it with
		const authPath = join(process.env.HOME ?? "", ".pi", "agent", "auth.json");
		const parsed = JSON.parse(await readFile(authPath, "utf8")) as Record<string, { type?: string; expires?: number }>;
		const native = parsed.anthropic;
		if (native?.type !== "oauth") return;
		warnedAboutStoredNativeCredential = true;
		const expiredForHours = typeof native.expires === "number"
			? Math.round((Date.now() - native.expires) / 3_600_000)
			: undefined;
		const age = expiredForHours !== undefined && expiredForHours > 0 ? ` (expired ${expiredForHours}h ago)` : "";
		logError("native_credential.stored", { expiredForHours, accounts: Object.keys(state.accounts).length });
		ctx.ui.notify(
			`pi still stores its own Anthropic OAuth login${age}, and pi resolves it before this extension's accounts. ` +
				"If it is stale, requests fail with invalid_grant before any pooled account is tried. " +
				"Remove it with: pi logout anthropic",
			"warning",
		);
	} catch {
		// No auth.json, or unreadable: nothing to warn about.
	}
}

/**
 * Re-activate the first remaining account when the active one was deleted.
 *
 * pi-accounts clears `active` without picking a fallback, and with no active
 * account the runtime stops injecting an Anthropic credential, so pi hides the
 * whole provider from `/model`.
 */
export async function healActiveAccount(store: AccountStore): Promise<void> {
	await store.updateProviderAsync("anthropic", async (state) => {
		if (state.active || Object.keys(state.accounts).length === 0) return state;
		const first = Object.keys(state.accounts)[0];
		return { ...state, active: first };
	});
}

/**
 * Drop a persisted `anthropic-<account>` defaultProvider only when that account
 * no longer exists. Alias selections are meant to survive restarts; a dangling
 * alias is not, because nothing will ever register that provider id again.
 */
export async function pruneStaleAliasDefaultProvider(store: AccountStore): Promise<void> {
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
 * Report which account a session is pinned to, without changing anything.
 *
 * This deliberately does not write the stored `active` account. An alias
 * resolves its own bound account, so the write bought the choosing session
 * nothing -- while deciding, for every *other* session, which account the
 * canonical `anthropic` provider sends. One session opening on a pinned model
 * could move the whole machine, and an unrelated session mid-request could then
 * fail with a 401 from an account it never chose.
 */
export async function reportPinnedAliasAccount(store: AccountStore, ctx: ExtensionContext): Promise<void> {
	const accountName = aliasAccountName(ctx.model?.provider);
	if (!accountName) return;
	const state = await store.readProviderAsync("anthropic");
	if (!state.accounts[accountName]) {
		logError("alias.account_missing", { account: accountName });
		ctx.ui.notify(`Anthropic account "${accountName}" is unavailable. Re-add it with /accounts.`, "error");
	}
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
export async function restoreAliasSelection(
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
	if (!model) {
		logError("alias.restore_failed", {
			wanted: `${desired.provider}/${desired.modelId}`,
			reason: "model not registered",
		});
		return;
	}
	logInfo("alias.restored", {
		from: `${ctx.model.provider}/${ctx.model.id}`,
		to: `${model.provider}/${model.id}`,
		source: recorded?.kind ?? "settings default",
	});
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
