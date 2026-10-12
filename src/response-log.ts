import { logInfo } from "./debug-log.ts";

type ResponseLogger = (event: string, fields: Record<string, unknown>) => void;

/**
 * Which responses already have a log line.
 *
 * Two wrappers can see the same request - the global fetch guard and the one
 * attached to a prepared request - and each logged its own line for it, so every
 * request was in the log twice, one line with `ms` and one without. The guard is
 * keyed on the Response itself, so the first wrapper to see it logs it and the
 * second stays quiet, whichever that turns out to be.
 *
 * The set hangs off a global symbol, not module state: a session daemon gives every
 * session its own module instance, each of which patches the same global fetch, so a
 * module-local guard would still let one request be logged once per live session.
 */
const LOGGED_KEY = Symbol.for("pi-multi-account.loggedResponses");
const logHost = globalThis as unknown as Record<symbol, WeakSet<Response> | undefined>;
if (logHost[LOGGED_KEY] === undefined) logHost[LOGGED_KEY] = new WeakSet<Response>();
const logged = logHost[LOGGED_KEY]!;

/**
 * Log one provider response without holding it back.
 *
 * Both diagnostic fetch wrappers awaited the clone's text before returning the response, which reads
 * a streaming reply to its very end before the SDK sees a byte: no provider streamed in any pi that
 * loaded this extension, and every reply arrived in one burst when it was complete (pi-web B32,
 * reproduced with `pi --mode json` against a slow local stream). A success is logged by status and
 * time only; an error body, small and complete, is read from a clone in the background.
 */
export function logProviderResponse(response: Response, fields: Record<string, unknown>, log: ResponseLogger = logInfo): void {
	if (logged.has(response)) return;
	logged.add(response);
	const entry = { ...fields, status: response.status };
	if (response.ok) {
		log("diag.http", entry);
		return;
	}
	void response
		.clone()
		.text()
		.then(
			(text) => { log("diag.http", { ...entry, body: text.slice(0, 300) }); },
			() => { log("diag.http", { ...entry, body: "<unreadable>" }); },
		);
}
