import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { isIP } from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import type { PmaEngine, ResolvedTarget } from "../core/engine.ts";
import { readRoutes, RouteRouter, retryable, targetId, type Route } from "../core/routes.ts";
import { updateJson, record } from "../core/storage.ts";
import { authenticate, GatewayError, GatewayUsage, permits } from "./access.ts";
import { decodeRequest, encodeResponse, ProtocolEncoder, protocolOf, type Protocol } from "./protocols.ts";
import { nativeRequest, relayNative, UpstreamFailure, noUsage, type MeasuredUsage } from "./native.ts";

export interface GatewayHandle {
	url: string;
	close(): Promise<void>;
}
export interface GatewayOptions {
	host?: string;
	port?: number;
	timeoutMs?: number;
	maxBodyBytes?: number;
	maxConcurrent?: number;
	fetch?: typeof fetch;
}
interface Owner {
	pid: number;
	host: string;
	nonce: string;
}
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code !== "ESRCH";
	}
}
async function claim(dir: string): Promise<() => Promise<void>> {
	const path = join(dir, "pi-multi-account-gateway-owner.json");
	const mine: Owner = { pid: process.pid, host: hostname(), nonce: randomUUID() };
	await updateJson<Owner | null, void>(path, null, async (owner) => {
		if (
			owner !== null &&
			(!record(owner) || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.host !== mine.host || alive(owner.pid))
		)
			throw new Error(
				"A gateway already owns this agent directory (or its ownership cannot be verified). Stop it before starting another.",
			);
		return { value: mine, result: undefined };
	});
	return async () => {
		await updateJson<Owner | null, void>(path, null, async (owner) => ({
			value: owner?.nonce === mine.nonce ? null : owner,
			result: undefined,
		}));
	};
}
async function bodyOf(request: IncomingMessage, limit: number, signal: AbortSignal): Promise<Record<string, unknown>> {
	if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity")
		throw new GatewayError(415, "Compressed request bodies are not supported");
	if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json"))
		throw new GatewayError(415, "Content-Type must be application/json");
	if (Number(request.headers["content-length"] ?? 0) > limit)
		throw new GatewayError(413, "Gateway request body limit exceeded", "request_too_large");
	let size = 0;
	const chunks: Buffer[] = [];
	const abort = () => request.destroy(new Error("Request cancelled while reading its body"));
	signal.addEventListener("abort", abort, { once: true });
	try {
		signal.throwIfAborted();
		for await (const chunk of request.iterator({ destroyOnReturn: false })) {
			size += chunk.length;
			if (size > limit) throw new GatewayError(413, "Gateway request body limit exceeded", "request_too_large");
			chunks.push(chunk);
		}
	} finally {
		signal.removeEventListener("abort", abort);
	}
	let body: unknown;
	try {
		body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new GatewayError(400, "Invalid JSON body");
	}
	if (!record(body) || typeof body.model !== "string" || !body.model || (body.stream !== undefined && typeof body.stream !== "boolean"))
		throw new GatewayError(400, "A request needs a model and a boolean stream flag");
	return body;
}
function json(res: ServerResponse, status: number, value: object): void {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
	res.end(JSON.stringify(value));
}
async function write(res: ServerResponse, chunk: string | Uint8Array, signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	if (res.destroyed) throw new Error("Client disconnected");
	if (res.write(chunk)) return;
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			res.off("drain", done);
			res.off("close", closed);
			signal.removeEventListener("abort", closed);
		};
		const done = () => {
			cleanup();
			resolve();
		};
		const closed = () => {
			cleanup();
			reject(new Error("Client disconnected"));
		};
		res.once("drain", done);
		res.once("close", closed);
		signal.addEventListener("abort", closed, { once: true });
		if (signal.aborted || res.destroyed) closed();
	});
}

/** Both /gateway start and the standalone CLI call this, with no agent session in the request path. */
export async function startGateway(
	engine: PmaEngine,
	options: GatewayOptions = {},
	router = new RouteRouter(engine),
): Promise<GatewayHandle> {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 8787;
	if (host !== "localhost" && !isIP(host)) throw new Error("Bind must be localhost or an explicit IP address");
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid gateway port");
	for (const value of [options.timeoutMs, options.maxBodyBytes, options.maxConcurrent])
		if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error("Gateway limits must be positive integers");
	const release = await claim(engine.agentDir);
	let server: Server;
	let usage: GatewayUsage;
	try {
		usage = new GatewayUsage(engine.agentDir);
		try {
			await usage.restore();
		} catch (error) {
			usage.close();
			throw error;
		}
	} catch (error) {
		await release();
		throw error;
	}
	const controllers = new Set<AbortController>();
	const pending = new Set<Promise<void>>();
	let active = 0;
	const maxBody = options.maxBodyBytes ?? 16 << 20;
	const maxConcurrent = options.maxConcurrent ?? 64;
	let closing = false;
	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const path = new URL(req.url ?? "/", "http://gateway").pathname;
		const proto: Protocol = path === "/v1/messages" ? "messages" : path === "/v1/chat/completions" ? "chat" : "responses";
		const controller = new AbortController();
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs ?? 120_000)]);
		controllers.add(controller);
		const gone = () => controller.abort();
		req.once("aborted", gone);
		res.once("close", gone);
		let finish: ReturnType<GatewayUsage["reserve"]> | undefined;
		const started = Date.now();
		let status = 500;
		let routeName = "";
		let measured = noUsage();
		let chosen: string | undefined;
		let reservation = 0;
		let tookSlot = false;
		const commit = (sse: boolean) => {
			if (!res.headersSent)
				res.writeHead(200, {
					"content-type": sse ? "text/event-stream" : "application/json",
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
					...(sse ? { "x-accel-buffering": "no" } : {}),
				});
		};
		try {
			if (closing) throw new GatewayError(503, "Gateway is shutting down");
			if (req.headers.origin) throw new GatewayError(403, "Browser-origin requests are disabled");
			if (path === "/healthz" && req.method === "GET") {
				json(res, 200, { ok: true });
				return;
			}
			const key = authenticate(engine.agentDir, req);
			if (path === "/stats" && req.method === "GET") {
				if (!key.admin) throw new GatewayError(403, "An admin key is required");
				json(res, 200, usage.stats());
				return;
			}
			if (path === "/v1/models" && req.method === "GET") {
				const routes = readRoutes(engine.agentDir).routes;
				const direct = (await engine.models.getAvailable(undefined, { signal })).map((m) => `${m.provider}/${m.id}`);
				const ids = [...new Set([...routes.map((r) => r.id), ...direct])].filter((id) => permits(key, id));
				json(res, 200, { object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "pi-multi-account" })) });
				return;
			}
			if (req.method !== "POST" || !["/v1/messages", "/v1/chat/completions", "/v1/responses"].includes(path))
				throw new GatewayError(404, "Unknown gateway endpoint");
			if (active >= maxConcurrent) throw new GatewayError(429, "Gateway concurrency limit reached", "rate_limit_error");
			active++;
			tookSlot = true;
			const body = await bodyOf(req, maxBody, signal);
			const nativeHeaders: Record<string, string> = {};
			for (const name of ["anthropic-beta", "anthropic-version", "openai-beta"]) {
				const value = req.headers[name];
				if (typeof value === "string") nativeHeaders[name] = value;
			}
			routeName = body.model as string;
			if (!permits(key, routeName)) throw new GatewayError(403, "This key cannot use the requested model");
			let route = readRoutes(engine.agentDir).routes.find((r) => r.id === routeName);
			if (!route) {
				const split = routeName.indexOf("/");
				if (split < 1) throw new GatewayError(404, "Unknown route or model");
				const target = { provider: routeName.slice(0, split), model: routeName.slice(split + 1) };
				try {
					engine.resolve(target);
				} catch {
					throw new GatewayError(404, "Unknown route or model; refresh the catalog");
				}
				route = { id: routeName, mode: "order", targets: [target], translate: true };
			}
			const session = req.headers["x-session-id"] ?? req.headers["session-id"];
			if (session !== undefined && (typeof session !== "string" || session.length > 256)) throw new GatewayError(400, "Invalid session id");
			const sessionId = session ? createHash("sha256").update(`${key.id}\0${session}`).digest("hex") : undefined;
			const targets = await router.candidates(route, sessionId);
			const outputLimit = Math.max(
				...targets.map((t) => {
					try {
						return engine.resolve(t).model.maxTokens;
					} catch {
						return 8192;
					}
				}),
			);
			// Reserve a conservative byte-based input upper bound and the model's full output ceiling.
			reservation = Buffer.byteLength(JSON.stringify(body)) + outputLimit;
			finish = usage.reserve(key, reservation);
			let lastFailure: UpstreamFailure | undefined;
			for (const target of targets) {
				signal.throwIfAborted();
				let resolved: ResolvedTarget;
				try {
					resolved = engine.resolve(target);
				} catch {
					continue;
				}
				chosen = targetId({ provider: resolved.provider, account: resolved.account, model: resolved.model.id });
				try {
					const native = resolved.model.api !== "azure-openai-responses" && protocolOf(resolved.model.api) === proto;
					if (native) {
						const response = await nativeRequest(engine, resolved, proto, body, signal, options.fetch, nativeHeaders);
						measured = await relayNative(response, {
							streaming: body.stream === true,
							signal,
							commit,
							write: (chunk) => write(res, chunk, signal),
						});
					} else {
						if (route.translate === false)
							throw new GatewayError(400, "Cross-protocol translation is disabled on this route", "unsupported_translation");
						const decoded = decodeRequest(proto, body, resolved.model);
						const encoder = new ProtocolEncoder(
							proto,
							routeName,
							record(body.stream_options) && body.stream_options.include_usage === true,
						);
						let responseStatus: number | undefined;
						const stream = engine.stream(resolved, decoded.context, {
							...decoded.options,
							signal,
							sessionId,
							onResponse: (r) => {
								responseStatus = r.status;
							},
						});
						let start = "";
						let final;
						for await (const event of stream) {
							if (event.type === "error") throw new UpstreamFailure(responseStatus);
							if (event.type === "done") final = event.message;
							if (body.stream === true) {
								const chunk = encoder.encode(event);
								if (event.type === "start") {
									start += chunk;
									continue;
								}
								commit(true);
								if (start) {
									await write(res, start, signal);
									start = "";
								}
								await write(res, chunk, signal);
							}
						}
						if (!final) throw new UpstreamFailure(responseStatus);
						measured = {
							input: final.usage.input + final.usage.cacheRead + final.usage.cacheWrite,
							output: final.usage.output,
							tokens: final.usage.totalTokens,
							known: Number.isFinite(final.usage.totalTokens) && final.usage.totalTokens > 0,
						};
						if (body.stream !== true) {
							commit(false);
							await write(res, JSON.stringify(encodeResponse(proto, final, routeName)), signal);
						}
					}
					status = 200;
					router.succeeded(route, target, sessionId, measured.tokens);
					res.end();
					return;
				} catch (error) {
					lastFailure = error instanceof UpstreamFailure ? error : new UpstreamFailure(undefined);
					if (res.headersSent || signal.aborted) throw error;
					if (error instanceof GatewayError && !(error instanceof UpstreamFailure)) throw error;
					if (error instanceof UpstreamFailure && !retryable(error.upstreamStatus)) throw error;
				}
			}
			throw lastFailure ?? new UpstreamFailure(undefined, "All route targets failed before output");
		} catch (error) {
			status = signal.aborted ? (controller.signal.aborted ? 499 : 504) : error instanceof GatewayError ? error.status : 502;
			if (!res.destroyed) {
				if (res.headersSent) {
					if (!signal.aborted)
						await write(
							res,
							new ProtocolEncoder(proto, routeName).encode({ type: "error", reason: "error", error: {} as never }),
							signal,
						).catch(() => undefined);
					res.end();
				} else {
					if (!req.complete) res.setHeader("connection", "close");
					if (status === 429)
						res.setHeader("retry-after", String(error instanceof UpstreamFailure && error.retryAfter ? Math.ceil(error.retryAfter) : 1));
					json(res, status, {
						...(proto === "messages" ? { type: "error" } : {}),
						error: {
							type: error instanceof GatewayError ? error.code : "upstream_error",
							message:
								error instanceof GatewayError
									? error.message
									: signal.aborted
										? "Request cancelled or timed out"
										: "Provider unavailable; check the local account configuration",
						},
					});
				}
			}
		} finally {
			finish?.({
				route: routeName,
				target: chosen,
				status,
				input: measured.known ? measured.input : reservation,
				output: measured.known ? measured.output : 0,
				tokens: measured.known ? measured.tokens : reservation,
				estimated: !measured.known,
				ms: Date.now() - started,
			});
			if (tookSlot) active--;
			controllers.delete(controller);
			req.off("aborted", gone);
			res.off("close", gone);
		}
	}
	try {
		server = createServer((req, res) => {
			const task = handle(req, res);
			pending.add(task);
			void task.finally(() => pending.delete(task)).catch(() => res.destroy());
		});
		server.headersTimeout = 15_000;
		server.requestTimeout = 30_000;
		server.keepAliveTimeout = 5000;
		server.maxHeadersCount = 100;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, host, () => {
				server.off("error", reject);
				resolve();
			});
		});
	} catch (error) {
		usage.close();
		await release();
		throw error;
	}
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No gateway address");
	let closePromise: Promise<void> | undefined;
	return {
		url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`,
		close() {
			return (closePromise ??= (async () => {
				closing = true;
				for (const controller of controllers) controller.abort();
				await new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				});
				await Promise.allSettled([...pending]);
				usage.close();
				await release();
			})());
		},
	};
}
