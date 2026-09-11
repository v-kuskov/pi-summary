import type { CachedSummary, Freshness, Section } from "./store.ts";

/** Char cap for anything embedded in a block reason or error message. */
export const MAX_REASON_CHARS = 6000;

/**
 * Hard limit on lines a single `read` may return. Larger spans must be split.
 *
 * The guard enforces it and the model-facing text quotes it, so it lives here - next to the
 * strings that have to agree with it - rather than in the guard, where a change to the
 * limit would silently leave every message quoting the old number.
 */
export const READ_LINE_LIMIT = 200;

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncateChars(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

/**
 * Render the `## map` block from section rows.
 *
 * Rows are rendered exactly as stored, with unclaimed line ranges shown as `skipped` rows
 * in place. Gaps are meaningful here: the summarizer is told to skip lines that do nothing,
 * so a `skipped` row is how the caller learns which lines the model deliberately declined
 * to map, instead of having to infer it from a jump in the numbers. A blob entry has no
 * rows, and the output says so rather than fabricating a region that spans the file — the
 * caller cannot tell an invented row from a real one, so a fake row would be trusted.
 */
export function renderMap(sections: Section[], totalLines: number): string {
	if (sections.length === 0) {
		return [
			"## map",
			"  (none) this file was summarized as a single blob; no line detail is available.",
			"  Use grep to locate a symbol in it, or read it in ranges of at most " +
				`${READ_LINE_LIMIT} lines.`,
		].join("\n");
	}

	type Row = { start: number; end: number; kind: string; name: string; note: string };

	// Interleave the skipped ranges so every line is accounted for in the output, and a
	// reader can see at a glance that a gap is deliberate.
	const rows: Row[] = [];
	let cursor = 1;
	for (const s of sections) {
		if (s.startLine > cursor) {
			rows.push({
				start: cursor,
				end: s.startLine - 1,
				kind: "skipped",
				name: "(nothing to map)",
				note: "",
			});
		}
		rows.push({ start: s.startLine, end: s.endLine, kind: s.kind, name: s.name, note: s.note });
		cursor = s.endLine + 1;
	}
	if (cursor <= totalLines) {
		rows.push({
			start: cursor,
			end: totalLines,
			kind: "skipped",
			name: "(nothing to map)",
			note: "",
		});
	}

	const width = Math.max(...rows.map((r) => String(r.end).length), 4);
	const kindWidth = Math.max(...rows.map((r) => r.kind.length), 4);
	const lines = rows.map((r) => {
		const range = `${String(r.start).padStart(width)}-${String(r.end).padStart(width)}`;
		const kind = r.kind.padEnd(kindWidth);
		const detail = r.note ? `${r.name} - ${r.note}` : r.name;
		return `${range}  ${kind}  ${detail}`.trimEnd();
	});
	return `## map\n${lines.join("\n")}`;
}

export type RenderOptions = {
	/** Include the cache/model header lines. Off inside a read-block reason. */
	header?: boolean;
	/**
	 * Cache state shown in the header. Includes the two states that only exist right after
	 * a model call: `miss` (nothing was cached) and `forced` (an explicit refresh).
	 */
	freshness?: Freshness | "miss" | "forced";
};

/**
 * Render a cached summary as the text the model sees. The map is always derived from the
 * section rows, so the prose and the line numbers cannot drift apart.
 */
export function renderSummary(entry: CachedSummary, options: RenderOptions = {}): string {
	const showHeader = options.header ?? true;
	const parts: string[] = [];

	if (showHeader) {
		parts.push(
			`# ${entry.path}  (${entry.lines} lines, ${formatBytes(entry.bytes)}, sha ${entry.hash})`,
		);
		if (options.freshness) parts.push(`cache: ${options.freshness}`);
		parts.push(`model: ${entry.model}`);
		if (entry.mode === "blob") {
			parts.push("map: none - summarized as a single blob, so there is no line detail");
		}
		parts.push("");
	}

	parts.push(entry.overview.trim());
	parts.push("");
	parts.push(renderMap(entry.sections, entry.lines));
	parts.push("");
	parts.push(
		entry.mode === "blob"
			? `# read ${entry.path} in ranges (max ${READ_LINE_LIMIT} lines per call), or grep it for a symbol.`
			: `# read ${entry.path} with offset/limit inside one range above (max ${READ_LINE_LIMIT} lines per call).`,
	);
	return parts.join("\n");
}

/** The compact form used inside a blocked-read reason. */
export function renderSummaryForReason(entry: CachedSummary): string {
	return truncateChars(renderSummary(entry, { header: true }), MAX_REASON_CHARS);
}
