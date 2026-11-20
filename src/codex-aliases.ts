/** Compatibility entrypoint; account/auth/catalog behavior now belongs to the shared core. */
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PmaEngine } from "./core/engine.ts";
import { registerPiProviders } from "./pi-adapter.ts";
export function registerCodexAliasProviders(pi: ExtensionAPI) {
	return registerPiProviders(pi, new PmaEngine(getAgentDir()), { families: ["openai-codex"], commands: false, networkOnBootstrap: false });
}
