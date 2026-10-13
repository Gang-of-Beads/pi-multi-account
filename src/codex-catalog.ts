/**
 * Per-account Codex context windows from the live ChatGPT `/codex/models` catalog.
 *
 * pi's native openai-codex metadata carries each model's default window
 * (272k for gpt-6-astra), while the backend advertises a larger
 * `max_context_window` per account (872k). The owner chose the maximum, falling
 * back to `context_window`, and to native metadata when the catalog is missing.
 * Windows are keyed by the token's ChatGPT account id, so a routine token
 * rotation keeps them and a re-login into a different account drops them.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { highestVersion, probeCliVersion } from "./cli-version.ts";
import { BASE_URL } from "./codex-shared.ts";

/**
 * The Codex CLI release the catalog request claims. Discovery is version-gated: an older client
 * receives an incomplete catalog, and a model missing from it keeps pi's native window (272k).
 * Measured 2026-10-13: 0.154.0 got no gpt-6.1-sol (it needs 0.160+) and no gpt-6-sol or
 * gpt-6-luna (0.158+), so those stayed at 272k instead of 872k. Kept at the latest published
 * openai/codex release; bump when a release lands.
 */
export const CODEX_CLIENT_VERSION = "0.162.1";

/** Raise the claimed Codex version without waiting for a release; a floor, like ANTHROPIC_CLI_VERSION_MIN. */
export const CODEX_VERSION_MIN_ENV = "CODEX_CLIENT_VERSION_MIN";

// undefined = probed and not found; null = not probed yet.
let detectedCodexVersion: string | undefined | null = null;

/** Version of a locally installed Codex CLI (`codex --version` prints `codex-cli <version>`), if any. */
export function detectCodexVersion(): string | undefined {
	if (detectedCodexVersion !== null) return detectedCodexVersion;
	detectedCodexVersion = probeCliVersion("codex");
	return detectedCodexVersion;
}

/** Test hook: forget the memoized probe result. */
export function resetCodexVersionCache(): void {
	detectedCodexVersion = null;
}

/** The version to claim: the highest of the pin, the environment floor and a local Codex CLI. */
export function codexClientVersion(): string {
	return highestVersion(CODEX_CLIENT_VERSION, process.env[CODEX_VERSION_MIN_ENV], detectCodexVersion());
}

export interface ContextCatalog {
	accountId: string;
	windows: Map<string, number>;
}

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function accountIdOf(access: string | undefined): string | undefined {
	try {
		const claims = JSON.parse(Buffer.from(access?.split(".")[1] ?? "", "base64url").toString());
		const accountId = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof accountId === "string" && accountId ? accountId : undefined;
	} catch {
		return undefined;
	}
}

export function contextWindows(body: unknown): Map<string, number> {
	if (!body || typeof body !== "object" || !("models" in body) || !Array.isArray(body.models)) {
		throw new Error("Codex model catalog has no models array");
	}
	const windows = new Map<string, number>();
	for (const model of body.models) {
		if (!model || typeof model !== "object" || typeof model.slug !== "string") continue;
		const window = positiveInteger(model.max_context_window) ? model.max_context_window : model.context_window;
		if (positiveInteger(window)) windows.set(model.slug, window);
	}
	if (!windows.size) throw new Error("Codex model catalog has no usable context windows");
	return windows;
}

export function applyContextWindows<T extends { id: string; contextWindow: number }>(
	models: T[],
	windows: ReadonlyMap<string, number>,
): T[] {
	return models.map((model) => ({ ...model, contextWindow: windows.get(model.id) ?? model.contextWindow }));
}

export function errorDetail(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}

/**
 * The last catalog fetched per account, so aliases can register their real windows when the
 * extension loads, before any session exists - as the Anthropic aliases do with their static
 * catalogue. A host that freezes providers after load (PI WEB's session daemon) ignores the
 * re-registration a session-start sync makes; the windows have to be right the first time.
 * A separate file: the shared account store stays read-only here.
 */
export function catalogCacheFile(): string {
	return join(getAgentDir(), "pi-multi-account-codex-catalog.json");
}

export function readCachedCatalogs(file: string = catalogCacheFile()): Map<string, ContextCatalog> {
	const catalogs = new Map<string, ContextCatalog>();
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as { accounts?: Record<string, { windows?: Record<string, unknown> }> };
		for (const [accountId, entry] of Object.entries(raw.accounts ?? {})) {
			const windows = new Map(
				Object.entries(entry.windows ?? {}).filter((pair): pair is [string, number] => positiveInteger(pair[1])),
			);
			if (windows.size > 0) catalogs.set(accountId, { accountId, windows });
		}
	} catch {
		// No cache yet, or an unreadable one: the catalog is fetched instead.
	}
	return catalogs;
}

/**
 * Merge fresh catalogs into the cache; the write is a rename, so a concurrent reader never sees half a
 * file. Two writers can still race and the last rename wins, which costs the loser one fetch at the next
 * load: this is a cache, not a store, and a lock would put the shared account store's lock on a path that
 * does not need it.
 */
export async function writeCachedCatalogs(
	fresh: ReadonlyMap<string, ContextCatalog>,
	file: string = catalogCacheFile(),
): Promise<void> {
	if (fresh.size === 0) return;
	const merged = new Map([...readCachedCatalogs(file), ...fresh]);
	const accounts = Object.fromEntries(
		[...merged].map(([accountId, catalog]) => [accountId, { windows: Object.fromEntries(catalog.windows) }]),
	);
	await mkdir(dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`, "utf8");
		await rename(temp, file);
	} catch (error) {
		await rm(temp, { force: true }).catch(() => undefined);
		throw error;
	}
}

/** Redirects are refused so the bearer token is never replayed to another origin. */
export async function fetchContextCatalog(access: string, request: typeof fetch = fetch, timeoutMs = 8000): Promise<ContextCatalog> {
	const accountId = accountIdOf(access);
	if (!accountId) throw new Error("Codex token has no account identity");
	const response = await request(`${BASE_URL}/codex/models?client_version=${encodeURIComponent(codexClientVersion())}`, {
		headers: { Authorization: `Bearer ${access}`, "ChatGPT-Account-Id": accountId },
		signal: AbortSignal.timeout(timeoutMs),
		redirect: "error",
	});
	if (!response.ok) throw new Error(`Codex model catalog request failed (${response.status})`);
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new Error("Codex model catalog returned invalid JSON");
	}
	return { accountId, windows: contextWindows(body) };
}
