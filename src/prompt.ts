import { readFile } from "node:fs/promises";
import { SECTION_KINDS } from "./schema.ts";

/** Separator between the line number and the line's text in the numbered excerpt. */
const GUTTER = "\t";

export type PreparedFile = {
	/** The file text as the model sees it: every line prefixed with its number. */
	text: string;
	/** Lines in the file, which is also how many lines the model is shown. */
	totalLines: number;
};

/**
 * Prefix every line with its 1-indexed number, right-aligned in a fixed column.
 *
 * The number is what makes the map checkable: the model copies a line's number out of the
 * left column instead of counting lines in prose, so a row's boundaries are read from the
 * excerpt rather than derived from it. An earlier version sent raw text and models that
 * could not hold an accurate count over hundreds of lines (qwen drifted a mean of 24 lines
 * on a 1396-line file, once by 68) invented a spacing rule and extrapolated from it. The
 * numbers remove the arithmetic the map depends on.
 */
function numberLines(lines: string[], width: number): string {
	return lines.map((line, i) => `${String(i + 1).padStart(width)}${GUTTER}${line}`).join("\n");
}

/**
 * Read a whole file for summarization, numbered.
 *
 * The entire file is sent, with no line or byte cap. The summarizer model is expected to
 * have the context for it, and a summary that covers only part of a file is not useful:
 * the cache has one entry per file, so an incomplete map can never be completed without
 * re-reading the file anyway. A file too large for the configured model's context will be
 * rejected by the provider, which surfaces as an ordinary summarizer error.
 */
export async function prepareFile(absPath: string): Promise<PreparedFile> {
	const text = (await readFile(absPath)).toString("utf-8");
	const allLines = text.split("\n");
	const totalLines = allLines.length;

	return {
		text: numberLines(allLines, String(totalLines).length),
		totalLines,
	};
}

/**
 * The summarization prompt: what the map is for, how the file is laid out, the JSON
 * contract, the limits the answer is held to, then the numbered file.
 *
 * There is no tool schema in this request, so this text is the entire contract - but it is
 * held to a goal, a shape, and a few limits, nothing more. Two things carry the weight:
 *
 * - The excerpt is **numbered**, and one line says the numbers are copied from the left
 *   column. That turns a counting task, which models fail at over long files, into a
 *   copying task.
 * - The `Limits` are what a model cannot infer: the `kind` vocabulary, that gaps are
 *   legal, that numbers come from the column rather than from counting, and the two field
 *   lengths that are cut on the way into storage.
 *
 * A worked example and a bullet per JSON field were both measured and dropped - together
 * about 2400 characters, over half the prompt. Every rule they stated is either stated
 * here once, shorter, or enforced locally by `normalizeSections` (overlap and reversed
 * ranges) instead of asked for.
 */
export function buildSummarizePrompt(path: string, file: PreparedFile): string {
	return [
		"Index this file so a later model can read the parts it needs instead of the whole file.",
		"Reply with one JSON object and nothing else - no prose, no markdown fence.",
		"",
		`File: ${path} (${file.totalLines} lines; line ${file.totalLines} is the last).`,
		"",
		"The excerpt is numbered, number then tab then line:",
		"",
		`     1${GUTTER}the first line of the file`,
		`     2${GUTTER}the second line`,
		"",
		"JSON shape:",
		'  { "overview": string, "sections": [ { "start_line": number, "end_line": number, "kind": string, "name": string, "note": string } ] }',
		"",
		"overview: what the file is for, its main exports and how they relate, and anything a reader must know before changing it. Shown without the map when there is no room for both, so it must stand alone. At most ten sentences.",
		"sections: rows in line order. A row is one declaration and its body, or a run of declarations that do the same kind of thing and read as one stripe. No two rows share a line.",
		"  start_line / end_line: inclusive line numbers copied from the left column.",
		`  kind: one of ${SECTION_KINDS.join(", ")}.`,
		"  name: the symbol, or the pattern plus how many when a row covers many; (top level) for loose statements.",
		"  note: what the region does, plus any side effect or invariant that matters when editing it. At most two sentences, about 200 characters.",
		"",
		"Limits:",
		"  - Copy line numbers from the left column; do not count lines yourself.",
		"  - Leave gaps where lines do nothing - blank runs, license headers, boilerplate.",
		"  - Say a thing once - a note that only renames the row above extends that row instead.",
		"",
		"Now map the file below the same way.",
		"",
		"<file>",
		file.text,
		"</file>",
	].join("\n");
}

/** Follow-up message listing what was wrong, sent when the previous answer failed validation. */
export function buildRepairPrompt(problems: string[]): string {
	return [
		"Your previous answer was rejected. It must be a single JSON object matching the shape above.",
		"",
		"Problems found:",
		...problems.map((problem) => `  - ${problem}`),
		"",
		"Reply with the corrected JSON object only. No prose, no markdown fence.",
		"Re-read the numbers in the left column of the excerpt and copy them, rather than adjusting them by hand.",
		"Rows may leave gaps for lines that do nothing, and no two rows may share a line.",
	].join("\n");
}


/**
 * Parse an answer that is supposed to be JSON.
 *
 * Tolerates the two slips a model makes most often: a markdown fence around the object,
 * and leading or trailing prose around it. Returns undefined when there is no JSON object
 * to be found at all.
 */
export function parseJsonAnswer(text: string): unknown | undefined {
	const cleaned = stripFences(text);
	const candidates = [cleaned];

	const first = cleaned.indexOf("{");
	const last = cleaned.lastIndexOf("}");
	if (first >= 0 && last > first) candidates.push(cleaned.slice(first, last + 1));

	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate);
		} catch {
			// Try the next candidate.
		}
	}
	return undefined;
}

/**
 * Salvage prose from an answer that never became valid JSON.
 *
 * Tries the `overview` field first, since a truncated object often still contains it
 * verbatim, then falls back to the whole answer with fences stripped. This is what a blob
 * entry stores, so it should read as prose rather than as a half-written JSON fragment.
 */
export function extractOverview(text: string): string {
	const cleaned = stripFences(text);
	const match = cleaned.match(/"overview"\s*:\s*"((?:[^"\\]|\\.)*)"/);
	if (match) {
		try {
			return JSON.parse(`"${match[1]}"`).trim();
		} catch {
			return match[1]!.trim();
		}
	}
	return cleaned.trim();
}

/** Drop a leading/trailing ``` fence so an otherwise-valid answer still parses. */
function stripFences(text: string): string {
	return text
		.replace(/^\s*```[a-z]*\s*\n?/i, "")
		.replace(/\n?```\s*$/i, "")
		.trim();
}

/** Model id in `provider/model` form for the cache header. */
export function modelLabel(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}
