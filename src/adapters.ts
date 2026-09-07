/**
 * Account provider adapters, patched for this extension.
 */
import type { OAuthCredential } from "@earendil-works/pi-ai";
import {
	createBuiltinProviderAdapters,
	type AccountProviderAdapter,
} from "@narumitw/pi-accounts/src/oauth.ts";
import { sanitizeRefreshError } from "./errors.ts";

let patched: AccountProviderAdapter[] | undefined;

/**
 * pi-accounts' adapters, with two fixes applied to every OAuth refresh:
 *
 * 1. Node 24's `AbortSignal.any()` throws when any entry is undefined. pi's
 *    built-in Anthropic refresh accepts an optional signal, but the underlying
 *    helper assumes a concrete one, and pi-accounts calls `oauth.refresh()`
 *    without a signal during session/account sync — which fail-closes the
 *    provider before any network request is attempted.
 * 2. Refresh responses only carry the rotating token fields, so the stored
 *    Claude Code metadata (label, subscription tier, source) must be preserved.
 *
 * Memoized: one process hosts many sessions, and the adapters are stateless.
 */
export function patchedProviders(): readonly AccountProviderAdapter[] {
	patched ??= createBuiltinProviderAdapters().map((provider) => ({
		...provider,
		oauth: {
			...provider.oauth,
			refresh: async (credential, signal) => {
				try {
					return preserveCredentialMetadata(
						credential,
						await provider.oauth.refresh(credential, signal ?? new AbortController().signal),
					);
				} catch (error) {
					throw sanitizeRefreshError(provider.id, undefined, error);
				}
			},
		},
	}));
	return patched;
}

/** The Anthropic adapter, which every alias and the billing layer depend on. */
export function anthropicAdapter(): AccountProviderAdapter {
	const adapter = patchedProviders().find((provider) => provider.id === "anthropic");
	if (!adapter) throw new Error("pi-multi-account: missing Anthropic provider adapter.");
	return adapter;
}

/** Keep non-token credential fields (label, tier, source) across a refresh. */
export function preserveCredentialMetadata<T extends OAuthCredential>(
	previous: T,
	refreshed: OAuthCredential,
): T {
	return {
		...(previous as Record<string, unknown>),
		...(refreshed as Record<string, unknown>),
		type: "oauth",
	} as T;
}
