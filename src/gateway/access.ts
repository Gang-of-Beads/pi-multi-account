import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync, openSync, closeSync, fstatSync, fchmodSync, readSync, constants } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { readJson, updateJson, positive, record } from "../core/storage.ts";

export interface CallerKey {
	id: string;
	name: string;
	hash: string;
	routes: string[];
	admin?: boolean;
	expires?: number;
	rpm?: number;
	dailyTokens?: number;
	maxConcurrent?: number;
}
interface KeysFile {
	version: 1;
	keys: CallerKey[];
}
export class GatewayError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code = "gateway_error",
	) {
		super(message);
	}
}
export const keysPath = (dir: string): string => join(dir, "pi-multi-account-gateway.json");
function validateKeys(raw: unknown): KeysFile {
	if (!record(raw) || raw.version !== 1 || !Array.isArray(raw.keys)) throw new Error("Invalid gateway keys file");
	const ids = new Set<string>();
	for (const k of raw.keys) {
		if (
			!record(k) ||
			typeof k.id !== "string" ||
			ids.has(k.id) ||
			typeof k.name !== "string" ||
			!/^[a-f0-9]{64}$/.test(String(k.hash)) ||
			!Array.isArray(k.routes) ||
			!k.routes.every((r) => typeof r === "string" && r.length > 0) ||
			(k.expires !== undefined && !positive(k.expires)) ||
			(k.admin !== undefined && typeof k.admin !== "boolean")
		)
			throw new Error("Invalid gateway key entry");
		for (const name of ["rpm", "dailyTokens", "maxConcurrent"])
			if (k[name] !== undefined && !positive(k[name])) throw new Error(`Invalid key limit: ${name}`);
		ids.add(k.id);
	}
	return raw as unknown as KeysFile;
}
export async function createCallerKey(
	dir: string,
	name: string,
	options: Partial<Pick<CallerKey, "routes" | "admin" | "expires" | "rpm" | "dailyTokens" | "maxConcurrent">> = {},
): Promise<{ key: CallerKey; secret: string }> {
	if (!name.trim() || name.length > 100) throw new Error("A key needs a name (max 100 characters)");
	const id = randomBytes(8).toString("hex");
	const secret = `pmak_${id}_${randomBytes(32).toString("base64url")}`;
	const key: CallerKey = { id, name, hash: hash(secret), routes: ["*"], ...options };
	validateKeys({ version: 1, keys: [key] });
	await updateJson<KeysFile, void>(keysPath(dir), { version: 1, keys: [] }, async (raw) => {
		const file = validateKeys(raw);
		file.keys.push(key);
		return { value: file, result: undefined };
	});
	return { key, secret };
}
export async function revokeCallerKey(dir: string, id: string): Promise<void> {
	await updateJson<KeysFile, void>(keysPath(dir), { version: 1, keys: [] }, async (raw) => {
		const file = validateKeys(raw);
		file.keys = file.keys.filter((k) => k.id !== id);
		return { value: file, result: undefined };
	});
}
const hash = (s: string): string => createHash("sha256").update(s).digest("hex");
export const permits = (key: CallerKey, route: string): boolean => key.routes.includes("*") || key.routes.includes(route);
export function authenticate(dir: string, request: IncomingMessage): CallerKey {
	const auth = request.headers.authorization;
	const api = request.headers["x-api-key"];
	if (Array.isArray(api) || (auth && !auth.startsWith("Bearer ")))
		throw new GatewayError(401, "Invalid gateway credential", "authentication_error");
	const bearer = auth?.slice(7);
	if (bearer && api && bearer !== api) throw new GatewayError(401, "Conflicting gateway credentials", "authentication_error");
	const token = bearer ?? api;
	const match = token?.match(/^pmak_([a-f0-9]{16})_[-_A-Za-z0-9]{43}$/);
	if (!match) throw new GatewayError(401, "A gateway API key is required", "authentication_error");
	const keys = validateKeys(readJson<unknown>(keysPath(dir), { version: 1, keys: [] })).keys;
	const key = keys.find((k) => k.id === match[1]);
	if (
		!key ||
		!timingSafeEqual(Buffer.from(key.hash, "hex"), Buffer.from(hash(token!), "hex")) ||
		(key.expires !== undefined && key.expires <= Date.now())
	)
		throw new GatewayError(401, "Invalid or expired gateway API key", "authentication_error");
	return key;
}

export interface UsageRecord {
	at: number;
	key: string;
	route: string;
	target?: string;
	status: number;
	input: number;
	output: number;
	tokens: number;
	estimated?: boolean;
	ms: number;
}
interface Accounted {
	day: string;
	tokens: number;
	reserved: number;
	active: number;
	requests: number[];
}
const dayOf = (now: number): string => new Date(now).toISOString().slice(0, 10);
/** One listener owns these reservations. Quotas include in-flight calls, not just finished ones. */
export class GatewayUsage {
	private keys = new Map<string, Accounted>();
	private failed = false;
	private fd: number | undefined;
	private recent: UsageRecord[] = [];
	readonly path: string;
	constructor(dir: string) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		this.path = join(dir, "pi-multi-account-usage.jsonl");
		this.fd = openSync(this.path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
		try {
			if (!fstatSync(this.fd).isFile()) throw new Error("Usage ledger must be a regular file");
			fchmodSync(this.fd, 0o600);
		} catch (error) {
			this.close();
			throw error;
		}
	}
	/** Never silently reset accounting after ledger corruption or an interrupted append. */
	async restore(): Promise<void> {
		if (this.fd === undefined) throw new Error("Usage ledger is closed");
		const size = fstatSync(this.fd).size;
		const last = Buffer.alloc(1);
		if (size) {
			readSync(this.fd, last, 0, 1, size - 1);
			if (last[0] !== 10) throw new Error("Usage ledger has an incomplete last record; repair it before serving");
		}
		const { createReadStream } = await import("node:fs");
		const { createInterface } = await import("node:readline");
		const reader = createInterface({
			input: createReadStream(this.path, { fd: this.fd, autoClose: false, start: 0 }),
			crlfDelay: Infinity,
		});
		try {
			for await (const line of reader) {
				let r: UsageRecord;
				try {
					r = JSON.parse(line);
				} catch {
					throw new Error("Usage ledger contains invalid JSON; repair it before serving");
				}
				if (
					!record(r) ||
					typeof r.key !== "string" ||
					typeof r.route !== "string" ||
					![r.at, r.tokens, r.input, r.output, r.status].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)
				)
					throw new Error("Usage ledger contains an invalid record; refusing to reset accounting");
				if (dayOf(r.at) === dayOf(Date.now())) this.state(r.key).tokens += r.tokens;
				if (r.at > Date.now() - 60_000) this.state(r.key).requests.push(r.at);
			}
		} finally {
			reader.close();
		}
	}
	private state(id: string): Accounted {
		let s = this.keys.get(id);
		const day = dayOf(Date.now());
		if (!s) {
			s = { day, tokens: 0, reserved: 0, active: 0, requests: [] };
			this.keys.set(id, s);
		}
		if (s.day !== day) {
			s.day = day;
			s.tokens = 0;
		} // Existing reservations remain counted across UTC midnight.
		return s;
	}
	reserve(key: CallerKey, tokens: number): (record: Omit<UsageRecord, "at" | "key">) => void {
		if (this.failed || this.fd === undefined) throw new GatewayError(503, "Usage ledger is unavailable; refusing unaccounted requests");
		const s = this.state(key.id);
		const now = Date.now();
		s.requests = s.requests.filter((at) => at > now - 60_000);
		if (s.active >= (key.maxConcurrent ?? 4)) throw new GatewayError(429, "Concurrent request limit reached", "rate_limit_error");
		if (key.rpm && s.requests.length >= key.rpm) throw new GatewayError(429, "Request rate limit reached", "rate_limit_error");
		if (key.dailyTokens && s.tokens + s.reserved + tokens > key.dailyTokens)
			throw new GatewayError(429, "Daily token limit reached (including in-flight reservations)", "rate_limit_error");
		s.requests.push(now);
		s.active++;
		s.reserved += tokens;
		let done = false;
		return (raw) => {
			if (done) return;
			done = true;
			const r: UsageRecord = { ...raw, at: Date.now(), key: key.id };
			if (![r.tokens, r.input, r.output].every((n) => Number.isFinite(n) && n >= 0)) {
				r.tokens = tokens;
				r.input = tokens;
				r.output = 0;
				r.estimated = true;
			}
			s.active--;
			s.reserved -= tokens;
			this.state(key.id).tokens += r.tokens;
			try {
				if (this.fd === undefined) throw new Error("Usage ledger closed");
				appendFileSync(this.fd, `${JSON.stringify(r)}\n`);
			} catch {
				this.failed = true;
			}
			this.recent.push(r);
			if (this.recent.length > 100) this.recent.shift();
		};
	}
	stats(key?: string): object {
		return {
			keys: [...this.keys]
				.filter(([id]) => !key || id === key)
				.map(([id, v]) => ({ id, tokens: v.tokens, inFlight: v.active, reserved: v.reserved })),
			recent: this.recent.filter((r) => !key || r.key === key),
			ledgerHealthy: !this.failed,
		};
	}
	close(): void {
		if (this.fd !== undefined) {
			closeSync(this.fd);
			this.fd = undefined;
		}
	}
}
