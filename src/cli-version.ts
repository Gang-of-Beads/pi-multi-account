/**
 * A vendor CLI version this extension claims on the wire.
 *
 * Both vendors gate on the client version: Anthropic's gateway refuses a model to a Claude Code
 * version below its minimum, and ChatGPT's Codex catalog hides models from an older Codex CLI.
 * Every source of a version is therefore a floor - a pin in the code, an environment minimum, the
 * CLI installed on the host - and the highest one is claimed, so no stale source can drag the claim
 * below what a model needs.
 */
import { execFileSync } from "node:child_process";

/** The wire shape of a claimed version: dotted numbers, optional pre-release suffix. */
const CLI_VERSION_SHAPE = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?";

/** One source for that shape, so the probe and the validator cannot drift apart. */
const CLI_VERSION_EXACT = new RegExp(`^${CLI_VERSION_SHAPE}$`);
const CLI_VERSION_IN_TEXT = new RegExp(`\\b(${CLI_VERSION_SHAPE})`);

/** A claim worth putting on the wire. */
export function isCliVersion(value: string | undefined): value is string {
	return value !== undefined && CLI_VERSION_EXACT.test(value);
}

/** Compare dotted numeric version prefixes; pre-release suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
	const parts = (value: string): number[] =>
		(/^\d+(?:\.\d+)*/.exec(value)?.[0] ?? "").split(".").map((part) => Number(part) || 0);
	const left = parts(a);
	const right = parts(b);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff < 0 ? -1 : 1;
	}
	return 0;
}

/** The highest of the pin and every well-formed floor; a malformed floor is dropped, not sent. */
export function highestVersion(pin: string, ...floors: Array<string | undefined>): string {
	return floors
		.filter(isCliVersion)
		.reduce((highest, candidate) => (compareVersions(candidate, highest) > 0 ? candidate : highest), pin);
}

/**
 * The version `<command> --version` prints, or undefined when the CLI is not on PATH or misbehaves.
 * Callers memoize: a spawn per request would be absurd.
 */
export function probeCliVersion(command: string): string | undefined {
	try {
		const out = execFileSync(command, ["--version"], { timeout: 3000, encoding: "utf8" });
		return CLI_VERSION_IN_TEXT.exec(out)?.[1];
	} catch {
		return undefined;
	}
}
