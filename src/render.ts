import { type CachedSummary, type Section, normalizeImportance } from "./store.ts";

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * How long a tier-2 short phrase may run before it is cut.
 *
 * A tier-2 row gets the note's first sentence, which is normally short; this only bites a
 * note that never stops - one long sentence with no boundary to truncate at. 120 characters
 * keeps that row to about one line in a normal terminal, which is the whole point of the
 * tier: the supporting detail stays one glanceable line while the tier-3 rows keep the full
 * two-sentence note.
 */
const MAX_SHORT_NOTE_CHARS = 120;

/**
 * The note's first sentence, for a tier-2 row.
 *
 * The design is "one line of the note" rather than a paraphrase, so the cut is mechanical: up
 * to and including the first `.`, `?` or `!` that ends a sentence (or the whole note when the
 * model wrote none). A note with no sentence boundary at all - a run-on the model never
 * punctuated - is hard-capped with an ellipsis instead, because leaving it whole would push a
 * tier-2 row to the full note the tier exists to shorten.
 */
function firstSentence(note: string): string {
	const trimmed = note.trim();
	if (trimmed.length === 0) return "";

	// A boundary is terminal punctuation followed by whitespace or the end of the note, so an
	// abbreviation or a `node/fs`-style token mid-sentence does not cut the phrase short.
	const boundary = /[.?!](?=\s|$)/.exec(trimmed);
	if (boundary) return trimmed.slice(0, boundary.index + 1);

	if (trimmed.length <= MAX_SHORT_NOTE_CHARS) return trimmed;
	const cut = trimmed.slice(0, MAX_SHORT_NOTE_CHARS);
	const lastSpace = cut.lastIndexOf(" ");
	return `${lastSpace > 0 ? cut.slice(0, lastSpace) : cut}…`;
}

/**
 * Render the `## map` block from section rows, most important first.
 *
 * Rows are sorted by importance (3, then 2, then 1) and by line within a tier, so the map
 * leads with the few regions a reader must know and lets the incidental ones sink. The tier
 * decides how much of each row is shown:
 *
 * - **3** - the full row: span, kind, name and the note.
 * - **2** - span, kind, name, and the note's *first sentence*; the full note is still stored.
 * - **1** - span and name only.
 *
 * That is a display rule and nothing more. The stored row is always the whole note, so the
 * limit costs nothing to reverse and a drill-down still reads the full text.
 *
 * Only mapped rows appear. The summarizer is told to skip lines that do nothing, so a gap
 * in the numbers is its answer, not a missing entry, and saying so on every blank run, else
 * branch and closing brace would bury the rows that carry information. A gap is read as
 * "nothing mapped here".
 *
 * A blob entry has no rows, and the empty block says so rather than fabricating a region that
 * spans the file — the caller cannot tell an invented row from a real one, so a fake row
 * would be trusted.
 */
export function renderMap(sections: Section[]): string {
	if (sections.length === 0) {
		return [
			"## map",
			"  (none) this file was summarized as a single blob; no line detail is available.",
		].join("\n");
	}

	// Importance is re-read through the ordinary default: an entry surfaced from a cache that
	// predates the field, or a row assembled by a caller, sorts and renders as tier 2.
	const ordered = [...sections].sort(
		(a, b) =>
			normalizeImportance(b.importance) - normalizeImportance(a.importance) ||
			a.startLine - b.startLine ||
			a.endLine - b.endLine,
	);

	const width = Math.max(...ordered.map((s) => String(s.endLine).length), 4);
	// Only tiers 2 and 3 print a kind, so a tier-1 row's kind must not widen the column.
	const kinds = ordered.filter((s) => normalizeImportance(s.importance) >= 2).map((s) => s.kind);
	const kindWidth = Math.max(0, ...kinds.map((k) => k.length), 4);

	const lines = ordered.map((s) => {
		const range = `${String(s.startLine).padStart(width)}-${String(s.endLine).padStart(width)}`;
		const detail = renderRow(s);
		// A tier-1 row has no kind, so its name is padded into the kind column to keep the
		// name column straight across the tiers rather than letting one tier shift left.
		if (detail.kind === undefined) {
			const gap = " ".repeat(kindWidth + 2);
			return `${range}  ${gap}${detail.text}`.trimEnd();
		}
		return `${range}  ${detail.kind.padEnd(kindWidth)}  ${detail.text}`.trimEnd();
	});
	return `## map\n${lines.join("\n")}`;
}

/** The detail columns of one row: a kind (absent at tier 1) and the text after it. */
function renderRow(section: Section): { kind: string | undefined; text: string } {
	const importance = normalizeImportance(section.importance);
	const note = section.note.trim();

	if (importance === 1) return { kind: undefined, text: section.name };
	if (importance === 2) {
		const short = firstSentence(note);
		return { kind: section.kind, text: short ? `${section.name} - ${short}` : section.name };
	}
	return { kind: section.kind, text: note ? `${section.name} - ${note}` : section.name };
}

/**
 * Render a cached summary as the text the model sees. The map is always derived from the
 * section rows, so the prose and the line numbers cannot drift apart.
 *
 * The header is always shown, and it never names the summarizer model: the model a
 * file was summarized with is not something the caller can act on. Cache state is not shown
 * either: freshness decides re-use inside the cache and means nothing to a reader
 * who already holds the answer, so this is a pure transform of the entry — one source for
 * the model's text and for the structured result a script receives.
 */
export function renderSummary(entry: CachedSummary): string {
	const parts: string[] = [];

	parts.push(
		`# ${entry.path}  (${entry.lines} lines, ${formatBytes(entry.bytes)}, sha ${entry.hash})`,
	);
	if (entry.mode === "blob") {
		parts.push("map: none - summarized as a single blob, so there is no line detail");
	}
	parts.push("");

	parts.push(entry.overview.trim());
	parts.push("");
	parts.push(renderMap(entry.sections));
	return parts.join("\n");
}
