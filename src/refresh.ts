/**
 * Background OAuth refresh: one sweep per process, plus the shared helpers that
 * refresh a single stored credential.
 */
import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { AccountStore } from "@narumitw/pi-accounts/src/accounts.ts";
import type { AccountProviderAdapter } from "@narumitw/pi-accounts/src/oauth.ts";
import { credentialSummary, fingerprint, logDebug, logError, logInfo } from "./debug-log.ts";
import { conciseRefreshFailure, errorMessage, sanitizeRefreshError } from "./errors.ts";
import { storeObserver } from "./store-watch.ts";

/** Refresh a credential this long before it actually expires. */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;
const BACKGROUND_REFRESH_POLL_MS = 60 * 1000;

/**
 * Whether this installation may refresh tokens on its own schedule.
 *
 * Anthropic rotates refresh tokens: a refresh mints a new one and invalidates
 * the previous one. Two installations sharing a credential file — a host
 * install and a container handed a copy of it for testing, say — will therefore
 * rotate each other's tokens away, which the API reports as
 * `"OAuth access token has been revoked."` rather than as an expiry.
 *
 * `PI_MULTI_ACCOUNT_BACKGROUND_REFRESH=0` makes an installation a passive
 * reader: it still uses the stored accounts, and pi-accounts still refreshes on
 * demand at `before_agent_start` when a token is actually needed, but it never
 * runs the unprompted sweep. Set it on the secondary installation so the
 * primary one stays the sole owner of rotation.
 *
 * Checked at call time rather than at construction so the guard covers every
 * caller of the loop, including the account menu and the import commands.
 */
function backgroundRefreshEnabled(): boolean {
	return process.env["PI_MULTI_ACCOUNT_BACKGROUND_REFRESH"] !== "0";
}

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
 * which is the whole point of the sweep.
 */
let inFlightRunCount = 0;

/** Bracket a run so the sweep leaves the credential it is using alone. */
export function markRunStarted(): void {
	inFlightRunCount += 1;
}

export function markRunFinished(): void {
	inFlightRunCount = Math.max(0, inFlightRunCount - 1);
}

/**
 * Accounts whose stored token the provider has rejected.
 *
 * A revoked token is not an expired one: Anthropic invalidates the whole token
 * family when a second installation refreshes with a rotated-away refresh
 * token, and the credential this process holds dies *before* the `expires`
 * timestamp it was stored with. The expiry-driven sweep therefore never sees a
 * reason to act, and every request keeps failing with a 401 until something
 * else happens to rotate the account.
 *
 * A 401 marks the account here instead, which makes the next sweep refresh it
 * regardless of the stored expiry. When the refresh token is still good the
 * account heals itself before the next turn; when it is not, the refresh
 * failure is recorded and surfaced as "needs re-login" rather than as an
 * unexplained 401.
 */
const suspectCredentials = new Set<string>();

function suspectKey(providerId: string, accountName: string): string {
	return `${providerId}:${accountName}`;
}

/** Mark an account's stored credential as rejected by the provider. */
export function markCredentialSuspect(providerId: string, accountName: string, reason: string): void {
	if (suspectCredentials.has(suspectKey(providerId, accountName))) return;
	suspectCredentials.add(suspectKey(providerId, accountName));
	logInfo("credential.suspect", { provider: providerId, account: accountName, reason });
}

/** Whether an account is currently marked as rejected. Tests and status use this. */
export function isCredentialSuspect(providerId: string, accountName: string): boolean {
	return suspectCredentials.has(suspectKey(providerId, accountName));
}

/** Clear all suspicion. Tests only. */
export function resetSuspectCredentialsForTesting(): void {
	suspectCredentials.clear();
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

export interface BackgroundRefreshLoop {
	start(): void;
	stop(): void;
	refreshNow(): Promise<void>;
}

export function acquireBackgroundRefreshLoop(
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
		if (!backgroundRefreshEnabled()) {
			logDebug("sweep.disabled", { reason: "PI_MULTI_ACCOUNT_BACKGROUND_REFRESH=0" });
			return;
		}
		if (running) return running;
		running = (async () => {
			try {
				logDebug("sweep.tick", { inFlightRuns: inFlightRunCount });
				// Read the counter at sweep time, not at loop construction: a run may
				// start or finish between ticks.
				await refreshExpiringAccounts(store, providers, { protectActiveAccount: inFlightRunCount > 0 });
			} catch (error) {
				// Background refresh is best-effort; request-time auth still reports actionable errors.
				logError("sweep.failed", { detail: errorMessage(error) });
			} finally {
				running = undefined;
			}
		})();
		return running;
	};

	return {
		start() {
			if (!backgroundRefreshEnabled()) return;
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

async function refreshExpiringAccounts(
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
		storeObserver(provider.id).observe(state, "refresh.sweep");
		for (const [accountName, credential] of Object.entries(state.accounts)) {
			const suspect = suspectCredentials.has(suspectKey(provider.id, accountName));
			if (credential.expires > now + REFRESH_SKEW_MS && !suspect) continue;
			// Refreshing rotates the token and invalidates the current one. The
			// active account is the one an in-flight run already resolved, so
			// rotating it now would fail that run mid-flight with a revoked-token
			// error. pi-accounts refreshes it at the next `before_agent_start`
			// anyway, which is a safe moment because no request is outstanding.
			if (options.protectActiveAccount && state.active === accountName) {
				logDebug("refresh.skipped", {
					provider: provider.id,
					account: accountName,
					reason: "active account has a run in flight",
					suspect,
					credential: credentialSummary(credential),
				});
				continue;
			}
			// A credential whose refresh keeps failing is retried on a backoff
			// instead of every tick: an `invalid_grant` account cannot be fixed by
			// trying again, only by a re-login.
			const blockedUntil = refreshBlockedUntil(provider.id, accountName, credential, now);
			if (blockedUntil !== undefined) {
				logDebug("refresh.backoff", {
					provider: provider.id,
					account: accountName,
					detail: refreshFailureDetail(provider.id, accountName),
					retryAt: new Date(blockedUntil).toISOString(),
				});
				continue;
			}
			// Cleared before the attempt: a refresh that fails records its own
			// failure, and re-marking on every tick would hide a genuine recovery.
			suspectCredentials.delete(suspectKey(provider.id, accountName));
			logInfo("refresh.due", {
				provider: provider.id,
				account: accountName,
				reason: suspect ? "provider rejected the stored token" : "expiring",
				credential: credentialSummary(credential),
			});
			try {
				await refreshAccountCredential(store, provider, accountName, credential, now, { force: suspect });
				clearRefreshFailure(provider.id, accountName);
			} catch (error) {
				// `refreshAccountCredential` already recorded this failure inside the
				// store lock; recording it again here is what logged every failure twice.
				logDebug("refresh.sweep_attempt_failed", { provider: provider.id, account: accountName });
			}
		}
	}
}

/**
 * Accounts whose last refresh failed, with a one-line reason and when to retry.
 *
 * Module scope so every session shows the same state, and so a recurring
 * background failure is reported once in the footer instead of being written to
 * each transcript.
 */
interface RefreshFailure {
	detail: string;
	attempts: number;
	firstFailedAt: number;
	nextAttemptAt: number;
	/** No amount of retrying fixes this one; only a re-login does. */
	permanent: boolean;
	/** The credential that failed, so a re-login can be detected and retried at once. */
	credential: string | undefined;
}

const refreshFailures = new Map<string, RefreshFailure>();

/** First retry delay for a failure that may be transient (network, 5xx, rate limit). */
const RETRY_BASE_MS = 60 * 1000;
const RETRY_MAX_MS = 15 * 60 * 1000;
/**
 * Retry interval for a credential that needs a re-login.
 *
 * Not "never": the user may re-login in another session or another
 * installation, and a stored credential that changed is retried immediately
 * anyway (see `refreshBlockedUntil`). This is only the floor for the hopeless
 * case, so a dead account costs one request every few hours instead of one per
 * minute — which is what turned a single dead account into a log full of
 * identical `invalid_grant` lines.
 */
const RELOGIN_RETRY_MS = 6 * 60 * 60 * 1000;

function refreshFailureKey(providerId: string, accountName: string): string {
	return `${providerId}:${accountName}`;
}

/** An `invalid_grant` refresh token is gone for good; retrying cannot bring it back. */
function isPermanentFailure(detail: string): boolean {
	return /invalid_grant|invalid_request|unauthorized_client/i.test(detail);
}

function recordRefreshFailure(
	providerId: string,
	accountName: string,
	error: unknown,
	credential?: { access?: string },
	now = Date.now(),
): void {
	const key = refreshFailureKey(providerId, accountName);
	const detail = conciseRefreshFailure(error);
	const previous = refreshFailures.get(key);
	const repeated = previous !== undefined && previous.detail === detail;
	const attempts = repeated ? previous.attempts + 1 : 1;
	const permanent = isPermanentFailure(detail);
	const backoff = permanent
		? RELOGIN_RETRY_MS
		: Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
	const failure: RefreshFailure = {
		detail,
		attempts,
		firstFailedAt: repeated ? previous.firstFailedAt : now,
		nextAttemptAt: now + backoff,
		permanent,
		credential: fingerprint(credential?.access),
	};
	refreshFailures.set(key, failure);

	const fields = {
		provider: providerId,
		account: accountName,
		detail,
		attempts,
		permanent,
		nextAttempt: new Date(failure.nextAttemptAt).toISOString(),
		...(permanent ? { action: "re-login this account in /accounts" } : {}),
	};
	// The same failure, over and over, is one fact — not one fact per minute.
	if (repeated) logDebug("refresh.failed_again", fields);
	else logError("refresh.failed", fields);
}

function clearRefreshFailure(providerId: string, accountName: string): void {
	if (!refreshFailures.delete(refreshFailureKey(providerId, accountName))) return;
	logInfo("refresh.recovered", { provider: providerId, account: accountName });
}

/**
 * How long an account is being left alone after a failed refresh, if at all.
 *
 * A credential that differs from the one that failed is always retried at once:
 * that is what a re-login, or a refresh by another installation, looks like from
 * here.
 */
function refreshBlockedUntil(
	providerId: string,
	accountName: string,
	credential: { access?: string },
	now: number,
): number | undefined {
	const failure = refreshFailures.get(refreshFailureKey(providerId, accountName));
	if (!failure) return undefined;
	if (failure.credential !== fingerprint(credential.access)) return undefined;
	return failure.nextAttemptAt > now ? failure.nextAttemptAt : undefined;
}

/** Why an account needs attention, for the footer and `/account-log`. */
export function refreshFailureDetail(providerId: string, accountName: string): string | undefined {
	return refreshFailures.get(refreshFailureKey(providerId, accountName))?.detail;
}

/** Clear all recorded failures. Tests only. */
export function resetRefreshFailuresForTesting(): void {
	refreshFailures.clear();
}

/** Names of the given provider's accounts that need a re-login. */
export function accountsNeedingRelogin(providerId: string, accountNames: Iterable<string>): string[] {
	return [...accountNames].filter((accountName) => refreshFailures.has(refreshFailureKey(providerId, accountName)));
}

/**
 * Refresh one stored account credential inside the account-store lock.
 *
 * The lock makes the read-modify-write atomic across sessions and processes,
 * which matters because Anthropic rotates tokens: two concurrent refreshes of
 * the same account would leave one session holding an invalidated token. A
 * credential another writer already refreshed is returned as-is.
 *
 * `force` refreshes a credential that has not expired yet. It exists for tokens
 * the provider has already rejected: a revoked token dies before its stored
 * expiry, so waiting for that expiry would keep every request failing.
 */
/**
 * One refresh per account at a time, per process.
 *
 * pi-web hosts many sessions - and every subagent - in one daemon, so a
 * rotation could send a dozen turns at the same credential at once. Each one
 * took the account store's file lock, and the eleventh waiter exhausted
 * proper-lockfile's retries: the turn died with "Lock file is already being
 * held" and the reader saw an auth failure for a credential that was perfectly
 * fine. Callers now share the in-flight refresh, so the lock sees one writer
 * instead of a crowd.
 */
const inFlightRefreshes = new Map<string, Promise<OAuthCredential>>();

export async function refreshAccountCredential(
	store: AccountStore,
	provider: AccountProviderAdapter,
	accountName: string,
	credential: OAuthCredential,
	now = Date.now(),
	options: { force?: boolean } = {},
): Promise<OAuthCredential> {
	const key = `${provider.id}\u0000${accountName}\u0000${options.force === true ? "force" : "due"}`;
	const running = inFlightRefreshes.get(key);
	if (running !== undefined) return running;
	const attempt = refreshAccountCredentialOnce(store, provider, accountName, credential, now, options)
		.finally(() => { inFlightRefreshes.delete(key); });
	inFlightRefreshes.set(key, attempt);
	return attempt;
}

/**
 * A held lock is not a bad credential.
 *
 * When the store cannot be written because someone else is writing it, the
 * honest answer is the credential the store holds now - another writer was
 * refreshing the same account - not a failed turn. Only a store that still
 * offers an unusable credential is a real failure.
 */
function isLockContention(error: unknown): boolean {
	const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
	if (code === "ELOCKED") return true;
	const message = error instanceof Error ? error.message : "";
	return message.includes("Lock file is already being held");
}

async function refreshAccountCredentialOnce(
	store: AccountStore,
	provider: AccountProviderAdapter,
	accountName: string,
	credential: OAuthCredential,
	now: number,
	options: { force?: boolean },
): Promise<OAuthCredential> {
	// The provider round trip happens OUTSIDE the store lock.
	//
	// It used to run inside `updateProviderAsync`, so one refresh held the
	// account file for the whole HTTP exchange - seconds, sometimes tens of
	// them. Every other process waiting on that file exhausted
	// proper-lockfile's retries and reported "Lock file is already being held"
	// as an auth failure: the owner lost turns to a credential that was fine
	// and a lock that was merely slow. The lock is now held only for the write.
	const current = (await store.readProviderAsync(provider.id)).accounts[accountName];
	if (!current || current.type !== "oauth") {
		throw new Error(`Account "${accountName}" was removed while refreshing.`);
	}
	if (current.access !== credential.access) {
		logInfo("refresh.superseded", {
			provider: provider.id,
			account: accountName,
			held: credentialSummary(credential),
			stored: credentialSummary(current),
		});
		// Someone else already replaced what we were holding; their credential
		// is fresh by definition, even for a forced refresh of a rejected one.
		if (current.expires > now + REFRESH_SKEW_MS) return current;
	}
	if (current.expires > now + REFRESH_SKEW_MS && options.force !== true) return current;

	let refreshed: OAuthCredential;
	try {
		refreshed = await provider.oauth.refresh(current, new AbortController().signal);
		clearRefreshFailure(provider.id, accountName);
		storeObserver(provider.id).expectSelfChange(`refresh ${accountName}`);
		logInfo("refresh.succeeded", {
			provider: provider.id,
			account: accountName,
			before: credentialSummary(current),
			after: credentialSummary(refreshed),
		});
	} catch (error) {
		recordRefreshFailure(provider.id, accountName, error, current, now);
		throw sanitizeRefreshError(provider.id, accountName, error);
	}

	try {
		await store.updateProviderAsync(provider.id, async (state) => {
			const latest = state.accounts[accountName];
			// A writer that landed while the round trip was in flight wins: its
			// credential is at least as new as this one, and overwriting it would
			// invalidate a token another process is already using.
			if (latest && latest.type === "oauth" && latest.access !== current.access) {
				refreshed = latest;
				return state;
			}
			return {
				...state,
				accounts: Object.assign(Object.create(null), state.accounts, { [accountName]: refreshed }),
			};
		});
	} catch (error) {
		if (!isLockContention(error)) throw error;
		// The token is valid whether or not it reached the file; a store that
		// cannot be written is not a failed refresh.
		logInfo("refresh.lock_contended", { provider: provider.id, account: accountName, wrote: false });
	}
	return refreshed;
}
