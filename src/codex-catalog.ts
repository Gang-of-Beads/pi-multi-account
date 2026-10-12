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
import { BASE_URL } from "./codex-shared.ts";

/** Codex discovery is version-gated; older clients receive an incomplete catalog. */
const CODEX_CLIENT_VERSION = "0.154.0";

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

/** Redirects are refused so the bearer token is never replayed to another origin. */
export async function fetchContextCatalog(access: string, request: typeof fetch = fetch): Promise<ContextCatalog> {
	const accountId = accountIdOf(access);
	if (!accountId) throw new Error("Codex token has no account identity");
	const response = await request(`${BASE_URL}/codex/models?client_version=${CODEX_CLIENT_VERSION}`, {
		headers: { Authorization: `Bearer ${access}`, "ChatGPT-Account-Id": accountId },
		signal: AbortSignal.timeout(8000),
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
