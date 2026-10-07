import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type CachedSummary,
	type Importance,
	type Section,
	normalizeImportance,
} from "./store.ts";

/**
 * Vocabulary for the `kind` field, shared by the schema, the prompt, and the validator.
 *
 * There is no `import` kind: imports, re-exports and boilerplate carry no line-level meaning
 * a reader would drill into, so the prompt tells the summarizer to skip them rather than name
 * them. A cache written before that still holds `import` rows, which is why the renderer and
 * the output schema take `kind` as a plain string rather than this union.
 */
export const SECTION_KINDS = [
	"type",
	"class",
	"interface",
	"function",
	"method",
	"const",
	"config",
	"test",
	"comment",
	"other",
] as const;

/** Longest a note may be before it is cut. Two sentences, matching the prompt. */
export const MAX_NOTE_CHARS = 200;

/** Longest an overview may be before it is cut. Ten sentences, matching the prompt. */
export const MAX_OVERVIEW_CHARS = 2400;

/**
 * The shape the model must return, and the shape the database stores.
 *
 * This is a plain JSON contract, not a tool schema: the summarizer is asked for JSON in
 * prose and the answer is validated here. A flat `{overview, sections[]}` is deliberate —
 * it keeps every provider's native JSON mode usable, since strict modes reject `$ref`,
 * `allOf`, `oneOf`, and object unions.
 *
 * The types carry no `description`s on purpose. This schema is never sent to a provider —
 * the request hand-builds `response_format: { type: "json_object" }` — and its only reader
 * is `Value.Errors` below, whose messages are built from the failing keyword rather than
 * from prose. The field-by-field contract lives in `buildSummarizePrompt`, which is the
 * text the model actually sees and the one place a change has to be made.
 */
export const emitSummarySchema = Type.Object({
	overview: Type.String(),
	sections: Type.Array(
		Type.Object({
			start_line: Type.Integer(),
			end_line: Type.Integer(),
			kind: StringEnum(SECTION_KINDS),
			name: Type.String(),
			note: Type.String(),
			importance: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
		}),
	),
});

export type EmitSummary = {
	overview: string;
	sections: Array<{
		start_line: number;
		end_line: number;
		kind: string;
		name: string;
		note: string;
		importance: 1 | 2 | 3;
	}>;
};

/**
 * True when the payload has the two fields the contract requires, at the right types.
 *
 * This is the boundary between "repair it" and "normalize it": a payload that fails here
 * cannot be salvaged locally, so the model is asked again. A payload that passes here is
 * only ever missing or wrong at the row level, which `normalizeSections` fixes for free.
 */
export function hasTopLevelShape(value: unknown): value is EmitSummary {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return typeof record.overview === "string" && Array.isArray(record.sections);
}

/** Human-readable schema violations, for the corrective prompt. */
export function describeSchemaErrors(value: unknown): string[] {
	const errors: string[] = [];
	for (const error of Value.Errors(emitSummarySchema, value)) {
		// `instancePath` is a JSON Pointer such as `/sections/0/start_line`.
		errors.push(`${error.instancePath || "/"} ${error.message}`);
		if (errors.length >= 8) break;
	}
	return errors;
}

export function truncateNote(note: string): string {
	const max = MAX_NOTE_CHARS;
	if (note.length <= max) return note;
	const cut = note.slice(0, max);
	const lastSpace = cut.lastIndexOf(" ");
	return `${lastSpace > 0 ? cut.slice(0, lastSpace) : cut}…`;
}

/**
 * Clamp, dedupe, and sort the model's rows into storable sections.
 *
 * Rows are repaired rather than rejected: a model that put a boundary one line out or
 * wrote a line range as a string has still told us where the region is, and spending a
 * model call to correct arithmetic is a worse trade than clamping it. Rows that cannot be
 * repaired — non-numeric, before line 1, starting past what was shown — are dropped.
 *
 * Overlapping rows are trimmed to the unclaimed lines after them. A model asked for a
 * complete map sometimes emits a container row (`1-24 comment`) alongside its contents
 * (`4-23 Widget1`), and both cannot be true; keeping the later row's start and cutting the
 * earlier row short is the reading that preserves the innermost, most specific region. Let
 * through unmodified, such rows render as a map that contradicts itself.
 *
 * Gaps are preserved, never filled. The prompt tells the model to skip lines that do
 * nothing, so a jump in the line numbers is its answer rather than an error, and the
 * renderer marks the skipped ranges explicitly.
 *
 * Returns undefined when nothing usable survives, which is the caller's signal to treat
 * the answer as a blob rather than as a map.
 */
export function normalizeSections(raw: unknown, shownLines: number): Section[] | undefined {
	const items = Array.isArray(raw) ? raw : [];
	const sections: Section[] = [];

	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		const row = item as Record<string, unknown>;
		const startLine = Math.trunc(Number(row.start_line));
		if (!Number.isFinite(startLine)) continue;
		if (startLine < 1 || startLine > shownLines) continue;

		// A bad `end_line` is coerced to `startLine` rather than dropping the row: the start
		// line is the row's address, so a row with a good start still points at a real place
		// in the file, and losing it costs more than reading it as a single line.
		const rawEnd = Math.trunc(Number(row.end_line));
		const endLine = Math.max(
			Math.min(Number.isFinite(rawEnd) ? rawEnd : startLine, shownLines),
			startLine,
		);

		sections.push({
			seq: 0,
			startLine,
			endLine,
			kind: String(row.kind ?? "other").trim().toLowerCase() || "other",
			name: String(row.name ?? "").trim() || "(unnamed)",
			// The prompt asks for two sentences; a note that ignores that is cut so one row
			// cannot outweigh the rest of the map in the stored entry.
			note: truncateNote(String(row.note ?? "").trim()),
			// A row is worth keeping whatever the model said about how much it matters, so an
			// omitted or nonsensical importance becomes the middle tier rather than a repair call.
			importance: normalizeImportance(row.importance),
		});
	}

	if (sections.length === 0) return undefined;

	const sorted = sections.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

	// Trim each row so it stops before the next row begins, dropping rows that the next row
	// completely covers.
	const tiled: Section[] = [];
	for (let i = 0; i < sorted.length; i++) {
		const current = sorted[i]!;
		const next = sorted[i + 1];
		if (next && current.endLine >= next.startLine) {
			if (next.startLine <= current.startLine) continue; // fully shadowed
			current.endLine = next.startLine - 1;
		}
		tiled.push(current);
	}

	return tiled.map((section, index) => ({ ...section, seq: index }));
}

/**
 * The `summary` tool's `outputSchema`: the summary and nothing else.
 *
 * Cache state, the summarizer model, the attempt count and the degradation flag are
 * generation history — they stay in the result's `details`, for diagnosis, and are not part
 * of what a caller came for. The second arm exists because pi resolves a tool that
 * declares an `outputSchema` to its `structuredContent` *instead of* the text: a call that
 * fell back to the whole file has no summary, so the file itself is the payload, and
 * omitting the field would hand scripts nothing where the model got a file.
 *
 * Every arm carries a `kind` so a script can branch on the shape before reading a field:
 * `overview` / `region` / `content` alone do distinguish the arms, and TypeScript narrows
 * on them, but an untyped script reading `overview` from a fallback would silently hold
 * undefined. The fallback arm also carries `error` and `truncated` - payload semantics,
 * not generation history: a script must be able to tell a failure payload from a summary
 * and see whether `content` was cut short, and this arm is its only channel.
 *
 * Unlike `emitSummarySchema` above, this schema does reach callers: codemode declarations
 * render it for scripts, which is why every field carries a one-line description.
 */
export const summaryOutputSchema = Type.Union([
	Type.Object({
		kind: Type.Literal("map", { description: "Map arm: the file's overview and line map." }),
		path: Type.String({
			description:
				"Project-root-relative path of the file, normalized on Windows; the fallback arm returns an absolute path instead. Re-resolve your own input rather than round-tripping this.",
		}),
		lines: Type.Integer({ description: "Total lines in the file." }),
		overview: Type.String({
			description:
				"The file's prose: what it is for, its main exports, and what to know before changing it.",
		}),
		sections: Type.Array(
			Type.Object({
				startLine: Type.Integer({
					description: "First line of the region, 1-based and inclusive.",
				}),
				endLine: Type.Integer({ description: "Last line of the region, inclusive." }),
				kind: Type.String({
					description:
						"What the region holds: type, class, interface, function, method, const, config, test, comment, or other.",
				}),
				name: Type.String({
					description:
						"The region's name: the symbol as the file spells it, or a pattern summary. Pass it back as region to drill into the row.",
				}),
				note: Type.String({
					description: "What lives in the region and what to know before editing it.",
				}),
				importance: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)], {
					description:
						"1 = incidental, 2 = supporting, 3 = load-bearing. A display tier; the note always holds the full text.",
				}),
			}),
			{
				description:
					"Every mapped region, in line order; empty exactly when the file has no line map and region lookups reject.",
			},
		),
	}),
	// The drill-down arm: one cached region and the numbered excerpt of its span. It has no
	// `overview`, because a caller that asked for a region already has the file's prose.
	Type.Object({
		kind: Type.Literal("region", { description: "Region arm: one cached region and its excerpt." }),
		path: Type.String({
			description:
				"Project-root-relative path of the file, normalized on Windows; the fallback arm returns an absolute path instead.",
		}),
		lines: Type.Integer({ description: "Total lines in the file." }),
		region: Type.Object(
			{
				startLine: Type.Integer({
					description: "First line of the region, 1-based and inclusive.",
				}),
				endLine: Type.Integer({ description: "Last line of the region, inclusive." }),
				kind: Type.String({
					description:
						"What the region holds: type, class, interface, function, method, const, config, test, comment, or other.",
				}),
				name: Type.String({
					description: "The region's name: the symbol as the file spells it, or a pattern summary.",
				}),
				note: Type.String({
					description: "What lives in the region and what to know before editing it.",
				}),
				importance: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)], {
					description:
						"1 = incidental, 2 = supporting, 3 = load-bearing. A display tier; the note always holds the full text.",
				}),
			},
			{ description: "The region asked for: its span, kind, name, note and tier." },
		),
		excerpt: Type.String({
			description: "The region's line-numbered excerpt of the current file.",
		}),
	}),
	Type.Object({
		kind: Type.Literal("file", {
			description: "Fallback arm: the whole file, returned only when summarization failed.",
		}),
		path: Type.String({
			description: "Absolute path of the file (the other arms return the project-root-relative path).",
		}),
		lines: Type.Integer({
			description: "Total lines in the file, counted whole even when content was cut short.",
		}),
		error: Type.String({ description: "Why the file could not be summarized." }),
		truncated: Type.Boolean({ description: "True when content was cut short of the file's end." }),
		content: Type.String({
			description:
				"The whole file. When truncated, a trailing '# the file is N lines and was cut here' comment marks the cut.",
		}),
	}),
]);

export type SummaryOutput = Static<typeof summaryOutputSchema>;

/**
 * Project a stored entry into the tool's structured result.
 *
 * `seq` is storage ordering and stays behind this seam; the array order already carries it.
 * Importance is normalized again here rather than trusted: an entry read from a cache written
 * before the field existed already reads as 2 by way of `readSummary`, and this keeps the
 * structured arm — the one a script acts on — on the same default if that ever changes.
 */
export function summaryOutputOf(entry: CachedSummary): SummaryOutput {
	return {
		kind: "map",
		path: entry.path,
		lines: entry.lines,
		overview: entry.overview,
		sections: entry.sections.map((section) => ({
			startLine: section.startLine,
			endLine: section.endLine,
			kind: section.kind,
			name: section.name,
			note: section.note,
			importance: normalizeImportance(section.importance),
		})),
	};
}

/** One region and its excerpt, as the drill-down returns them. */
export type RegionOutput = {
	kind: "region";
	path: string;
	lines: number;
	region: {
		startLine: number;
		endLine: number;
		kind: string;
		name: string;
		note: string;
		importance: Importance;
	};
	excerpt: string;
};

/**
 * Project one cached region and its excerpt into the drill-down's structured result.
 *
 * Only the region asked for is exposed, not the whole map: the caller already chose a layer,
 * and returning every row would make the drill-down cost the same context as the summary it
 * was meant to narrow.
 */
export function regionOutputOf(
	entry: CachedSummary,
	section: Section,
	excerpt: string,
): RegionOutput {
	return {
		kind: "region",
		path: entry.path,
		lines: entry.lines,
		region: {
			startLine: section.startLine,
			endLine: section.endLine,
			kind: section.kind,
			name: section.name,
			note: section.note,
			importance: normalizeImportance(section.importance),
		},
		excerpt,
	};
}
