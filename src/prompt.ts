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
 * - The rows must **tile** the excerpt — each row beginning where the last one ended. That
 *   is a completion criterion the model can check as it writes and the caller can check
 *   after, rather than a property nobody verifies.
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
		"overview: one to three sentences, plain prose. It must stand alone - it is shown without the map when there is no room for both.",
		"sections: one row per region, ordered by line, covering the whole file: the first row starts at line 1, each row starts on the line after the previous row ends, and the last row ends at line " +
			`${file.totalLines}. Every line belongs to exactly one row, so there are no gaps and no overlaps.`,
		"  A row starts on the line where its declaration begins.",
		"  start_line / end_line: integers copied from the left column, inclusive.",
		`  kind: one of ${SECTION_KINDS.join(", ")}.`,
		"  name: the declaration or symbol name, or (top level) for loose statements.",
		"  note: at most 90 characters on what that row does.",
		"",
		"One row per top-level declaration. A run of adjacent one-line declarations of the same",
		"kind is one row; a class or function is one row covering its whole body. Blank lines go",
		"to the row before them.",
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
		'{"overview":"Reads files and clamps numbers to a limit. Exports clamp, which caps a value at LIMIT.","sections":[',
		'{"start_line":1,"end_line":2,"kind":"import","name":"node/fs/promises","note":"imported for readFile, used by callers of this module"},',
		'{"start_line":3,"end_line":4,"kind":"const","name":"LIMIT","note":"caps every value clamp returns"},',
		'{"start_line":5,"end_line":8,"kind":"function","name":"clamp()","note":"returns the smaller of n and LIMIT"}]}',
		"",
		"The three rows above cover the whole 8-line file: row 1 starts at 1 and ends at 2, row 2 starts at 3 and ends at 4, row 3 starts at 5 and ends at line 8. Each number was copied out of the left column.",
		"",
		"Now map the file below the same way, covering all of it.",
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
	].join("\n");
}

/**
 * Check that the rows cover the whole file with no gap and no overlap.
 *
 * Coverage is the one property of a map that can be checked without the source, and every
 * complete map has it. A break means either the model worked from a pattern instead of
 * copying the numbers, or it stopped short - and since the cache holds one entry per file,
 * a partial map can never be completed without re-reading the file, so it is worth one
 * repair call to ask for the whole thing.
 *
 * Violations are returned as text for the repair prompt.
 */
export function describeCoverageProblems(
	sections: Array<{ startLine: number; endLine: number; name: string }>,
	totalLines: number,
): string[] {
	const problems: string[] = [];

	const first = sections[0]!;
	if (first.startLine !== 1) {
		problems.push(`the first row starts at line ${first.startLine}; it must start at line 1`);
	}

	for (let i = 1; i < sections.length; i++) {
		const previous = sections[i - 1]!;
		const current = sections[i]!;
		if (current.startLine !== previous.endLine + 1) {
			problems.push(
				`row "${current.name}" starts at line ${current.startLine} but the row before it ends at line ${previous.endLine}; rows must meet with no gap and no overlap`,
			);
		}
	}

	const last = sections[sections.length - 1]!;
	if (last.endLine !== totalLines) {
		problems.push(
			`the last row ends at line ${last.endLine}; it must end at line ${totalLines}, the last line of the file`,
		);
	}

	return problems.slice(0, 5);
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
