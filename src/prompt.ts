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
 * The summarization prompt: how to read the excerpt, the JSON contract, a worked example,
 * then the numbered file.
 *
 * There is no tool schema in this request, so this text is the entire contract. Two things
 * carry most of the weight:
 *
 * - The excerpt is **numbered**, and the prompt says to copy numbers from the left column.
 *   That turns a counting task, which models fail at over long files, into a copying task.
 * - The rows may **leave gaps** where lines do nothing, but must not **overlap** - two rows
 *   describing the same line leave the caller unable to tell which note applies. Overlap is
 *   trimmed locally rather than sent back, so it never costs a model call.
 */
export function buildSummarizePrompt(path: string, file: PreparedFile): string {
	return [
		"You are indexing a source file so a later model can read only the parts it needs instead of the whole file.",
		"Reply with a single JSON object and nothing else: no prose, no explanation, no markdown fence.",
		"",
		`File: ${path}`,
		`The file is ${file.totalLines} lines, and all of it is below. Line 1 is the first line and line ${file.totalLines} is the last.`,
		"",
		"The excerpt below is numbered. Every line begins with its own line number in the left",
		`column, then a tab, then the line:`,
		"",
		`     1${GUTTER}the first line of the file`,
		`     2${GUTTER}the second line`,
		"",
		"Take every number in your answer from that column. Copy the number printed beside the",
		"line you mean, and do not count lines yourself or compute them from a pattern.",
		"",
		"JSON shape:",
		'  { "overview": string, "sections": [ { "start_line": number, "end_line": number, "kind": string, "name": string, "note": string } ] }',
		"",
		"overview: up to ten sentences of plain prose, and it must stand alone - it is shown without the map when there is no room for both. Say what the file is for, what its main exports are and how they relate, and anything a reader must know before changing it. Skip line numbers and restating the map.",
		"sections: one row per region that does something, in line order. Rows must not overlap.",
		"  A row starts on the line where its declaration begins and ends on its last line.",
		"  Leave gaps between rows where nothing happens, such as runs of blank lines, long license headers, and generated boilerplate. A gap is the answer 'these lines are not worth mapping', so skip them rather than inventing a region to cover them. Skipped lines are shown to the caller as 'skipped', so a gap costs nothing and reads correctly.",
		"  start_line / end_line: integers copied from the left column, inclusive.",
		`  kind: one of ${SECTION_KINDS.join(", ")}.`,
		"  name: the declaration or symbol name, or (top level) for loose statements.",
		"  note: up to two sentences, or about 200 characters. This is the only place detail lives - the caller reads the map and then a single range, so say what the region does and any side effect or invariant that matters when editing it. Do not pad a trivia row to fill the budget.",
		"",
		"Map only lines that do something. A run of adjacent one-line declarations of the same",
		"kind is one row; a class or function is one row covering its whole body. Do not merge",
		"unrelated regions to avoid a gap, and do not add a row for lines that do nothing.",
		"",
		"Example. An 8-line file and its correct rows:",
		"",
		`     1${GUTTER}import { readFile } from "node:fs/promises";`,
		`     2${GUTTER}`,
		`     3${GUTTER}const LIMIT = 10;`,
		`     4${GUTTER}`,
		`     5${GUTTER}export function clamp(n: number): number {`,
		`     6${GUTTER}  return Math.min(n, LIMIT);`,
		`     7${GUTTER}}`,
		`     8${GUTTER}`,
		"",
		'{"overview":"Reads files and clamps numbers to a limit. Exports clamp, which caps a value at LIMIT; callers use it to keep pagination sizes inside the API limit. The module has no side effects, so importing it is free.","sections":[',
		'{"start_line":1,"end_line":1,"kind":"import","name":"node/fs/promises","note":"Imported for readFile, though nothing in this file calls it - an unused import."},',
		'{"start_line":3,"end_line":3,"kind":"const","name":"LIMIT","note":"The cap clamp applies. Lowering it silently changes every caller that relies on the default page size."},',
		'{"start_line":5,"end_line":7,"kind":"function","name":"clamp()","note":"Returns min of n and LIMIT. Pure, and safe to call in a hot loop."}]}',
		"",
		"The three rows above leave lines 2, 4, and 8 unmapped on purpose: they are blank, so there is nothing to say about them. Each number was copied out of the left column.",
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
		"Rows may leave gaps for lines that do nothing; what they must not do is overlap each other.",
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
