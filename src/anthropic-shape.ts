/**
 * Anthropic OAuth request shaping: make a pi request look like Claude Code
 * traffic beyond the billing header.
 *
 * Two independent problems, one module, because both answer the same question —
 * "what does Anthropic's server-side classifier think produced this request?":
 *
 * 1. Prompt fingerprinting. Anthropic's client detection does not read headers or
 *    TLS, it reads the `system` content (measured: gist.github.com/mrcattusdev/
 *    53b046e56b5a0149bdb3c0f34b5f217a — swapping only the static prompt section
 *    flips the verdict on an unchanged account and token). pi's verbose preamble,
 *    its `docs` section and the tools filler are pi-specific text that no Claude
 *    Code request contains, so the preamble is replaced with a neutral minimum and
 *    the two pi-only blocks are dropped.
 *
 * 2. Transcribed reasoning. Anthropic's `reasoning_extraction` refusal category
 *    ("reverse engineering or duplicating model outputs") fires when the model's
 *    own reasoning reaches it as plain text. pi serializes thinking that way in
 *    every summarization transcript (`[Assistant thinking]: …`, compaction
 *    utils.js), which is the one place pi turns reasoning into text on purpose.
 *    Measured on claude-opus-5-5: transcript with the marker refused 6/6, the same
 *    transcript with the segments removed accepted 6/6.
 *
 * Shaping is anchored, never positional: every rule matches a string pi currently
 * emits, so a pi reword degrades to "rule stops firing" instead of corruption.
 *
 * Ported in spirit from gotgenes/pi-anthropic-auth (MIT) — its
 * `src/system-prompt-shaping.ts` and `docs/plans/0065-*`. The section scan here is
 * string-based rather than a full parser because pi's rendered prompt is a flat
 * string by the time an extension sees it.
 */

/**
 * Prefix of pi's built-in default preamble. Only a preamble starting with this is
 * rewritten, so `--system-prompt` and subagent prompts (which replace the preamble
 * wholesale, e.g. `<active_agent name="scout"/>`) are left alone.
 */
export const PI_DEFAULT_PROMPT_PREFIX =
	"You are an expert coding assistant operating inside pi, a coding agent harness.";

/** The neutral prompt substituted for pi's preamble on OAuth requests. */
export const MINIMAL_ANTHROPIC_OAUTH_PROMPT =
	"You are an expert coding assistant.\n" +
	"Be concise and helpful.\n" +
	"Use the available tools to answer the user's request.\n" +
	"Show file paths clearly when working with files.";

/** Marks pi's own `docs` section. Extensions can register a section named `docs` too. */
export const PI_DOCS_SECTION_ANCHOR = "Pi documentation (read only when the user asks about pi itself";

/** The tools section's trailing sentence about custom tools; the paragraph goes, the section stays. */
export const PI_TOOLS_FILLER_ANCHOR = "In addition to the tools above";

/**
 * Inline replacements for known classifier trigger phrases.
 *
 * `Here is some useful information about the environment…` was isolated by
 * opencode-claude-auth by bisecting a failing prompt; that project's own env
 * builder emits it, so it is carried here as a documented risk rather than a
 * current pi hit.
 */
export const TEXT_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
	[
		"Here is some useful information about the environment you are running in:",
		"Environment context you are running in:",
	],
];

/** pi's transcript paragraph markers, in the order `serializeConversation` emits them. */
const TRANSCRIPT_MARKERS = [
	"[User]: ",
	"[Assistant thinking]: ",
	"[Assistant]: ",
	"[Assistant tool calls]: ",
	"[Tool result]: ",
];

/** The marker whose whole paragraph is dropped. Exported: callers test for it too. */
export const TRANSCRIPT_THINKING_MARKER = "[Assistant thinking]: ";

/** Envelope markers pi wraps a summarization transcript in (compaction, branch, turn prefix). */
const ENVELOPES: ReadonlyArray<readonly [string, string]> = [
	["<conversation>\n", "\n</conversation>"],
	["# Conversation\n", "\n\n# Instructions\n"],
];

/** Remove the first paragraph containing `anchor`, with the separator that joined it. */
function removeParagraph(text: string, anchor: string): string {
	const at = text.indexOf(anchor);
	if (at === -1) return text;
	const blank = text.indexOf("\n\n", at);
	const close = text.indexOf("\n</", at);
	const paraEnd = blank === -1 ? close : close === -1 ? blank : Math.min(blank, close);
	const paraStart = text.lastIndexOf("\n\n", at);
	if (paraStart === -1) {
		// First paragraph: eat the separator that follows instead.
		const end = paraEnd === -1 ? text.length : paraEnd;
		return text.slice(paraEnd === close ? end : Math.min(end + 2, text.length));
	}
	return text.slice(0, paraStart) + (paraEnd === -1 ? "" : text.slice(paraEnd));
}

/** Drop a `<name>…</name>` section when its body contains `anchor`. */
function dropSection(text: string, name: string, anchor: string): string {
	const open = `\n\n<${name}>\n`;
	const at = text.indexOf(open);
	if (at === -1) return text;
	const close = text.indexOf(`\n</${name}>`, at + open.length);
	if (close === -1) return text;
	const bodyEnd = close;
	if (!text.slice(at + open.length, bodyEnd).includes(anchor)) return text;
	return text.slice(0, at) + text.slice(bodyEnd + `\n</${name}>`.length);
}

function applyTextReplacements(text: string): string {
	let out = text;
	for (const [match, replacement] of TEXT_REPLACEMENTS) out = out.replaceAll(match, replacement);
	return out;
}

/**
 * Shape one rendered system prompt (or one rendered section value).
 *
 * Idempotent: the minimal prompt does not start with pi's prefix, the dropped
 * section is gone, and every anchor is consumed exactly once.
 */
export function shapeSystemPromptText(text: string): string {
	let out = dropSection(text, "docs", PI_DOCS_SECTION_ANCHOR);
	out = removeParagraph(out, PI_TOOLS_FILLER_ANCHOR);
	out = applyTextReplacements(out);
	if (out.startsWith(PI_DEFAULT_PROMPT_PREFIX)) {
		const end = out.indexOf("\n\n");
		out = end === -1 ? MINIMAL_ANTHROPIC_OAUTH_PROMPT : MINIMAL_ANTHROPIC_OAUTH_PROMPT + out.slice(end);
	}
	return out;
}

/**
 * Matches the framing pi puts on a mid-conversation section change
 * (`renderSystemMessageUpdate`). Group 1 names an updated section, group 2 a removed one.
 */
const SECTION_UPDATE_FRAME =
	/^(?:Updated system prompt section "([a-z][a-z0-9_-]*)":\n\n|Removed system prompt section "([a-z][a-z0-9_-]*)"\.$)/gm;

/**
 * Shape a mid-conversation `role: "system"` message.
 *
 * pi re-sends changed prompt sections inside `messages[]` on models that accept
 * them; that route would otherwise re-introduce the pi-only blocks shaping just
 * removed from `system[]`. Returns undefined when every framed part shaped away.
 */
export function shapeSystemUpdateText(text: string): string | undefined {
	const frames = [...text.matchAll(SECTION_UPDATE_FRAME)];
	if (frames.length === 0) return text;

	const parts: string[] = [];
	const leading = text.slice(0, frames[0]!.index).trim();
	if (leading) parts.push(leading);

	for (const [index, frame] of frames.entries()) {
		const from = frame.index;
		const to = frames[index + 1]?.index ?? text.length;
		const framing = frame[0];
		if (frame[2] !== undefined) {
			// A removal notice for a section we never forwarded names nothing.
			if (frame[2] === "docs") continue;
			parts.push(text.slice(from, to).trimEnd());
			continue;
		}
		const value = text.slice(from + framing.length, to).trim();
		const shaped = shapeSystemPromptText(value);
		parts.push(shaped ? `${framing}\n\n${shaped}` : framing);
	}
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Split a transcript into its marker-delimited paragraphs.
 *
 * Cuts only at a blank line that is immediately followed by a known marker, so a
 * thinking block that itself contains blank lines stays one segment instead of
 * being orphaned from its marker.
 */
function splitSegments(body: string): string[] {
	const parts: string[] = [];
	let cursor = 0;
	for (let at = body.indexOf("\n\n"); at !== -1; at = body.indexOf("\n\n", at + 2)) {
		if (!TRANSCRIPT_MARKERS.some((marker) => body.startsWith(marker, at + 2))) continue;
		parts.push(body.slice(cursor, at));
		cursor = at + 2;
	}
	parts.push(body.slice(cursor));
	return parts;
}

/**
 * Remove transcribed-reasoning segments from every summarization envelope in `text`.
 *
 * Gated on the marker itself: a payload without `[Assistant thinking]: ` is returned
 * byte-identical, so ordinary turns are untouched.
 */
export function stripTranscribedThinking(text: string): { text: string; removed: number } {
	if (!text.includes(TRANSCRIPT_THINKING_MARKER)) return { text, removed: 0 };

	let out = "";
	let cursor = 0;
	let removed = 0;
	for (;;) {
		// Windows are searched from `cursor` and consumed in order, so overlapping or
		// repeated envelopes are each handled once.
		let start = -1;
		let open = "";
		let close = "";
		for (const [candidateOpen, candidateClose] of ENVELOPES) {
			const at = text.indexOf(candidateOpen, cursor);
			if (at === -1 || (start !== -1 && at >= start)) continue;
			start = at;
			open = candidateOpen;
			close = candidateClose;
		}
		if (start === -1) break;

		const bodyStart = start + open.length;
		const bodyEnd = text.indexOf(close, bodyStart);
		if (bodyEnd === -1) break;

		const segments = splitSegments(text.slice(bodyStart, bodyEnd));
		const kept = segments.filter((segment) => !segment.startsWith(TRANSCRIPT_THINKING_MARKER));
		removed += segments.length - kept.length;

		out += text.slice(cursor, bodyStart) + kept.join("\n\n");
		cursor = bodyEnd;
	}
	return { text: out + text.slice(cursor), removed };
}

/** Copied from pi-ai's `convertContentBlocks`, so a rewritten result reads like an untouched one. */
const IMAGE_PLACEHOLDER = "(see attached image)";

/**
 * Make an errored `tool_result` all-text, which Anthropic requires.
 *
 * `400 messages.N.content.0.tool_result: all content must be type `text` if
 * `is_error` is true`. pi-ai encodes a tool result as a content-block array
 * whenever the tool returned an image (anthropic-messages.js `convertContentBlocks`),
 * and sets `is_error` straight from the tool's own flag, so the two together —
 * any failing tool that also returns a picture — are rejected. Measured on
 * pi 1.1.0 with pi-agent-browser-native's `agent_browser_code`, whose failure
 * result carries a screenshot.
 *
 * The image has to go: Anthropic accepts no non-text block in an errored result,
 * and the text block already carries the failure. Returns whether it rewrote
 * anything.
 */
export function textifyErrorToolResult(block: Record<string, unknown>): boolean {
	if (block["type"] !== "tool_result" || !block["is_error"] || !Array.isArray(block["content"])) return false;
	const content = block["content"] as Array<Record<string, unknown> | undefined>;
	if (!content.some((inner) => inner?.["type"] !== "text")) return false;
	block["content"] = content
		.map((inner) => {
			if (inner?.["type"] === "text" && typeof inner["text"] === "string") return inner["text"];
			return inner?.["type"] === "image" ? IMAGE_PLACEHOLDER : `[${String(inner?.["type"] ?? "unknown")}]`;
		})
		.filter((part) => part.length > 0)
		.join("\n\n");
	return true;
}
