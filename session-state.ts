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
import { accountsNeedingRelogin } from "./refresh.ts";
import { storeObserver } from "./store-watch.ts";

const BILLING_STATUS_KEY = "pi-multi-account";

export async function updateBillingStatus(store: AccountStore, ctx: ExtensionContext): Promise<void> {
	try {
		const state = await store.readProviderAsync("anthropic");
		const failedAccounts = accountsNeedingRelogin("anthropic", Object.keys(state.accounts));
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
 * Point the stored active account at the alias this session selected, so
 * `/accounts`, the canonical `anthropic` provider, and any other extension
 * reading the store agree with the last explicit choice. The alias itself does
 * not depend on this: it always resolves its own bound account.
 */
export async function syncActiveAccountToSelectedAlias(store: AccountStore, ctx: ExtensionContext): Promise<void> {
	const accountName = aliasAccountName(ctx.model?.provider);
	if (!accountName) return;
	const state = await store.readProviderAsync("anthropic");
	if (!state.accounts[accountName]) {
		logError("alias.account_missing", { account: accountName });
		ctx.ui.notify(`Anthropic account "${accountName}" is unavailable. Re-add it with /accounts.`, "error");
		return;
	}
	if (state.active === accountName) return;
	storeObserver("anthropic").expectSelfChange(`select alias ${accountName}`);
	logInfo("active.switched", { from: state.active, to: accountName, cause: "alias selected in this session" });
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
