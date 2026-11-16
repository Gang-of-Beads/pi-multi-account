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
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { logError, logInfo } from "./debug-log.ts";
import { errorMessage } from "./errors.ts";
import { ALIAS_PREFIX } from "./aliases.ts";

/** The one name that overrides pi's native Anthropic provider. */
export const NATIVE_POOL_NAME = "anthropic";


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
		join(getAgentDir(), "pi-multi-account-pools.json")
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

/**
 * The stored pools.
 *
 * A broken file answers "no pools" — but says so in the log, because the next write rebuilds
 * the file from that empty answer and would otherwise destroy every definition silently. Names
 * the writer would refuse are dropped here too: a hand-edited `anthropic-work` would shadow the
 * per-account alias it is reserved against, since the registered provider id is the pool name.
 */
export function readPools(): PoolDefinition[] {
	let raw: string;
	try {
		raw = readFileSync(poolsFilePath(), "utf8");
	} catch {
		return []; // no file yet is not worth a line
	}
	let parsed: Partial<PoolsFile>;
	try {
		parsed = JSON.parse(raw) as Partial<PoolsFile>;
	} catch (error) {
		logError("pool.read_failed", { path: poolsFilePath(), detail: errorMessage(error) });
		return [];
	}
	if (!Array.isArray(parsed.pools)) return [];
	return parsed.pools.filter(
		(entry): entry is PoolDefinition =>
			typeof entry?.name === "string" &&
			checkPoolName(entry.name).ok &&
			(entry.accounts === "all" || (Array.isArray(entry.accounts) && entry.accounts.every((a) => typeof a === "string"))),
	);
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

/**
 * Add one account to a pool, keeping the rest and its order.
 *
 * `"all"` already follows every account, so adding to it is a no-op the caller reports rather
 * than a rewrite that would freeze today's account list. Answers "added" after the write, or
 * why nothing changed: "present", "all", or "unknown" for a pool that is not there.
 */
export function addAccountToPool(name: string, account: string): "added" | "present" | "all" | "unknown" {
	const pools = readPools();
	const pool = pools.find((candidate) => candidate.name === name);
	if (pool === undefined) return "unknown";
	if (pool.accounts === "all") return "all";
	if (pool.accounts.includes(account)) return "present";
	upsertPool({ ...pool, accounts: [...pool.accounts, account] });
	return "added";
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
