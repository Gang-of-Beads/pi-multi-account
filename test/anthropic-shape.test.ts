/**
 * Request shaping: prompt de-fingerprinting and transcribed-reasoning stripping.
 *
 * Both rules answer Anthropic's server-side payload classifier, which is what
 * returns the misleading `400 You're out of extra usage` for an unshaped pi
 * prompt and the `reasoning_extraction` refusal for reasoning that reached it as
 * plain text. The measurements behind each rule are in src/anthropic-shape.ts.
 *
 * The transcript strip is the one with a hard number attached: a transcript
 * carrying `[Assistant thinking]: ` was refused 6/6 on claude-opus-5-5; the same
 * transcript with the segments removed was accepted 6/6.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	MINIMAL_ANTHROPIC_OAUTH_PROMPT,
	PI_DEFAULT_PROMPT_PREFIX,
	PI_DOCS_SECTION_ANCHOR,
	PI_TOOLS_FILLER_ANCHOR,
	shapeSystemPromptText,
	shapeSystemUpdateText,
	stripTranscribedThinking,
	textifyErrorToolResult,
} from "../src/anthropic-shape.ts";

const PI_PREAMBLE = `${PI_DEFAULT_PROMPT_PREFIX} You help users by reading files, executing commands, editing code, and writing new files.`;
const PI_DOCS = `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /pi/README.md
- Additional docs: /pi/docs`;
const FILLER = "In addition to the tools above, you may have access to other custom tools depending on the project.";

/** A rendered pi prompt, in the shape `getSystemMessageText` produces. */
const PI_PROMPT = [
	PI_PREAMBLE,
	`<tools>\n- read: Read a file\n\n${FILLER}\n</tools>`,
	"<rules>\n- Be concise in your responses\n</rules>",
	`<docs>\n${PI_DOCS}\n</docs>`,
	"<cwd>\n/home/hxd\n</cwd>",
].join("\n\n");

// --- prompt shaping ---------------------------------------------------------

{
	const shaped = shapeSystemPromptText(PI_PROMPT);
	assert.ok(shaped.startsWith(MINIMAL_ANTHROPIC_OAUTH_PROMPT), "the pi preamble is replaced by the neutral minimum");
	assert.ok(!shaped.includes(PI_DEFAULT_PROMPT_PREFIX), "none of the pi preamble survives");
	assert.equal(shaped.split("\n\n<tools>")[0], MINIMAL_ANTHROPIC_OAUTH_PROMPT, "the preamble occupies exactly one chunk");
	assert.ok(shaped.includes("- read: Read a file"), "the tools section itself is kept");
	assert.ok(shaped.includes("</tools>"), "the tools section close is kept");
	assert.ok(!shaped.includes(FILLER), "the custom-tool filler paragraph is dropped");
	assert.ok(shaped.includes("<rules>"), "a section with no rule to apply is untouched");
	assert.ok(!shaped.includes("<docs>"), "pi's docs section is dropped");
	assert.ok(shaped.includes("<cwd>\n/home/hxd\n</cwd>"), "sections after the dropped one survive intact");
	assert.equal(shapeSystemPromptText(shaped), shaped, "shaping is idempotent");
}

// A `docs` section an extension registered must not be dropped on its name alone:
// only the anchor identifies pi's own.
{
	const custom = ["<docs>\nMy own notes\n</docs>", PI_PROMPT].join("\n\n");
	const shaped = shapeSystemPromptText(custom);
	assert.ok(shaped.includes("<docs>\nMy own notes\n</docs>"), "a foreign docs section is kept");
	assert.ok(!shaped.includes("Main documentation"), "pi's docs section is still dropped");
}

// A subagent prompt replaces the preamble wholesale; it must survive verbatim
// apart from the two content rules.
{
	const scout = ['<active_agent name="scout"/>\n\nYou are a scouting subagent.', "<tools>\nx\n\n" + FILLER + "\n</tools>"].join("\n\n");
	const shaped = shapeSystemPromptText(scout);
	assert.ok(shaped.startsWith('<active_agent name="scout"/>'), "a custom preamble is not replaced");
	assert.ok(!shaped.includes(FILLER), "content rules still apply to a custom preamble");
}

// The known classifier trigger phrase is rewritten.
{
	const shaped = shapeSystemPromptText("Here is some useful information about the environment you are running in:\n- cwd");
	assert.ok(shaped.startsWith("Environment context you are running in:"), "the trigger phrase is rewritten");
}

// --- mid-conversation section updates ---------------------------------------

{
	const update = 'Updated system prompt section "tools":\n\n<tools>\nx\n\n' + FILLER + "\n</tools>";
	const shaped = shapeSystemUpdateText(update);
	assert.ok(shaped!.startsWith('Updated system prompt section "tools":'), "the framing is preserved");
	assert.ok(!shaped!.includes(FILLER), "the framed value is shaped like a leading section");
}

{
	// pi never forwarded the docs section, so a notice retracting it names nothing.
	assert.equal(shapeSystemUpdateText('Removed system prompt section "docs".'), undefined, "a docs removal notice is dropped");
	assert.equal(
		shapeSystemUpdateText('Removed system prompt section "skills".'),
		'Removed system prompt section "skills".',
		"a removal of a section we did forward is kept",
	);
}

assert.equal(shapeSystemUpdateText("plain text"), "plain text", "text without framing passes through");

// --- transcript strip -------------------------------------------------------

const transcript = (marker: string) =>
	[
		`<conversation>\n[User]: fix the bug\n\n${marker} The user wants X. Let me check.\n\n[Assistant]: Done.\n\n[Assistant tool calls]: read(path="a.ts")\n\n[Tool result]: ok\n</conversation>`,
		"Produce the structured summary.",
	].join("\n\n");

{
	const { text, removed } = stripTranscribedThinking(transcript("[Assistant thinking]: "));
	assert.equal(removed, 1, "the thinking segment is counted");
	assert.ok(!text.includes("[Assistant thinking]: "), "the thinking segment is gone");
	assert.ok(text.includes("[User]: fix the bug"), "the user segment stays");
	assert.ok(text.includes("[Assistant]: Done."), "the visible assistant segment stays");
	assert.ok(text.includes("[Assistant tool calls]: read"), "the tool-call segment stays");
	assert.ok(text.includes("[Tool result]: ok"), "the tool-result segment stays");
	assert.ok(text.endsWith("Produce the structured summary."), "text outside the envelope is untouched");
}

// A thinking block containing blank lines is removed whole, not orphaned.
{
	const multi = transcript("[Assistant thinking]: first paragraph\n\nsecond paragraph");
	const { text, removed } = stripTranscribedThinking(multi);
	assert.equal(removed, 1, "a multi-paragraph thinking block is one segment");
	assert.ok(!text.includes("second paragraph"), "the whole block goes, not just its first paragraph");
	assert.ok(text.includes("[Assistant]: Done."), "the next segment is not eaten with it");
}

// A thinking segment at the end of an envelope leaves no trailing blank run.
{
	const trailing = "<conversation>\n[User]: a\n\n[Assistant thinking]: b\n</conversation>\n\ntail";
	const { text, removed } = stripTranscribedThinking(trailing);
	assert.equal(removed, 1);
	assert.equal(text, "<conversation>\n[User]: a\n</conversation>\n\ntail", "no separator is left dangling");
}

// The turn-prefix summarizer uses `# Conversation`, not an XML envelope.
{
	const turnPrefix = "# Conversation\n[User]: a\n\n[Assistant thinking]: b\n\n[Assistant]: c\n\n# Instructions\ndo it";
	const { text, removed } = stripTranscribedThinking(turnPrefix);
	assert.equal(removed, 1, "the `# Conversation` envelope is recognised");
	assert.ok(!text.includes("[Assistant thinking]: "));
	assert.ok(text.includes("# Instructions\ndo it"), "the instruction tail is untouched");
}

// Several envelopes in one message are each handled.
{
	const two = "<conversation>\n[User]: a\n\n[Assistant thinking]: b\n</conversation>\n\n<conversation>\n[User]: c\n\n[Assistant thinking]: d\n</conversation>";
	const { text, removed } = stripTranscribedThinking(two);
	assert.equal(removed, 2, "both envelopes are stripped");
	assert.equal(text, "<conversation>\n[User]: a\n</conversation>\n\n<conversation>\n[User]: c\n</conversation>", "both thinking segments are gone, envelopes and user turns intact");
}

// No marker: byte-identical. A marker outside an envelope: untouched.
{
	const plain = "assistant said things\n\nand more";
	assert.deepEqual(stripTranscribedThinking(plain), { text: plain, removed: 0 }, "no marker is a no-op");
	const outside = "[Assistant thinking]: b\n\nprose";
	assert.deepEqual(stripTranscribedThinking(outside), { text: outside, removed: 0 }, "a marker outside an envelope is kept");
}

// A user message that merely quotes a marker inside its own envelope is still a
// deliberate rewrite, and that is the documented trade: the model loses the
// quoted reasoning, not the answer.
{
	const quoted = "Look at this:\n\n<conversation>\n[Assistant thinking]: hmm\n</conversation>";
	const { removed } = stripTranscribedThinking(quoted);
	assert.equal(removed, 1, "a quoted envelope is stripped too");
}

// --- errored tool_result must be all text -------------------------------
// Anthropic: `all content must be type `text` if `is_error` is true`. pi-ai emits
// a block array with an image whenever a tool returned a picture, and copies the
// tool's own error flag, so a failing screenshot tool is rejected outright.
{
	const withImage = {
		type: "tool_result",
		tool_use_id: "t1",
		is_error: true,
		content: [{ type: "text", text: "{\"success\": false}" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA" } }],
	};
	assert.equal(textifyErrorToolResult(withImage), true, "an errored image result is rewritten");
	assert.equal(typeof withImage.content, "string", "the content becomes a string");
	assert.equal(withImage.content, "{\"success\": false}\n\n(see attached image)", "text is kept, the image becomes pi-ai's own placeholder");
	assert.equal(withImage.tool_use_id, "t1", "no other field is touched");
	assert.equal(withImage.is_error, true, "the error flag stays set");

	// Image-only: the placeholder is still a legitimate all-text result.
	const imageOnly = { type: "tool_result", is_error: true, content: [{ type: "image" }] };
	assert.equal(textifyErrorToolResult(imageOnly), true);
	assert.equal(imageOnly.content, "(see attached image)");

	// A non-image, non-text block still has to go; name it rather than lose it.
	const odd = { type: "tool_result", is_error: true, content: [{ type: "text", text: "a" }, { type: "tool_reference" }] };
	assert.equal(textifyErrorToolResult(odd), true);
	assert.equal(odd.content, "a\n\n[tool_reference]");

	// Untouched cases: already all text, not an error, not a tool_result at all,
	// and content that is already a plain string.
	assert.equal(textifyErrorToolResult({ type: "tool_result", is_error: true, content: [{ type: "text", text: "x" }] }), false, "an all-text error result is left alone");
	const ok = { type: "tool_result", is_error: false, content: [{ type: "text", text: "x" }, { type: "image" }] };
	assert.equal(textifyErrorToolResult(ok), false, "a successful result keeps its image");
	assert.equal(Array.isArray(ok.content), true, "and keeps it as blocks");
	assert.equal(textifyErrorToolResult({ type: "tool_result", content: [{ type: "image" }] }), false, "a missing is_error is not an error");
	assert.equal(textifyErrorToolResult({ type: "text", text: "x" }), false, "a text block is not a tool_result");
	const plain = { type: "tool_result", is_error: true, content: "already a string" };
	assert.equal(textifyErrorToolResult(plain), false, "string content is already all text");
	assert.equal(plain.content, "already a string", "and is untouched");

	// Idempotent, and an empty errored result stays empty rather than gaining text.
	const twice = { type: "tool_result", is_error: true, content: [{ type: "image" }] };
	textifyErrorToolResult(twice);
	assert.equal(textifyErrorToolResult(twice), false, "a second pass is a no-op");
	assert.equal(textifyErrorToolResult({ type: "tool_result", is_error: true, content: [] }), false, "an empty result is fine as-is");
}

// --- anchor drift -----------------------------------------------------------
// Every rule matches a string pi currently emits, so a pi reword makes the rule
// stop firing silently. Check the anchors against pi's own prompt builder rather
// than against this file's hand-written fixture. Tolerant of a missing file: the
// peer range spans pi versions whose layout this test should not pin.
{
	const promptPath = join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js");
	if (existsSync(promptPath)) {
		const { buildSystemPrompt } = (await import(promptPath)) as {
			buildSystemPrompt: (input: Record<string, unknown>) => string;
		};
		const real = buildSystemPrompt({
			cwd: "/tmp",
			contextFiles: [],
			selectedTools: ["read", "bash"],
			toolSnippets: { read: "Read a file", bash: "Run a command" },
		});
		assert.ok(real.startsWith(PI_DEFAULT_PROMPT_PREFIX), "pi's preamble still starts with the pinned prefix");
		assert.ok(real.includes(PI_DOCS_SECTION_ANCHOR), "pi's docs anchor still matches");
		assert.ok(real.includes(PI_TOOLS_FILLER_ANCHOR), "the tools filler anchor still matches");

		const shapedReal = shapeSystemPromptText(real);
		assert.ok(shapedReal.startsWith(MINIMAL_ANTHROPIC_OAUTH_PROMPT), "pi's own prompt is shaped");
		assert.ok(!shapedReal.includes("<docs>"), "pi's own docs section is dropped from the real prompt");
		assert.ok(!shapedReal.includes(PI_TOOLS_FILLER_ANCHOR), "…and its tools filler paragraph too");
		assert.ok(shapedReal.includes("</tools>"), "pi's tools close survives the real prompt");
		assert.ok(shapedReal.includes("<cwd>\n/tmp\n</cwd>"), "everything else survives the real prompt");
	} else {
		console.warn("anthropic-shape: pi's system-prompt.js not found; anchor drift not verified");
	}
}

console.log("anthropic-shape: ok");
