import { randomUUID } from "node:crypto";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	ImageContent,
	Message,
	Model,
	Api,
	SimpleStreamOptions,
	Tool,
	ToolCall,
	Usage,
} from "@earendil-works/pi-ai";
import { record, positive } from "../core/storage.ts";
import { errorMessage } from "../core/routes.ts";
import { GatewayError } from "./access.ts";

export type Protocol = "messages" | "chat" | "responses";
export const protocolOf = (api: string): Protocol | undefined =>
	api === "anthropic-messages"
		? "messages"
		: api === "openai-completions"
			? "chat"
			: ["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(api)
				? "responses"
				: undefined;
export const object = (value: unknown): Record<string, unknown> => {
	if (!record(value)) throw new GatewayError(400, "Expected a JSON object", "invalid_request_error");
	return value;
};
const list = (value: unknown): unknown[] => {
	if (!Array.isArray(value)) throw new GatewayError(400, "Expected an array", "invalid_request_error");
	return value;
};
const text = (value: unknown): string => {
	if (typeof value !== "string") throw new GatewayError(400, "Expected a string", "invalid_request_error");
	return value;
};
function image(url: unknown): ImageContent {
	const match = text(url).match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
	if (!match || match[2].length % 4 !== 0)
		throw new GatewayError(
			400,
			"Cross-protocol images require a base64 data URL; remote URLs and file IDs require a native route",
			"unsupported_translation",
		);
	return { type: "image", mimeType: match[1], data: match[2] };
}
function parts(value: unknown): (import("@earendil-works/pi-ai").TextContent | ImageContent)[] {
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (value === null || value === undefined) return [];
	return list(value).map((raw) => {
		const p = object(raw);
		if (["text", "input_text", "output_text"].includes(String(p.type))) return { type: "text" as const, text: text(p.text) };
		if (p.type === "image_url") return image(object(p.image_url).url);
		if (p.type === "input_image") return image(p.image_url);
		if (p.type === "image") {
			const source = object(p.source);
			if (source.type !== "base64") throw new GatewayError(400, "Only base64 image blocks can be translated", "unsupported_translation");
			return image(`data:${text(source.media_type)};base64,${text(source.data)}`);
		}
		throw new GatewayError(400, `Cannot translate content block: ${String(p.type)}`, "unsupported_translation");
	});
}
const toolName = (value: unknown): string => {
	const name = text(value);
	if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(name)) throw new GatewayError(400, "Invalid tool name");
	return name;
};
function toolsOf(raw: unknown, proto: Protocol): Tool[] | undefined {
	if (raw === undefined) return undefined;
	return list(raw).map((r) => {
		const t = object(r);
		const f = proto === "chat" ? object(t.function) : t;
		if ((proto !== "messages" && t.type !== "function") || (proto === "messages" && t.type !== undefined && t.type !== "custom"))
			throw new GatewayError(400, "Native server tools require a native protocol route", "unsupported_translation");
		return {
			name: toolName(f.name),
			description: f.description === undefined ? "" : text(f.description),
			parameters: object(
				(proto === "messages" ? f.input_schema : f.parameters) ?? { type: "object", properties: {} },
			) as Tool["parameters"],
			...(f.strict === true ? { constrainedSampling: { type: "json_schema" as const, strict: "require" as const } } : {}),
		};
	});
}
function call(id: unknown, name: unknown, args: unknown): ToolCall {
	let parsed: unknown = args;
	if (typeof args === "string") {
		try {
			parsed = JSON.parse(args);
		} catch {
			throw new GatewayError(400, "Invalid function-call arguments");
		}
	}
	return { type: "toolCall", id: text(id), name: toolName(name), arguments: object(parsed) as ToolCall["arguments"] };
}
function assistant(model: Model<Api>, content: AssistantMessage["content"]): AssistantMessage {
	return {
		...errorMessage(model, ""),
		content,
		stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop",
		errorMessage: undefined,
	};
}

/** Translation is deliberately stateless. Opaque/stateful inputs must stay on a native wire. */
export function decodeRequest(
	proto: Protocol,
	body: Record<string, unknown>,
	model: Model<Api>,
): { context: Context; options: SimpleStreamOptions } {
	if (body.previous_response_id || body.conversation || body.background || body.store === true || body.truncation === "auto")
		throw new GatewayError(400, "Stateful or background Responses requests require a native Responses route", "unsupported_translation");
	const allowed = new Set([
		"model",
		"stream",
		"messages",
		"input",
		"instructions",
		"system",
		"tools",
		"tool_choice",
		"max_tokens",
		"max_completion_tokens",
		"max_output_tokens",
		"temperature",
		"top_p",
		"reasoning",
		"thinking",
		"output_config",
		"stream_options",
		"store",
		"parallel_tool_calls",
		"service_tier",
	]);
	for (const key of Object.keys(body))
		if (!allowed.has(key)) throw new GatewayError(400, `Field ${key} is not supported on a translated route`, "unsupported_translation");
	const targetProtocol = protocolOf(model.api);
	if (
		(body.top_p !== undefined || body.parallel_tool_calls !== undefined || body.service_tier !== undefined) &&
		targetProtocol === undefined
	)
		throw new GatewayError(400, "Sampling/tier overrides require a compatible target protocol", "unsupported_translation");
	if (body.top_p !== undefined && (typeof body.top_p !== "number" || !Number.isFinite(body.top_p) || body.top_p < 0 || body.top_p > 1))
		throw new GatewayError(400, "Invalid top_p");
	if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== "boolean")
		throw new GatewayError(400, "Invalid parallel_tool_calls");
	if (body.service_tier !== undefined && (typeof body.service_tier !== "string" || targetProtocol === "messages"))
		throw new GatewayError(400, "service_tier cannot be translated to this target", "unsupported_translation");
	for (const name of ["reasoning", "thinking", "output_config", "stream_options"])
		if (body[name] !== undefined && !record(body[name])) throw new GatewayError(400, `Invalid ${name}`);
	for (const [name, fields] of Object.entries({
		reasoning: ["effort"],
		output_config: ["effort"],
		thinking: ["type", "budget_tokens"],
		stream_options: ["include_usage"],
	})) {
		const nested = body[name];
		if (record(nested) && Object.keys(nested).some((key) => !fields.includes(key)))
			throw new GatewayError(400, `Unsupported translated field in ${name}`, "unsupported_translation");
	}
	if (
		record(body.stream_options) &&
		body.stream_options.include_usage !== undefined &&
		typeof body.stream_options.include_usage !== "boolean"
	)
		throw new GatewayError(400, "Invalid include_usage flag");
	const messages: Message[] = [];
	const timestamp = Date.now();
	let systemPrompt = body.instructions === undefined ? undefined : text(body.instructions);
	if (body.system !== undefined)
		systemPrompt = parts(body.system)
			.map((p) =>
				p.type === "text"
					? p.text
					: (() => {
							throw new GatewayError(400, "An image cannot be system instructions");
						})(),
			)
			.join("\n");
	const names = new Map<string, string>();
	const result = (id: unknown, content: unknown, isError = false) => {
		const callId = text(id);
		messages.push({
			role: "toolResult",
			toolCallId: callId,
			toolName: names.get(callId) ?? "tool",
			content: parts(content),
			isError,
			timestamp,
		});
	};
	if (proto === "chat") {
		for (const raw of list(body.messages)) {
			const m = object(raw);
			if (m.role === "system" || m.role === "developer")
				messages.push({
					role: "system",
					content: parts(m.content)
						.map((p) => (p.type === "text" ? p.text : ""))
						.join("\n"),
					timestamp,
				});
			else if (m.role === "user") messages.push({ role: "user", content: parts(m.content), timestamp });
			else if (m.role === "tool") result(m.tool_call_id, m.content);
			else if (m.role === "assistant") {
				const content: AssistantMessage["content"] = parts(m.content).map((p) => {
					if (p.type !== "text") throw new GatewayError(400, "Assistant images cannot be translated");
					return p;
				});
				if (typeof m.reasoning_content === "string") content.unshift({ type: "thinking", thinking: m.reasoning_content });
				for (const rawCall of m.tool_calls === undefined ? [] : list(m.tool_calls)) {
					const c = object(rawCall);
					const f = object(c.function);
					const parsed = call(c.id, f.name, f.arguments);
					names.set(parsed.id, parsed.name);
					content.push(parsed);
				}
				messages.push(assistant(model, content));
			} else throw new GatewayError(400, "Unsupported chat role");
		}
	} else if (proto === "messages") {
		for (const raw of list(body.messages)) {
			const m = object(raw);
			if (m.role !== "user" && m.role !== "assistant") throw new GatewayError(400, "Invalid Messages role");
			const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : list(m.content);
			let content: AssistantMessage["content"] = [];
			let user: (import("@earendil-works/pi-ai").TextContent | ImageContent)[] = [];
			const flush = () => {
				if (user.length) {
					messages.push({ role: "user", content: user, timestamp });
					user = [];
				}
			};
			for (const rawBlock of blocks) {
				const b = object(rawBlock);
				if (b.type === "tool_result") {
					if (m.role !== "user") throw new GatewayError(400, "tool_result must have the user role");
					flush();
					result(b.tool_use_id, b.content, b.is_error === true);
				} else if (b.type === "tool_use") {
					if (m.role !== "assistant") throw new GatewayError(400, "tool_use must have the assistant role");
					const c = call(b.id, b.name, b.input);
					names.set(c.id, c.name);
					content.push(c);
				} else if (b.type === "thinking") {
					if (b.signature) throw new GatewayError(400, "Signed thinking must stay on a native Messages route", "unsupported_translation");
					content.push({ type: "thinking", thinking: text(b.thinking) });
				} else if (m.role === "assistant") {
					for (const p of parts([b])) {
						if (p.type !== "text") throw new GatewayError(400, "Assistant images cannot be translated");
						content.push(p);
					}
				} else user.push(...parts([b]));
			}
			if (m.role === "assistant") messages.push(assistant(model, content));
			else flush();
		}
	} else {
		const input = typeof body.input === "string" ? [{ type: "message", role: "user", content: body.input }] : list(body.input);
		for (const raw of input) {
			const item = object(raw);
			if (item.type === "function_call") {
				const c = call(item.call_id, item.name, item.arguments);
				names.set(c.id, c.name);
				messages.push(assistant(model, [c]));
			} else if (item.type === "function_call_output") result(item.call_id, item.output);
			else if (item.type === "reasoning") {
				const summaryParts = list(item.summary ?? []);
				if (item.encrypted_content || (item.id && !summaryParts.some((p) => record(p) && typeof p.text === "string" && p.text.trim())))
					throw new GatewayError(400, "Opaque reasoning must stay on its native Responses route", "unsupported_translation");
				const summary = summaryParts.map((s) => text(object(s).text)).join("\n");
				messages.push(assistant(model, [{ type: "thinking", thinking: summary }]));
			} else if (item.type === "message" || item.type === undefined) {
				if (item.role === "system" || item.role === "developer")
					messages.push({
						role: "system",
						content: parts(item.content)
							.map((p) => (p.type === "text" ? p.text : ""))
							.join("\n"),
						timestamp,
					});
				else if (item.role === "user") messages.push({ role: "user", content: parts(item.content), timestamp });
				else if (item.role === "assistant")
					messages.push(
						assistant(
							model,
							parts(item.content).map((p) => {
								if (p.type !== "text") throw new GatewayError(400, "Assistant images cannot be translated");
								return p;
							}),
						),
					);
				else throw new GatewayError(400, "Unsupported Responses role");
			} else throw new GatewayError(400, `Cannot translate Responses item ${String(item.type)}`, "unsupported_translation");
		}
	}
	if (!messages.length) throw new GatewayError(400, "A request needs messages or input");
	let reasoning: SimpleStreamOptions["reasoning"];
	const effort = record(body.reasoning) ? body.reasoning.effort : record(body.output_config) ? body.output_config.effort : undefined;
	if (effort !== undefined && !["none", "off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(effort)))
		throw new GatewayError(400, "Unsupported reasoning effort");
	if (effort && effort !== "off" && effort !== "none") reasoning = effort as SimpleStreamOptions["reasoning"];
	if (record(body.thinking) && body.thinking.type !== "disabled") {
		if (body.thinking.type === "enabled" && positive(body.thinking.budget_tokens))
			reasoning = body.thinking.budget_tokens > 16_384 ? "high" : "medium";
		else if (body.thinking.type !== "adaptive") throw new GatewayError(400, "Unsupported thinking mode");
	}
	const max = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens;
	if (max !== undefined && !positive(max)) throw new GatewayError(400, "Invalid output token limit");
	if (
		body.temperature !== undefined &&
		(typeof body.temperature !== "number" || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)
	)
		throw new GatewayError(400, "Invalid temperature");
	const choice =
		record(body.tool_choice) && (body.tool_choice.type === "auto" || body.tool_choice.type === "none")
			? body.tool_choice.type
			: body.tool_choice;
	if (choice !== undefined && choice !== "auto" && choice !== "none")
		throw new GatewayError(400, "Forced tool choices require a native route", "unsupported_translation");
	return {
		context: { systemPrompt, messages, tools: toolsOf(body.tools, proto) },
		options: {
			reasoning,
			maxTokens: max === undefined ? undefined : Math.min(max as number, model.maxTokens),
			temperature: body.temperature as number | undefined,
			toolChoice: choice as "auto" | "none" | undefined,
			transport: "sse",
			maxRetries: 0,
			onPayload: (payload) => {
				if (record(payload)) {
					if (body.top_p !== undefined) payload.top_p = body.top_p;
					if (body.service_tier !== undefined) payload.service_tier = body.service_tier;
					if (body.store === false && targetProtocol === "responses") payload.store = false;
					if (body.parallel_tool_calls !== undefined) {
						if (targetProtocol === "messages")
							payload.tool_choice = { type: choice ?? "auto", disable_parallel_tool_use: !body.parallel_tool_calls };
						else payload.parallel_tool_calls = body.parallel_tool_calls;
					}
				}
				return payload;
			},
		},
	};
}

export const publicUsage = (u: Usage) => ({
	input_tokens: u.input + u.cacheRead + u.cacheWrite,
	output_tokens: u.output,
	total_tokens: u.totalTokens,
	input_tokens_details: { cached_tokens: u.cacheRead },
	output_tokens_details: { reasoning_tokens: u.reasoning ?? 0 },
});
const chatUsage = (u: Usage) => ({
	prompt_tokens: u.input + u.cacheRead + u.cacheWrite,
	completion_tokens: u.output,
	total_tokens: u.totalTokens,
	prompt_tokens_details: { cached_tokens: u.cacheRead },
	completion_tokens_details: { reasoning_tokens: u.reasoning ?? 0 },
});
const stop = (m: AssistantMessage, proto: Protocol) =>
	m.stopReason === "toolUse"
		? proto === "messages"
			? "tool_use"
			: "tool_calls"
		: m.stopReason === "length"
			? proto === "messages"
				? "max_tokens"
				: "length"
			: proto === "messages"
				? "end_turn"
				: "stop";
function responseItems(m: AssistantMessage, id: string): Record<string, unknown>[] {
	return m.content.map((c, index) =>
		c.type === "toolCall"
			? {
					type: "function_call",
					id: `fc_${id}_${index}`,
					call_id: c.id,
					name: c.name,
					arguments: JSON.stringify(c.arguments),
					status: "completed",
				}
			: c.type === "thinking"
				? { type: "reasoning", id: `rs_${id}_${index}`, summary: [{ type: "summary_text", text: c.thinking }] }
				: {
						type: "message",
						id: `msg_${id}_${index}`,
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: c.text, annotations: [] }],
					},
	);
}
export function encodeResponse(proto: Protocol, m: AssistantMessage, model: string, id = randomUUID().replaceAll("-", "")): object {
	if (proto === "messages")
		return {
			id: `msg_${id}`,
			type: "message",
			role: "assistant",
			model,
			content: m.content.map((c) =>
				c.type === "toolCall"
					? { type: "tool_use", id: c.id, name: c.name, input: c.arguments }
					: c.type === "thinking"
						? { type: "thinking", thinking: c.thinking, signature: m.api === "anthropic-messages" ? (c.thinkingSignature ?? "") : "" }
						: { type: "text", text: c.text },
			),
			stop_reason: stop(m, proto),
			stop_sequence: null,
			usage: {
				input_tokens: m.usage.input,
				output_tokens: m.usage.output,
				cache_read_input_tokens: m.usage.cacheRead,
				cache_creation_input_tokens: m.usage.cacheWrite,
			},
		};
	if (proto === "chat")
		return {
			id: `chatcmpl-${id}`,
			object: "chat.completion",
			created: Math.floor(m.timestamp / 1000),
			model,
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content:
							m.content
								.filter((c) => c.type === "text")
								.map((c) => c.text)
								.join("") || null,
						...(m.content.some((c) => c.type === "thinking")
							? {
									reasoning_content: m.content
										.filter((c) => c.type === "thinking")
										.map((c) => c.thinking)
										.join(""),
								}
							: {}),
						...(m.content.some((c) => c.type === "toolCall")
							? {
									tool_calls: m.content
										.filter((c) => c.type === "toolCall")
										.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })),
								}
							: {}),
					},
					finish_reason: stop(m, proto),
				},
			],
			usage: chatUsage(m.usage),
		};
	return {
		id: `resp_${id}`,
		object: "response",
		created_at: Math.floor(m.timestamp / 1000),
		status: m.stopReason === "length" ? "incomplete" : "completed",
		model,
		output: responseItems(m, id),
		usage: publicUsage(m.usage),
		...(m.stopReason === "length" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
	};
}

/** Encoders preserve event ordering, content indexes and incremental function-call arguments. */
export class ProtocolEncoder {
	readonly id = randomUUID().replaceAll("-", "");
	private sequence = 0;
	private readonly created = Math.floor(Date.now() / 1000);
	private started = false;
	private toolIndexes = new Map<number, number>();
	constructor(
		readonly proto: Protocol,
		readonly model: string,
		readonly includeUsage = false,
	) {}
	private frame(event: string | undefined, data: object | string): string {
		return `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
	}
	private response(event: string, data: object): string {
		return this.frame(event, { type: event, sequence_number: this.sequence++, ...data });
	}
	private chunk(delta: object, finish: string | null = null): string {
		return this.frame(undefined, {
			id: `chatcmpl-${this.id}`,
			object: "chat.completion.chunk",
			created: this.created,
			model: this.model,
			choices: [{ index: 0, delta, finish_reason: finish }],
		});
	}
	encode(event: AssistantMessageEvent): string {
		if (event.type === "error")
			return this.frame(this.proto === "chat" ? undefined : "error", {
				type: "error",
				error: { type: "api_error", message: "Upstream stream failed; no automatic replay after output" },
			});
		let out = "";
		if (!this.started) {
			const initial = event.type === "done" ? event.message : event.partial;
			this.started = true;
			if (this.proto === "messages")
				out += this.frame("message_start", {
					type: "message_start",
					message: {
						id: `msg_${this.id}`,
						type: "message",
						role: "assistant",
						model: this.model,
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: {
							input_tokens: initial.usage.input,
							output_tokens: 0,
							cache_read_input_tokens: initial.usage.cacheRead,
							cache_creation_input_tokens: initial.usage.cacheWrite,
						},
					},
				});
			else if (this.proto === "chat") out += this.chunk({ role: "assistant" });
			else {
				const response = {
					id: `resp_${this.id}`,
					object: "response",
					created_at: this.created,
					status: "in_progress",
					model: this.model,
					output: [],
				};
				out += this.response("response.created", { response });
				out += this.response("response.in_progress", { response });
			}
		}
		if (event.type === "start") return out;
		if (event.type === "done") {
			if (this.proto === "messages")
				return (
					out +
					this.frame("message_delta", {
						type: "message_delta",
						delta: { stop_reason: stop(event.message, this.proto), stop_sequence: null },
						usage: {
							input_tokens: event.message.usage.input,
							output_tokens: event.message.usage.output,
							cache_read_input_tokens: event.message.usage.cacheRead,
							cache_creation_input_tokens: event.message.usage.cacheWrite,
						},
					}) +
					this.frame("message_stop", { type: "message_stop" })
				);
			if (this.proto === "chat")
				return (
					out +
					this.chunk({}, stop(event.message, this.proto)) +
					(this.includeUsage
						? this.frame(undefined, {
								id: `chatcmpl-${this.id}`,
								object: "chat.completion.chunk",
								created: this.created,
								model: this.model,
								choices: [],
								usage: chatUsage(event.message.usage),
							})
						: "") +
					this.frame(undefined, "[DONE]")
				);
			return (
				out +
				this.response(event.message.stopReason === "length" ? "response.incomplete" : "response.completed", {
					response: encodeResponse("responses", event.message, this.model, this.id),
				})
			);
		}
		const index = "contentIndex" in event ? event.contentIndex : 0;
		const content = "partial" in event ? event.partial.content[index] : undefined;
		if (this.proto === "chat") {
			if (event.type === "text_delta") out += this.chunk({ content: event.delta });
			if (event.type === "thinking_delta") out += this.chunk({ reasoning_content: event.delta });
			if (event.type === "toolcall_start" && content?.type === "toolCall") {
				const i = this.toolIndexes.size;
				this.toolIndexes.set(index, i);
				out += this.chunk({
					tool_calls: [{ index: i, id: content.id, type: "function", function: { name: content.name, arguments: "" } }],
				});
			}
			if (event.type === "toolcall_delta")
				out += this.chunk({ tool_calls: [{ index: this.toolIndexes.get(index), function: { arguments: event.delta } }] });
			return out;
		}
		if (this.proto === "messages") {
			if (event.type === "text_start" || event.type === "thinking_start" || event.type === "toolcall_start")
				out += this.frame("content_block_start", {
					type: "content_block_start",
					index,
					content_block:
						event.type === "text_start"
							? { type: "text", text: "" }
							: event.type === "thinking_start"
								? { type: "thinking", thinking: "" }
								: {
										type: "tool_use",
										id: content?.type === "toolCall" ? content.id : "",
										name: content?.type === "toolCall" ? content.name : "",
										input: {},
									},
				});
			if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta")
				out += this.frame("content_block_delta", {
					type: "content_block_delta",
					index,
					delta:
						event.type === "text_delta"
							? { type: "text_delta", text: event.delta }
							: event.type === "thinking_delta"
								? { type: "thinking_delta", thinking: event.delta }
								: { type: "input_json_delta", partial_json: event.delta },
				});
			if (event.type === "text_end" || event.type === "thinking_end" || event.type === "toolcall_end") {
				if (
					event.type === "thinking_end" &&
					event.partial.api === "anthropic-messages" &&
					content?.type === "thinking" &&
					content.thinkingSignature
				)
					out += this.frame("content_block_delta", {
						type: "content_block_delta",
						index,
						delta: { type: "signature_delta", signature: content.thinkingSignature },
					});
				out += this.frame("content_block_stop", { type: "content_block_stop", index });
			}
			return out;
		}
		const itemId = `${content?.type === "toolCall" ? "fc" : content?.type === "thinking" ? "rs" : "msg"}_${this.id}_${index}`;
		if (event.type === "text_start" || event.type === "thinking_start" || event.type === "toolcall_start") {
			const item =
				content?.type === "toolCall"
					? { type: "function_call", id: itemId, call_id: content.id, name: content.name, arguments: "", status: "in_progress" }
					: content?.type === "thinking"
						? { type: "reasoning", id: itemId, summary: [] }
						: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] };
			out += this.response("response.output_item.added", { output_index: index, item });
			if (event.type === "text_start")
				out += this.response("response.content_part.added", {
					output_index: index,
					item_id: itemId,
					content_index: 0,
					part: { type: "output_text", text: "", annotations: [] },
				});
			if (event.type === "thinking_start")
				out += this.response("response.reasoning_summary_part.added", {
					output_index: index,
					item_id: itemId,
					summary_index: 0,
					part: { type: "summary_text", text: "" },
				});
		}
		if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta")
			out += this.response(
				event.type === "text_delta"
					? "response.output_text.delta"
					: event.type === "thinking_delta"
						? "response.reasoning_summary_text.delta"
						: "response.function_call_arguments.delta",
				{ item_id: itemId, output_index: index, content_index: 0, summary_index: 0, delta: event.delta },
			);
		if (event.type === "text_end" || event.type === "thinking_end" || event.type === "toolcall_end") {
			if (content?.type === "text") {
				out += this.response("response.output_text.done", { item_id: itemId, output_index: index, content_index: 0, text: content.text });
				out += this.response("response.content_part.done", {
					item_id: itemId,
					output_index: index,
					content_index: 0,
					part: { type: "output_text", text: content.text, annotations: [] },
				});
			}
			if (content?.type === "thinking") {
				out += this.response("response.reasoning_summary_text.done", {
					item_id: itemId,
					output_index: index,
					summary_index: 0,
					text: content.thinking,
				});
				out += this.response("response.reasoning_summary_part.done", {
					item_id: itemId,
					output_index: index,
					summary_index: 0,
					part: { type: "summary_text", text: content.thinking },
				});
			}
			if (content?.type === "toolCall")
				out += this.response("response.function_call_arguments.done", {
					item_id: itemId,
					output_index: index,
					name: content.name,
					arguments: JSON.stringify(content.arguments),
				});
			out += this.response("response.output_item.done", { output_index: index, item: responseItems(event.partial, this.id)[index] });
		}
		return out;
	}
}
