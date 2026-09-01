/**
 * User-facing pool management: `/pools`, `/pool-create`, `/pool-add`,
 * `/pool-remove`, `/pool-delete`.
 *
 * A pool is created through a short flow — name it, pick the accounts it may
 * use ("every current account" or a specific ordered list) — and immediately
 * registers a provider with that name, so it shows up in `/model` right away.
 * Definitions persist in `~/.pi/agent/pi-multi-account-pools.json` and are
 * re-registered on every session start.
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type { AccountStore } from "@narumitw/pi-accounts/src/accounts.ts";
import { parseAccountName } from "@narumitw/pi-accounts/src/accounts.ts";
import { logInfo } from "./debug-log.ts";
import { type PoolRuntime } from "./pool.ts";
import {
	checkPoolName,
	deletePool,
	NATIVE_POOL_NAME,
	readPools,
	upsertPool,
	type PoolAccounts,
	type PoolDefinition,
} from "./pools-store.ts";

type PoolModel = ProviderModelConfig & Record<string, unknown>;

/** Anthropic models as pi currently sees them, for pool provider catalogues. */
function readAnthropicModels(ctx: ExtensionContext): PoolModel[] {
	return ctx.modelRegistry
		.getAvailable()
		.filter((model) => model.provider === "anthropic")
		.map(({ provider: _provider, baseUrl: _baseUrl, ...model }) => ({ ...model })) as PoolModel[];
}

/** Names a pool may not take because something else already uses them. */
async function takenProviderNames(ctx: ExtensionContext, store: AccountStore): Promise<Set<string>> {
	const taken = new Set<string>();
	for (const id of ctx.modelRegistry.getRegisteredProviderIds()) {
		taken.add(id);
	}
	try {
		const state = await store.readProviderAsync("anthropic");
		for (const name of Object.keys(state.accounts)) taken.add(`anthropic-${name}`);
	} catch {
		// Store unreadable: collision checks degrade to registry ids only.
	}
	return taken;
}

/** Accounts currently stored, in store order. */
async function storedAccountNames(store: AccountStore): Promise<string[]> {
	try {
		const state = await store.readProviderAsync("anthropic");
		return Object.keys(state.accounts);
	} catch {
		return [];
	}
}

/** One-line status of a pool, for `/pools`. */
function describePool(definition: PoolDefinition, available: string[]): string {
	const serving = definition.accounts === "all"
		? available
		: definition.accounts.filter((account) => available.includes(account));
	const members = definition.accounts === "all" ? "all accounts (dynamic)" : definition.accounts.join(", ");
	return `${definition.name} — ${members} · serving: ${serving.length > 0 ? serving.join(", ") : "(none available)"}`;
}

function splitArgs(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

/**
 * Register the pool commands and return the session-start sync hook.
 *
 * `sync` re-registers every stored pool definition (picking up account
 * changes, deletions and `all` pools growing with the store) and drops
 * registrations whose definition was deleted here or by another session.
 */
export function registerPoolCommands(
	pi: ExtensionAPI,
	store: AccountStore,
	runtime: PoolRuntime,
): { sync(ctx: ExtensionContext): Promise<void> } {
	const createPool = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const parts = splitArgs(args);
		const available = await storedAccountNames(store);
		if (available.length === 0) {
			ctx.ui.notify("No Anthropic accounts are stored yet — add one with /accounts first.", "error");
			return;
		}

		// Name: from the command line, or asked for. Validated against the
		// pool rules and every provider id already in use.
		let name: string | undefined = parts[0];
		for (;;) {
			if (name === undefined) {
				if (!ctx.hasUI) {
					ctx.ui.notify("Usage: /pool-create <name> [account ...]", "error");
					return;
				}
				const answer = await ctx.ui.input(
					"Name the aggregate pool — this becomes the provider id in /model:",
					"claude-pool",
				);
				if (answer === undefined) return; // cancelled
				name = answer.trim();
				if (name.length === 0) {
					ctx.ui.notify("A pool needs a name.", "warning");
					name = undefined;
					continue;
				}
			}
			const parsed = parseAccountName(name);
			const checked = parsed.ok ? checkPoolName(parsed.name) : ({ ok: false as const, error: parsed.error });
			if (!checked.ok) {
				ctx.ui.notify(checked.error, "warning");
				name = undefined;
				continue;
			}
			// The native override is the one deliberate collision; everything
			// else must be a fresh id.
			if (checked.name !== NATIVE_POOL_NAME) {
				const taken = await takenProviderNames(ctx, store);
				if (taken.has(checked.name)) {
					ctx.ui.notify(`"${checked.name}" is already a provider. Pick another name.`, "warning");
					name = undefined;
					continue;
				}
			}
			name = checked.name;
			break;
		}

		// Accounts: explicit list from the command line, or picked interactively.
		let accounts: PoolAccounts;
		const named = parts.slice(1);
		if (named.length > 0) {
			const unknown = named.filter((account) => !available.includes(account));
			if (unknown.length > 0) {
				ctx.ui.notify(
					`Unknown account(s): ${unknown.join(", ")}. Known: ${available.join(", ")}.`,
					"error",
				);
				return;
			}
			accounts = named;
		} else if (!ctx.hasUI) {
			// Headless default: every current account.
			accounts = "all";
		} else {
			const mode = await ctx.ui.select(
				`Pool "${name}" — which accounts may it use?`,
				["All accounts (dynamic)", "Pick specific accounts…"],
			);
			if (mode === undefined) return;
			if (mode === "All accounts (dynamic)") {
				accounts = "all";
			} else {
				const picked = await pickAccounts(ctx, available, `Pool "${name}" — add an account (failover order):`);
				if (picked === undefined) return;
				if (picked.length === 0) {
					ctx.ui.notify("A pool needs at least one account.", "warning");
					return;
				}
				accounts = picked;
			}
		}

		const definition: PoolDefinition = { name, accounts };
		const confirmed =
			!ctx.hasUI ||
			(await ctx.ui.confirm(
				"Create aggregate pool",
				`${name} — ${accounts === "all" ? "all accounts (dynamic)" : accounts.join(", ")}\n\n` +
					`Requests through ${name}/<model> try the accounts in order and fail over on 429/401/403/5xx. ` +
					"Create it?",
			));
		if (!confirmed) return;

		upsertPool(definition);
		runtime.registerPool(definition, readAnthropicModels(ctx));
		ctx.ui.notify(
			`Pool "${name}" created. Use it in /model as ${name}/<model>.` +
				(name === NATIVE_POOL_NAME ? " It replaced the native anthropic provider, as you chose." : ""),
			"info",
		);
	};

	pi.registerCommand("pools", {
		description: "List aggregate account pools and their status",
		handler: async (_args, ctx) => {
			const definitions = readPools();
			if (definitions.length === 0) {
				ctx.ui.notify(
					"No aggregate pools. Create one with /pool-create <name> [accounts...] — " +
						"it appears in /model under that name and fails over across its accounts.",
					"info",
				);
				return;
			}
			const available = await storedAccountNames(store);
			ctx.ui.notify(
				definitions.map((definition) => describePool(definition, available)).join("\n") +
					"\n\n/pool-create · /pool-add · /pool-remove · /pool-delete",
				"info",
			);
		},
	});

	pi.registerCommand("pool-create", {
		description: "Create an aggregate pool: /pool-create [name] [account ...]",
		handler: createPool,
	});

	pi.registerCommand("pool-add", {
		description: "Add accounts to a pool: /pool-add [name] [account ...]",
		handler: async (args, ctx) => {
			const definition = await pickPool(ctx, store, args, "Add accounts to which pool?");
			if (!definition) return;
			if (definition.accounts === "all") {
				ctx.ui.notify(
					`Pool "${definition.name}" tracks every account dynamically — nothing to add. ` +
						"If you wanted a fixed list, delete it and recreate with explicit accounts.",
					"info",
				);
				return;
			}
			const available = await storedAccountNames(store);
			const candidates = available.filter((account) => !definition.accounts.includes(account));
			if (candidates.length === 0) {
				ctx.ui.notify(`Pool "${definition.name}" already contains every stored account.`, "info");
				return;
			}
			const named = splitArgs(args).slice(1);
			const picked = named.length > 0
				? named.filter((account) => candidates.includes(account))
				: ctx.hasUI
					? await pickAccounts(ctx, candidates, `Add to "${definition.name}" (failover order):`)
					: undefined;
			if (!picked || picked.length === 0) {
				if (named.length > 0) {
					ctx.ui.notify(`Nothing added. Unknown account(s): ${named.filter((a) => !candidates.includes(a)).join(", ")}.`, "error");
				}
				return;
			}
			const updated: PoolDefinition = { name: definition.name, accounts: [...definition.accounts, ...picked] };
			upsertPool(updated);
			runtime.registerPool(updated, readAnthropicModels(ctx));
			ctx.ui.notify(`Added to "${definition.name}": ${picked.join(", ")}.`, "info");
		},
	});

	pi.registerCommand("pool-remove", {
		description: "Remove accounts from a pool: /pool-remove [name] [account ...]",
		handler: async (args, ctx) => {
			const definition = await pickPool(ctx, store, args, "Remove accounts from which pool?");
			if (!definition) return;
			const available = await storedAccountNames(store);
			const current = definition.accounts === "all" ? available : definition.accounts;
			const removable = current.filter((account) => available.includes(account));
			if (removable.length === 0) {
				ctx.ui.notify(`Pool "${definition.name}" has no stored accounts to remove.`, "info");
				return;
			}
			const named = splitArgs(args).slice(1);
			const picked = named.length > 0
				? named.filter((account) => removable.includes(account))
				: ctx.hasUI
					? await pickAccounts(ctx, removable, `Remove from "${definition.name}":`)
					: undefined;
			if (!picked || picked.length === 0) {
				if (named.length > 0) {
					ctx.ui.notify(`Nothing removed. Not in the pool: ${named.filter((a) => !removable.includes(a)).join(", ")}.`, "error");
				}
				return;
			}
			const remaining = current.filter((account) => !picked.includes(account));
			if (remaining.length === 0) {
				ctx.ui.notify(
					`Pool "${definition.name}" would be left empty. Delete it with /pool-delete ${definition.name} instead.`,
					"warning",
				);
				return;
			}
			// Removing from an "all" pool freezes it into the explicit remainder.
			const updated: PoolDefinition = { name: definition.name, accounts: remaining };
			upsertPool(updated);
			runtime.registerPool(updated, readAnthropicModels(ctx));
			ctx.ui.notify(`Removed from "${definition.name}": ${picked.join(", ")}.`, "info");
		},
	});

	pi.registerCommand("pool-delete", {
		description: "Delete an aggregate pool: /pool-delete [name]",
		handler: async (args, ctx) => {
			const definition = await pickPool(ctx, store, args, "Delete which pool?");
			if (!definition) return;
			const confirmed =
				!ctx.hasUI ||
				(await ctx.ui.confirm("Delete pool", `Delete "${definition.name}"? The provider disappears from /model.`));
			if (!confirmed) return;
			deletePool(definition.name);
			runtime.unregisterPool(definition.name);
			ctx.ui.notify(`Pool "${definition.name}" deleted.`, "info");
		},
	});

	logInfo("pool.commands_registered", {});

	return {
		async sync(ctx) {
			const definitions = readPools();
			const models = readAnthropicModels(ctx);
			for (const definition of definitions) {
				runtime.registerPool(definition, models);
			}
			// Definitions deleted here or by another session must not linger in /model.
			const defined = new Set(definitions.map((pool) => pool.name));
			for (const name of runtime.registeredPoolNames()) {
				if (!defined.has(name)) runtime.unregisterPool(name);
			}
		},
	};
}

/** Ask for a pool by name when the command line does not name one. */
async function pickPool(
	ctx: ExtensionCommandContext,
	store: AccountStore,
	args: string,
	title: string,
): Promise<PoolDefinition | undefined> {
	const definitions = readPools();
	if (definitions.length === 0) {
		ctx.ui.notify("No aggregate pools yet. Create one with /pool-create.", "info");
		return undefined;
	}
	const name = splitArgs(args)[0];
	if (name) {
		const found = definitions.find((pool) => pool.name === name);
		if (!found) {
			ctx.ui.notify(
				`No pool named "${name}". Existing: ${definitions.map((pool) => pool.name).join(", ")}.`,
				"error",
			);
			return undefined;
		}
		return found;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify(
			`Pass a pool name. Existing: ${definitions.map((pool) => pool.name).join(", ")}.`,
			"error",
		);
		return undefined;
	}
	const available = await storedAccountNames(store);
	const selected = await ctx.ui.select(
		title,
		definitions.map((pool) => `${pool.name} — ${pool.accounts === "all" ? "all accounts" : pool.accounts.filter((a) => available.includes(a)).length} account(s)`),
	);
	const pickedName = selected?.split(" — ")[0];
	return definitions.find((pool) => pool.name === pickedName);
}

/**
 * Multi-select accounts, one pick at a time, in failover order.
 * Returns undefined when cancelled, [] when "Done" was chosen first.
 */
async function pickAccounts(
	ctx: ExtensionCommandContext,
	candidates: string[],
	title: string,
): Promise<string[] | undefined> {
	const picked: string[] = [];
	const remaining = [...candidates];
	for (;;) {
		const options = [...remaining, "✓ Done"];
		const choice = await ctx.ui.select(`${title} [picked: ${picked.join(", ") || "none"}]`, options);
		if (choice === undefined) return picked.length > 0 ? picked : undefined;
		if (choice === "✓ Done") return picked;
		const index = remaining.indexOf(choice);
		if (index >= 0) {
			remaining.splice(index, 1);
			picked.push(choice);
		}
		if (remaining.length === 0) return picked;
	}
}
