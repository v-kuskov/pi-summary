import { existsSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Extensions the read guard leaves alone.
 *
 * Prose and notes are read whole - they are written to be read in order, and refusing a
 * README because of its length only takes the file away, while the map of one adds nothing a
 * skim does not. The limit exists for source files, where a wrong guess about where a symbol
 * lives costs a wasted call.
 */
const UNGUARDED_EXTENSIONS = new Set([".md", ".txt"]);

/**
 * True when the read guard should leave this path to the built-in `read` tool.
 *
 * A path with no extension is unguarded too: `Makefile`, `Dockerfile`, `.gitignore` and
 * `LICENSE` are prose or build config, and `extname` reports `""` for all of them
 * (including the dotfile, whose leading dot is the whole basename, not an extension).
 */
export function isUnguardedPath(absPath: string): boolean {
	const ext = extname(absPath).toLowerCase();
	return ext === "" || UNGUARDED_EXTENSIONS.has(ext);
}

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
