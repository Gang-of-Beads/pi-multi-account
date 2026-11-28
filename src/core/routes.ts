import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { PmaEngine, ResolvedTarget, Target } from "./engine.ts";
import { PROVIDER_APIS, type ProviderApi } from "./provider-defs.ts";
import { positive, readJson, record, updateJson } from "./storage.ts";

export interface Route {
	id: string;
	mode: "order" | "rotate" | "weighted" | "usage";
	targets: Target[];
	translate?: boolean;
}
export interface RoutesFile {
	version: 1;
	routes: Route[];
}
export const routesPath = (dir: string): string => join(dir, "pi-multi-account-routes.json");
export function parseTarget(reference: string): Target {
	const slash = reference.indexOf("/");
	if (slash < 1) throw new Error("Use provider[@account]/model for each target");
	const [provider, account, ...extra] = reference.slice(0, slash).split("@");
	if (extra.length) throw new Error("Use only one account qualifier per target");
	// `provider/model:api` pins the shape this target is served on (`@account` stays the account).
	const [model, api] = reference.slice(slash + 1).split(":");
	const target = { provider, ...(account === undefined ? {} : { account }), model: model!, ...(api === undefined ? {} : { api: api as ProviderApi }) };
	validateRoutes({ version: 1, routes: [{ id: "validate-target", mode: "order", targets: [target] }] });
	return target;
}
export function validateRoutes(value: unknown): RoutesFile {
	if (!record(value) || value.version !== 1 || !Array.isArray(value.routes))
		throw new Error("Invalid routes file: expected version 1 and routes[]");
	const names = new Set<string>();
	for (const r of value.routes) {
		if (
			!record(r) ||
			typeof r.id !== "string" ||
			!/^[a-zA-Z0-9._-]{1,64}$/.test(r.id) ||
			names.has(r.id) ||
			!["order", "rotate", "weighted", "usage"].includes(String(r.mode)) ||
			!Array.isArray(r.targets) ||
			!r.targets.length ||
			r.targets.length > 100 ||
			(r.translate !== undefined && typeof r.translate !== "boolean")
		)
			throw new Error("Invalid or duplicate route");
		names.add(r.id);
		for (const t of r.targets)
			if (
				!record(t) ||
				typeof t.provider !== "string" ||
				!/^[a-zA-Z0-9._-]{1,100}$/.test(t.provider) ||
				typeof t.model !== "string" ||
				!t.model ||
				t.model.length > 200 ||
				/[\s\x00-\x1f]/.test(t.model) ||
				(t.account !== undefined && (typeof t.account !== "string" || !/^(\*|[a-zA-Z0-9._-]{1,64})$/.test(t.account))) ||
				(t.weight !== undefined && (!positive(t.weight) || t.weight > 1000)) ||
				(t.api !== undefined && !PROVIDER_APIS.includes(t.api as ProviderApi))
			)
				throw new Error(`Invalid target in route ${r.id}`);
	}
	return value as unknown as RoutesFile;
}
export function readRoutes(dir: string): RoutesFile {
	return validateRoutes(readJson(routesPath(dir), { version: 1, routes: [] }));
}
export async function saveRoute(dir: string, route: Route): Promise<void> {
	validateRoutes({ version: 1, routes: [route] });
	await updateJson<RoutesFile, void>(routesPath(dir), { version: 1, routes: [] }, async (raw) => {
		const file = validateRoutes(raw);
		const index = file.routes.findIndex((r) => r.id === route.id);
		if (index < 0) file.routes.push(route);
		else file.routes[index] = route;
		return { value: file, result: undefined };
	});
}
export const targetId = (t: Target): string => `${t.provider}/${t.account ?? ""}/${t.model}`;
export const retryable = (status?: number): boolean =>
	status === undefined || status === 200 || [401, 403, 404, 408, 429].includes(status) || status >= 500;
export function errorMessage(model: Model<Api>, message: string, aborted = false): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: aborted ? "aborted" : "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
}

/** The same scheduler is used by Pi's route providers and by the HTTP transport. */
export class RouteRouter {
	private cursors = new Map<string, number>();
	private used = new Map<string, number>();
	private sticky = new Map<string, { at: number; target: string }>();
	constructor(readonly engine: PmaEngine) {}
	async candidates(route: Route, session?: string): Promise<Target[]> {
		const targets: Target[] = [];
		for (const target of route.targets) {
			if (target.account !== "*") targets.push(target);
			else {
				const state = await this.engine.store.readProviderAsync(target.provider as never);
				const names = Object.keys(state.accounts).filter((n) => state.accounts[n]?.type === "oauth");
				if (state.active && names.includes(state.active)) (names.splice(names.indexOf(state.active), 1), names.unshift(state.active));
				for (const account of names) targets.push({ ...target, account });
			}
		}
		if (!targets.length) throw new Error(`Route ${route.id} has no usable accounts`);
		let start = 0;
		const cursor = this.cursors.get(route.id) ?? 0;
		if (route.mode === "weighted") {
			const total = targets.reduce((s, t) => s + (t.weight ?? 1), 0);
			let n = cursor % total;
			for (let i = 0; i < targets.length; i++) {
				n -= targets[i].weight ?? 1;
				if (n < 0) {
					start = i;
					break;
				}
			}
		} else if (route.mode === "rotate") start = cursor % targets.length;
		else if (route.mode === "usage")
			start = targets.reduce(
				(best, t, i) => ((this.used.get(targetId(t)) ?? 0) < (this.used.get(targetId(targets[best])) ?? 0) ? i : best),
				0,
			);
		const sticky = session ? this.sticky.get(`${route.id}\0${session}`) : undefined;
		if (sticky && Date.now() - sticky.at < 3_600_000) {
			const index = targets.findIndex((t) => targetId(t) === sticky.target);
			if (index >= 0) start = index;
		}
		this.cursors.set(route.id, (cursor + 1) % 1_000_000);
		return [...targets.slice(start), ...targets.slice(0, start)].filter(
			(t, i, all) => all.findIndex((a) => targetId(a) === targetId(t)) === i,
		);
	}
	succeeded(route: Route, target: Target, session: string | undefined, tokens = 1): void {
		this.used.set(targetId(target), (this.used.get(targetId(target)) ?? 0) + Math.max(1, tokens));
		if (session) {
			const key = `${route.id}\0${session}`;
			this.sticky.delete(key);
			this.sticky.set(key, { target: targetId(target), at: Date.now() });
		}
		while (this.sticky.size > 10_000) this.sticky.delete(this.sticky.keys().next().value!);
	}
	stream(route: Route | undefined, context: Context, options: SimpleStreamOptions = {}) {
		const routeName = route?.id ?? "removed-route";
		const output = createAssistantMessageEventStream();
		void (async () => {
			let last: AssistantMessage | undefined;
			try {
				if (!route) throw new Error("The route was removed");
				const candidates = await this.candidates(route, options.sessionId);
				for (const target of candidates) {
					options.signal?.throwIfAborted();
					let resolved: ResolvedTarget;
					try {
						resolved = this.engine.resolve(target);
					} catch {
						continue;
					}
					let status: number | undefined;
					let committed = false;
					const held: AssistantMessageEvent[] = [];
					try {
						const stream = this.engine.stream(resolved, structuredClone(context), {
							...options,
							maxRetries: 0,
							onResponse: async (r, m) => {
								status = r.status;
								await options.onResponse?.(r, m);
							},
						});
						for await (const event of stream) {
							if (event.type === "error") {
								last = event.error;
								if (committed || !retryable(status) || options.signal?.aborted) {
									output.push(event);
									output.end();
									return;
								}
								break;
							}
							if (event.type === "done") {
								if (!committed) for (const prior of held) output.push(prior);
								output.push(event);
								this.succeeded(route, target, options.sessionId, event.message.usage.totalTokens);
								output.end();
								return;
							}
							if (!committed) {
								held.push(event);
								if (event.type !== "start") {
									committed = true;
									for (const prior of held) output.push(prior);
									held.length = 0;
								}
							} else output.push(event);
						}
					} catch {
						last = errorMessage(resolved.model, "Provider request failed", options.signal?.aborted);
						if (committed || !retryable(status) || options.signal?.aborted) {
							output.push({ type: "error", reason: last.stopReason === "aborted" ? "aborted" : "error", error: last });
							output.end();
							return;
						}
					}
				}
				throw new Error(last?.errorMessage ?? `Route ${route.id} exhausted its targets`);
			} catch {
				const model = { id: routeName, provider: "pma", api: "pma-route" } as Model<Api>;
				const error = errorMessage(
					model,
					`Route ${routeName} could not complete a request; check account availability and the route targets`,
					options.signal?.aborted,
				);
				output.push({ type: "error", reason: options.signal?.aborted ? "aborted" : "error", error });
				output.end();
			}
		})();
		return output;
	}
	provider(routes: readonly Route[]): import("@earendil-works/pi-ai").Provider {
		return {
			id: "pma",
			name: "Multi-account routes",
			auth: { apiKey: { name: "Local routes", resolve: async () => ({ auth: { apiKey: "local-route" } }) } },
			getModels: () =>
				routes.map((route) => {
					const models = route.targets.flatMap((t) => {
						const names =
							t.account === "*" ? Object.keys(this.engine.store.read().providers[t.provider as never]?.accounts ?? {}) : [t.account];
						return names.flatMap((account) => {
							try {
								return [this.engine.resolve({ ...t, account }).model];
							} catch {
								return [];
							}
						});
					});
					return {
						id: route.id,
						name: route.id,
						provider: "pma",
						api: "pma-route",
						baseUrl: "local:",
						reasoning: models.some((m) => m.reasoning),
						input: ["text", "image"],
						contextWindow: models.length ? Math.min(...models.map((m) => m.contextWindow)) : 128_000,
						maxTokens: models.length ? Math.min(...models.map((m) => m.maxTokens)) : 8192,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					};
				}),
			stream: (model, context, options) => this.stream(routes.find((r) => r.id === model.id)!, context, options as SimpleStreamOptions),
			streamSimple: (model, context, options) => this.stream(routes.find((r) => r.id === model.id)!, context, options),
		};
	}
}
