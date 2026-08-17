/**
 * Account-name helpers shared by the menu and the import flows.
 */
import { DEFAULT_PI_LOGIN_LABEL } from "@narumitw/pi-accounts/src/accounts.ts";

/** True for the reserved name that means "pi's own built-in login". */
export function isDefaultPiLoginName(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return (
		normalized === "default" ||
		normalized === "--default" ||
		normalized === DEFAULT_PI_LOGIN_LABEL.toLowerCase()
	);
}

/** Parse a comma/space separated account-name list, e.g. PI_MULTI_ACCOUNT_AUTO_IMPORT_NAMES. */
export function parseNameList(value: string | undefined): string[] {
	return (value ?? "")
		.split(/[,\s]+/)
		.map((entry) => entry.trim())
		.filter(Boolean);
}
