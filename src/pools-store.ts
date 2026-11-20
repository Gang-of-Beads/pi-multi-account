/** Legacy Anthropic pools. Their schema and commands stay compatible with v0.x. */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { FileAccountStorageBackend } from "@narumitw/pi-accounts/src/storage.ts";
import { logError, logInfo } from "./debug-log.ts";
import { ALIAS_PREFIX } from "./aliases.ts";
export const NATIVE_POOL_NAME = "anthropic";
export type PoolAccounts = "all" | string[];
export interface PoolDefinition {
	name: string;
	accounts: PoolAccounts;
}
interface PoolsFile {
	version: 1;
	pools: PoolDefinition[];
}
export const poolsFilePath = (): string => process.env.PI_MULTI_ACCOUNT_POOLS_FILE || join(getAgentDir(), "pi-multi-account-pools.json");
export type PoolNameCheck = { ok: true; name: string } | { ok: false; error: string };
export function checkPoolName(raw: string): PoolNameCheck {
	const name = raw.trim();
	if (!/^[A-Za-z0-9._-]{1,64}$/.test(name))
		return { ok: false, error: 'Pool names may use letters, digits, ".", "_", "-" (max 64 chars).' };
	if (name.startsWith(ALIAS_PREFIX))
		return { ok: false, error: `Names starting with "${ALIAS_PREFIX}" are reserved for per-account aliases.` };
	return { ok: true, name };
}
function valid(pool: unknown): pool is PoolDefinition {
	const p = pool as PoolDefinition | undefined;
	return (
		typeof p?.name === "string" &&
		checkPoolName(p.name).ok &&
		(p.accounts === "all" ||
			(Array.isArray(p.accounts) && p.accounts.every((n) => typeof n === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(n))))
	);
}
function parse(raw: string | undefined, strict = true): PoolDefinition[] {
	if (raw === undefined) return [];
	let file: PoolsFile;
	try {
		file = JSON.parse(raw);
	} catch {
		throw new Error("Invalid pools JSON; refusing to overwrite it");
	}
	if (
		file?.version !== 1 ||
		!Array.isArray(file.pools) ||
		(strict && (!file.pools.every(valid) || new Set(file.pools.map((p) => p.name)).size !== file.pools.length))
	)
		throw new Error("Invalid pools configuration; refusing to overwrite it");
	return file.pools.filter(valid);
}
/** Display/startup can retain no pools on corruption; mutation must not treat that as an empty store. */
export function readPools(): PoolDefinition[] {
	try {
		return parse(readFileSync(poolsFilePath(), "utf8"), false);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			logError("pool.read_failed", {
				path: poolsFilePath(),
				detail: "Invalid or unreadable pools file; changes are disabled until repaired",
			});
		return [];
	}
}
function mutate<R>(change: (pools: PoolDefinition[]) => { result: R; changed: boolean }): R {
	return new FileAccountStorageBackend(poolsFilePath()).withLock((raw) => {
		const pools = parse(raw);
		const { result, changed } = change(pools);
		return { result, ...(changed ? { next: `${JSON.stringify({ version: 1, pools }, null, 2)}\n` } : {}) };
	});
}
export function upsertPool(definition: PoolDefinition): void {
	if (!valid(definition)) throw new Error("Invalid pool definition");
	mutate((pools) => {
		const index = pools.findIndex((p) => p.name === definition.name);
		if (index < 0) pools.push(definition);
		else pools[index] = definition;
		return { result: undefined, changed: true };
	});
	logInfo("pool.saved", { name: definition.name, accounts: definition.accounts });
}
export function addAccountToPool(name: string, account: string): "added" | "present" | "all" | "unknown" {
	if (!/^[A-Za-z0-9._-]{1,64}$/.test(account)) throw new Error("Invalid account name");
	return mutate((pools) => {
		const pool = pools.find((p) => p.name === name);
		if (!pool) return { result: "unknown", changed: false };
		if (pool.accounts === "all") return { result: "all", changed: false };
		if (pool.accounts.includes(account)) return { result: "present", changed: false };
		pool.accounts.push(account);
		return { result: "added", changed: true };
	});
}
export function deletePool(name: string): boolean {
	return mutate((pools) => {
		const index = pools.findIndex((p) => p.name === name);
		if (index < 0) return { result: false, changed: false };
		pools.splice(index, 1);
		return { result: true, changed: true };
	});
}
export function expandPoolAccounts(definition: PoolDefinition, storedAccounts: string[], storedActive: string | undefined): string[] {
	const available = new Set(storedAccounts);
	if (definition.accounts !== "all") return definition.accounts.filter((name) => available.has(name));
	return storedActive !== undefined && available.has(storedActive)
		? [storedActive, ...storedAccounts.filter((name) => name !== storedActive)]
		: [...storedAccounts];
}
export function resetPoolsFileForTesting(): void {
	rmSync(poolsFilePath(), { force: true });
}
