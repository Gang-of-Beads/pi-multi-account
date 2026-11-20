/** Anthropic compatibility names used by pools and session selection. */
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { AccountStore } from "@narumitw/pi-accounts/src/accounts.ts";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { withExtraModels, type RegisteredModel } from "./models.ts";
import { PmaEngine } from "./core/engine.ts";
import { registerPiProviders } from "./pi-adapter.ts";
type ProviderChatModelConfig = Exclude<ProviderModelConfig, { type: "image" | "classifier" }>;
export const ALIAS_PREFIX = "anthropic-";
export interface AliasRegistry {
	bootstrap(): Promise<void>;
	sync(ctx: ExtensionContext): Promise<void>;
}
export function aliasAccountName(providerId: string | undefined): string | undefined {
	return providerId?.startsWith(ALIAS_PREFIX) ? providerId.slice(ALIAS_PREFIX.length) || undefined : undefined;
}
export function builtinAnthropicModels(): (ProviderChatModelConfig & Record<string, unknown>)[] {
	return withExtraModels(getBuiltinModels("anthropic") as RegisteredModel[]) as (ProviderChatModelConfig & Record<string, unknown>)[];
}
export function registerAccountAliasProviders(pi: ExtensionAPI, store: AccountStore): AliasRegistry {
	return registerPiProviders(pi, new PmaEngine(getAgentDir(), { store }), {
		families: ["anthropic"],
		skipNativeAnthropic: () => true,
		commands: false,
		networkOnBootstrap: false,
	});
}
