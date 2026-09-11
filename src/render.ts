import type { CachedSummary, Freshness, Section } from "./store.ts";

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

/**
 * Render the `## map` block from section rows.
 *
 * Only mapped rows appear. The summarizer is told to skip lines that do nothing, so a gap
 * in the numbers is its answer, not a missing entry, and saying so on every blank run, else
 * branch and closing brace would bury the rows that carry information. A gap is read as
 * "nothing mapped here".
 *
 * A blob entry has no rows, and the output says so rather than fabricating a region that
 * spans the file — the caller cannot tell an invented row from a real one, so a fake row
 * would be trusted.
 */
export function renderMap(sections: Section[]): string {
	if (sections.length === 0) {
		return [
			"## map",
			"  (none) this file was summarized as a single blob; no line detail is available.",
			"  Use grep to locate a symbol in it, or read it in ranges of at most " +
				`${READ_LINE_LIMIT} lines.`,
		].join("\n");
	}

	const width = Math.max(...sections.map((s) => String(s.endLine).length), 4);
	const kindWidth = Math.max(...sections.map((s) => s.kind.length), 4);
	const lines = sections.map((s) => {
		const range = `${String(s.startLine).padStart(width)}-${String(s.endLine).padStart(width)}`;
		const kind = s.kind.padEnd(kindWidth);
		const detail = s.note ? `${s.name} - ${s.note}` : s.name;
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
			? `# read ${entry.path} in ranges (max ${READ_LINE_LIMIT} lines per call), or grep it for a symbol.`
			: `# read ${entry.path} with offset/limit inside one range above (max ${READ_LINE_LIMIT} lines per call).`,
	);
	return parts.join("\n");
}


