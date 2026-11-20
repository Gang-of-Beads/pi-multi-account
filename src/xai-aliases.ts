/** Compatibility entrypoint; the Pi adapter and standalone service share the same providers. */
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AccountStore } from "@narumitw/pi-accounts/src/accounts.ts";
import { PmaEngine } from "./core/engine.ts";
import { registerPiProviders } from "./pi-adapter.ts";
export const XAI_ACTIVE_ALIAS = "xai";
export const XAI_ALIAS_PREFIX = "xai-";
export function registerXaiAliasProviders(pi: ExtensionAPI, store: AccountStore) {
	return registerPiProviders(pi, new PmaEngine(getAgentDir(), { store }), {
		families: ["xai"],
		commands: false,
		networkOnBootstrap: false,
	});
}
