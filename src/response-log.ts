import { logInfo } from "./debug-log.ts";

type ResponseLogger = (event: string, fields: Record<string, unknown>) => void;

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
