import { createHash } from "node:crypto";
import { join } from "node:path";
import {
	createModels,
	type Api,
	type Context,
	type Model,
	type ModelAuth,
	type Provider,
	type SimpleStreamOptions,
	type OAuthCredential,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { AccountStore } from "@narumitw/pi-accounts/src/accounts.ts";
import { LocklessReadAccountStore } from "../account-store.ts";
import { patchedProviders } from "../adapters.ts";
import { attachShaping, applyUserAgentOverride } from "../billing.ts";
import { withExtraModels, type RegisteredModel } from "../models.ts";
import {
	refreshAccountCredential,
	isCredentialSuspect,
	REFRESH_SKEW_MS,
	markRunStarted,
	markRunFinished,
	markCredentialSuspect,
} from "../refresh.ts";
import { ModelCatalog, catalogKey, clientVersion, chatgptAccountId } from "./catalog.ts";
import { readCachedCatalogs, applyContextWindows } from "../codex-catalog.ts";
import { definitionToProvider, readProviderDefs, type ProviderDefinition } from "./provider-defs.ts";
import { nativeCredentials, offline, readJson } from "./storage.ts";

const ACTIVE: Record<string, string> = { anthropic: "anthropic", "openai-codex": "codex", xai: "xai", "github-copilot": "copilot" };
export const accountProviderId = (provider: string, account: string): string => `${ACTIVE[provider] ?? provider}-${account}`;
export interface Target {
	provider: string;
	model: string;
	account?: string;
	weight?: number;
}
export interface ResolvedTarget {
	model: Model<Api>;
	provider: string;
	account?: string;
}

/** No Pi session, agent loop, tools or ExtensionContext lives in the shared runtime. */
export class PmaEngine {
	readonly catalog: ModelCatalog;
	readonly store: AccountStore;
	readonly models;
	private aliases = new Map<string, { provider: string; account?: string }>();
	private owned = new Set<string>();
	private baseline: Map<string, Provider>;
	private nativeSnapshots = new Map<string, { identity: string; models: Model<Api>[] }>();
	/** Providers the user defined; handed to Pi by the adapter and served by the gateway as they are. */
	readonly definitions: readonly ProviderDefinition[];
	private nativeProviders = new Map<string, Provider>();
	constructor(
		readonly agentDir: string,
		options: { store?: AccountStore; fetch?: typeof fetch; providers?: Provider[] } = {},
	) {
		this.store = options.store ?? new LocklessReadAccountStore(join(agentDir, "pi-accounts.json"));
		this.catalog = new ModelCatalog(agentDir, options.fetch);
		this.models = createModels({ credentials: nativeCredentials(join(agentDir, "auth.json")) });
		this.baseline = new Map((options.providers ?? builtinProviders()).map((p) => [p.id, p]));
		// User definitions join the baseline so an id resolves like a built-in one; a broken file fails
		// the engine rather than silently routing to the wrong endpoint.
		this.definitions = readProviderDefs(agentDir).providers;
		for (const p of this.baseline.values()) {
			const wrapped: Provider = {
				...p,
				getModels: () => (this.nativeSnapshot(p.id) ?? [...p.getModels()]).map((m) => ({ ...m, headers: this.headers(p.id, m.headers) })),
				getAllModels: () => [
					...wrapped.getModels(),
					...(p.getAllModels?.() ?? []).filter((m) => m.type !== undefined && m.type !== "chat"),
				],
				filterModels: (models, credential) =>
					this.nativeSnapshot(p.id) !== undefined ? models : (p.filterModels?.(models, credential) ?? models),
				stream: (model, context, options) => p.stream(model, context, this.options(p.id, options as SimpleStreamOptions) as never),
				streamSimple: (model, context, options) => p.streamSimple(model, context, this.options(p.id, options)),
			};
			this.nativeProviders.set(p.id, wrapped);
			this.models.setProvider(wrapped);
		}
		// Definitions are static providers: no discovery, no account store, so they register untouched.
		for (const definition of this.definitions) this.models.setProvider(definitionToProvider(definition));
	}

	/** Providers a definition owns; the adapter announces these, the engine never wraps them. */
	private get definedProviders(): Provider[] {
		return this.definitions.map(definitionToProvider);
	}
	private nativeSnapshot(id: string): Model<Api>[] | undefined {
		if (!["anthropic", "openai-codex", "xai", "github-copilot"].includes(id)) return undefined;
		const stored = readJson<Record<string, { access?: string; key?: string }>>(join(this.agentDir, "auth.json"), {})[id];
		const env = (
			{ anthropic: "ANTHROPIC_API_KEY", xai: "XAI_API_KEY", "github-copilot": "COPILOT_GITHUB_TOKEN" } as Record<string, string>
		)[id];
		const token = stored?.access ?? stored?.key ?? (env ? process.env[env] : undefined);
		if (!token) return undefined;
		const identity = `native:${chatgptAccountId(token) ?? createHash("sha256").update(token).digest("hex")}`;
		const live = this.nativeSnapshots.get(id);
		if (live?.identity === identity) return live.models;
		return this.catalog.get(catalogKey(id, identity))?.models;
	}
	canonicalProvider(id: string): string {
		return this.aliases.get(id)?.provider ?? id;
	}
	importProvider(provider: Provider): void {
		if (provider.id !== "pma" && !this.owned.has(provider.id)) this.models.setProvider(provider);
	}
	get dynamicProviders(): Provider[] {
		return [...this.nativeProviders.values()].filter(
			(p) => ["anthropic", "openai-codex", "xai", "github-copilot"].includes(p.id) && !this.owned.has(p.id),
		);
	}
	get accountProviders(): Provider[] {
		return [...this.owned].map((id) => this.models.getProvider(id)!).filter(Boolean);
	}
	async initialize(options: { network?: boolean; timeoutMs?: number } = {}): Promise<void> {
		await this.syncAccounts();
		if (options.network !== false) {
			const configured =
				this.owned.size > 0 || (await Promise.all(this.dynamicProviders.map((p) => this.models.checkAuth(p.id)))).some(Boolean);
			if (configured) await this.refresh({ timeoutMs: options.timeoutMs ?? 3000, refreshTokens: false });
		}
	}
	async syncAccounts(): Promise<void> {
		const all = await this.store.readAsync();
		const wanted = new Set<string>();
		for (const [canonical, state] of Object.entries(all.providers)) {
			const base = this.baseline.get(canonical);
			if (!base?.auth.oauth) continue;
			for (const [name, credential] of Object.entries(state.accounts)) {
				if (credential.type !== "oauth") continue;
				const id = accountProviderId(canonical, name);
				wanted.add(id);
				this.install(id, canonical, name);
			}
			if (state.active && state.accounts[state.active]?.type === "oauth") {
				const id = ACTIVE[canonical] ?? canonical;
				wanted.add(id);
				this.install(id, canonical);
			}
		}
		for (const id of this.owned)
			if (!wanted.has(id)) {
				this.models.deleteProvider(id);
				this.aliases.delete(id);
				const native = this.nativeProviders.get(id);
				if (native) this.models.setProvider(native);
			}
		this.owned = wanted;
	}
	private install(id: string, canonical: string, pinned?: string): void {
		const base = this.baseline.get(canonical)!;
		this.aliases.set(id, { provider: canonical, account: pinned });
		const provider: Provider = {
			id,
			name: id,
			baseUrl: canonical === "xai" ? "https://cli-chat-proxy.grok.com/v1" : base.baseUrl,
			auth: {
				apiKey: {
					name: `${id} account token`,
					check: async ({ signal }) => {
						signal.throwIfAborted();
						const found = await this.account(canonical, pinned);
						return found ? { type: "api_key", source: `pi-accounts:${found.name}` } : undefined;
					},
					resolve: async ({ signal }) => {
						const found = await this.credential(canonical, pinned, signal);
						return found ? { auth: await base.auth.oauth!.toAuth(found.credential), source: `pi-accounts:${found.name}` } : undefined;
					},
				},
			},
			getModels: () =>
				this.accountModels(canonical, pinned).map((m) => ({
					...m,
					provider: id,
					...(canonical === "xai" ? { baseUrl: provider.baseUrl! } : {}),
					headers: this.headers(canonical, m.headers),
				})),
			refreshModels: async ({ signal, force, allowNetwork }) => {
				if (allowNetwork) await this.refreshAccount(canonical, pinned, signal, force);
			},
			stream: (model, context, options) =>
				base.stream({ ...model, provider: canonical }, context, this.options(canonical, options as SimpleStreamOptions) as never),
			streamSimple: (model, context, options) =>
				base.streamSimple({ ...model, provider: canonical }, context, this.options(canonical, options)),
		};
		this.models.setProvider(provider);
	}
	private headers(provider: string, previous?: Record<string, string>): Record<string, string> | undefined {
		if (provider === "openai-codex")
			return { ...previous, version: clientVersion(provider), "user-agent": `codex_cli_rs/${clientVersion(provider)}` };
		if (provider === "xai") return { ...previous, "x-grok-client-version": clientVersion(provider) };
		return previous;
	}
	private options(provider: string, options?: SimpleStreamOptions): SimpleStreamOptions {
		const result = { ...options };
		const priorResponse = result.onResponse;
		result.onResponse = async (response, model) => {
			if (response.status === 401 && result.apiKey) await this.rejected(provider, result.apiKey);
			await priorResponse?.(response, model);
		};
		if (provider !== "anthropic") return result;
		const shaped = attachShaping(result) as SimpleStreamOptions;
		const realFetch = shaped.fetch ?? globalThis.fetch;
		shaped.fetch = (input, init) => {
			const headers = new Headers(init?.headers);
			applyUserAgentOverride(headers);
			return realFetch(input, { ...init, headers });
		};
		return shaped;
	}
	async rejected(provider: string, access: string): Promise<void> {
		const state = await this.store.readProviderAsync(provider as never);
		for (const [name, credential] of Object.entries(state.accounts))
			if (credential.type === "oauth" && credential.access === access)
				markCredentialSuspect(provider, name, "provider rejected the request token (401)");
	}
	private async account(provider: string, pinned?: string): Promise<{ name: string; credential: OAuthCredential } | undefined> {
		const state = await this.store.readProviderAsync(provider as never);
		const name = pinned ?? state.active;
		const credential = name ? state.accounts[name] : undefined;
		return name && credential?.type === "oauth" ? { name, credential } : undefined;
	}
	private async credential(provider: string, pinned: string | undefined, signal: AbortSignal) {
		signal.throwIfAborted();
		const found = await this.account(provider, pinned);
		if (!found) return undefined;
		const adapter = patchedProviders().find((p) => p.id === provider);
		if (adapter && (isCredentialSuspect(provider, found.name) || found.credential.expires <= Date.now() + REFRESH_SKEW_MS)) {
			found.credential = await refreshAccountCredential(this.store, adapter, found.name, found.credential, Date.now(), {
				force: isCredentialSuspect(provider, found.name),
			});
		}
		signal.throwIfAborted();
		return found;
	}
	private identity(name: string, credential: OAuthCredential): string {
		let sub: string | undefined;
		try {
			const value = JSON.parse(Buffer.from(credential.access.split(".")[1], "base64url").toString()).sub;
			if (typeof value === "string") sub = value;
		} catch {
			/* Opaque tokens are keyed by their fingerprint instead. */
		}
		return `${name}:${chatgptAccountId(credential.access) ?? sub ?? createHash("sha256").update(credential.access).digest("hex")}`;
	}
	private accountModels(provider: string, pinned?: string): Model<Api>[] {
		// AccountStore.read() is synchronous; use the lockless atomic snapshot when available.
		let state;
		try {
			state = this.store.read().providers[provider as never] ?? { accounts: {} };
		} catch {
			return this.baseModels(provider);
		}
		const name = pinned ?? state.active;
		const credential = name ? state.accounts[name] : undefined;
		if (!name || credential?.type !== "oauth") return [];
		const cached = this.catalog.get(catalogKey(provider, this.identity(name, credential)));
		if (cached) return cached.models;
		const base = this.baseModels(provider);
		if (provider === "openai-codex") {
			const accountId = chatgptAccountId(credential.access);
			const legacy = accountId ? readCachedCatalogs(join(this.agentDir, "pi-multi-account-codex-catalog.json")).get(accountId) : undefined;
			if (legacy) return applyContextWindows(base, legacy.windows);
		}
		return base;
	}
	private baseModels(provider: string): Model<Api>[] {
		const base = [...(this.baseline.get(provider)?.getModels() ?? [])];
		return provider === "anthropic" ? (withExtraModels(base as RegisteredModel[]) as Model<Api>[]) : base;
	}
	private async refreshAccount(provider: string, pinned: string | undefined, signal: AbortSignal, force?: boolean): Promise<void> {
		const found = await this.credential(provider, pinned, signal);
		if (!found) return;
		const auth = await this.baseline.get(provider)!.auth.oauth!.toAuth(found.credential);
		await this.catalog.discover(provider, this.identity(found.name, found.credential), auth, this.baseModels(provider), { signal, force });
	}
	async refresh(
		options: { signal?: AbortSignal; timeoutMs?: number; force?: boolean; refreshTokens?: boolean } = {},
	): Promise<{ errors: string[] }> {
		if (offline()) return { errors: [] };
		const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? 8000)]);
		await this.catalog.refreshPublic(signal, options.force).catch(() => undefined);
		const errors: string[] = [];
		await Promise.all(
			[...this.aliases]
				.filter(([, a]) => a.account !== undefined)
				.map(async ([id, a]) => {
					try {
						const held = await this.account(a.provider, a.account);
						if (options.refreshTokens === false && held && held.credential.expires <= Date.now() + REFRESH_SKEW_MS) return;
						await this.refreshAccount(a.provider, a.account, signal, options.force);
					} catch {
						errors.push(`${id}: catalog unavailable; retained last good or built-in metadata`);
					}
				}),
		);
		const native = readJson<Record<string, OAuthCredential>>(join(this.agentDir, "auth.json"), {});
		await Promise.all(
			this.dynamicProviders.map(async (p) => {
				if (options.refreshTokens === false && native[p.id]?.type === "oauth" && native[p.id].expires <= Date.now() + REFRESH_SKEW_MS)
					return;
				try {
					const auth = await this.models.getAuth(p.id, { signal });
					if (!auth) return;
					const identity = `native:${
						chatgptAccountId(auth.auth.apiKey) ??
						createHash("sha256")
							.update(auth.auth.apiKey ?? auth.source ?? p.id)
							.digest("hex")
					}`;
					const resolved = {
						...auth.auth,
						...(p.id === "xai"
							? { baseUrl: native[p.id]?.type === "oauth" ? "https://cli-chat-proxy.grok.com/v1" : "https://api.x.ai/v1" }
							: {}),
					};
					const entry = await this.catalog.discover(p.id, identity, resolved, this.baseModels(p.id), { signal, force: options.force });
					this.nativeSnapshots.set(p.id, { identity, models: entry.models });
				} catch {
					errors.push(`${p.id}: native catalog unavailable; retained last good or built-in metadata`);
				}
			}),
		);
		return { errors };
	}
	resolve(target: Target): ResolvedTarget {
		let id = target.account ? accountProviderId(target.provider, target.account) : target.provider;
		const active = this.aliases.get(id);
		if (active && active.account === undefined) {
			const name = this.store.read().providers[active.provider as never]?.active;
			if (name) id = accountProviderId(active.provider, name);
		}
		const model = this.models.getModel(id, target.model);
		if (!model) throw new Error(`Unknown model: ${id}/${target.model}; refresh the catalog`);
		const alias = this.aliases.get(id);
		return { model, provider: alias?.provider ?? id, account: alias?.account ?? target.account };
	}
	async auth(target: ResolvedTarget, signal?: AbortSignal): Promise<ModelAuth> {
		const resolved = await this.models.getAuth(target.model, { signal });
		if (!resolved) throw new Error(`No configured credential for ${target.model.provider}`);
		return resolved.auth;
	}
	stream(target: ResolvedTarget, context: Context, options: SimpleStreamOptions = {}) {
		markRunStarted();
		try {
			const stream = this.models.streamSimple(target.model, context, options);
			void stream
				.result()
				.finally(markRunFinished)
				.catch(() => undefined);
			return stream;
		} catch (error) {
			markRunFinished();
			throw error;
		}
	}
}
