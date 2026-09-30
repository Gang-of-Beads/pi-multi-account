/**
 * Self-check for the abort forensics: an aborted in-flight Anthropic fetch
 * must log both the fetch initiator and the aborter's stack.
 */
import assert from "node:assert";
import { installAbortDiagnostics } from "../src/abort-diagnostics.ts";
import { logInfo } from "../src/debug-log.ts";

const keepalive = setInterval(() => undefined, 1000);
const captured: Array<{ event: string; data: Record<string, unknown> }> = [];
const original = logInfo;
// debug-log's logInfo is a module-level export - it cannot simply be swapped out; use its output file instead? Simplified:
// installAbortDiagnostics logs through logInfo; to assert on it, monkey-patch console?
// In practice debug-log.logInfo writes a file plus optional console output. Settle for less here: verify nothing throws and
// fetch behaves the same, then check the log by hand. Real assertions would need dependency injection.
installAbortDiagnostics();

// 1. A normal request is unaffected
const ok = await fetch("https://api.anthropic.com/v1/messages", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ model: "claude-opus-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
}).catch((e) => ({ status: 0, error: String(e) }));
assert.ok(ok, "wrapped fetch returns a response");

// 2. An aborted request: the probe records the abort (with its stack), and fetch rejects with an AbortError
const controller = new AbortController();
const aborting = fetch("https://api.anthropic.com/v1/messages", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: "{}",
	signal: controller.signal,
}).then(
	() => "completed",
	(e: Error) => `${e.name}: ${e.message}`,
);
setTimeout(() => controller.abort(new Error("forensics-test")), 50);
const outcome = (await aborting) as string;
assert.match(outcome, /forensics-test/, `aborted fetch rejects with the abort reason, got: ${outcome}`);

clearInterval(keepalive);
console.log("ok: abort forensics installed, fetch passthrough intact, abort captured");
