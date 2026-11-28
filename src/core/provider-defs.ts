/**
 * User-defined providers: an endpoint someone else runs, offered the way a built-in provider is.
 *
 * The built-in four (Anthropic, Codex, xAI, Copilot) are a closed set: their catalogues are
 * discovered by their own rules and their accounts carry OAuth tokens. A relay, a self-hosted
 * gateway or a vendor nobody has wired yet needs the opposite — a plain definition the user
 * writes: where it is, which API shape it speaks, how a key reaches it, and which models it has.
 *
 * Definitions are data, never code, and live in the agent directory next to the account store so
 * the gateway and the extension read the same list. Everything routes through them like any other
 * provider (`pma/<route>`, `relay/model`), so routing, failover, the gateway and the pi models all
 * work without a special case.
 */
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model, Provider, StreamFunction, TranscriptContext } from "@earendil-works/pi-ai";
import { streamSimple as anthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as openaiCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as openaiResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { updateJson } from "./storage.ts";

/** The API shapes a definition may speak; each one is a pi-ai transport, not a vendor. */
export const PROVIDER_APIS = ["anthropic-messages", "openai-completions", "openai-responses"] as const;
export type ProviderApi = (typeof PROVIDER_APIS)[number];

/** One transport per api shape; the api's own stream function, nothing rewritten. */
const TRANSPORTS: Readonly<Record<ProviderApi, StreamFunction>> = {
	"anthropic-messages": anthropicMessages as unknown as StreamFunction,
	"openai-responses": openaiResponses as unknown as StreamFunction,
	"openai-completions": openaiCompletions as unknown as StreamFunction,
};

export interface DefinedModel {
	id: string;
	/** Serve this model on another shape than the provider's, e.g. a relay that speaks two. */
	api?: ProviderApi;
	name?: string;
	context?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: ("text" | "image")[];
}

/** How a key reaches the endpoint. A literal key lives in the (0600) definitions file. */
export type DefinedAuth =
	| { kind: "key"; key: string }
	| { kind: "env"; env: string }
	| { kind: "none" };

export interface ProviderDefinition {
	id: string;
	/** Defaults to the id. */
	name?: string;
	api: ProviderApi;
	baseUrl: string;
	auth: DefinedAuth;
	/** Extra request headers, e.g. a vendor's client-version header. */
	headers?: Record<string, string>;
	models: DefinedModel[];
}

export interface ProviderDefsFile {
	version: 1;
	providers: ProviderDefinition[];
}

export const providerDefsPath = (agentDir: string): string => join(agentDir, "pi-multi-account-providers.json");

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Built-in ids are the four the engine owns; a definition may not shadow them. */
export const BUILTIN_PROVIDER_IDS = ["anthropic", "openai-codex", "xai", "github-copilot"] as const;

function fail(message: string): never {
	throw new Error(message);
}

function checkModel(raw: unknown, index: number): DefinedModel {
	if (!raw || typeof raw !== "object") fail(`models[${index}] must be an object`);
	const m = raw as Record<string, unknown>;
	if (typeof m["id"] !== "string" || !m["id"].trim()) fail(`models[${index}].id must be a non-empty string`);
	const context = m["context"] ?? 128_000;
	const maxTokens = m["maxTokens"] ?? 8_192;
	if (!Number.isSafeInteger(context) || (context as number) < 1_000) fail(`models[${index}].context must be an integer >= 1000`);
	if (!Number.isSafeInteger(maxTokens) || (maxTokens as number) < 1) fail(`models[${index}].maxTokens must be a positive integer`);
	if (m["name"] !== undefined && typeof m["name"] !== "string") fail(`models[${index}].name must be a string`);
	if (m["reasoning"] !== undefined && typeof m["reasoning"] !== "boolean") fail(`models[${index}].reasoning must be a boolean`);
	if (m["api"] !== undefined && !PROVIDER_APIS.includes(m["api"] as ProviderApi))
		fail(`models[${index}].api must be one of ${PROVIDER_APIS.join(", ")}`);
	const input = m["input"] ?? ["text"];
	if (!Array.isArray(input) || input.length === 0 || input.some((v) => v !== "text" && v !== "image"))
		fail(`models[${index}].input must be a non-empty list of "text" and "image"`);
	return {
		id: m["id"].trim(),
		...(typeof m["name"] === "string" ? { name: m["name"] } : {}),
		context: context as number,
		maxTokens: maxTokens as number,
		...(m["reasoning"] === true ? { reasoning: true } : {}),
		...(m["api"] === undefined ? {} : { api: m["api"] as ProviderApi }),
		input: input as ("text" | "image")[],
	};
}

/** One definition, validated. Unknown fields are refused so a typo is a load error, not a shrug. */
export function checkProviderDefinition(raw: unknown, index = 0): ProviderDefinition {
	if (!raw || typeof raw !== "object") fail(`providers[${index}] must be an object`);
	const p = raw as Record<string, unknown>;
	const id = p["id"];
	if (typeof id !== "string" || !ID.test(id)) fail(`providers[${index}].id must match ${String(ID)}`);
	if ((BUILTIN_PROVIDER_IDS as readonly string[]).includes(id)) fail(`provider id "${id}" is built in`);
	if (!PROVIDER_APIS.includes(p["api"] as ProviderApi))
		fail(`providers[${index}].api must be one of ${PROVIDER_APIS.join(", ")}`);
	const baseUrl = p["baseUrl"];
	if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) fail(`providers[${index}].baseUrl must be an http(s) URL`);
	const auth = p["auth"];
	let checkedAuth: DefinedAuth;
	if (!auth || typeof auth !== "object") fail(`providers[${index}].auth must be an object`);
	const a = auth as Record<string, unknown>;
	if (a["kind"] === "key" && typeof a["key"] === "string" && a["key"].trim()) checkedAuth = { kind: "key", key: a["key"].trim() };
	else if (a["kind"] === "env" && typeof a["env"] === "string" && /^[A-Z0-9_]+$/.test(a["env"])) checkedAuth = { kind: "env", env: a["env"] };
	else if (a["kind"] === "none") checkedAuth = { kind: "none" };
	else fail(`providers[${index}].auth must be { kind: "key", key } , { kind: "env", env } or { kind: "none" }`);
	if (p["headers"] !== undefined) {
		const h = p["headers"];
		if (!h || typeof h !== "object" || Array.isArray(h)) fail(`providers[${index}].headers must be an object`);
		for (const [name, value] of Object.entries(h)) if (typeof value !== "string") fail(`providers[${index}].headers.${name} must be a string`);
	}
	if (p["name"] !== undefined && typeof p["name"] !== "string") fail(`providers[${index}].name must be a string`);
	const models = p["models"];
	if (!Array.isArray(models) || models.length === 0) fail(`providers[${index}].models must be a non-empty list`);
	const checkedModels = models.map(checkModel);
	if (new Set(checkedModels.map((m) => m.id)).size !== checkedModels.length) fail(`providers[${index}].models has a duplicate id`);
	return {
		id,
		...(typeof p["name"] === "string" ? { name: p["name"] } : {}),
		api: p["api"] as ProviderApi,
		baseUrl,
		auth: checkedAuth,
		...(p["headers"] === undefined ? {} : { headers: { ...(p["headers"] as Record<string, string>) } }),
		models: checkedModels,
	};
}

export function parseProviderDefs(raw: unknown): ProviderDefsFile {
	const file = raw as ProviderDefsFile | undefined;
	if (!file || typeof file !== "object") fail("provider definitions must be an object");
	if (file.version !== 1) fail("provider definitions need version 1");
	if (!Array.isArray(file.providers)) fail("provider definitions need a providers list");
	const providers = file.providers.map((p, index) => checkProviderDefinition(p, index));
	if (new Set(providers.map((p) => p.id)).size !== providers.length) fail("two providers share an id");
	return { version: 1, providers };
}

/** A missing file is an empty list; an unreadable or invalid one throws so routing fails closed. */
export function readProviderDefs(agentDir: string): ProviderDefsFile {
	let text: string;
	try {
		text = readFileSync(providerDefsPath(agentDir), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, providers: [] };
		throw error;
	}
	return parseProviderDefs(JSON.parse(text) as unknown);
}

/** Whole-file write for importers and tests: validated first, then renamed into place at 0600. */
export function saveProviderDefs(agentDir: string, file: ProviderDefsFile): void {
	const path = providerDefsPath(agentDir);
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(parseProviderDefs(file), null, "\t")}\n`, { mode: 0o600 });
	chmodSync(temporary, 0o600);
	renameSync(temporary, path);
}

/** The definitions file is rewritten whole under the account store's lock. */
async function mutate(agentDir: string, update: (file: ProviderDefsFile) => ProviderDefsFile): Promise<void> {
	await updateJson<ProviderDefsFile, void>(providerDefsPath(agentDir), { version: 1, providers: [] }, (current) =>
		Promise.resolve({ value: parseProviderDefs(update(parseProviderDefs(current))), result: undefined }),
	);
}

export async function addProviderDef(agentDir: string, definition: unknown): Promise<ProviderDefinition> {
	let added: ProviderDefinition | undefined;
	await mutate(agentDir, (file) => {
		const checked = checkProviderDefinition(definition, file.providers.length);
		if (file.providers.some((p) => p.id === checked.id)) fail(`provider "${checked.id}" already exists`);
		added = checked;
		return { version: 1, providers: [...file.providers, checked] };
	});
	return added!;
}

export async function removeProviderDef(agentDir: string, id: string): Promise<boolean> {
	const before = readProviderDefs(agentDir).providers.length;
	await mutate(agentDir, (file) => ({ version: 1, providers: file.providers.filter((p) => p.id !== id) }));
	return readProviderDefs(agentDir).providers.length < before;
}

function keyOf(auth: DefinedAuth): string | undefined {
	if (auth.kind === "key") return auth.key;
	if (auth.kind === "env") return process.env[auth.env];
	return undefined;
}

/** The definition as a pi-ai provider: static models, a static key, and the transport of its api. */
export function definitionToProvider(definition: ProviderDefinition): Provider {
	const models = definition.models.map(
		(m): Model<Api> =>
			({
				id: m.id,
				name: m.name ?? m.id,
				api: m.api ?? definition.api,
				provider: definition.id,
				baseUrl: definition.baseUrl,
				input: m.input ?? ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				reasoning: m.reasoning === true,
				contextWindow: m.context ?? 128_000,
				maxTokens: m.maxTokens ?? 8_192,
				...(definition.headers ? { headers: { ...definition.headers } } : {}),
			}) as Model<Api>,
	);
	const source = `provider-def:${definition.id}`;
	return {
		id: definition.id,
		name: definition.name ?? definition.id,
		baseUrl: definition.baseUrl,
		// Even a keyless local server answers through `apiKey` auth, reporting whether it is configured.
		auth: {
			apiKey: {
				name: `${definition.id} key`,
				check: () => Promise.resolve(keyOf(definition.auth) === undefined ? undefined : { type: "api_key" as const, source }),
				resolve: () => {
					const key = keyOf(definition.auth);
					return Promise.resolve(key === undefined ? undefined : { auth: { apiKey: key }, source });
				},
			},
		},
		getModels: () => models,
		// Nothing to discover: the definition is the catalogue.
		refreshModels: () => Promise.resolve(),
		// The transport follows each model: one definition may offer models on two shapes.
		stream: (model, context, options) => TRANSPORTS[model.api as ProviderApi](model, context, options),
		streamSimple: (model, context: TranscriptContext, options) => TRANSPORTS[model.api as ProviderApi](model, context, options),
	};
}
