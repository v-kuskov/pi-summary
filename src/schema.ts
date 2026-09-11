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
			"One to three sentences: what this file does, and what its main exports are for.",
	}),
	sections: Type.Array(
		Type.Object({
			start_line: Type.Integer({ description: "Inclusive 1-indexed first line of the region." }),
			end_line: Type.Integer({ description: "Inclusive 1-indexed last line of the region." }),
			kind: StringEnum(SECTION_KINDS, { description: "What kind of declaration this region is." }),
			name: Type.String({
				description: "Declaration or symbol name; use (top level) for loose statements.",
			}),
			note: Type.String({ description: "At most 90 characters on what the region does." }),
		}),
		{
			description:
				"Contiguous regions covering the file in order, with no gaps and no overlaps.",
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

/**
 * Clamp, drop, and sort the model's rows into storable sections.
 *
 * Rows are repaired rather than rejected: a model that put a boundary one line out or
 * wrote a line range as a string has still told us where the region is, and spending a
 * model call to correct arithmetic is a worse trade than clamping it. Rows that cannot be
 * repaired — non-numeric, before line 1, starting past what was shown — are dropped.
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
			note: String(row.note ?? "").trim(),
		});
	}

	if (sections.length === 0) return undefined;

	return sections
		.sort((a, b) => a.startLine - b.startLine)
		.map((section, index) => ({ ...section, seq: index }));
}
