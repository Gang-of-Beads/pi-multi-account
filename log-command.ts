/**
 * `/account-log` — read the debug log and check the stored credentials.
 *
 * Account problems are cross-process and after-the-fact: by the time a user
 * asks "why did that fail?", the failing token has usually been rotated away.
 * This command answers the two questions that follow a surprise 401 without
 * leaving the session: what happened (the log), and what is true right now
 * (a live probe of every stored account).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AccountStore } from "@narumitw/pi-accounts/src/accounts.ts";
import { readFileSync } from "node:fs";
import { credentialSummary, fingerprint, logInfo, logLevel, logPath } from "./debug-log.ts";
import { errorMessage } from "./errors.ts";
import { accountsNeedingRelogin, isCredentialSuspect } from "./refresh.ts";

const DEFAULT_TAIL_LINES = 20;

/** Last `count` lines of the debug log. */
export function tailLog(path: string, count: number): string[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const lines = raw.split("\n").filter((line) => line.trim().length > 0);
	return lines.slice(-count);
}

/** Compact, human-readable form of one JSONL log line. */
export function formatLogLine(line: string): string {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return line;
	}
	const { ts, event, host: _host, pid, rt, ...rest } = parsed;
	const time = typeof ts === "string" ? ts.slice(11, 19) : "??:??:??";
	const detail = Object.entries(rest)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
		.join(" ");
	return `${time} [${pid}/${rt}] ${String(event)} ${detail}`.trimEnd();
}

export type ProbeVerdict = "ok" | "revoked" | "rate_limited" | "unknown";

/** Map a probe response status onto what it says about the credential. */
export function verdictForStatus(status: number): ProbeVerdict {
	if (status === 401 || status === 403) return "revoked";
	if (status === 429) return "rate_limited";
	// 404 is the expected answer: the probe asks for a model that does not
	// exist, which the API only gets to reject *after* it has accepted the
	// token. Anything else non-5xx also means authentication succeeded.
	if (status < 500) return "ok";
	return "unknown";
}

/**
 * Ask Anthropic whether a stored access token is still accepted.
 *
 * Deliberately requests a non-existent model: authentication is checked before
 * the model is resolved, so a valid token answers 404 and an invalid one
 * answers 401 — a definitive auth check that consumes no tokens and no quota.
 */
export async function probeAccessToken(
	accessToken: string,
	fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; verdict: ProbeVerdict; detail?: string }> {
	try {
		const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				authorization: `Bearer ${accessToken}`,
				"anthropic-version": "2023-06-01",
				"anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "pi-multi-account-probe",
				max_tokens: 1,
				messages: [{ role: "user", content: "probe" }],
			}),
			signal: AbortSignal.timeout(20_000),
		});
		return { status: response.status, verdict: verdictForStatus(response.status) };
	} catch (error) {
		return { status: 0, verdict: "unknown", detail: errorMessage(error) };
	}
}

export function registerAccountLogCommand(pi: ExtensionAPI, store: AccountStore): void {
	pi.registerCommand("account-log", {
		description: "Show the pi-multi-account debug log, or check every stored account with /account-log check",
		handler: async (args, ctx) => {
			const argument = args.trim().toLowerCase();

			if (argument === "check") {
				const state = await store.readProviderAsync("anthropic");
				const names = Object.keys(state.accounts);
				if (names.length === 0) {
					ctx.ui.notify("No Anthropic accounts are stored.", "info");
					return;
				}
				ctx.ui.notify(`Checking ${names.length} Anthropic account(s)…`, "info");
				const lines: string[] = [];
				for (const name of names) {
					const credential = state.accounts[name];
					const result =
						credential?.type === "oauth"
							? await probeAccessToken(credential.access)
							: { status: 0, verdict: "unknown" as ProbeVerdict, detail: "not an oauth credential" };
					logInfo("account.probe", {
						account: name,
						active: state.active === name,
						status: result.status,
						verdict: result.verdict,
						detail: result.detail,
						credential: credentialSummary(credential),
					});
					const marks = [
						state.active === name ? "active" : undefined,
						isCredentialSuspect("anthropic", name) ? "rejected since last refresh" : undefined,
						accountsNeedingRelogin("anthropic", [name]).length > 0 ? "refresh failing" : undefined,
					].filter(Boolean);
					lines.push(
						`${name}: ${result.verdict}` +
							`${result.status ? ` (HTTP ${result.status})` : ""}` +
							`${marks.length > 0 ? ` · ${marks.join(" · ")}` : ""}` +
							` · token ${fingerprint(credential?.access) ?? "none"}`,
					);
				}
				const revoked = lines.filter((line) => line.includes(": revoked"));
				ctx.ui.notify(
					[`Anthropic accounts (active: ${state.active ?? "none"})`, ...lines].join("\n"),
					revoked.length > 0 ? "warning" : "info",
				);
				if (revoked.length > 0) {
					ctx.ui.notify("Re-login the revoked account(s) with /accounts → Re-login.", "warning");
				}
				return;
			}

			const requested = Number.parseInt(argument, 10);
			const count = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 200) : DEFAULT_TAIL_LINES;
			const path = logPath();
			const lines = tailLog(path, count);
			const header = `pi-multi-account log · level=${logLevel()} · ${path}`;
			if (lines.length === 0) {
				ctx.ui.notify(
					`${header}\n(empty — set PI_MULTI_ACCOUNT_LOG=debug for per-request detail, or PI_MULTI_ACCOUNT_LOG=0 to disable)`,
					"info",
				);
				return;
			}
			ctx.ui.notify([header, ...lines.map(formatLogLine)].join("\n"), "info");
		},
	});
}
