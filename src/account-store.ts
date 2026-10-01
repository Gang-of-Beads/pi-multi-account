import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ACCOUNTS_FILE, type AccountsData, AccountStore, parseAccountsData } from "@narumitw/pi-accounts/src/account-store.ts";
import type { AccountStorageBackend } from "@narumitw/pi-accounts/src/storage.ts";

/**
 * Account store whose reads skip the cross-process write lock.
 *
 * pi-accounts reads under the same exclusive proper-lockfile lock that
 * writers take. Every pi process sharing HOME (pi-web daemons, the TUI,
 * subagents, background tasks) reads on each turn, so readers queued on each
 * other and on writers until one ran out of retries and the model request
 * failed with "account store unreadable: Lock file is already being held".
 * Writers replace the file with an atomic rename, so a plain read always sees
 * one complete version; writes still go through the locked backend.
 */
export class LocklessReadAccountStore extends AccountStore {
	constructor(
		readonly filePath: string = join(getAgentDir(), ACCOUNTS_FILE),
		backend?: AccountStorageBackend,
	) {
		super(backend);
	}

	override async readAsync(): Promise<AccountsData> {
		return parseAccountsData(await readIfExists(this.filePath));
	}
}

async function readIfExists(filePath: string): Promise<string | undefined> {
	try {
		return await readFile(filePath, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}
