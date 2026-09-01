/**
 * Aggregate account pools with automatic failover.
 *
 * A pool is user-defined (`/pool-create`): it binds a provider id the user
 * chose to a set of Anthropic accounts, and every request through it walks the
 * accounts in order — healthy ones first, cooled-down ones trailing — until
 * one answers. Per-account `anthropic-<name>` aliases are untouched: they
 * keep talking to exactly their own account.
 *
 * Pool definitions come from pools-store.ts. The one special case is a pool
 * literally named `anthropic`, which overrides the native provider (an
 * explicit user choice); any other name registers a fresh provider whose
 * catalogue and request surface mirror the native one.
 *
 * Why retrying inside the stream override is safe:
 *
 * - pi-ai's Anthropic `stream` performs the HTTP request inside its async body
 *   and only pushes `{type: "start"}` once the response headers are back. Every
 *   request-level failure (401/429/5xx…) surfaces as an `error` event with no
 *   other event having been emitted, so an attempt that failed before any
 *   content was forwarded can be retried with the next account's credential
 *   without any risk of duplicated output. An error after content started is
 *   forwarded as-is: retrying then could duplicate or diverge partial output.
 * - The registration replaces the native provider object wholesale (the string
 *   form of `registerProvider` cannot override `stream`); every field except
 *   the request entry points is inherited, so auth, /login, the catalogue and
 *   filterModels behave exactly as before.
 * - pi-accounts marks the Anthropic adapter `requiresApiKeyBridge: false` and
 *   drives credentials through the runtime api-key override, so it does not
 *   own a config overlay that our re-registration could disturb.
 *
 * The credential pi resolved for the turn arrives in `options.apiKey` and is
 * ignored: the pool picks and refreshes credentials itself, per attempt, under
 * the shared account-store lock. A dead active account therefore fails over
 * instead of failing the turn.
 *
 *   PI_MULTI_ACCOUNT_FAILOVER=0      disable pool registration entirely
 *   PI_MULTI_ACCOUNT_POOLS_FILE=...  move the pool definitions file
 */
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { AccountStore } from "@narumitw/pi-accounts/src/accounts.ts";
import {
	createAssistantMessageEventStream,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { anthropicAdapter } from "./adapters.ts";
import { applyUserAgentOverride, buildUserAgent } from "./billing.ts";
import { credentialSummary, logDebug, logError, logInfo } from "./debug-log.ts";
import { errorMessage } from "./errors.ts";
import { expandPoolAccounts, NATIVE_POOL_NAME, readPools, type PoolDefinition } from "./pools-store.ts";
import { isCredentialSuspect, markCredentialSuspect, REFRESH_SKEW_MS, refreshAccountCredential } from "./refresh.ts";
import { storeObserver } from "./store-watch.ts";

type ProviderModel = ProviderModelConfig & Record<string, unknown>;
type StreamKind = "stream" | "streamSimple";
type ProviderState = Awaited<ReturnType<AccountStore["readProviderAsync"]>>;

/** Statuses that are worth trying a different account for. */
const FAILOVER_STATUSES = new Set([401, 403, 408, 429, 500, 502, 503, 504, 529]);

export interface PoolNotice {
	message: string;
	level: "info" | "warning" | "error";
}

/**
 * Failover notices nobody has shown the user yet.
 *
 * The pool runs inside the agent loop where no UI context exists, so findings
 * are parked here and drained by the next `after_provider_response`.
 */
const pendingNotices: PoolNotice[] = [];

/** Take the failover notices no session has reported yet. */
export function drainPoolNotices(): PoolNotice[] {
	return pendingNotices.splice(0, pendingNotices.length);
}

/**
 * The account each pool last resolved a credential for, plus the most recent
 * across all pools.
 *
 * A response handler sees only the provider id, not which account served the
 * request — failover may have moved it off the first pick. Tracking it per
 * pool keeps two pools in one process from reporting each other's account.
 */
let lastResolvedAccount: string | undefined;
const lastAccountByPool = new Map<string, string>();

export function lastPoolAccount(poolName?: string): string | undefined {
	return poolName === undefined ? lastResolvedAccount : lastAccountByPool.get(poolName);
}

/**
 * Where each pool starts its next request.
 *
 * Rotation, not scheduling: a pool keeps using the account that last worked,
 * and an error moves it to the next one, one account at a time. There is no
 * cooldown clock, no backoff and no retry-after bookkeeping — a failing
 * account simply stops being the starting point.
 */
const poolCursor = new Map<string, string>();

/** Point a pool at the account that just served it. */
function setPoolCursor(poolName: string, accountName: string): void {
	if (poolCursor.get(poolName) === accountName) return;
	poolCursor.set(poolName, accountName);
	logDebug("pool.cursor", { pool: poolName, account: accountName });
}

/** Reset rotation state and notices. Tests only. */
export function resetPoolStateForTesting(): void {
	pendingNotices.length = 0;
	lastResolvedAccount = undefined;
	lastAccountByPool.clear();
	poolCursor.clear();
}

/** Whether a status should move the pool to the next account. */
export function isFailoverEligible(status: number | undefined): boolean {
	return status !== undefined && FAILOVER_STATUSES.has(status);
}

/**
 * Order the pool's accounts for one request.
 *
 * The definition fixes the order; the rotation cursor fixes the starting
 * point. Accounts before the cursor are still tried — after the ones behind
 * it — so a request only fails when every account failed.
 */
export function planAccountOrder(accounts: string[], startAt?: string): string[] {
	if (startAt === undefined) return [...accounts];
	const index = accounts.indexOf(startAt);
	if (index <= 0) return [...accounts];
	return [...accounts.slice(index), ...accounts.slice(0, index)];
}

/**
 * The account a pool would try first right now, without making a request.
 *
 * The footer needs something to show before the first request of a session:
 * until the pool resolves a credential there is no "current" account, and
 * showing nothing at all hides both the pool and the subscription-billing
 * status. The rotation cursor is honored, so this is the account that will
 * actually serve the next request.
 */
export function poolFirstPick(
	poolName: string,
	state: Pick<ProviderState, "active" | "accounts">,
): string | undefined {
	const definition = readPools().find((pool) => pool.name === poolName);
	if (!definition) return undefined;
	const accounts = expandPoolAccounts(definition, Object.keys(state.accounts), state.active);
	return planAccountOrder(accounts, poolCursor.get(poolName))[0];
}

/** The surface of the built-in provider the pool delegates to (narrowed for tests). */
export interface BaseStreamHost {
	stream: (model: never, context: never, options: never) => AssistantMessageEventStream;
	streamSimple: (model: never, context: never, options: never) => AssistantMessageEventStream;
}

export interface PoolRuntimeOptions {
	/** Test seam: the provider whose stream functions the pool wraps. Defaults to Pi's built-in Anthropic provider. */
	baseProvider?: BaseStreamHost;
	/** Test seam: the adapter used to refresh credentials. Defaults to the patched Anthropic adapter. */
	refreshAdapter?: Parameters<typeof refreshAccountCredential>[1];
}

export interface PoolRuntime {
	/** Register (or re-register) one user-defined pool as a provider. */
	registerPool(definition: PoolDefinition, models?: ProviderModel[]): void;
	/** Drop a pool's provider registration. */
	unregisterPool(name: string): void;
	/** Provider ids currently registered for pools. */
	registeredPoolNames(): string[];
}

/** Whether pool registration is enabled (PI_MULTI_ACCOUNT_FAILOVER=0 disables). */
export function poolsEnabled(): boolean {
	return process.env.PI_MULTI_ACCOUNT_FAILOVER !== "0";
}

/** Provider ids currently registered for pools in this process. */
const poolProviderNames = new Set<string>();

/** Whether this provider id was registered as a pool in this process. */
export function isPoolProvider(providerId: string | undefined): boolean {
	return providerId !== undefined && poolProviderNames.has(providerId);
}

/** Footer label for a pool provider: which pool, which account answered. */
export function poolLabel(providerId: string | undefined, account: string): string {
	return providerId !== undefined
		? `${providerId} pool: ${account}`
		: `pool: ${account}`;
}

function errorEvent(message: string, reason: "error" | "aborted" = "error"): AssistantMessageEvent {
	return {
		type: "error",
		reason,
		error: {
			role: "assistant",
			content: [],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: reason,
			errorMessage: message,
			timestamp: Date.now(),
		},
	} as unknown as AssistantMessageEvent;
}

export function createPoolRuntime(
	pi: ExtensionAPI,
	store: AccountStore,
	options: PoolRuntimeOptions = {},
): PoolRuntime {
	poolProviderNames.clear();
	if (!poolsEnabled()) {
		logInfo("pool.disabled", { reason: "PI_MULTI_ACCOUNT_FAILOVER=0" });
		return {
			registerPool: () => undefined,
			unregisterPool: () => undefined,
			registeredPoolNames: () => [],
		};
	}

	const native = builtinProviders().find((provider) => provider.id === "anthropic");
	if (!native) throw new Error("pi-multi-account: Pi's built-in Anthropic provider is unavailable.");
	const baseProvider = options.baseProvider ?? native;
	const refreshAdapter = options.refreshAdapter ?? anthropicAdapter();

	/**
	 * One request attempt against one account.
	 *
	 * The fetch wrapper is what makes the failure legible: the Anthropic SDK
	 * raises its own error for non-2xx responses, but the status and
	 * `retry-after` are read here, before the SDK wraps the response, so the
	 * failover loop never has to parse error message text.
	 */
	const attempt = (
		kind: StreamKind,
		model: ProviderModel,
		context: unknown,
		options_: Record<string, unknown> | undefined,
		accountName: string,
		credential: OAuthCredential,
	): { events: AssistantMessageEventStream; captured: () => number | undefined } => {
		let seen: number | undefined;
		const realFetch = typeof options_?.fetch === "function" ? (options_.fetch as typeof fetch) : undefined;
		const captureFetch: typeof fetch = async (input, init) => {
			// The SDK has fully merged its headers by now (including its built-in
			// bare `claude-cli/<version>` UA) — the last point where the wire UA
			// can be synced with the billing header's cc_version.
			const fixedInit = init
				? { ...init, headers: new Headers(init.headers ?? undefined) }
				: { headers: new Headers() };
			const requestHeaders = fixedInit.headers as Headers;
			const uaBefore = requestHeaders.get("user-agent") ?? undefined;
			applyUserAgentOverride(requestHeaders);
			const uaAfter = requestHeaders.get("user-agent") ?? undefined;
			if (uaAfter !== uaBefore) {
				logDebug("request.user_agent", { account: accountName, before: uaBefore, after: uaAfter });
			}
			const response = await (realFetch ?? globalThis.fetch)(input, fixedInit as RequestInit);
			seen = response.status;
			return response;
		};
		const streamOptions = {
			...(options_ ?? {}),
			apiKey: credential.access,
			fetch: captureFetch,
		};
		const events =
			kind === "stream"
				? baseProvider.stream(model as never, context as never, streamOptions as never)
				: baseProvider.streamSimple(model as never, context as never, streamOptions as never);
		return { events, captured: () => seen };
	};

	/**
	 * Resolve one account's access token, refreshing suspect/expiring
	 * credentials under the shared store lock. Returns undefined when the
	 * account cannot produce a credential right now (gone, or refresh failed) —
	 * the pool just moves on to the next account.
	 */
	const resolveAccount = async (
		accountName: string,
		signal: AbortSignal | undefined,
		poolName?: string,
	): Promise<OAuthCredential | undefined> => {
		try {
			const state = await store.readProviderAsync("anthropic");
			storeObserver("anthropic").observe(state, `pool.resolve:${accountName}`);
			let credential = state.accounts[accountName];
			if (!credential || credential.type !== "oauth") {
				logDebug("pool.account_unavailable", { account: accountName, reason: "no stored oauth credential" });
				return undefined;
			}
			const suspect = isCredentialSuspect("anthropic", accountName);
			if (suspect || credential.expires <= Date.now() + REFRESH_SKEW_MS) {
				credential = await refreshAccountCredential(
					store,
					refreshAdapter,
					accountName,
					credential,
					Date.now(),
					{ force: suspect },
				);
			}
			signal?.throwIfAborted();
			logDebug("pool.request_credential", {
				account: accountName,
				storedActive: state.active,
				credential: credentialSummary(credential),
			});
			lastResolvedAccount = accountName;
			if (poolName !== undefined) lastAccountByPool.set(poolName, accountName);
			return credential;
		} catch (error) {
			if (signal?.aborted) return undefined;
			logError("pool.resolve_failed", { account: accountName, detail: errorMessage(error) });
			return undefined;
		}
	};

	const runPool = (
		definition: PoolDefinition,
		kind: StreamKind,
		model: ProviderModel,
		context: unknown,
		options_: Record<string, unknown> | undefined,
	): AssistantMessageEventStream => {
		const outer = createAssistantMessageEventStream();
		void (async () => {
			const signal = options_?.signal as AbortSignal | undefined;
			let state: ProviderState;
			try {
				state = await store.readProviderAsync("anthropic");
			} catch (error) {
				// No store, no pool: surface a clear failure instead of a hang.
				outer.push(errorEvent(`pi-multi-account: account store unreadable: ${errorMessage(error)}`));
				outer.end();
				return;
			}
			const accounts = planAccountOrder(
				expandPoolAccounts(definition, Object.keys(state.accounts), state.active),
				poolCursor.get(definition.name),
			);
			if (accounts.length === 0) {
				outer.push(
					errorEvent(
						`pi-multi-account: pool "${definition.name}" has no usable accounts. ` +
							"Add accounts with /accounts, or edit the pool with /pool-add.",
					),
				);
				outer.end();
				return;
			}

			let lastFailure: AssistantMessageEvent | undefined;
			for (let index = 0; index < accounts.length; index += 1) {
				const accountName = accounts[index]!;
				if (signal?.aborted) break;
				const credential = await resolveAccount(accountName, signal, definition.name);
				if (!credential) continue;

				const { events, captured } = attempt(kind, model, context, options_, accountName, credential);
				let sawContent = false;
				let failure: AssistantMessageEvent | undefined;
				try {
					for await (const event of events) {
						if (event.type === "error") {
							failure = event;
							break;
						}
						sawContent = true;
						outer.push(event);
					}
				} catch (error) {
					// The inner stream itself threw (unexpected): treat as a failure
					// with no captured status, so it only fails over while untouched.
					failure = errorEvent(errorMessage(error), signal?.aborted ? "aborted" : "error");
				}

				if (!failure) {
					// The iteration forwarded every event including the completing
					// `done`, which has already resolved the outer stream's result.
					// The account that worked becomes the next request's starting
					// point: rotation only moves on failure.
					setPoolCursor(definition.name, accountName);
					if (!sawContent) {
						// Defensive: a stream that ended without any event at all.
						outer.push(errorEvent(`pi-multi-account: account "${accountName}" produced no response.`));
					}
					outer.end();
					return;
				}

				const capturedStatus = captured();
				const errorBody = (failure as { error?: { errorMessage?: string } }).error;
				const errorStatus = capturedStatus ?? statusFromMessage(errorBody?.errorMessage ?? "");
				const failureMessage = errorBody?.errorMessage ?? "";
				const aborted = signal?.aborted === true || (failure as { reason?: string }).reason === "aborted";
				const eligible = !aborted && !sawContent && isFailoverEligible(errorStatus);
				if (!eligible) {
					outer.push(failure);
					outer.end();
					return;
				}

				// A rejected token still gets marked for refresh: that is credential
				// health, not rotation policy — it is what lets the account come
				// back on its own the next time the rotation reaches it.
				if (errorStatus === 401 || errorStatus === 403) {
					markCredentialSuspect("anthropic", accountName, `provider answered ${errorStatus}`);
				}
				lastFailure = failure;
				const next = accounts[index + 1];
				// Move the rotation on, so the next request starts at the account
				// this one is about to try instead of failing here again.
				if (next !== undefined) setPoolCursor(definition.name, next);
				logInfo("pool.failover", {
					pool: definition.name,
					from: accountName,
					to: next ?? "(none)",
					status: errorStatus,
					attempt: index + 1,
					of: accounts.length,
					detail: failureMessage.slice(0, 200) || undefined,
				});
				pendingNotices.push({
					message: next
						? `Pool "${definition.name}": account "${accountName}" failed (${errorStatus}); retrying with "${next}".`
						: `Pool "${definition.name}": account "${accountName}" failed (${errorStatus}); no other account available.`,
					level: "warning",
				});
			}

			// Every account failed (or none could resolve). Report the last real
			// provider error, or an honest summary when none ever got that far.
			// An aborted loop reports the abort, not a pool-wide failure.
			if (signal?.aborted && !lastFailure) {
				outer.push(errorEvent("Request was aborted", "aborted"));
				outer.end();
				return;
			}
			outer.push(
				lastFailure ??
					errorEvent(
						`pi-multi-account: every account in pool "${definition.name}" failed to resolve a credential. Check /accounts.`,
					),
			);
			outer.end();
		})();
		return outer;
	};

	/** Credential resolution for a custom-named pool provider. */
	const poolApiKeyAuth = (definition: PoolDefinition) => ({
		name: `${definition.name} pool account`,
		async check({ signal }: { signal: AbortSignal }) {
			signal.throwIfAborted();
			const state = await store.readProviderAsync("anthropic");
			return expandPoolAccounts(definition, Object.keys(state.accounts), state.active).length > 0
				? { type: "api_key" as const, source: `pi-accounts:${definition.name}` }
				: undefined;
		},
		async resolve({ signal }: { signal: AbortSignal }) {
			signal.throwIfAborted();
			// The stream wrapper picks the account per request; this resolution
			// only tells pi the provider is configured, and hands the turn the
			// first pick for anything that inspects the key before streaming.
			const state = await store.readProviderAsync("anthropic");
			const accounts = expandPoolAccounts(definition, Object.keys(state.accounts), state.active);
			for (const accountName of accounts) {
				const credential = await resolveAccount(accountName, signal, definition.name);
				if (credential) return { auth: { apiKey: credential.access }, source: `pi-accounts:${accountName}` };
			}
			logError("pool.unresolved", { pool: definition.name, reason: "no usable account credential" });
			return undefined;
		},
	});

	const registerProviderFor = (definition: PoolDefinition, models: ProviderModel[]): void => {
		const isNativeOverride = definition.name === NATIVE_POOL_NAME;
		const stream = (kind: StreamKind) => (model: never, context: never, opts: never) =>
			runPool(definition, kind, model as ProviderModel, context, opts as Record<string, unknown> | undefined);
		if (isNativeOverride) {
			// The user explicitly chose the native id: inherit everything,
			// replace only the request entry points.
			pi.unregisterProvider(NATIVE_POOL_NAME);
			pi.registerProvider({
				...(native as Provider),
				stream: stream("stream"),
				streamSimple: stream("streamSimple"),
			} as Provider);
		} else {
			const aliasModels = models.map((model) => ({
				...model,
				api: model.api!,
				provider: definition.name,
				baseUrl: "https://api.anthropic.com",
			}));
			pi.unregisterProvider(definition.name);
			pi.registerProvider({
				id: definition.name,
				name: definition.name,
				baseUrl: "https://api.anthropic.com",
				headers: { "user-agent": buildUserAgent() },
				auth: { apiKey: poolApiKeyAuth(definition) },
				getModels: () => aliasModels,
				stream: stream("stream"),
				streamSimple: stream("streamSimple"),
			} as Provider);
		}
		poolProviderNames.add(definition.name);
		logInfo("pool.registered", { name: definition.name, accounts: definition.accounts, nativeOverride: isNativeOverride });
	};

	return {
		registerPool(definition, models) {
			registerProviderFor(definition, models ?? builtinAnthropicModels());
		},
		unregisterPool(name) {
			pi.unregisterProvider(name);
			poolProviderNames.delete(name);
		},
		registeredPoolNames() {
			return [...poolProviderNames];
		},
	};
}

function builtinAnthropicModels(): ProviderModel[] {
	return builtinProviders()
		.find((provider) => provider.id === "anthropic")
		?.getModels()
		.map(({ provider: _provider, baseUrl: _baseUrl, ...model }) => ({ ...model })) as ProviderModel[];
}

/** Last-resort status extraction from an SDK error message ("429 {…}"). */
function statusFromMessage(message: string): number | undefined {
	const match = message.match(/^\s*(\d{3})\b/);
	if (!match) return undefined;
	const status = Number.parseInt(match[1]!, 10);
	return Number.isFinite(status) ? status : undefined;
}
