import {
	type ExtensionAPI,
	type ExtensionContext,
	isReadToolResult,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { peekFreshSummary } from "./cache.ts";
import { notifyUser } from "./error.ts";
import { failureNotice } from "./fallback.ts";
import { countLinesFrom, looksBinary } from "./hash.ts";
import { isRegularFile, isUnguardedPath, resolveFilePath } from "./paths.ts";
import { READ_LINE_LIMIT, renderSummary } from "./render.ts";
import { summarizeFile, type SummarizeOutcome } from "./summarize.ts";

/** A notice to append to a read result, keyed by tool call id, awaiting that result. */
const pendingNotices = new Map<string, string>();

/**
 * A read either returns the lines it asked for, or it returns the file's map. Nothing else.
 *
 * A span of `READ_LINE_LIMIT` lines or fewer is left alone and returns exactly what was read.
 * A span of more than that is answered with the map instead: the call is blocked, the read
 * never runs, and the model gets the summary as the tool result. So a refused read costs
 * nothing from the file itself and nothing from the model's context.
 *
 * The map is served from cache when one is fresh. When the file has never been summarized the
 * guard summarizes it here, so a cold oversized `read` costs up to `MAX_ATTEMPTS` model calls —
 * this is the one place in the extension that spends them without the caller naming a file to
 * `summary`.
 *
 * The call is refused rather than clamped because a clamped read is neither of the two useful
 * answers. It spends the context of a real read and still shows a fraction of the file, and a
 * map bolted onto its tail hides that the model was cut off. `read`'s own limit is the rule:
 * ask for more than it, and the answer is the map.
 *
 * A refusal is reported to the model as a failed call — pi's core turns the reason into an error
 * tool result — which is deliberate here: the read genuinely did not happen, and the reason
 * carries the map. No `tool_result` handler runs for a refused call, so the reason is the only
 * channel out.
 *
 * When no summary can be produced the read is *not* refused: with no map to offer, refusing the
 * read would take the file away and leave nothing behind. The failure is raised as a
 * notification and, for runs with no UI, as a note appended to the read result.
 *
 * Prose, notes and extensionless files (`.md`, `.txt`, `Makefile`) are never touched. They are
 * written to be read in order and a map of a README says nothing a skim does not, so the limit
 * buys nothing there and only cuts the file mid-section. The limit is for source files, where
 * not knowing which range holds a symbol costs a wasted call.
 */
export function registerReadGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("read", event)) return;

		const absPath = resolveFilePath(event.input.path, ctx.cwd);
		if (isUnguardedPath(absPath)) return;
		// Anything the guard cannot measure is left to the built-in read tool. The probe
		// functions below open the file, and it can vanish in between - an editor rewriting
		// it, a delete, a permission change - so they are guarded too. A read must never
		// fail because the *guard* failed to look at the file.
		try {
			if (!isRegularFile(absPath)) return;
			if (await looksBinary(absPath)) return;
		} catch {
			return;
		}

		const rawOffset = event.input.offset;
		const offset =
			typeof rawOffset === "number" && Number.isFinite(rawOffset)
				? Math.max(1, Math.trunc(rawOffset))
				: 1;

		const rawLimit = event.input.limit;
		const limit =
			typeof rawLimit === "number" && Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : undefined;

		// A non-positive limit is the built-in tool's problem, not the guard's.
		if (limit !== undefined && limit <= 0) return;

		let remaining: number;
		try {
			remaining = await countLinesFrom(absPath, offset, READ_LINE_LIMIT);
		} catch {
			return; // unreadable now: let the built-in read report it
		}
		if (remaining === 0) return; // offset past EOF: let the read tool raise its own error

		// With an explicit limit the call is already bounded; otherwise the whole tail counts
		// as the span the model is asking for, which is exactly the unbounded read to refuse.
		const span = limit === undefined ? remaining : Math.min(remaining, limit);
		if (span <= READ_LINE_LIMIT) return;

		const summarized = await ensureSummary(ctx, absPath);

		// No summary, so refusing the read would leave the model with nothing. Let it through
		// and say why.
		if (summarized.error !== undefined) {
			const notice = failureNotice("summary", summarized.error, "Reading the file directly.");
			notifyUser(ctx, notice, "error");
			pendingNotices.set(event.toolCallId, `# ${notice}`);
			return;
		}

		return { block: true, reason: renderReason(offset, summarized) };
	});

	// A notification only exists in the UI, which is absent in print and RPC runs. On the
	// failure path the read does run, so the notice rides its result.
	pi.on("tool_result", async (event) => {
		if (!isReadToolResult(event)) return;
		const notice = pendingNotices.get(event.toolCallId);
		if (notice === undefined) return;
		pendingNotices.delete(event.toolCallId);

		return { content: [...event.content, { type: "text", text: `\n${notice}` }] };
	});
}

/**
 * The text a refused read returns: why it was not performed, then the map.
 *
 * The map is rendered with its header, so the model still sees the file's size and hash.
 */
function renderReason(offset: number, summarized: Summarized): string {
	const where = offset === 1 ? "this file" : `lines ${offset} onward`;
	const banner = [
		`# read not performed: ${where} is longer than ${READ_LINE_LIMIT} lines, and a read returns`,
		`# at most ${READ_LINE_LIMIT}. The summary is below; read one of its ranges with offset/limit.`,
		"",
	];
	return [...banner, summarized.text].join("\n");
}

/** A summary to answer the read with, or the reason there is none. */
type Summarized = { text: string; error?: undefined } | { text?: undefined; error: unknown };

/**
 * Get a summary from cache or by generating one.
 *
 * Nothing here throws: a `read` must not fail because the summarizer did. A cache problem
 * falls through to generating a summary, and a failure to generate is returned so the caller
 * can notify and let the read through.
 */
async function ensureSummary(ctx: ExtensionContext, absPath: string): Promise<Summarized> {
	try {
		const peek = await peekFreshSummary(ctx, absPath);
		if (peek) return { text: renderSummary(peek.entry) };
	} catch {
		// Fall through to generating one; an unreadable cache is not fatal.
	}

	let outcome: SummarizeOutcome;
	try {
		outcome = await summarizeFile(ctx, { path: absPath });
	} catch (error) {
		return { error };
	}
	return { text: renderSummary(outcome.entry) };
}
