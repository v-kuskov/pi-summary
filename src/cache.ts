import { isRegularFile, resolveFilePath } from "./paths.ts";
import { ensureSchema, freshnessOf, openDb, readSummary } from "./store.ts";
import { summarizeFile } from "./summarize.ts";
import { cacheKey, findProjectRoot } from "./paths.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CachedSummary } from "./store.ts";

export type PeekResult = {
	entry: CachedSummary;
	dbPath: string;
	firstTouch: boolean;
};

/**
 * Read a fresh cached summary without ever calling a model.
 *
 * This is the read guard's hot path: a plain SQLite read when the file is unchanged, and
 * `undefined` the rest of the time.
 */
export async function peekFreshSummary(
	ctx: ExtensionContext,
	path: string,
): Promise<PeekResult | undefined> {
	const absPath = resolveFilePath(path, ctx.cwd);
	if (!isRegularFile(absPath)) return undefined;

	const root = findProjectRoot(ctx.cwd);
	const { db, dbPath, firstTouch } = openDb(ctx.cwd);
	try {
		ensureSchema(db);
		const cached = readSummary(db, cacheKey(absPath, root));
		if (!cached) return undefined;
		if ((await freshnessOf(cached)) !== "fresh") return undefined;
		return { entry: cached, dbPath, firstTouch };
	} finally {
		db.close();
	}
}

export { summarizeFile };
