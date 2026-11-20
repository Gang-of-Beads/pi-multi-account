import { constants, openSync, fstatSync, readFileSync, closeSync } from "node:fs";
import { FileAccountStorageBackend } from "@narumitw/pi-accounts/src/storage.ts";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";

/** Atomic writers let readers avoid the exclusive write lock. Never follow credential symlinks. */
export function readJson<T>(path: string, missing: T): T {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return missing;
		throw error;
	}
	try {
		if (!fstatSync(fd).isFile()) throw new Error(`Not a regular file: ${path}`);
		try {
			return JSON.parse(readFileSync(fd, "utf8")) as T;
		} catch {
			throw new Error(`Invalid JSON file: ${path}`);
		}
	} finally {
		closeSync(fd);
	}
}

export async function updateJson<T, R>(path: string, missing: T, update: (value: T) => Promise<{ value: T; result: R }>): Promise<R> {
	return new FileAccountStorageBackend(path).withLockAsync(async (raw) => {
		let current = missing;
		if (raw !== undefined) {
			try {
				current = JSON.parse(raw) as T;
			} catch {
				throw new Error(`Invalid JSON file: ${path}`);
			}
		}
		const { value, result } = await update(current);
		return { result, next: `${JSON.stringify(value, null, 2)}\n` };
	});
}

/** Pi's native auth.json, using the same locked read-modify-write contract as named accounts. */
export function nativeCredentials(path: string): CredentialStore {
	const credential = (value: unknown): Credential | undefined => {
		if (value === undefined) return undefined;
		if (
			record(value) &&
			((value.type === "api_key" && (value.key === undefined || typeof value.key === "string")) ||
				(value.type === "oauth" &&
					typeof value.access === "string" &&
					typeof value.refresh === "string" &&
					typeof value.expires === "number" &&
					Number.isFinite(value.expires)))
		)
			return value as unknown as Credential;
		throw new Error("Invalid native credential record; refusing to overwrite it");
	};
	const load = () => {
		const value = readJson<unknown>(path, {});
		if (!record(value)) throw new Error("Invalid native credential store");
		return value;
	};
	return {
		async read(id, options) {
			options?.signal?.throwIfAborted();
			return credential(load()[id]);
		},
		async list() {
			return Object.entries(load()).map(([providerId, c]) => ({ providerId, type: credential(c)!.type }));
		},
		async modify(id, fn, options) {
			return updateJson<Record<string, Credential>, Credential | undefined>(path, {}, async (value) => {
				options?.signal?.throwIfAborted();
				if (!record(value)) throw new Error("Invalid native credential store");
				const next = credential(await fn(credential(value[id])));
				if (next !== undefined) value = { ...value, [id]: next };
				return { value, result: value[id] };
			});
		},
		async delete(id, options) {
			await updateJson<Record<string, Credential>, void>(path, {}, async (value) => {
				options?.signal?.throwIfAborted();
				if (!record(value)) throw new Error("Invalid native credential store");
				delete value[id];
				return { value, result: undefined };
			});
		},
	};
}

export function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function positive(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}
export const offline = (): boolean => /^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? "");
