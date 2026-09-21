import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isEditToolResult } from "@earendil-works/pi-coding-agent";
import { countLinesFrom } from "./hash.ts";
import { resolveFilePath } from "./paths.ts";

/**
 * Tell the model where an edit landed.
 *
 * A successful `edit` returns one line and nothing else - `Successfully replaced 2 block(s)
 * in src/foo.ts.` The diff, the patch and the first changed line are all computed, and all
 * reach the `tool_result` hook in `details`, but `details` is a rendering channel: it is
 * read by the TUI, the HTML exporter and the session transcript, and by no provider
 * adapter. So the model learns that an edit succeeded and never learns where it landed.
 *
 * That gap is what makes an editing session re-read files. Measured on one session, a
 * 253-line file was read 61 times and 61 of 61 reads passed no `limit`, so every one was
 * intercepted by the guard and every stale one paid a whole-file model call. The model was
 * not checking its spelling - it was looking up line numbers it had no other way to get.
 * Two numbers answer it: where the change is, and how long the file is now.
 *
 * This is appended rather than replacing the built-in confirmation, which carries the block
 * count and the path as the model wrote it. Both are model-visible only; the TUI draws the
 * edit result from `details.diff`, and draws nothing from `content`, so the transcript looks
 * the same as before.
 *
 * Only successful edits are touched, and a locator that cannot be computed exactly is not
 * appended at all, because a wrong line number is worse than no line number: the model would
 * act on it.
 *
 * One `edit` call can land in several disjoint places, so the locator names every changed
 * run of lines rather than the span between the first and the last. A span would name the
 * unchanged lines between the runs as edited - measured over one real session of 447 edits,
 * 231 (52%) landed in two or more disjoint runs, and the widest span named 64 unchanged
 * lines. A model told its change is "somewhere in 18-86" has learned nothing it can act on,
 * which is the re-read this exists to prevent.
 *
 * A no-op edit needs no guard of its own here. The built-in tool throws ("The replacement
 * produced identical content") rather than returning a result, and although pi catches that
 * throw and still runs this hook, it arrives as an error result and is declined by the
 * `isError` check below.
 */
export function registerEditLocator(pi: ExtensionAPI): void {
	pi.on("tool_result", async (event, ctx) => {
		if (!isEditToolResult(event) || event.isError) return;

		// `firstChangedLine` is optional in `EditToolDetails`, so `undefined` is a real absence
		// rather than a defensive check. The rest of the predicate is not decoration either: a
		// zero, a fraction or a negative would name a line that cannot exist, and `NaN` is the
		// case that makes `Number.isInteger` necessary rather than redundant - `NaN < 1` is
		// false, so a `< 1` test alone lets it through into the sort below, where it would come
		// out as a line number that is not a number. See the smoke suite's `firstChangedLine`
		// case for the four values this refuses.
		const first = event.details?.firstChangedLine;
		if (typeof first !== "number" || !Number.isInteger(first) || first < 1) return;

		const path = event.input.path;
		if (typeof path !== "string" || path.length === 0) return;

		let runs: [number, number][];
		let total: number;
		try {
			runs = changedRuns(event.details?.diff ?? "", first);
			total = await countLines(resolveFilePath(path, ctx.cwd));
		} catch {
			// The file vanished or became unreadable between the write and this read.
			return;
		}

		// A line number past the end of the file means the file on disk is not the one
		// that was edited, so nothing derived from it can be trusted.
		if (total < (runs[runs.length - 1]?.[1] ?? first)) return;

		const where = nameRuns(runs);
		// `read` counts an emptied file as 1 line, so the singular is reachable: a call that
		// deletes a file's only line lands here.
		const size = `${total} ${total === 1 ? "line" : "lines"}`;
		return {
			content: [
				...event.content,
				{ type: "text", text: `Edited ${where}; the file now has ${size}.` },
			],
		};
	});
}

/**
 * The runs of lines the edit changed, in the new file's numbering.
 *
 * `details.diff` is the display diff: `-` and `+` rows carrying their line number in a left
 * column, with unchanged runs collapsed to `...`. The `+` rows are the lines that exist in
 * the new file, so grouping consecutive ones gives the regions the edit really touched.
 * `first` seeds the list because pi computed it itself, so a diff this could not parse still
 * names the one line the tool was sure about.
 *
 * A deletion's phantom row is skipped. A deletion renders as a `+` row with no text -
 * `diffLines` reports the empty remainder after the removed run as an addition - so counting
 * it would name a line nothing was written to. When a call only deletes, every `+` row is
 * such a phantom, the list holds just `first`, and the answer is where the removed text
 * began: the line the model should look at.
 *
 * A replace, or a delete followed by an insert, is deliberately not special-cased. The `+`
 * rows of both are real lines of the new file, so naming them names lines that do exist.
 */
function changedRuns(diff: string, first: number): [number, number][] {
	const lines: number[] = [first];
	for (const row of diff.split("\n")) {
		const match = /^\+\s*(\d+)\s(.*)$/.exec(row);
		if (!match) continue;
		// A deletion's phantom row carries no text. Skipping it is not cosmetic: it would
		// otherwise be reported as a change at a line nothing was written to.
		if ((match[2] ?? "").trim() === "") continue;
		const line = Number(match[1]);
		if (Number.isInteger(line) && line >= 1) lines.push(line);
	}
	lines.sort((a, b) => a - b);

	const runs: [number, number][] = [];
	for (const line of lines) {
		const last = runs[runs.length - 1];
		if (last && line <= last[1] + 1) {
			if (line > last[1]) last[1] = line;
		} else {
			runs.push([line, line]);
		}
	}
	return runs;
}

/**
 * Name the changed runs as `line 250` or `lines 6, 40 and 251`.
 *
 * Every run is named, because the span between the first and the last would name the
 * unchanged lines in the gaps. Digits and punctuation only, so the clause stays short enough
 * to sit behind the built-in confirmation: over the same 447-edit session the median render
 * was 51 characters and the widest, a 34-run edit, was 224.
 */
function nameRuns(runs: [number, number][]): string {
	const parts = runs.map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`));
	// Plural by span, not by run count: a single run that covers several lines is still
	// `lines 250-251`, and only a lone single-line run is `line 250`.
	const single = runs.length === 1 && runs[0]?.[0] === runs[0]?.[1];
	if (parts.length === 1) return `${single ? "line" : "lines"} ${parts[0]}`;
	const head = parts.slice(0, -1).join(", ");
	return `lines ${head} and ${parts[parts.length - 1]}`;
}

/**
 * How many lines the file has now, counted the way `read` counts them.
 *
 * This is the number a model needs in order to pick an `offset`, so it has to equal what
 * `read` reports or the next `offset` lands in the wrong place. `read` computes
 * `text.split("\n").length` - the raw split, with no popping (pi's `core/tools/read.js`,
 * its `totalFileLines`) - so a file of `a\nb\nc\n` is 4 lines and an empty file is 1. That is
 * the same `newlines + 1` rule `fingerprint` states in hash.ts, and the one the guard's
 * boundary arithmetic depends on.
 *
 * `countLinesFrom` already streams this way and returns exactly `newlines + 1` when it is
 * allowed to run to EOF, so the cap is lifted by asking for more lines than any file has.
 * An earlier version of this function duplicated that loop; measured against it over empty
 * files, files with and without a trailing newline, CRLF and a 5000-line file, the two
 * agreed on every case.
 */
async function countLines(absPath: string): Promise<number> {
	return countLinesFrom(absPath, 1, Number.POSITIVE_INFINITY);
}
