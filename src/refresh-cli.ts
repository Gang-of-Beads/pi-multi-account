/**
 * Standalone credential refresh, for machines that are not running pi.
 *
 * The in-extension sweep (refresh.ts) only exists while a pi session does: it
 * starts on `session_start` and stops on `session_shutdown`. A machine that
 * sits idle for a day therefore lets every access token lapse, and the next
 * person to open a session pays a refresh — or, if the refresh token aged out
 * too, a re-login.
 *
 * This entrypoint runs one sweep and exits, so a systemd timer or launchd
 * agent can keep an idle machine's credentials current. It deliberately does
 * NOT start a pi session, make a model request, or hold any lock longer than
 * the account-store write needs.
 *
 * Usage:
 *   node <pi's jiti> refresh-cli.ts [--window <minutes>] [--force] [--json]
 *
 *   --window N   refresh credentials expiring within N minutes (default 45)
 *   --force      refresh every account regardless of expiry
 *   --json       machine-readable output, one object
 *
 * Why the default window is wider than the in-session skew (5 min): an active
 * pi session sweeps every 60s and will always win the race, so this timer only
 * ever acts on a machine where nothing else is looking after the tokens.
 * Overlapping with a live session is safe anyway — the refresh runs under the
 * shared account-store lock and a superseded credential is detected — but not
 * racing it at all is cheaper.
 *
 * Exit codes: 0 when every due account ended up with a live credential
 * (including "another writer already refreshed it"), 1 when at least one
 * account still needs attention (a re-login, usually).
 */
import { AccountStore } from "@narumitw/pi-accounts/src/accounts.ts";
import { anthropicAdapter } from "./adapters.ts";
import { fingerprint, logInfo } from "./debug-log.ts";
import { conciseRefreshFailure } from "./errors.ts";
import { refreshAccountCredential } from "./refresh.ts";

interface AccountOutcome {
	account: string;
	action: "refreshed" | "still-valid" | "failed" | "skipped";
	expiresInMin: number;
	before?: string;
	after?: string;
	detail?: string;
}

function parseArgs(argv: string[]): { windowMs: number; force: boolean; json: boolean } {
	let windowMinutes = 45;
	const windowIndex = argv.indexOf("--window");
	if (windowIndex >= 0) {
		const parsed = Number.parseInt(argv[windowIndex + 1] ?? "", 10);
		if (Number.isFinite(parsed) && parsed > 0) windowMinutes = parsed;
	}
	return {
		windowMs: windowMinutes * 60 * 1000,
		force: argv.includes("--force"),
		json: argv.includes("--json"),
	};
}

async function main(): Promise<number> {
	const { windowMs, force, json } = parseArgs(process.argv.slice(2));
	const store = new AccountStore();
	const adapter = anthropicAdapter();
	const now = Date.now();

	const state = await store.readProviderAsync("anthropic");
	const names = Object.keys(state.accounts);
	const outcomes: AccountOutcome[] = [];

	for (const account of names) {
		const credential = state.accounts[account];
		const expiresInMin = credential ? Math.round((credential.expires - now) / 60000) : 0;
		if (!credential || credential.type !== "oauth") {
			outcomes.push({ account, action: "skipped", expiresInMin, detail: "no stored oauth credential" });
			continue;
		}
		if (!force && credential.expires > now + windowMs) {
			outcomes.push({ account, action: "still-valid", expiresInMin, after: fingerprint(credential.access) });
			continue;
		}
		try {
			const refreshed = await refreshAccountCredential(store, adapter, account, credential, now, { force });
			const changed = refreshed.access !== credential.access;
			outcomes.push({
				account,
				action: changed ? "refreshed" : "still-valid",
				expiresInMin: Math.round((refreshed.expires - now) / 60000),
				...(changed ? { before: fingerprint(credential.access) } : {}),
				after: fingerprint(refreshed.access),
			});
		} catch (error) {
			outcomes.push({
				account,
				action: "failed",
				expiresInMin,
				before: fingerprint(credential.access),
				detail: conciseRefreshFailure(error),
			});
		}
	}

	const failed = outcomes.filter((o) => o.action === "failed");
	logInfo("refresh.cli", {
		accounts: names.length,
		refreshed: outcomes.filter((o) => o.action === "refreshed").length,
		failed: failed.length,
		windowMinutes: Math.round(windowMs / 60000),
		force,
	});

	if (json) {
		process.stdout.write(`${JSON.stringify({ at: new Date(now).toISOString(), outcomes }, null, 2)}\n`);
	} else if (outcomes.length === 0) {
		process.stdout.write("No Anthropic accounts stored; nothing to refresh.\n");
	} else {
		for (const o of outcomes) {
			const window = `${o.expiresInMin >= 0 ? "expires in" : "expired"} ${Math.abs(o.expiresInMin)}min`;
			const tokens = o.before ? ` ${o.before} → ${o.after}` : o.after ? ` ${o.after}` : "";
			process.stdout.write(`${o.account}: ${o.action} (${window})${tokens}${o.detail ? ` — ${o.detail}` : ""}\n`);
		}
	}

	return failed.length > 0 ? 1 : 0;
}

main().then(
	(code) => process.exit(code),
	(error) => {
		process.stderr.write(`pi-multi-account refresh failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	},
);
