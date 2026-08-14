/**
 * Subscription account credential discovery (read-only).
 *
 * Entry point `detectSubscriptionAccounts()` finds subscription-backed OAuth
 * accounts already logged in on this machine. Today it only knows the Claude
 * Code client (macOS Keychain or ~/.claude/.credentials.json); future
 * subscription clients (GitHub Copilot, OpenAI Codex, …) plug in here.
 *
 * Reading is ported from pi-claude-auth (MIT, github.com/pankajudhas81/pi-claude-auth,
 * keychain.ts) with logging removed and every write-back path stripped: this
 * module only READS credentials; nothing is ever written back.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SubscriptionClientId = "claude-code";

export interface SubscriptionCredentials {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	subscriptionType?: string;
}

export interface SubscriptionAccount {
	/** Which subscription client the credentials belong to. */
	client: SubscriptionClientId;
	label: string;
	/** Where the credentials were read from (e.g. keychain service name, "file"). */
	source: string;
	credentials: SubscriptionCredentials;
}

/**
 * Detect subscription accounts from every supported client.
 * Add future clients here (e.g. GitHub Copilot, OpenAI Codex).
 */
export function detectSubscriptionAccounts(): SubscriptionAccount[] {
	return readClaudeCodeAccounts().map((account) => ({
		client: "claude-code",
		...account,
	}));
}
const PRIMARY_SERVICE = "Claude Code-credentials";

function parseCredentials(raw: string): SubscriptionCredentials | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	const data = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth ?? parsed;
	const creds = data as {
		accessToken?: unknown;
		refreshToken?: unknown;
		expiresAt?: unknown;
		subscriptionType?: unknown;
		mcpOAuth?: unknown;
	};

	// Entries that only contain mcpOAuth are MCP server credentials, not
	// user accounts.
	if ((parsed as { mcpOAuth?: unknown }).mcpOAuth && !creds.accessToken) {
		return null;
	}

	if (
		typeof creds.accessToken !== "string" ||
		typeof creds.refreshToken !== "string" ||
		typeof creds.expiresAt !== "number"
	) {
		return null;
	}

	return {
		accessToken: creds.accessToken,
		refreshToken: creds.refreshToken,
		expiresAt: creds.expiresAt,
		subscriptionType:
			typeof creds.subscriptionType === "string" ? creds.subscriptionType : undefined,
	};
}

function readKeychainService(serviceName: string): string | null {
	try {
		return execFileSync(
			"/usr/bin/security",
			["find-generic-password", "-s", serviceName, "-w"],
			{ timeout: 2000, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
		).trim();
	} catch {
		return null;
	}
}

function listClaudeKeychainServices(): string[] {
	const services: string[] = [];
	const seen = new Set<string>();
	try {
		const dump = execSync("security dump-keychain", {
			timeout: 5000,
			maxBuffer: 10 * 1024 * 1024, // 10 MB
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const re = /"Claude Code-credentials(?:-[0-9a-f]+)?"/g;
		let match = re.exec(dump);
		while (match !== null) {
			const svc = match[0].slice(1, -1);
			if (!seen.has(svc)) {
				seen.add(svc);
				services.push(svc);
			}
			match = re.exec(dump);
		}
	} catch {
		// Fall through and try the primary service directly.
	}
	const ordered: string[] = [];
	if (seen.has(PRIMARY_SERVICE)) ordered.push(PRIMARY_SERVICE);
	for (const svc of services) {
		if (svc !== PRIMARY_SERVICE) ordered.push(svc);
	}
	if (ordered.length === 0) ordered.push(PRIMARY_SERVICE);
	return ordered;
}

function readCredentialsFile(): SubscriptionCredentials | null {
	try {
		const credPath = join(homedir(), ".claude", ".credentials.json");
		if (!existsSync(credPath)) return null;
		return parseCredentials(readFileSync(credPath, "utf8"));
	} catch {
		return null;
	}
}

function buildAccountLabels(credsList: SubscriptionCredentials[]): string[] {
	const baseLabels = credsList.map((creds) => {
		if (creds.subscriptionType) {
			const tier =
				creds.subscriptionType.charAt(0).toUpperCase() + creds.subscriptionType.slice(1);
			return `Claude ${tier}`;
		}
		return "Claude";
	});

	const counts = new Map<string, number>();
	for (const label of baseLabels) counts.set(label, (counts.get(label) ?? 0) + 1);

	const seen = new Map<string, number>();
	return baseLabels.map((base) => {
		if ((counts.get(base) ?? 0) <= 1) return base;
		const n = (seen.get(base) ?? 0) + 1;
		seen.set(base, n);
		return `${base} ${n}`;
	});
}

function readClaudeCodeAccounts(): Omit<SubscriptionAccount, "client">[] {
	const rawAccounts: Array<{ source: string; credentials: SubscriptionCredentials }> = [];

	if (process.platform !== "darwin") {
		const creds = readCredentialsFile();
		if (creds) rawAccounts.push({ source: "file", credentials: creds });
	} else {
		for (const serviceName of listClaudeKeychainServices()) {
			const raw = readKeychainService(serviceName);
			if (!raw) continue;
			const creds = parseCredentials(raw);
			if (!creds) continue;
			rawAccounts.push({ source: serviceName, credentials: creds });
		}
		if (rawAccounts.length === 0) {
			const creds = readCredentialsFile();
			if (creds) rawAccounts.push({ source: "file", credentials: creds });
		}
	}

	const labels = buildAccountLabels(rawAccounts.map((account) => account.credentials));
	return rawAccounts.map((account, index) => ({
		label: labels[index],
		source: account.source,
		credentials: account.credentials,
	}));
}