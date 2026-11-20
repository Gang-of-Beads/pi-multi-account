import type { PmaEngine, ResolvedTarget } from "../core/engine.ts";
import { clientVersion, chatgptAccountId } from "../core/catalog.ts";
import { withShapingOnPayload, buildUserAgent } from "../billing.ts";
import { record } from "../core/storage.ts";
import { GatewayError } from "./access.ts";
import type { Protocol } from "./protocols.ts";

export class UpstreamFailure extends GatewayError {
	constructor(
		readonly upstreamStatus: number | undefined,
		message = "Upstream request failed",
		readonly retryAfter?: number,
	) {
		super(
			upstreamStatus === 400 || upstreamStatus === 413 ? upstreamStatus : upstreamStatus === 429 ? 429 : 502,
			`${message}${upstreamStatus === undefined ? "" : ` (HTTP ${upstreamStatus})`}`,
			upstreamStatus === 429 ? "rate_limit_error" : "upstream_error",
		);
	}
}
export interface MeasuredUsage {
	input: number;
	output: number;
	tokens: number;
	known: boolean;
	inputKnown?: boolean;
	outputKnown?: boolean;
}
export const noUsage = (): MeasuredUsage => ({ input: 0, output: 0, tokens: 0, known: false });
export function measure(value: unknown): MeasuredUsage {
	if (!record(value)) return noUsage();
	const u = record(value.usage) ? value.usage : value;
	const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
	const input = n(u.input_tokens ?? u.prompt_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
	const output = n(u.output_tokens ?? u.completion_tokens);
	const valid = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0;
	const inputKnown = valid(u.input_tokens ?? u.prompt_tokens);
	const outputKnown = valid(u.output_tokens ?? u.completion_tokens);
	return { input, output, tokens: n(u.total_tokens) || input + output, known: inputKnown && outputKnown, inputKnown, outputKnown };
}

/** Inspect SSE without rewriting its bytes; a native protocol must keep opaque fields intact. */
export class SseInspector {
	private decoder = new TextDecoder();
	private pending = "";
	content = false;
	terminal = false;
	failed = false;
	usage = noUsage();
	response?: Record<string, unknown>;
	feed(chunk: Uint8Array, end = false): void {
		this.pending += this.decoder.decode(chunk, { stream: !end });
		this.pending = this.pending.replaceAll("\r\n", "\n");
		if (this.pending.length > 2 << 20) throw new UpstreamFailure(200, "Upstream sent an oversized SSE event");
		for (;;) {
			const split = this.pending.indexOf("\n\n");
			if (split < 0) break;
			const frame = this.pending.slice(0, split);
			this.pending = this.pending.slice(split + 2);
			const data = frame
				.split("\n")
				.filter((s) => s.startsWith("data:"))
				.map((s) => s.slice(5).trimStart())
				.join("\n");
			if (!data) continue;
			if (data === "[DONE]") {
				this.terminal = true;
				continue;
			}
			let event: unknown;
			try {
				event = JSON.parse(data);
			} catch {
				throw new UpstreamFailure(200, "Upstream sent invalid SSE JSON");
			}
			if (!record(event)) continue;
			const type = event.type;
			if (event.error || type === "error" || type === "response.failed" || type === "response.cancelled") this.failed = true;
			if (["message_stop", "response.completed", "response.incomplete"].includes(String(type))) this.terminal = true;
			if (record(event.response)) {
				this.response = event.response;
				this.mergeUsage(measure(event.response));
			}
			this.mergeUsage(measure(event));
			if (record(event.message)) {
				const m = measure(event.message);
				this.mergeUsage({ ...m, outputKnown: false });
			}
			if (
				type === "content_block_delta" ||
				type === "content_block_start" ||
				type === "response.output_text.delta" ||
				type === "response.reasoning_summary_text.delta" ||
				type === "response.function_call_arguments.delta"
			)
				this.content = true;
			if (type === "response.output_item.added" && record(event.item) && event.item.type === "function_call") this.content = true;
			if (Array.isArray(event.choices))
				for (const choice of event.choices)
					if (record(choice) && record(choice.delta) && (choice.delta.content || choice.delta.reasoning_content || choice.delta.tool_calls))
						this.content = true;
		}
	}
	private mergeUsage(next: MeasuredUsage): void {
		const inputKnown = next.inputKnown || this.usage.inputKnown;
		const outputKnown = next.outputKnown || this.usage.outputKnown;
		const input = next.inputKnown ? next.input : this.usage.input;
		const output = next.outputKnown ? next.output : this.usage.output;
		this.usage = { input, output, tokens: input + output, known: Boolean(inputKnown && outputKnown), inputKnown, outputKnown };
	}
}

export async function nativeRequest(
	engine: PmaEngine,
	target: ResolvedTarget,
	proto: Protocol,
	raw: Record<string, unknown>,
	signal: AbortSignal,
	request: typeof fetch = fetch,
	clientHeaders?: HeadersInit,
): Promise<Response> {
	signal.throwIfAborted();
	const auth = await engine.auth(target, signal);
	signal.throwIfAborted();
	const headers = new Headers(target.model.headers);
	for (const [name, value] of Object.entries(auth.headers ?? {})) {
		if (value === null) headers.delete(name);
		else headers.set(name, value);
	}
	if (auth.apiKey) headers.set("authorization", `Bearer ${auth.apiKey}`);
	const forwarded = new Headers(clientHeaders);
	for (const name of ["anthropic-beta", "anthropic-version", "openai-beta"]) {
		const value = forwarded.get(name);
		if (value) headers.set(name, value);
	}
	headers.set("content-type", "application/json");
	headers.set("accept", raw.stream === true ? "text/event-stream" : "application/json");
	let base = auth.baseUrl ?? target.model.baseUrl;
	let body: Record<string, unknown> = structuredClone({ ...raw, model: target.model.id });
	let path = proto === "messages" ? "/v1/messages" : proto === "chat" ? "/chat/completions" : "/responses";
	if (target.provider === "xai" && target.model.baseUrl.includes("cli-chat-proxy.grok.com")) {
		base = "https://cli-chat-proxy.grok.com/v1";
		headers.set("x-grok-client-version", clientVersion("xai"));
	}
	if (proto === "messages") {
		path = /\/v1\/?$/.test(base) ? "/messages" : "/v1/messages";
		if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
		if (auth.apiKey?.startsWith("sk-ant-oat")) {
			headers.set(
				"anthropic-beta",
				[
					...new Set([...(headers.get("anthropic-beta") ?? "").split(",").filter(Boolean), "oauth-2025-04-20", "claude-code-20250219"]),
				].join(","),
			);
			headers.set("x-app", "cli");
			headers.set("anthropic-dangerous-direct-browser-access", "true");
			headers.set("user-agent", buildUserAgent());
			const system =
				typeof body.system === "string" ? [{ type: "text", text: body.system }] : Array.isArray(body.system) ? body.system : [];
			body.system = system.some((b) => record(b) && typeof b.text === "string" && b.text.includes("You are Claude Code"))
				? system
				: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }, ...system];
			body = (await withShapingOnPayload(undefined)(body)) as typeof body;
		} else if (auth.apiKey) {
			headers.delete("authorization");
			headers.set("x-api-key", auth.apiKey);
		}
	}
	if (target.provider === "openai-codex") {
		if (body.store === true || body.background === true)
			throw new GatewayError(
				400,
				"The ChatGPT subscription backend does not support stored or background Responses",
				"unsupported_subscription_feature",
			);
		path = "/codex/responses";
		base = "https://chatgpt.com/backend-api";
		headers.set("chatgpt-account-id", chatgptAccountId(auth.apiKey) ?? "");
		headers.set("version", clientVersion("openai-codex"));
		headers.set("originator", "codex_cli_rs");
		headers.set("user-agent", `codex_cli_rs/${clientVersion("openai-codex")}`);
		headers.set("accept", "text/event-stream");
		body.stream = true;
		body.store = false;
		body.instructions ??= "";
		body.include ??= ["reasoning.encrypted_content"];
		if (typeof body.input === "string") body.input = [{ role: "user", content: [{ type: "input_text", text: body.input }] }];
		delete body.max_output_tokens;
		delete body.temperature;
		delete body.top_p;
	}
	if (target.provider === "github-copilot") {
		headers.set("copilot-integration-id", "vscode-chat");
		headers.set("editor-version", "vscode/1.104.0");
		headers.set("editor-plugin-version", "copilot-chat/0.30.0");
	}
	const url = `${base.replace(/\/$/, "")}${path}`;
	const response = await request(url, { method: "POST", headers, body: JSON.stringify(body), signal, redirect: "error" });
	if (response.status === 401 && auth.apiKey) await engine.rejected(target.provider, auth.apiKey);
	// The Codex backend can stream SSE without a Content-Type header; its SDK uses the wire contract too.
	if (response.ok && body.stream === true && !response.headers.get("content-type")) {
		const responseHeaders = new Headers(response.headers);
		responseHeaders.set("content-type", "text/event-stream");
		return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
	}
	return response;
}

export async function relayNative(
	response: Response,
	options: { streaming: boolean; signal: AbortSignal; commit: (sse: boolean) => void; write: (chunk: Uint8Array) => Promise<void> },
): Promise<MeasuredUsage> {
	if (!response.ok) {
		await response.body?.cancel();
		const retry = response.headers.get("retry-after");
		const seconds = retry ? Number(retry) || Math.ceil((Date.parse(retry) - Date.now()) / 1000) : undefined;
		throw new UpstreamFailure(
			response.status,
			"Upstream request failed",
			seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? seconds : undefined,
		);
	}
	if (!response.body) throw new UpstreamFailure(response.status, "Upstream returned no body");
	const reader = response.body.getReader();
	const inspector = new SseInspector();
	const sse = (response.headers.get("content-type") ?? "").includes("text/event-stream");
	let committed = false;
	const held: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			options.signal.throwIfAborted();
			const { done, value } = await reader.read();
			if (done) break;
			if (sse) inspector.feed(value);
			if (inspector.failed) throw new UpstreamFailure(response.status, "Upstream stream failed");
			if (!sse || !options.streaming || !committed) {
				held.push(value);
				bytes += value.length;
				if (bytes > (options.streaming ? 128 << 10 : 16 << 20)) throw new UpstreamFailure(200, "Upstream response prelude is too large");
			} else await options.write(value);
			if (sse && options.streaming && !committed && (inspector.content || inspector.terminal)) {
				options.commit(true);
				committed = true;
				for (const chunk of held) await options.write(chunk);
				held.length = 0;
			}
		}
		if (sse) {
			inspector.feed(new Uint8Array(), true);
			if (!inspector.terminal || inspector.failed)
				throw new UpstreamFailure(200, "Upstream stream ended without a successful terminal event");
			if (options.streaming) {
				if (!committed) {
					options.commit(true);
					for (const chunk of held) await options.write(chunk);
				}
			} else {
				if (!inspector.response) throw new UpstreamFailure(200, "Upstream did not return a complete Responses object");
				options.commit(false);
				await options.write(Buffer.from(JSON.stringify(inspector.response)));
			}
			return inspector.usage;
		}
		let body: unknown;
		try {
			body = JSON.parse(Buffer.concat(held).toString("utf8"));
		} catch {
			throw new UpstreamFailure(200, "Upstream returned invalid JSON");
		}
		if (!record(body) || body.error) throw new UpstreamFailure(200, "Upstream returned an error body");
		if (options.streaming) throw new UpstreamFailure(200, "Upstream did not honor streaming");
		options.commit(false);
		for (const chunk of held) await options.write(chunk);
		return measure(body);
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
