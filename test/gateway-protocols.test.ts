import assert from "node:assert/strict";
import { decodeRequest, encodeResponse, ProtocolEncoder, type Protocol } from "../src/gateway/protocols.ts";
import { SseInspector } from "../src/gateway/native.ts";
import type { Api, AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
const model: Model<Api> = {
	id: "test",
	name: "Test",
	provider: "test",
	api: "openai-completions",
	baseUrl: "https://example.test",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 100000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = {
	input: 10,
	output: 5,
	cacheRead: 3,
	cacheWrite: 2,
	totalTokens: 20,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const message: AssistantMessage = {
	role: "assistant",
	api: model.api,
	provider: "test",
	model: "test",
	content: [
		{ type: "text", text: "你好🙂" },
		{ type: "thinking", thinking: "reason", thinkingSignature: "foreign-signature" },
		{ type: "toolCall", id: "call_1", name: "weather", arguments: { city: "北京" } },
	],
	stopReason: "toolUse",
	timestamp: 1,
	usage,
};
{
	const chat = decodeRequest(
		"chat",
		{
			messages: [
				{ role: "system", content: "rules" },
				{ role: "user", content: "hi" },
				{ role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: '{"x":1}' } }] },
				{ role: "tool", tool_call_id: "c", content: "result" },
			],
			tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
		},
		model,
	);
	assert.equal(chat.context.messages[0].role, "system");
	assert.equal(chat.context.messages[2].role, "assistant");
	assert.deepEqual((chat.context.messages[2] as AssistantMessage).content, [{ type: "toolCall", id: "c", name: "f", arguments: { x: 1 } }]);
	assert.equal(chat.context.messages[3].role, "toolResult");
	assert.equal((chat.context.messages[3] as { toolName: string }).toolName, "f");
	assert.equal(chat.context.tools?.[0].name, "f");
	const messages = decodeRequest(
		"messages",
		{
			system: [{ type: "text", text: "rules" }],
			messages: [
				{ role: "assistant", content: [{ type: "tool_use", id: "c", name: "f", input: { n: 3 } }] },
				{
					role: "user",
					content: [
						{ type: "text", text: "before" },
						{ type: "tool_result", tool_use_id: "c", is_error: true, content: "failure" },
						{ type: "text", text: "after" },
					],
				},
			],
		},
		model,
	);
	assert.equal(messages.context.systemPrompt, "rules");
	assert.deepEqual(
		messages.context.messages.map((m) => m.role),
		["assistant", "user", "toolResult", "user"],
		"tool results preserve their position among text blocks",
	);
	assert.equal((messages.context.messages[2] as { isError: boolean }).isError, true);
	const response = decodeRequest(
		"responses",
		{
			instructions: "rules",
			input: [
				{ role: "user", content: [{ type: "input_text", text: "hi" }] },
				{ type: "function_call", call_id: "c", name: "f", arguments: "{}" },
				{ type: "function_call_output", call_id: "c", output: "answer" },
			],
			reasoning: { effort: "high" },
			max_output_tokens: 5000,
		},
		model,
	);
	assert.equal(response.context.messages[2].role, "toolResult");
	assert.equal(response.options.reasoning, "high");
	assert.equal(response.options.maxTokens, 1000, "translated output limits cannot exceed the model's ceiling");
}
{
	const image = { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } };
	assert.equal(
		(decodeRequest("chat", { messages: [{ role: "user", content: [image] }] }, model).context.messages[0].content as { type: string }[])[0]
			.type,
		"image",
	);
	const rejected: [Protocol, Record<string, unknown>][] = [
		["chat", { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "http://169.254.169.254/secret" } }] }] }],
		["responses", { input: "hi", previous_response_id: "resp_private" }],
		["responses", { input: [{ type: "reasoning", id: "rs_private", encrypted_content: "sealed" }] }],
		["responses", { input: [{ type: "message", role: "user", content: [{ type: "input_file", file_id: "file_private" }] }] }],
		["messages", { messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "sealed" }] }] }],
		["chat", { messages: [{ role: "user", content: "hi" }], response_format: { type: "json_schema" } }],
		["chat", { messages: [{ role: "user", content: "hi" }], tool_choice: "required" }],
		["chat", { messages: [{ role: "user", content: "hi" }], tools: [{ type: "web_search" }] }],
		["chat", { messages: [{ role: "user", content: "hi" }], max_tokens: -1 }],
		["chat", { messages: [{ role: "assistant", tool_calls: [{ id: "c", function: { name: "f", arguments: "{" } }] }] }],
	];
	for (const [proto, body] of rejected)
		assert.throws(
			() => decodeRequest(proto, body, model),
			(e: unknown) => (e as { status: number }).status === 400,
			`unsupported inputs are rejected, never silently discarded (${proto})`,
		);
}
{
	const chat = encodeResponse("chat", message, "public-model") as {
		model: string;
		choices: { finish_reason: string; message: { tool_calls: { function: { arguments: string } }[] } }[];
	};
	assert.equal(chat.model, "public-model");
	assert.equal(chat.choices[0].finish_reason, "tool_calls");
	assert.equal(chat.choices[0].message.tool_calls[0].function.arguments, '{"city":"北京"}');
	const responses = encodeResponse("responses", message, "route") as { output: { type: string }[]; usage: { input_tokens: number } };
	assert.deepEqual(
		responses.output.map((o) => o.type),
		["message", "reasoning", "function_call"],
	);
	assert.equal(responses.usage.input_tokens, 15);
	const anthropic = encodeResponse("messages", message, "route") as { stop_reason: string; content: { type: string }[] };
	assert.equal(anthropic.stop_reason, "tool_use");
	assert.deepEqual(
		anthropic.content.map((o) => o.type),
		["text", "thinking", "tool_use"],
	);
	assert.equal((anthropic.content[1] as { signature?: string }).signature, "", "foreign signatures are not Anthropic signatures");
	const replay = decodeRequest(
		"responses",
		{ input: [...responses.output, { type: "function_call_output", call_id: "call_1", output: "done" }] },
		model,
	);
	assert.equal(replay.context.messages.at(-1)?.role, "toolResult", "translated Responses output can be replayed with tool results");
}
{
	for (const proto of ["messages", "chat", "responses"] as const) {
		const encoder = new ProtocolEncoder(proto, "route");
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: message },
			{ type: "text_start", contentIndex: 0, partial: message },
			{ type: "text_delta", contentIndex: 0, delta: "你好🙂", partial: message },
			{ type: "text_end", contentIndex: 0, content: "你好🙂", partial: message },
			{ type: "thinking_start", contentIndex: 1, partial: message },
			{ type: "thinking_delta", contentIndex: 1, delta: "reason", partial: message },
			{ type: "thinking_end", contentIndex: 1, content: "reason", partial: message },
			{ type: "toolcall_start", contentIndex: 2, partial: message },
			{ type: "toolcall_delta", contentIndex: 2, delta: '{"city":', partial: message },
			{ type: "toolcall_delta", contentIndex: 2, delta: '"北京"}', partial: message },
			{ type: "toolcall_end", contentIndex: 2, toolCall: message.content[2] as never, partial: message },
			{ type: "done", reason: "toolUse", message },
		];
		const wire = events.map((e) => encoder.encode(e)).join("");
		assert.ok(wire.includes("你好🙂"));
		assert.ok(wire.includes("weather"));
		const frames = wire
			.split("\n\n")
			.filter(Boolean)
			.map((f) =>
				f
					.split("\n")
					.find((l) => l.startsWith("data: "))!
					.slice(6),
			)
			.filter((f) => f !== "[DONE]")
			.map((f) => JSON.parse(f));
		if (proto === "responses") {
			assert.deepEqual(
				frames.map((f) => f.sequence_number),
				frames.map((_, i) => i),
			);
			assert.equal(frames.filter((f) => f.type === "response.completed").length, 1);
			assert.deepEqual(
				frames.filter((f) => f.type === "response.output_item.added").map((f) => f.output_index),
				[0, 1, 2],
			);
			assert.equal(
				frames
					.filter((f) => f.type === "response.function_call_arguments.delta")
					.map((f) => f.delta)
					.join(""),
				'{"city":"北京"}',
			);
		} else if (proto === "messages") {
			assert.equal(frames.filter((f) => f.type === "message_start").length, 1);
			assert.equal(frames.filter((f) => f.type === "message_stop").length, 1);
			assert.deepEqual(
				frames.filter((f) => f.type === "content_block_stop").map((f) => f.index),
				[0, 1, 2],
			);
		} else {
			assert.equal(wire.split("[DONE]").length - 1, 1);
			assert.equal(frames.filter((f) => f.choices[0].delta.tool_calls).length, 3);
		}
	}
}
{
	const inspector = new SseInspector();
	const wire = Buffer.from(
		'data: {"type":"response.output_text.delta","delta":"你好🙂"}\r\n\r\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\r\n\r\n',
	);
	for (const byte of wire) inspector.feed(new Uint8Array([byte]));
	inspector.feed(new Uint8Array(), true);
	assert.equal(inspector.content, true);
	assert.equal(inspector.terminal, true);
	assert.equal(inspector.failed, false);
	assert.equal(inspector.usage.tokens, 5);
	const failed = new SseInspector();
	failed.feed(Buffer.from('data: {"type":"error","error":{"message":"bad"}}\n\n'));
	assert.equal(failed.failed, true);
}
console.log("ok: protocol translation (tools, images, thinking, rejection boundaries, SSE ordering, Unicode)");
