import { readFile } from "node:fs/promises";
import { SummaryError } from "./error.ts";
import type { CachedSummary, Section } from "./store.ts";

/** A cached region together with the numbered excerpt of its span. */
export type RegionHit = {
	section: Section;
	excerpt: string;
};

/**
 * Resolve a `region` argument against a cached entry's rows, with no model call.
 *
 * The argument is a string and is read two ways, in order:
 *
 * 1. as a **name** — an exact match on a row's `name` first, then case-insensitively, so the
 *    symbol a reader copied out of the map resolves to the row that named it.
 * 2. failing that, as a **line number** — the row whose span contains it, so a reader who has
 *    a line in hand does not have to find the name first.
 *
 * The order is deliberate: a row named `42` and a request for line 42 are both "42", and the
 * map is a list of names, so reading it as a name takes precedence and the line reading is
 * the fallback. A miss returns `undefined`; the caller turns that into an error that names
 * what does exist, rather than spending a summarization the caller did not ask for.
 */
export function findRegion(entry: CachedSummary, region: string): Section | undefined {
	const wanted = region.trim();
	if (wanted.length === 0) return undefined;

	const byName = entry.sections.find((section) => section.name === wanted);
	if (byName) return byName;
	const lower = wanted.toLowerCase();
	const byNameCase = entry.sections.find((section) => section.name.toLowerCase() === lower);
	if (byNameCase) return byNameCase;

	const line = Number(wanted);
	if (Number.isInteger(line) && line >= 1) {
		return entry.sections.find((section) => line >= section.startLine && line <= section.endLine);
	}
	return undefined;
}

/**
 * The line-numbered excerpt of a region's span, read from the file on disk.
 *
 * The excerpt is numbered exactly the way the summarizer's input was (number, tab, line), so
 * a reader who has the map can copy a boundary into a `read` and land where the map promised.
 * The file is read rather than sliced out of the cache because the cache stores rows, not
 * text: the region's *where* is cached, its *what* is always the current file, so an edit
 * that moves a line is reflected in the excerpt without a new summary.
 */
export async function regionExcerpt(absPath: string, section: Section): Promise<string> {
	const text = (await readFile(absPath)).toString("utf-8");
	const lines = text.split("\n");
	// A line past the end cannot be real - the file shrank since it was summarized - so the
	// slice is clamped rather than allowed to run off the end.
	const last = Math.min(section.endLine, lines.length);
	const slice = lines.slice(section.startLine - 1, last);
	const width = String(section.endLine).length;
	return slice.map((line, i) => `${String(section.startLine + i).padStart(width)}\t${line}`).join("\n");
}

/**
 * The error for a `region` that matches no row.
 *
 * It names what the map *does* hold, so a caller can pick a real region from the message
 * instead of paying for another summary. The names come from the cached rows, so this reads
 * the same whether the miss was a typo or a line that fell in a gap.
 */
export function regionMiss(entry: CachedSummary, region: string): SummaryError {
	if (entry.sections.length === 0) {
		return new SummaryError(
			`${entry.path} has no line map to look a region up in - it was summarized as a blob`,
			`Read the file directly, or summarize it again to try for a map.`,
		);
	}
	const names = entry.sections.map((section) => `${section.name} (${section.startLine}-${section.endLine})`);
	const shown = names.slice(0, 30);
	const more = names.length > shown.length ? `, and ${names.length - shown.length} more` : "";
	// The names go in the message, not the hint: pi drops a thrown tool error's hint, and the
	// correction is exactly what a caller needs to see here.
	return new SummaryError(
		`no region "${region}" in ${entry.path}; regions here: ${shown.join(", ")}${more}`,
	);
}
