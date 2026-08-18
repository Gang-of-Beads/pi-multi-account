/**
 * Structured debug log for account/credential lifecycle events.
 *
 * Why this exists: every interesting failure in this extension happens *between*
 * processes — a background sweep rotates a token, another installation sharing
 * the same `pi-accounts.json` rotates it again, a host app rewrites the active
 * account under a running session — and none of it is visible in the transcript.
 * The user sees one 401 and a working retry, with nothing to diagnose from.
 *
 * So every credential decision is appended to a JSONL file that outlives the
 * session: which account a request authenticated as, when a token was refreshed
 * and by whom, when the store changed underneath us, and what the provider
 * answered. One line per event, newest last.
 *
 * Tokens are never written. Each credential is identified by a short SHA-256
 * fingerprint, which is enough to tell "the token changed" and "these two
 * installations hold the same token" apart without leaking the secret.
 *
 *   PI_MULTI_ACCOUNT_LOG=0|off      disable entirely
 *   PI_MULTI_ACCOUNT_LOG=debug      include per-request resolution events
 *   PI_MULTI_ACCOUNT_LOG_FILE=path  write somewhere other than
 *                                   ~/.pi/agent/pi-multi-account.log
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

export type LogLevel = "off" | "info" | "debug";

/** Rotate at this size, keeping exactly one previous file. */
const MAX_LOG_BYTES = 4 * 1024 * 1024;

/**
 * Identifies this process in a log file that several processes share.
 *
 * `host` and `pid` alone cannot distinguish a container that bind-mounts the
 * host's home directory from the host itself, and that is exactly the case that
 * corrupts rotating OAuth tokens, so a random per-process id is included too.
 */
const RUNTIME_ID = randomBytes(3).toString("hex");

let cachedLevel: LogLevel | undefined;
let cachedPath: string | undefined;
/** Logging must never break a session, so a broken sink disables itself. */
let sinkBroken = false;

function envLevel(): LogLevel {
	const raw = (process.env.PI_MULTI_ACCOUNT_LOG ?? "").trim().toLowerCase();
	if (raw === "0" || raw === "off" || raw === "false" || raw === "none") return "off";
	if (raw === "debug" || raw === "trace" || raw === "2") return "debug";
	return "info";
}

/** Current log level, re-read only once per process. */
export function logLevel(): LogLevel {
	cachedLevel ??= envLevel();
	return cachedLevel;
}

/** Absolute path of the log file, even when logging is disabled. */
export function logPath(): string {
	cachedPath ??=
		process.env.PI_MULTI_ACCOUNT_LOG_FILE ||
		join(process.env.HOME ?? ".", ".pi", "agent", "pi-multi-account.log");
	return cachedPath;
}

/** Reset memoized configuration. Tests only. */
export function resetLogConfigForTesting(): void {
	cachedLevel = undefined;
	cachedPath = undefined;
	sinkBroken = false;
}

/**
 * Short, non-reversible identifier for a secret.
 *
 * The point is comparability: the same token logged by two processes produces
 * the same fingerprint, so "the container rotated the token I was holding" is
 * visible in the log without the token ever being in it.
 */
export function fingerprint(secret: string | undefined): string | undefined {
	if (!secret) return undefined;
	return createHash("sha256").update(secret).digest("hex").slice(0, 8);
}

/** Log-safe view of a stored credential: fingerprints plus expiry, no secrets. */
export function credentialSummary(
	credential: { access?: string; refresh?: string; expires?: number } | undefined,
): Record<string, unknown> | undefined {
	if (!credential) return undefined;
	const expires = credential.expires;
	return {
		access: fingerprint(credential.access),
		refresh: fingerprint(credential.refresh),
		...(typeof expires === "number"
			? { expiresAt: new Date(expires).toISOString(), expiresInSec: Math.round((expires - Date.now()) / 1000) }
			: {}),
	};
}

function rotateIfNeeded(path: string): void {
	try {
		if (statSync(path).size < MAX_LOG_BYTES) return;
		renameSync(path, `${path}.1`);
	} catch {
		// Missing file (nothing to rotate) or an unwritable directory; the append
		// below reports the real problem by disabling the sink.
	}
}

function write(level: Exclude<LogLevel, "off">, event: string, fields: Record<string, unknown>): void {
	if (sinkBroken) return;
	const configured = logLevel();
	if (configured === "off") return;
	if (level === "debug" && configured !== "debug") return;

	const line = `${JSON.stringify({
		ts: new Date().toISOString(),
		event,
		host: hostname(),
		pid: process.pid,
		rt: RUNTIME_ID,
		...fields,
	})}\n`;

	const path = logPath();
	try {
		rotateIfNeeded(path);
		appendFileSync(path, line, "utf8");
	} catch {
		try {
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, line, "utf8");
		} catch {
			// Read-only home, no space, whatever it is: stop trying. A debug log is
			// never worth failing a session over.
			sinkBroken = true;
		}
	}
}

/** Record a normal lifecycle event. */
export function logInfo(event: string, fields: Record<string, unknown> = {}): void {
	write("info", event, fields);
}

/** Record a high-volume event (per request, per sweep tick). */
export function logDebug(event: string, fields: Record<string, unknown> = {}): void {
	write("debug", event, fields);
}

/** Record a failure. Always written, whatever the level (unless disabled). */
export function logError(event: string, fields: Record<string, unknown> = {}): void {
	write("info", event, { level: "error", ...fields });
}
