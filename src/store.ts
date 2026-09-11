import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fingerprint, type FileFingerprint } from "./hash.ts";
import { resolveDbPath } from "./paths.ts";

/** One mapped region of a file. */
export type Section = {
	seq: number;
	startLine: number;
	endLine: number;
	kind: string;
	name: string;
	note: string;
};

export type SummaryMode = "mapped" | "blob";

/**
 * One summary per file. A file is mapped whole or summarized as a blob; there is no
 * partially mapped state, so `mode` alone says whether the rows mean anything.
 */
export type CachedSummary = {
	path: string;
	absPath: string;
	hash: string;
	lines: number;
	bytes: number;
	mtimeMs: number;
	model: string;
	mode: SummaryMode;
	overview: string;
	createdAt: string;
	sections: Section[];
};

export type Freshness = "fresh" | "stale" | "missing";

/** Everything needed to write one summary, in one transaction. */
export type SummaryInput = {
	path: string;
	absPath: string;
	fp: FileFingerprint;
	model: string;
	mode: SummaryMode;
	overview: string;
	sections: Section[];
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS file_summary (
  path          TEXT PRIMARY KEY,
  abs_path      TEXT NOT NULL,
  hash          TEXT NOT NULL,
  lines         INTEGER NOT NULL,
  bytes         INTEGER NOT NULL,
  mtime_ms      INTEGER NOT NULL,
  model         TEXT NOT NULL,
  mode          TEXT NOT NULL,
  overview      TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS file_section (
  path       TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  note       TEXT NOT NULL,
  PRIMARY KEY (path, seq)
);
`;

/** Databases this process has already opened, so the first touch can report the path. */
const seenDbs = new Set<string>();

export type OpenResult = { db: DatabaseSync; dbPath: string; firstTouch: boolean };

export function openDb(cwd: string): OpenResult {
	const dbPath = resolveDbPath(cwd);
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new DatabaseSync(dbPath);
	// busy_timeout FIRST: switching the journal mode requires an exclusive lock, so with the
	// default zero timeout two processes starting at once make it fail immediately with
	// SQLITE_BUSY ("database is locked") instead of waiting their turn. Setting the timeout
	// afterwards leaves the one statement that needs it most unprotected.
	db.exec("PRAGMA busy_timeout = 3000");
	db.exec("PRAGMA journal_mode = WAL");
	const firstTouch = !seenDbs.has(dbPath);
	if (firstTouch) seenDbs.add(dbPath);
	return { db, dbPath, firstTouch };
}

/** Create tables if absent. Cheap enough to run on every connection. */
export function ensureSchema(db: DatabaseSync): void {
	db.exec(SCHEMA);
}

/**
 * Read a cached summary and its sections.
 *
 * Sections are a separate table rather than one text blob so a caller can query ranges
 * ("what is at line 1200?") without parsing prose out of an overview.
 */
export function readSummary(db: DatabaseSync, path: string): CachedSummary | undefined {
	const row = db.prepare("SELECT * FROM file_summary WHERE path = ?").get(path) as
		| Record<string, unknown>
		| undefined;
	if (!row) return undefined;

	const sections = db
		.prepare(
			"SELECT seq, start_line, end_line, kind, name, note FROM file_section WHERE path = ? ORDER BY seq",
		)
		.all(path) as Array<Record<string, unknown>>;

	return {
		path: String(row.path),
		absPath: String(row.abs_path),
		hash: String(row.hash),
		lines: Number(row.lines),
		bytes: Number(row.bytes),
		mtimeMs: Number(row.mtime_ms),
		model: String(row.model),
		mode: row.mode === "mapped" ? "mapped" : "blob",
		overview: String(row.overview),
		createdAt: String(row.created_at),
		sections: sections.map((s) => ({
			seq: Number(s.seq),
			startLine: Number(s.start_line),
			endLine: Number(s.end_line),
			kind: String(s.kind),
			name: String(s.name),
			note: String(s.note),
		})),
	};
}

/**
 * Compare a cached entry against the file on disk.
 *
 * `mtime` and `size` are only a cheap pre-check: when they match, the file is unchanged
 * and no hashing is needed. When they differ the hash decides, which is what catches a
 * rewrite that lands within the same mtime tick.
 *
 * Re-summarizing costs a model call, so this errs toward hashing rather than toward
 * calling the model on a maybe-changed file.
 */
export async function freshnessOf(
	entry: Pick<CachedSummary, "hash" | "absPath" | "bytes" | "mtimeMs">,
): Promise<Freshness> {
	let stats;
	try {
		stats = await stat(entry.absPath);
	} catch {
		return "missing";
	}
	if (stats.size === entry.bytes && Math.round(stats.mtimeMs) === entry.mtimeMs) {
		return "fresh";
	}
	try {
		const fp = await fingerprint(entry.absPath);
		return fp.hash === entry.hash ? "fresh" : "stale";
	} catch {
		return "missing";
	}
}

/**
 * Replace a file's summary and its sections in one transaction, so a cache hit can never
 * pair an old overview with new line ranges.
 */
export function writeSummary(db: DatabaseSync, input: SummaryInput): void {
	db.exec("BEGIN IMMEDIATE");
	try {
		db.prepare(
			`INSERT INTO file_summary
			   (path, abs_path, hash, lines, bytes, mtime_ms, model, mode, overview, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(path) DO UPDATE SET
			   abs_path = excluded.abs_path,
			   hash = excluded.hash,
			   lines = excluded.lines,
			   bytes = excluded.bytes,
			   mtime_ms = excluded.mtime_ms,
			   model = excluded.model,
			   mode = excluded.mode,
			   overview = excluded.overview,
			   created_at = excluded.created_at`,
		).run(
			input.path,
			input.absPath,
			input.fp.hash,
			input.fp.lines,
			input.fp.bytes,
			input.fp.mtimeMs,
			input.model,
			input.mode,
			input.overview,
			new Date().toISOString(),
		);

		db.prepare("DELETE FROM file_section WHERE path = ?").run(input.path);
		const insertSection = db.prepare(
			"INSERT INTO file_section (path, seq, start_line, end_line, kind, name, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		for (const s of input.sections) {
			insertSection.run(input.path, s.seq, s.startLine, s.endLine, s.kind, s.name, s.note);
		}

		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}
