import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Walk up from `start` looking for a project root (a directory containing `.git`). */
export function findProjectRoot(start: string): string {
	let current = resolve(start);
	for (;;) {
		if (existsSync(join(current, ".git"))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) {
			return resolve(start);
		}
		current = parent;
	}
}

/** Per-project database path. */
export function resolveDbPath(cwd: string): string {
	return join(findProjectRoot(cwd), ".pi", "summaries.db");
}

/**
 * Cache key for a file: relative to the project root, `/`-separated, and
 * lowercased on win32 so `Src/Foo.ts` and `src/foo.ts` are one entry.
 */
export function cacheKey(absPath: string, root: string): string {
	const rel = relative(root, absPath);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		// Outside the project root — key on the absolute path instead.
		return normalizeKey(absPath);
	}
	return normalizeKey(rel);
}

function normalizeKey(value: string): string {
	const slashed = value.split(sep).join("/");
	return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

/** Resolve a `read`/`summary` path argument against cwd, stripping a leading `@`. */
export function resolveFilePath(input: string, cwd: string): string {
	const stripped = input.startsWith("@") ? input.slice(1) : input;
	return resolve(cwd, stripped);
}

export function isRegularFile(absPath: string): boolean {
	try {
		return statSync(absPath).isFile();
	} catch {
		return false;
	}
}
