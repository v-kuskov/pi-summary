import { Type } from "typebox";
import { Value } from "typebox/value";
import { StringEnum } from "@earendil-works/pi-ai";
import type { Section } from "./store.ts";

/** Vocabulary for the `kind` field, shared by the schema, the prompt, and the validator. */
export const SECTION_KINDS = [
	"import",
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
 */
export const emitSummarySchema = Type.Object({
	overview: Type.String({
		description:
			"Up to ten sentences: what the file is for, its main exports and how they relate, and what a reader must know before changing it.",
	}),
	sections: Type.Array(
		Type.Object({
			start_line: Type.Integer({ description: "Inclusive 1-indexed first line of the region." }),
			end_line: Type.Integer({ description: "Inclusive 1-indexed last line of the region." }),
			kind: StringEnum(SECTION_KINDS, { description: "What kind of declaration this region is." }),
			name: Type.String({
				description: "Declaration or symbol name; use (top level) for loose statements.",
			}),
			note: Type.String({
				description:
					"Up to two sentences on what the region does, including a side effect or invariant a reader needs before editing it.",
			}),
		}),
		{
			description:
				"Regions in line order. They must not overlap, and they may leave gaps where lines do nothing.",
		},
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

export function truncateNote(note: string, max = MAX_NOTE_CHARS): string {
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
		const endLine = Math.trunc(Number(row.end_line));
		if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) continue;
		if (startLine < 1 || startLine > shownLines) continue;

		sections.push({
			seq: 0,
			startLine,
			// A row cannot claim lines past what the model was shown, and a reversed range is
			// read as a single line rather than dropped.
			endLine: Math.max(Math.min(endLine, shownLines), startLine),
			kind: String(row.kind ?? "other").trim().toLowerCase() || "other",
			name: String(row.name ?? "").trim() || "(unnamed)",
			// A runaway note is cut rather than trusted: one unbounded note can outweigh every
			// other row in a map and crowd out the read-block reason.
			note: truncateNote(String(row.note ?? "").trim()),
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
