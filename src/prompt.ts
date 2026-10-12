import { readFile } from "node:fs/promises";

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
 * The summarization prompt: what the map is for, how the file is laid out, the limits the
 * answer is held to, then the numbered file.
 *
 * The field-by-field contract is not here: it rides on `emitMapSchema`, which the model
 * sees as the parameters of the `emit_map` tool it must call. What remains is held to a
 * goal and a few limits, nothing more. Three things carry the weight:
 *
 * - The map is a **retrieval index**, not a caption: `name` is asked for as the exact symbol
 *   as the file spells it, never a bare number, and `note` is asked to name the
 *   behaviors and data a reader would look for - so every row answers "where does X live".
 * - The excerpt is **numbered**, and one line says the numbers are copied from the left
 *   column. That turns a counting task, which models fail at over long files, into a
 *   copying task.
 * - The `Limits` are what a model cannot infer: that gaps are legal, that numbers come
 *   from the column rather than from counting, and that boilerplate gets no rows.
 *
 * A worked example was measured and dropped - it was over half the prompt, and every rule
 * it stated is either stated here once, shorter, or enforced locally by `normalizeSections`
 * (overlap and reversed ranges) as well as asked for.
 */
export function buildSummarizePrompt(path: string, file: PreparedFile): string {
	return [
		"Index this file so a later model can find where any information in it lives and read only that part.",
		"Reply only by calling the emit_map tool.",
		"",
		`File: ${path} (${file.totalLines} lines; line ${file.totalLines} is the last).`,
		"",
		"The excerpt is numbered, number then tab then line:",
		"",
		`     1${GUTTER}the first line of the file`,
		`     2${GUTTER}the second line`,
		"",
		"Limits:",
		"  - Copy line numbers from the left column; counting them yourself drifts over long files.",
		"  - Skip imports, re-exports, license headers and boilerplate: they get no rows.",
		"  - Leave gaps where lines do nothing - blank runs and boilerplate.",
		"  - Say a thing once - a note that only renames the row above extends that row instead.",
		"",
		"Now map where everything in the file below lives.",
		"",
		"<file>",
		file.text,
		"</file>",
	].join("\n");
}

/**
 * The turn-level nudge: a turn that ended without an `emit_map` call is not an ending,
 * it is a turn that still owes its answer.
 */
export const CONTINUATION_PROMPT =
	"You MUST call the `emit_map` tool NOW with the map for this file.";

/** Model id in `provider/model` form for the cache header. */
export function modelLabel(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}
