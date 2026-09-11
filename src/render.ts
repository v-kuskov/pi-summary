import type { CachedSummary, Freshness, Section } from "./store.ts";

/** Char cap for anything embedded in a block reason or error message. */
export const MAX_REASON_CHARS = 6000;

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
 * Rows are rendered exactly as stored. A map is complete or it is not a map: a partial one
 * is sent back to be finished before anything is written, so there is no uncovered tail to
 * append here and no region to invent. A blob entry has no rows, and the output says so
 * rather than fabricating a region that spans the file — the caller cannot tell an invented
 * row from a real one, so a fake row would be trusted and acted on.
 */
export function renderMap(sections: Section[]): string {
	if (sections.length === 0) {
		return [
			"## map",
			"  (none) this file was summarized as a single blob; no line detail is available.",
			"  Use grep to locate a symbol in it, or read it in ranges of at most 200 lines.",
		].join("\n");
	}

	const rows = sections.map((s) => ({
		start: s.startLine,
		end: s.endLine,
		kind: s.kind,
		name: s.name,
		note: s.note,
	}));

	const width = Math.max(...rows.map((r) => String(r.end).length), 4);
	const kindWidth = Math.max(...rows.map((r) => r.kind.length), 4);
	const lines = rows.map((r) => {
		const range = `${String(r.start).padStart(width)}-${String(r.end).padStart(width)}`;
		const kind = r.kind.padEnd(kindWidth);
		const detail = r.note ? `${r.name} - ${r.note}` : r.name;
		return `${range}  ${kind}  ${detail}`;
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
	parts.push(renderMap(entry.sections));
	parts.push("");
	parts.push(
		entry.mode === "blob"
			? `# read ${entry.path} in ranges (max 200 lines per call), or grep it for a symbol.`
			: `# read ${entry.path} with offset/limit inside one range above (max 200 lines per call).`,
	);
	return parts.join("\n");
}

/** The compact form used inside a blocked-read reason. */
export function renderSummaryForReason(entry: CachedSummary): string {
	return truncateChars(renderSummary(entry, { header: true }), MAX_REASON_CHARS);
}
