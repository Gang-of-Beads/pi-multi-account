/**
 * The one thing Anthropic's tool validator refuses, removed on the way out.
 *
 * Anthropic rejects `minimum`/`maximum` on an `integer` property outright:
 *
 *   400 tools.44.custom: For 'integer' type, properties maximum, minimum are
 *   not supported
 *
 * and one bounded property anywhere in the tool list fails the whole request -
 * the assistant message never arrives, so the session looks stuck rather than
 * broken. The bounds are declared by whoever writes the tool: our own tools,
 * other extensions, MCP servers. Fixing each declaration is whack-a-mole, and
 * an npm-installed extension cannot be fixed locally at all.
 *
 * It lives here, and not in a host-level extension, because the rule is
 * Anthropic's: every provider this extension registers is an Anthropic one, so
 * stripping in the pool's stream wrapper is exactly as wide as the rule - and
 * OpenAI/Gemini requests, which accept the bounds, keep them.
 *
 * The mutation is IN PLACE and at every level. pi-ai reads tool schemas off the
 * system messages it is about to convert, so replacing a schema object would
 * leave the request on the old one, while mutating the nodes themselves reaches
 * the wire. Idempotent, which is what makes a per-request sweep free.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SCHEMA_VALUE_KEYS = ["properties", "patternProperties", "$defs", "definitions"];
const SCHEMA_LIST_KEYS = ["allOf", "anyOf", "oneOf", "prefixItems"];
const SCHEMA_CHILD_KEYS = ["items", "additionalProperties", "not", "contains", "propertyNames"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** How many keywords were removed, so a caller can tell a rewrite from a no-op. */
export function stripRefusedBounds(node: unknown): number {
	if (Array.isArray(node)) {
		let removed = 0;
		for (const entry of node) removed += stripRefusedBounds(entry);
		return removed;
	}
	if (!isRecord(node)) return 0;

	let removed = 0;
	if (node["type"] === "integer") {
		if (node["minimum"] !== undefined) { delete node["minimum"]; removed += 1; }
		if (node["maximum"] !== undefined) { delete node["maximum"]; removed += 1; }
		if (node["exclusiveMinimum"] !== undefined) { delete node["exclusiveMinimum"]; removed += 1; }
		if (node["exclusiveMaximum"] !== undefined) { delete node["exclusiveMaximum"]; removed += 1; }
		if (node["multipleOf"] !== undefined) { delete node["multipleOf"]; removed += 1; }
	}
	for (const key of SCHEMA_VALUE_KEYS) {
		const bag = node[key];
		if (!isRecord(bag)) continue;
		for (const value of Object.values(bag)) removed += stripRefusedBounds(value);
	}
	for (const key of SCHEMA_LIST_KEYS) removed += stripRefusedBounds(node[key]);
	for (const key of SCHEMA_CHILD_KEYS) removed += stripRefusedBounds(node[key]);
	return removed;
}

/**
 * Sweep the tool declarations riding on a request's messages.
 *
 * pi-ai collects the tools for a request from `toolsAdded` on system messages
 * ({@link getCurrentTools}), so that is where the schemas that reach the wire
 * live - not on the session's registered definitions.
 */
export function stripRefusedBoundsInMessages(messages: unknown): number {
	if (!Array.isArray(messages)) return 0;
	let removed = 0;
	for (const message of messages) {
		if (!isRecord(message)) continue;
		if (message["role"] !== "system") continue;
		const added = message["toolsAdded"];
		if (!Array.isArray(added)) continue;
		for (const tool of added) {
			if (!isRecord(tool)) continue;
			removed += stripRefusedBounds(tool["parameters"]);
		}
	}
	return removed;
}

/**
 * The registered tool definitions, for the hosts that never reach the stream.
 *
 * The stream wrapper is the right place for a request that goes through this
 * extension's provider - but pi 0.87's CLI resolves and sends without ever
 * calling it, so a strip placed only there leaves `pi -p --model
 * anthropic/...` failing. Sweeping the definitions at session start covers
 * that path too: the prompt's tool declarations are built from them afterwards.
 */
export function stripRefusedBoundsInTools(tools: readonly { parameters?: unknown }[]): number {
	let removed = 0;
	for (const tool of tools) removed += stripRefusedBounds(tool.parameters);
	return removed;
}

/** Providers whose endpoint runs the validator this module works around. */
export function isAnthropicProvider(provider: string | undefined): boolean {
	return provider === "anthropic" || (provider?.startsWith("anthropic-") ?? false);
}

/**
 * The active account's access token, read straight from the store file.
 *
 * pi 0.87's one-shot CLI streams at the API level - it never reaches a provider
 * object - so the only thing that decides whether a pooled request works there
 * is the key pi resolves: an OAuth token must arrive as a bearer token, and a
 * literal placeholder sent as `x-api-key` is a 401 that pi retries silently
 * until the command looks hung. Reading synchronously keeps registration
 * synchronous, which is what lets `pi -p --model anthropic/...` resolve before
 * the first session runs.
 */
export function activeAnthropicToken(): string | undefined {
	const path = join(process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "pi-accounts.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
	const providers = (parsed as { providers?: Record<string, { active?: string; accounts?: Record<string, { access?: unknown }> }> }).providers;
	const state = providers?.["anthropic"];
	const access = state?.active === undefined ? undefined : state.accounts?.[state.active]?.access;
	return typeof access === "string" && access.length > 0 ? access : undefined;
}
