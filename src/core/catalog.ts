import { createHash } from "node:crypto";
import { join } from "node:path";
import { statSync } from "node:fs";
import type { Api, Model, ModelAuth, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { highestVersion, isCliVersion, probeCliVersion } from "../cli-version.ts";
import { FileAccountStorageBackend } from "@narumitw/pi-accounts/src/storage.ts";
import { readJson, record, positive, offline } from "./storage.ts";

export const CODEX_FLOOR = "0.170.0";
export const GROK_FLOOR = "1.0.13";
const HOUR = 3_600_000;
const FRESH_MS = 15 * 60_000;
const published = new Map<string, string>();
export const publishedVersion = (id: string): string | undefined => published.get(id);
export function clientVersion(id: string): string {
	if (id === "openai-codex")
		return highestVersion(CODEX_FLOOR, published.get(id), process.env.CODEX_CLIENT_VERSION_MIN, localVersion("codex"));
	if (id === "xai")
		return highestVersion(GROK_FLOOR, published.get(id), process.env.PI_MULTI_ACCOUNT_GROK_CLI_VERSION, localVersion("grok"));
	return highestVersion("2.1.322", published.get(id), process.env.ANTHROPIC_CLI_VERSION_MIN, localVersion("claude"));
}
const local = new Map<string, { at: number; version: string | undefined }>();
function localVersion(command: string): string | undefined {
	const cached = local.get(command);
	if (!cached || Date.now() - cached.at >= 10 * 60_000) local.set(command, { at: Date.now(), version: probeCliVersion(command) });
	return local.get(command)?.version;
}

export interface CatalogEntry {
	at: number;
	clientVersion?: string;
	models: Model<Api>[];
	source: string;
}
interface CatalogFile {
	version: 1;
	entries: Record<string, CatalogEntry>;
	published?: Record<string, { at: number; version: string }>;
	metadata?: { at: number; data: Record<string, unknown> };
}
export const catalogKey = (provider: string, identity: string): string =>
	`${provider}:${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;

/** Read a bounded public or authenticated JSON document. Never replay bearer tokens on redirects. */
export async function fetchJson(url: string, init: RequestInit, request: typeof fetch = fetch, limit = 16 << 20): Promise<unknown> {
	return JSON.parse(await fetchText(url, init, request, limit));
}
async function fetchText(url: string, init: RequestInit, request: typeof fetch, limit: number): Promise<string> {
	const response = await request(url, { ...init, redirect: "error" });
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Catalog request failed (${response.status})`);
	}
	if (!response.body) throw new Error("Catalog response has no body");
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = response.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > limit) throw new Error("Catalog response is too large");
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	return Buffer.concat(chunks).toString("utf8");
}

export class ModelCatalog {
	readonly path: string;
	private file: CatalogFile;
	private requests = new Map<string, Promise<CatalogEntry>>();
	private stamp = "";
	constructor(
		agentDir: string,
		private readonly request: typeof fetch = fetch,
	) {
		this.path = join(agentDir, "pi-multi-account-catalog.json");
		this.file = this.read();
		for (const [id, entry] of Object.entries(this.file.published ?? {}))
			if (entry && isCliVersion(entry.version)) published.set(id, highestVersion(entry.version, published.get(id)));
	}
	private read(): CatalogFile {
		try {
			const f = readJson<CatalogFile>(this.path, { version: 1, entries: {} });
			return f.version === 1 && record(f.entries) ? f : { version: 1, entries: {} };
		} catch {
			return { version: 1, entries: {} };
		} // This file is a disposable cache, never the account/config store.
	}
	get(key: string): CatalogEntry | undefined {
		try {
			const s = statSync(this.path);
			const stamp = `${s.ino}:${s.mtimeMs}:${s.size}`;
			if (stamp !== this.stamp) {
				this.file = this.read();
				this.stamp = stamp;
			}
		} catch {
			/* A missing cache leaves the in-memory snapshot intact. */
		}
		const entry = this.file.entries[key];
		return entry &&
			Number.isFinite(entry.at) &&
			Array.isArray(entry.models) &&
			entry.models.every(
				(m) =>
					record(m) &&
					typeof m.id === "string" &&
					typeof m.name === "string" &&
					typeof m.api === "string" &&
					typeof m.baseUrl === "string" &&
					typeof m.reasoning === "boolean" &&
					Array.isArray(m.input) &&
					positive(m.contextWindow) &&
					positive(m.maxTokens) &&
					record(m.cost) &&
					[m.cost.input, m.cost.output, m.cost.cacheRead, m.cost.cacheWrite].every(
						(n) => typeof n === "number" && Number.isFinite(n) && n >= 0,
					),
			)
			? entry
			: undefined;
	}
	async refreshPublic(signal: AbortSignal, force = false): Promise<void> {
		if (offline()) return;
		if (force) local.clear();
		let changed = false;
		signal = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
		const now = Date.now();
		const versions = { "openai-codex": "@openai/codex", anthropic: "@anthropic-ai/claude-code" };
		await Promise.all([
			...Object.entries(versions).map(async ([id, pkg]) => {
				if (!force && now - (this.file.published?.[id]?.at ?? 0) < 6 * HOUR) return;
				try {
					const body = await fetchJson(`https://registry.npmjs.org/${pkg}/latest`, { signal }, this.request, 4 << 20);
					if (record(body) && typeof body.version === "string" && /^\d+\.\d+\.\d+$/.test(body.version)) {
						published.set(id, highestVersion(clientVersion(id), body.version));
						(this.file.published ??= {})[id] = { at: now, version: body.version };
						changed = true;
					}
				} catch {
					/* A version lookup must not make an otherwise usable model disappear. */
				}
			}),
			(async () => {
				if (!force && now - (this.file.published?.xai?.at ?? 0) < 6 * HOUR) return;
				try {
					const version = (
						await fetchText("https://storage.googleapis.com/grok-build-public-artifacts/cli/stable", { signal }, this.request, 1024)
					)
						.trim()
						.split(/\r?\n/)[0];
					if (/^\d+\.\d+\.\d+$/.test(version)) {
						published.set("xai", highestVersion(clientVersion("xai"), version));
						(this.file.published ??= {}).xai = { at: now, version };
						changed = true;
					}
				} catch {
					/* The local CLI and version floor remain available. */
				}
			})(),
			(async () => {
				if (force || now - (this.file.metadata?.at ?? 0) >= 6 * HOUR) {
					try {
						const body = await fetchJson("https://models.dev/api.json", { signal }, this.request);
						if (record(body)) {
							const data = Object.fromEntries(
								["anthropic", "openai", "xai", "github-copilot"].filter((id) => record(body[id])).map((id) => [id, body[id]]),
							);
							if (Object.keys(data).length) {
								this.file.metadata = { at: now, data };
								changed = true;
							}
						}
					} catch {
						/* Last good metadata remains usable offline. */
					}
				}
			})(),
		]);
		if (changed) await this.save();
	}
	metadata(provider: string): Record<string, unknown> {
		const data = this.file.metadata?.data?.[provider === "openai-codex" ? "openai" : provider];
		return record(data) && record(data.models) ? data.models : {};
	}
	async discover(
		provider: string,
		identity: string,
		auth: ModelAuth,
		base: readonly Model<Api>[],
		options: { signal: AbortSignal; force?: boolean },
	): Promise<CatalogEntry> {
		const key = catalogKey(provider, identity);
		const cached = this.get(key);
		if (
			offline() ||
			(!options.force &&
				cached &&
				Date.now() - cached.at < FRESH_MS &&
				(provider !== "openai-codex" || cached.clientVersion === clientVersion(provider)))
		) {
			if (cached) return cached;
			return { at: 0, models: [...base], source: "builtin" };
		}
		const running = this.requests.get(key);
		if (running) return running;
		const promise = this.fetch(provider, auth, base, options.signal)
			.then(async (entry) => {
				this.file.entries[key] = entry;
				await this.save();
				return entry;
			})
			.finally(() => this.requests.delete(key));
		this.requests.set(key, promise);
		return promise;
	}
	private async fetch(provider: string, auth: ModelAuth, base: readonly Model<Api>[], signal: AbortSignal): Promise<CatalogEntry> {
		const headers = new Headers(auth.headers as Record<string, string> | undefined);
		if (auth.apiKey) headers.set("authorization", `Bearer ${auth.apiKey}`);
		let url: string;
		if (provider === "openai-codex") {
			url = `https://chatgpt.com/backend-api/codex/models?client_version=${clientVersion(provider)}`;
			const id = chatgptAccountId(auth.apiKey);
			if (id) headers.set("ChatGPT-Account-Id", id);
		} else if (provider === "xai") {
			url = `${auth.baseUrl ?? "https://cli-chat-proxy.grok.com/v1"}/models`;
			headers.set("x-grok-client-version", clientVersion(provider));
		} else if (provider === "anthropic") {
			url = "https://api.anthropic.com/v1/models?limit=1000";
			headers.set("anthropic-version", "2023-06-01");
			if (auth.apiKey?.startsWith("sk-ant-oat")) headers.set("anthropic-beta", "oauth-2025-04-20");
			else if (auth.apiKey) {
				headers.delete("authorization");
				headers.set("x-api-key", auth.apiKey);
			}
		} else if (provider === "github-copilot") url = `${auth.baseUrl ?? "https://api.individual.githubcopilot.com"}/models`;
		else return { at: 0, models: [...base], source: "builtin" };
		let body = await fetchJson(url, { headers, signal }, this.request, 4 << 20);
		if (provider === "anthropic" && record(body) && Array.isArray(body.data)) {
			const rows = [...body.data];
			let page = body;
			let pages = 0;
			while (page.has_more === true) {
				if (++pages > 10 || typeof page.last_id !== "string") throw new Error("Invalid or excessive Anthropic catalog pagination");
				const next = await fetchJson(`${url}&after_id=${encodeURIComponent(page.last_id)}`, { headers, signal }, this.request, 4 << 20);
				if (!record(next) || !Array.isArray(next.data)) throw new Error("Invalid Anthropic catalog page");
				rows.push(...next.data);
				page = next;
			}
			body = { data: rows };
		}
		const models = parseModels(provider, body, base, this.metadata(provider));
		if (!models.length) throw new Error(`${provider} listed no usable chat models`);
		const located = provider === "xai" && auth.baseUrl ? models.map((m) => ({ ...m, baseUrl: auth.baseUrl! })) : models;
		return { at: Date.now(), models: located, source: "vendor", clientVersion: clientVersion(provider) };
	}
	private async save(): Promise<void> {
		const fresh = this.file;
		this.file = await new FileAccountStorageBackend(this.path).withLockAsync(async (raw) => {
			let old: CatalogFile = { version: 1, entries: {} };
			try {
				const parsed: unknown = raw === undefined ? undefined : JSON.parse(raw);
				if (record(parsed) && parsed.version === 1 && record(parsed.entries)) old = parsed as unknown as CatalogFile;
			} catch {
				/* Only this disposable cache may be rebuilt after invalid JSON. */
			}
			const entries = { ...(old.entries ?? {}) };
			for (const [key, entry] of Object.entries(fresh.entries)) if (!entries[key] || entries[key].at <= entry.at) entries[key] = entry;
			const value: CatalogFile = {
				version: 1,
				entries,
				published: { ...old.published, ...fresh.published },
				metadata: (old.metadata?.at ?? 0) > (fresh.metadata?.at ?? 0) ? old.metadata : fresh.metadata,
			};
			return { next: `${JSON.stringify(value, null, 2)}\n`, result: value };
		});
	}
}

export function chatgptAccountId(access: string | undefined): string | undefined {
	try {
		const p = JSON.parse(Buffer.from(access?.split(".")[1] ?? "", "base64url").toString());
		const id = p?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof id === "string" ? id : undefined;
	} catch {
		return undefined;
	}
}

/** Vendor availability is authoritative; models.dev enriches it, never invents account entitlements. */
export function parseModels(
	provider: string,
	body: unknown,
	base: readonly Model<Api>[],
	metadata: Record<string, unknown> = {},
): Model<Api>[] {
	if (!record(body)) throw new Error("Invalid model catalog");
	const rows = Array.isArray(body.models) ? body.models : body.data;
	if (!Array.isArray(rows)) throw new Error("Model catalog has no list");
	const seen = new Set<string>();
	const out: Model<Api>[] = [];
	for (const row of rows) {
		if (!record(row)) continue;
		const id = typeof row.slug === "string" ? row.slug : row.id;
		if (typeof id !== "string" || !id || id.length > 200 || /[\s\x00-\x1f]/.test(id) || row.visibility === "hide" || seen.has(id)) continue;
		const caps = record(row.capabilities) ? row.capabilities : {};
		if (caps.type && caps.type !== "chat") continue;
		if (/^(text-embedding|whisper|tts-|dall-e|gpt-image)/.test(id)) continue;
		const known = base.find((m) => m.id === id);
		const { headers: _headers, ...facts } = known ?? {};
		const info = record(metadata[id]) ? metadata[id] : {};
		const limit = record(info.limit) ? info.limit : {};
		const cost = { ...(record(info.cost) ? info.cost : {}), ...(record(row.cost) ? row.cost : {}) };
		const vendorLimits = record(caps.limits) ? caps.limits : {};
		const supports = record(caps.supports) ? caps.supports : {};
		const endpoints = Array.isArray(row.supported_endpoints) ? row.supported_endpoints : [];
		const api =
			provider === "github-copilot" && endpoints.length
				? endpoints.some((e) => String(e).endsWith("/messages"))
					? "anthropic-messages"
					: endpoints.some((e) => String(e).endsWith("/responses"))
						? "openai-responses"
						: "openai-completions"
				: known?.api;
		const levels = Array.isArray(row.supported_reasoning_levels)
			? row.supported_reasoning_levels.map((l) => (record(l) ? l.effort : l)).filter((l): l is string => typeof l === "string")
			: undefined;
		const thinking: ThinkingLevelMap = {};
		if (levels?.length) {
			for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
				thinking[level] = levels.includes(level) ? level : level === "off" && levels.includes("none") ? "none" : null;
			}
		}
		const modalities = Array.isArray(row.input_modalities)
			? row.input_modalities
			: record(info.modalities) && Array.isArray(info.modalities.input)
				? info.modalities.input
				: undefined;
		const context =
			[
				row.max_context_window,
				row.context_window,
				row.context_window_size,
				vendorLimits.max_prompt_tokens,
				limit.input,
				limit.context,
				known?.contextWindow,
			].find(positive) ?? 128_000;
		const output =
			[row.max_output_tokens, vendorLimits.max_output_tokens, limit.output, known?.maxTokens].find(positive) ?? Math.min(8192, context);
		const number = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback);
		// Unknown models do not inherit a sibling's price or unverified protocol flags.
		out.push({
			...facts,
			id,
			name: String(row.display_name ?? row.name ?? info.name ?? known?.name ?? id),
			provider,
			api:
				api ??
				(provider === "anthropic" ? "anthropic-messages" : provider === "openai-codex" ? "openai-codex-responses" : "openai-responses"),
			baseUrl:
				known?.baseUrl ??
				(provider === "anthropic"
					? "https://api.anthropic.com"
					: provider === "openai-codex"
						? "https://chatgpt.com/backend-api"
						: provider === "xai"
							? "https://cli-chat-proxy.grok.com/v1"
							: "https://api.individual.githubcopilot.com"),
			reasoning: levels
				? levels.some((l) => l !== "none" && l !== "off")
				: Boolean(info.reasoning ?? supports.reasoning ?? known?.reasoning),
			input: modalities
				? modalities.includes("image")
					? ["text", "image"]
					: ["text"]
				: typeof supports.vision === "boolean"
					? supports.vision
						? ["text", "image"]
						: ["text"]
					: (known?.input ?? ["text"]),
			contextWindow: context,
			maxTokens: Math.min(output, context),
			cost: {
				input: number(cost.input, known?.cost.input),
				output: number(cost.output, known?.cost.output),
				cacheRead: number(cost.cache_read, known?.cost.cacheRead),
				cacheWrite: number(cost.cache_write, known?.cost.cacheWrite),
			},
			...(levels ? { thinkingLevelMap: thinking } : {}),
		});
		seen.add(id);
	}
	return out;
}
