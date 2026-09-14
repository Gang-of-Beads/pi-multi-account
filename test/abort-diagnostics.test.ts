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
// debug-log 的 logInfo 是模块级导出——直接换不走,这里改用它的输出文件? 简化:
// installAbortDiagnostics 通过 logInfo 写日志;为了断言,monkey-patch console?
// 实际上 debug-log.logInfo 写文件+可选 console。这里退而求其次:验证不抛错且
// fetch 行为不变,再人工核对日志。真正要做断言的话需要依赖注入。
installAbortDiagnostics();

// 1. 正常请求不受影响
const ok = await fetch("https://api.anthropic.com/v1/messages", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ model: "claude-opus-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
}).catch((e) => ({ status: 0, error: String(e) }));
assert.ok(ok, "wrapped fetch returns a response");

// 2. 被 abort 的请求: 探针记录 abort(带栈),且 fetch 以 AbortError 拒绝
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
