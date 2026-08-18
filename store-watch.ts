/**
 * Detects changes made to the shared account store by *someone else*.
 *
 * `~/.pi/agent/pi-accounts.json` is global mutable state with several writers:
 * every pi session on the machine, every container that mounts the same home
 * directory, and host applications (pi web among them) that switch the active
 * account by rewriting the file directly. A session reads the store at request
 * time, so a foreign write silently changes which account that session bills to
 * — or hands it a token that a second installation has already rotated away,
 * which Anthropic reports as `OAuth access token has been revoked`, not as an
 * expiry.
 *
 * None of that was observable before. This module snapshots the store on every
 * read this extension performs, diffs it against the last state we knew about,
 * and reports the difference as `self` (we wrote it) or `foreign` (someone
 * else did). Foreign changes are the ones worth waking the user for.
 */
import { credentialSummary, fingerprint, logInfo } from "./debug-log.ts";

interface StoredCredentialLike {
	access?: string;
	refresh?: string;
	expires?: number;
}

interface ProviderStateLike {
	active?: string;
	accounts: Record<string, StoredCredentialLike | undefined>;
}

export interface StoreSnapshot {
	active?: string;
	/** account name → access-token fingerprint */
	access: Record<string, string | undefined>;
	/** account name → refresh-token fingerprint */
	refresh: Record<string, string | undefined>;
}

export type StoreChangeKind = "active_account" | "token_rotated" | "account_added" | "account_removed";

export interface StoreChange {
	kind: StoreChangeKind;
	account?: string;
	from?: string;
	to?: string;
}

export function snapshotProviderState(state: ProviderStateLike): StoreSnapshot {
	const access: Record<string, string | undefined> = {};
	const refresh: Record<string, string | undefined> = {};
	for (const [name, credential] of Object.entries(state.accounts)) {
		access[name] = fingerprint(credential?.access);
		refresh[name] = fingerprint(credential?.refresh);
	}
	return { ...(state.active === undefined ? {} : { active: state.active }), access, refresh };
}

/**
 * What changed between two snapshots.
 *
 * A rotated token is reported per account rather than as one opaque "store
 * changed" event, because which account rotated is the whole diagnosis: a token
 * that rotates without this process refreshing it means a second writer owns
 * the credential, and the token this process still holds is already dead.
 */
export function diffSnapshots(previous: StoreSnapshot, next: StoreSnapshot): StoreChange[] {
	const changes: StoreChange[] = [];
	if (previous.active !== next.active) {
		changes.push({
			kind: "active_account",
			...(previous.active === undefined ? {} : { from: previous.active }),
			...(next.active === undefined ? {} : { to: next.active }),
		});
	}
	for (const name of Object.keys(next.access)) {
		if (!(name in previous.access)) {
			changes.push({ kind: "account_added", account: name });
			continue;
		}
		const before = previous.access[name];
		const after = next.access[name];
		if (before !== after) {
			changes.push({
				kind: "token_rotated",
				account: name,
				...(before === undefined ? {} : { from: before }),
				...(after === undefined ? {} : { to: after }),
			});
		}
	}
	for (const name of Object.keys(previous.access)) {
		if (!(name in next.access)) changes.push({ kind: "account_removed", account: name });
	}
	return changes;
}

/** One-line description of a change, for notifications. */
export function describeChange(change: StoreChange): string {
	switch (change.kind) {
		case "active_account":
			return `active account changed ${change.from ?? "(none)"} → ${change.to ?? "(none)"}`;
		case "token_rotated":
			return `token for "${change.account}" was rotated by another process`;
		case "account_added":
			return `account "${change.account}" was added`;
		case "account_removed":
			return `account "${change.account}" was removed`;
	}
}

/**
 * Tracks the store state this process believes it last wrote or read.
 *
 * Module-level rather than per-session: one process hosts many sessions, and a
 * change is foreign only when *no* session in this process caused it.
 */
/**
 * Foreign changes seen since a session last reported them.
 *
 * The sweep that usually notices a foreign write has no UI context, so the
 * finding is parked here and drained by the next session event that does.
 */
const pendingForeignChanges: StoreChange[] = [];

/** Take the foreign changes nobody has reported to the user yet. */
export function drainForeignChanges(): StoreChange[] {
	return pendingForeignChanges.splice(0, pendingForeignChanges.length);
}

const observers = new Map<string, StoreObserver>();

/**
 * The observer for a provider, shared by every session in this process.
 *
 * A change is foreign only when no session in this process caused it, so the
 * bookkeeping cannot be per-session.
 */
export function storeObserver(providerId: string): StoreObserver {
	let observer = observers.get(providerId);
	if (!observer) {
		observer = new StoreObserver(providerId);
		observers.set(providerId, observer);
	}
	return observer;
}

export class StoreObserver {
	private previous: StoreSnapshot | undefined;
	/** Writes this process is about to make, so they are not reported as foreign. */
	private pendingSelfReasons: string[] = [];

	private readonly providerId: string;

	constructor(providerId: string) {
		// Written out rather than a parameter property: pi loads extensions with
		// type stripping, which does not support them.
		this.providerId = providerId;
	}

	/**
	 * Announce a write this process is performing. The next `observe` treats the
	 * matching difference as our own rather than as a foreign writer.
	 */
	expectSelfChange(reason: string): void {
		this.pendingSelfReasons.push(reason);
	}

	/**
	 * Diff the freshly read state against what we last saw and log the result.
	 *
	 * Returns only the foreign changes: the ones no session in this process
	 * asked for, which are the ones a user needs to know about.
	 */
	observe(state: ProviderStateLike, source: string): StoreChange[] {
		const next = snapshotProviderState(state);
		const previous = this.previous;
		this.previous = next;
		if (!previous) {
			logInfo("store.baseline", {
				provider: this.providerId,
				source,
				active: next.active,
				accounts: Object.keys(next.access),
				access: next.access,
			});
			return [];
		}

		const changes = diffSnapshots(previous, next);
		if (changes.length === 0) return [];

		const selfReasons = this.pendingSelfReasons;
		this.pendingSelfReasons = [];
		const origin = selfReasons.length > 0 ? "self" : "foreign";
		for (const change of changes) {
			logInfo("store.changed", {
				provider: this.providerId,
				source,
				origin,
				...(selfReasons.length > 0 ? { reasons: selfReasons } : {}),
				...change,
				...(change.account
					? { credential: credentialSummary(state.accounts[change.account]) }
					: {}),
			});
		}
		if (origin !== "foreign") return [];
		pendingForeignChanges.push(...changes);
		return changes;
	}
}
