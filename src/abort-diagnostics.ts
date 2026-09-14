/**
 * Abort forensics: when a request to the Anthropic gateway dies with
 * "This operation was aborted" (an undici AbortError), the interesting
 * question is who called abort() — the turn's signal can be fired by the
 * client, a watchdog, a runtime teardown, or the SDK itself. None of those
 * layers log it, so the error reaches the UI as a bare "aborted" with no
 * reason.
 *
 * Two instruments, both pass-through:
 *  1. `fetch` is wrapped so every request to api.anthropic.com records its
 *     initiator stack and duration. On abort, the initiator stack tells us
 *     which layer's stream was used.
 *  2. `AbortController.prototype.abort` is shadowed so that when an
 *     in-flight Anthropic request's signal fires, the aborter's own stack is
 *     captured — that is the answer to "who called abort".
 *
 * Overhead is one Map lookup per fetch and one per abort; nothing else in
 * the process changes behavior.
 */
import { logInfo } from "./debug-log.ts";

interface InFlight {
	url: string;
	initiator: string;
	startedAt: number;
}

// Singleton across every plugin instance in the process: pi-web loads the
// extension once per runtime (global bootstrap + each session), and stacked
// wrappers both double-log every request and break the abort attribution -
// instance A registers the in-flight signal in its own map, so instance B's
// AbortController patch finds nothing. One wrapper, one shared map.
const GLOBAL_KEY = "__piMultiAccountAbortDiag" as const;
const globalState = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as
	| { installed: boolean; inFlight: Map<AbortSignal, InFlight> }
	| undefined;
const state = globalState ?? { installed: false, inFlight: new Map<AbortSignal, InFlight>() };
(globalThis as Record<string, unknown>)[GLOBAL_KEY] = state;

const inFlight = state.inFlight;

function frames(stack: string, count: number): string {
	return stack
		.split("\n")
		.slice(1, count + 1)
		.map((line) => line.trim().replace(/^at /, ""))
		.join(" <- ")
		.slice(0, 600);
}

export function installAbortDiagnostics(): void {
	if (state.installed) return;
	state.installed = true;

	const originalFetch = globalThis.fetch;
	globalThis.fetch = ((async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
		const isAnthropic = typeof url === "string" && url.includes("api.anthropic.com");
		const signal: AbortSignal | undefined = init?.signal ?? (input as Request)?.signal;
		if (!isAnthropic || !signal) return originalFetch.call(globalThis, input, init);

		const initiator = frames(new Error().stack ?? "", 6);
		const startedAt = Date.now();
		inFlight.set(signal, { url, initiator, startedAt });
		logInfo("diag.fetch_started", { url: url.slice(0, 80), initiatedBy: frames(initiator, 3) });
		signal.addEventListener(
			"abort",
			() => {
				// The abort listener fires before the fetch rejects; the
				// aborter's stack (if instrumented) is logged separately by the
				// AbortController patch, keyed on the same signal.
				const meta = inFlight.get(signal);
				// signal.reason names the killer natively: undici timeouts carry
				// TimeoutError (headers/body), client aborts carry the caller's
				// reason, and a plain AbortError means an external signal.
				const reason = signal.reason;
				logInfo("diag.fetch_aborted", {
					url: url.slice(0, 80),
					elapsedMs: Date.now() - startedAt,
					reasonName: reason instanceof Error ? reason.name : typeof reason,
					reasonMessage: String(reason instanceof Error ? reason.message : reason ?? "").slice(0, 120),
					initiatedBy: frames(meta?.initiator ?? initiator, 4),
				});
			},
			{ once: true },
		);

		try {
			return await originalFetch.call(globalThis, input, init);
		} finally {
			inFlight.delete(signal);
		}
	}) as unknown as typeof fetch);

	const originalAbort = AbortController.prototype.abort;
	AbortController.prototype.abort = function (this: AbortController, reason?: unknown): AbortSignal {
		const meta = inFlight.get(this.signal);
		if (meta) {
			logInfo("diag.abort_called", {
				url: meta.url.slice(0, 80),
				elapsedMs: Date.now() - meta.startedAt,
				reason: reason instanceof Error ? reason.message : reason === undefined ? "(none)" : String(reason).slice(0, 120),
				calledBy: frames(new Error().stack ?? "", 8),
			});
		}
		return originalAbort.call(this, reason) as unknown as AbortSignal;
	} as typeof AbortController.prototype.abort;
}
