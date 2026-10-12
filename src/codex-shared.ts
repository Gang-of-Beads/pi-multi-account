/**
 * The `openai-codex` slice of the shared account store, plus the credential plumbing
 * the codex alias providers need.
 *
 * Folded in from the standalone `codex-accounts` extension (2026-10-13): pi-multi-account
 * already owns the store, the `/accounts` menu and the background refresh for this
 * provider, so the alias providers that expose those accounts to `/model` belong here
 * too instead of in a second, unversioned extension.
 *
 * This module only READS the store: the background sweep owns token rotation behind its
 * file lock, and a second writer would rotate the shared refresh token out from under it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const NATIVE_PROVIDER = "openai-codex";
/** Provider id that follows the store's active account (mirrors native `anthropic`). */
export const ACTIVE_ALIAS_ID = "codex";
export const ALIAS_PREFIX = "codex-";
export const BASE_URL = "https://chatgpt.com/backend-api";
export const TOKEN_URL = "https://auth.openai.com/oauth/token";
/** Codex CLI's public OAuth client id (same one pi-ai's native flow uses). */
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface CodexCredential {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
}

export interface CodexState {
	active?: string;
	accounts: Record<string, CodexCredential>;
}

/** The same file pi-accounts maintains, resolved the way the rest of pi resolves it. */
export function accountsFile(): string {
	return join(getAgentDir(), "pi-accounts.json");
}

export function readCodexState(file: string = accountsFile()): CodexState {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as {
			providers?: Record<string, { active?: string; accounts?: Record<string, CodexCredential> }>;
		};
		const state = raw?.providers?.[NATIVE_PROVIDER] ?? {};
		return { active: state.active, accounts: state.accounts ?? {} };
	} catch {
		return { accounts: {} };
	}
}

/** Alias provider ids (`codex-<name>`) for every stored OAuth account with a token. */
export function codexAliasIds(state: CodexState): string[] {
	return Object.keys(state.accounts)
		.filter((name) => name && state.accounts[name]?.type === "oauth" && state.accounts[name]?.access)
		.map((name) => `${ALIAS_PREFIX}${name}`)
		.sort();
}

/**
 * Which stored account a provider id pins to; `codex` follows the active account,
 * `codex-<name>` pins that name. Undefined when the id maps to nothing usable
 * (missing account, non-OAuth credential, no access token).
 */
export function accountFor(
	state: CodexState,
	providerId: string,
): { name: string; credential: CodexCredential } | undefined {
	const name =
		providerId === ACTIVE_ALIAS_ID
			? state.active
			: providerId.startsWith(ALIAS_PREFIX)
				? providerId.slice(ALIAS_PREFIX.length)
				: undefined;
	const credential = name ? state.accounts[name] : undefined;
	if (!name || credential?.type !== "oauth" || !credential.access) return undefined;
	return { name, credential };
}

/**
 * Last-resort in-memory refresh (sweep disabled, or a token that expired between sweeps).
 * Never writes the shared store — see the module docstring.
 */
export async function freshCredential(credential: CodexCredential): Promise<CodexCredential> {
	return (credential.expires ?? 0) <= Date.now() + REFRESH_SKEW_MS && credential.refresh
		? refreshInMemory(credential)
		: credential;
}

export async function refreshInMemory(credential: CodexCredential): Promise<CodexCredential> {
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: credential.refresh ?? "",
			client_id: CLIENT_ID,
		}),
	});
	if (!res.ok) throw new Error(`codex token refresh failed (${res.status})`);
	const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
	if (!json.access_token) throw new Error("codex token refresh response missing access_token");
	return {
		...credential,
		access: json.access_token,
		...(json.refresh_token ? { refresh: json.refresh_token } : {}),
		expires: Date.now() + (json.expires_in ?? 3600) * 1000,
	};
}
