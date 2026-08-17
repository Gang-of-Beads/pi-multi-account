/**
 * Subscription-account import: `/sub-accounts`, `/sub-import`, and the
 * interactive first-run flow that lets the user name each account.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { AccountStore, parseAccountName } from "@narumitw/pi-accounts/src/accounts.ts";
import { type AliasRegistry } from "./aliases.ts";
import { errorMessage } from "./errors.ts";
import { isDefaultPiLoginName } from "./names.ts";
import type { BackgroundRefreshLoop } from "./refresh.ts";
import { updateBillingStatus } from "./session-state.ts";
import { detectSubscriptionAccounts, type SubscriptionAccount } from "./subscription-credentials.ts";

/** Claude Code metadata stored alongside the rotating OAuth token fields. */
export type StoredClaudeCredential = OAuthCredential & {
	client?: "claude-code";
	source?: "claude-code";
	label?: string;
	subscriptionType?: string;
};

export function registerClaudeImportCommands(
	pi: ExtensionAPI,
	store: AccountStore,
	aliases: AliasRegistry,
	refreshLoop: Pick<BackgroundRefreshLoop, "refreshNow">,
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

/** Import detected accounts, honouring requested names and generating the rest. */
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

/**
 * Ask the user to name each detected subscription account before importing it.
 * Falls back to generated names when there is no dialog-capable UI, or when the
 * user leaves an answer empty.
 */
export async function runInteractiveImport(
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
