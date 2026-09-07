/**
 * User-defined aggregate pools: named groups of Anthropic accounts that share
 * one provider id and fail over together.
 *
 * A pool is whatever the user makes of it: created through `/pool-create`,
 * named by them (the provider id that shows up in `/model` is that name), and
 * backed by either "every current account" or an explicit, ordered list. A
 * pool literally named `anthropic` overrides the native provider — that is the
 * one reserved name, and choosing it is an explicit act, not a default.
 *
 * Definitions live in their own small JSON file rather than inside
 * `pi-accounts.json`: the account store belongs to pi-accounts' schema, while
 * pools are this extension's concept, edited rarely and read on session start.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logError, logInfo } from "./debug-log.ts";

/** The one name that overrides pi's native Anthropic provider. */
export const NATIVE_POOL_NAME = "anthropic";

/** Prefix reserved for per-account aliases (`anthropic-<name>` in aliases.ts). */
const ALIAS_PREFIX = "anthropic-";

export type PoolAccounts = "all" | string[];

export interface PoolDefinition {
	/** The provider id this pool registers; user-chosen. */
	name: string;
	/** Every current account (dynamically), or an explicit ordered list. */
	accounts: PoolAccounts;
}

interface PoolsFile {
	version: 1;
	pools: PoolDefinition[];
}

/** Absolute path of the pool definitions file. */
export function poolsFilePath(): string {
	return (
		process.env.PI_MULTI_ACCOUNT_POOLS_FILE ||
		join(process.env.HOME ?? ".", ".pi", "agent", "pi-multi-account-pools.json")
	);
}

export type PoolNameCheck = { ok: true; name: string } | { ok: false; error: string };

/** Validate a pool name the way account aliases are validated, minus the alias prefix. */
export function checkPoolName(raw: string): PoolNameCheck {
	const name = raw.trim();
	if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
		return { ok: false, error: 'Pool names may use letters, digits, ".", "_", "-" (max 64 chars).' };
	}
	if (name.startsWith(ALIAS_PREFIX)) {
		return {
			ok: false,
			error: `Names starting with "${ALIAS_PREFIX}" are reserved for per-account aliases.`,
		};
	}
	return { ok: true, name };
}

export function readPools(): PoolDefinition[] {
	try {
		const parsed = JSON.parse(readFileSync(poolsFilePath(), "utf8")) as Partial<PoolsFile>;
		if (!Array.isArray(parsed.pools)) return [];
		return parsed.pools.filter(
			(entry): entry is PoolDefinition =>
				typeof entry?.name === "string" &&
				(entry.accounts === "all" || (Array.isArray(entry.accounts) && entry.accounts.every((a) => typeof a === "string"))),
		);
	} catch {
		return [];
	}
}

/** Insert or replace one pool definition (position preserved), creating the file when needed. */
export function upsertPool(definition: PoolDefinition): void {
	const pools = readPools();
	const index = pools.findIndex((pool) => pool.name === definition.name);
	if (index >= 0) pools[index] = definition;
	else pools.push(definition);
	writePools({ version: 1, pools });
	logInfo("pool.saved", { name: definition.name, accounts: definition.accounts });
}

export function deletePool(name: string): boolean {
	const pools = readPools();
	const next = pools.filter((pool) => pool.name !== name);
	if (next.length === pools.length) return false;
	writePools({ version: 1, pools: next });
	logInfo("pool.deleted", { name });
	return true;
}

function writePools(file: PoolsFile): void {
	const path = poolsFilePath();
	const temp = `${path}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
		renameSync(temp, path);
	} catch (error) {
		// A definition that cannot be persisted still works for this process;
		// the failure is logged rather than thrown into the command flow.
		logError("pool.persist_failed", { detail: error instanceof Error ? error.message : String(error) });
		try {
			writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
		} catch {
			logError("pool.persist_failed", { detail: "direct write also failed" });
		}
	}
}

/** Expand a pool definition against the store: the accounts it may try, in order. */
export function expandPoolAccounts(
	definition: PoolDefinition,
	storedAccounts: string[],
	storedActive: string | undefined,
): string[] {
	const available = new Set(storedAccounts);
	if (definition.accounts === "all") {
		const ordered = storedActive !== undefined && available.has(storedActive)
			? [storedActive, ...storedAccounts.filter((name) => name !== storedActive)]
			: [...storedAccounts];
		return ordered;
	}
	// An explicit list may name accounts that no longer exist; those are dropped
	// here, and the request-time resolver skips anything that vanished since.
	return definition.accounts.filter((name) => available.has(name));
}

/** Reset on-disk definitions. Tests only. */
export function resetPoolsFileForTesting(): void {
	try {
		rmSync(poolsFilePath(), { force: true });
	} catch {
		// Nothing to clean.
	}
}
