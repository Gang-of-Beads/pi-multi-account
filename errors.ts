/**
 * Error shaping shared by every refresh path.
 */
/** Marks an error whose message has already been condensed for the user. */
const SANITIZED = Symbol.for("pi-multi-account.sanitizedRefreshError");

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Condense an OAuth refresh failure into one actionable line. */
export function conciseRefreshFailure(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const payloadMatch = message.match(/body=(\{.*\})/s);
	if (payloadMatch) {
		try {
			const payload = JSON.parse(payloadMatch[1]) as { error?: unknown; error_description?: unknown };
			if (typeof payload.error === "string" && typeof payload.error_description === "string") {
				return `${payload.error} (${payload.error_description})`;
			}
			if (typeof payload.error === "string") return payload.error;
		} catch {
			// Fall through to plain-text cleanup.
		}
	}

	if (/invalid_grant/i.test(message) && /Refresh token not found or invalid/i.test(message)) {
		return "invalid_grant (refresh token not found or invalid)";
	}

	return message
		.replace(/; stack=.*$/s, "")
		.replace(/^Anthropic token refresh request failed\.\s*/i, "")
		.replace(/^Token exchange request failed\.\s*/i, "")
		.replace(/^OAuth refresh failed\.\s*/i, "")
		.replace(/\burl=https?:\/\/[^;]+;?\s*/gi, "")
		.replace(/\bdetails=/gi, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Wrap a refresh failure in a short, actionable error.
 *
 * pi surfaces provider auth errors verbatim in `/model` and at request time, and
 * the upstream failure carries a full stack plus the raw response body. Already
 * sanitized errors pass through unchanged, so the innermost (most specific)
 * message survives when several layers wrap the same failure.
 */
export function sanitizeRefreshError(providerId: string, accountName: string | undefined, error: unknown): Error {
	if (error instanceof Error && SANITIZED in error) return error;
	const subject = accountName ? `${providerId} account "${accountName}"` : `${providerId} account`;
	const detail = conciseRefreshFailure(error) || "refresh failed";
	const guidance = /invalid_grant/i.test(detail) ? " Re-login this account in /accounts." : "";
	const sanitized = new Error(`${subject} refresh failed: ${detail}.${guidance}`.replace(/\.\s*\./g, "."));
	Object.defineProperty(sanitized, SANITIZED, { value: true });
	return sanitized;
}
