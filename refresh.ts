/**
 * Background OAuth refresh: one sweep per process, plus the shared helpers that
 * refresh a single stored credential.
 */
import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { AccountStore } from "@narumitw/pi-accounts/src/accounts.ts";
import type { AccountProviderAdapter } from "@narumitw/pi-accounts/src/oauth.ts";
import { conciseRefreshFailure, sanitizeRefreshError } from "./errors.ts";

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
		if (!backgroundRefreshEnabled()) return;
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
		for (const [accountName, credential] of Object.entries(state.accounts)) {
			if (credential.expires > now + REFRESH_SKEW_MS) continue;
			// Refreshing rotates the token and invalidates the current one. The
			// active account is the one an in-flight run already resolved, so
			// rotating it now would fail that run mid-flight with a revoked-token
			// error. pi-accounts refreshes it at the next `before_agent_start`
			// anyway, which is a safe moment because no request is outstanding.
			if (options.protectActiveAccount && state.active === accountName) continue;
			try {
				await refreshAccountCredential(store, provider, accountName, credential, now);
				clearRefreshFailure(provider.id, accountName);
			} catch (error) {
				recordRefreshFailure(provider.id, accountName, error);
			}
		}
	}
}

/**
 * Accounts whose last refresh failed, with a one-line reason.
 *
 * Module scope so every session shows the same state, and so a recurring
 * background failure is reported once in the footer instead of being written to
 * each transcript.
 */
const refreshFailures = new Map<string, string>();

function refreshFailureKey(providerId: string, accountName: string): string {
	return `${providerId}:${accountName}`;
}

function recordRefreshFailure(providerId: string, accountName: string, error: unknown): void {
	refreshFailures.set(refreshFailureKey(providerId, accountName), conciseRefreshFailure(error));
}

function clearRefreshFailure(providerId: string, accountName: string): void {
	refreshFailures.delete(refreshFailureKey(providerId, accountName));
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
 */
export async function refreshAccountCredential(
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
