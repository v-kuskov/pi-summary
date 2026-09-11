import { readFile } from "node:fs/promises";
import { SECTION_KINDS } from "./schema.ts";

/** Longest file we will embed in a summarization prompt, by lines and by bytes. */
export const MAX_SUMMARY_LINES = 4000;
export const MAX_SUMMARY_BYTES = 160_000;

export type PreparedFile = {
	/** The text sent to the model. */
	text: string;
	/** Lines actually included in `text`. */
	shownLines: number;
	totalLines: number;
	truncated: boolean;
};

/**
 * Read a file for summarization, capped so a huge file cannot produce a huge prompt.
 *
 * When the cap bites, the caller tells the model how much it is seeing, and the stored
 * `covered_lines` reflects only the part that was sent — the tool never claims to have
 * mapped code it never saw.
 */
export async function prepareFile(absPath: string): Promise<PreparedFile> {
	const buffer = await readFile(absPath);
	const text = buffer.toString("utf-8");
	const allLines = text.split("\n");
	const totalLines = allLines.length;

	let shown = allLines.slice(0, MAX_SUMMARY_LINES).join("\n");
	let truncated = allLines.length > MAX_SUMMARY_LINES;
	if (Buffer.byteLength(shown, "utf-8") > MAX_SUMMARY_BYTES) {
		shown = shown.slice(0, MAX_SUMMARY_BYTES);
		truncated = true;
	}
	const shownLines = truncated ? shown.split("\n").length : totalLines;

	return { text: shown, shownLines, totalLines, truncated };
}

/**
 * The summarization prompt: the JSON contract, a worked example, then the file.
 *
 * There is no tool schema in this request. The shape of the answer is described here
 * instead, which is why the wording is as explicit as it is — the prompt is the only
 * place the contract appears, so an imprecise description becomes a repair round-trip.
 */
export function buildSummarizePrompt(path: string, file: PreparedFile): string {
	const scope = file.truncated
		? `The file is ${file.totalLines} lines. You are being shown only the first ${file.shownLines} lines. Map ONLY the lines you can see, ending at or before line ${file.shownLines}.`
		: `The file is ${file.totalLines} lines. Map the whole file, from line 1 to line ${file.totalLines}.`;

	return [
		"You are indexing a source file so a later model can read only the parts it needs instead of the whole file.",
		"Reply with a single JSON object and nothing else: no prose, no explanation, no markdown fence.",
		"",
		`File: ${path}`,
		scope,
		"",
		"JSON shape:",
		'  { "overview": string, "sections": [ { "start_line": number, "end_line": number, "kind": string, "name": string, "note": string } ] }',
		"",
		"overview: one to three sentences, plain prose. It must stand alone - it is shown without the map when there is no room for both.",
		"sections: one entry per contiguous region, in order, with no gaps and no overlaps between the first and last line you map.",
		"  start_line / end_line: integers, inclusive, 1-indexed, and never invented. Put a boundary where a declaration starts.",
		`  kind: one of ${SECTION_KINDS.join(", ")}.`,
		"  name: the declaration or symbol name, or (top level) for loose statements.",
		"  note: at most 90 characters on what that region does.",
		"",
		"A well shaped answer for a 1420-line file:",
		'{"overview":"Implements the HTTP client for the sync layer. Exports FooClient, which handles request signing and retry.","sections":[',
		'{"start_line":1,"end_line":24,"kind":"import","name":"node/fs, node/crypto","note":"constants for timeouts"},',
		'{"start_line":25,"end_line":140,"kind":"class","name":"FooClient","note":"HTTP transport with configurable retry"},',
		'{"start_line":141,"end_line":620,"kind":"method","name":"FooClient.request()","note":"builds, signs, sends one request"},',
		'{"start_line":621,"end_line":1420,"kind":"method","name":"FooClient.retry()","note":"exponential backoff and jitter"}]}',
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
