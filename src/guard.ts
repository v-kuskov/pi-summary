import {
	type ExtensionAPI,
	type ExtensionContext,
	type ToolCallEventResult,
	isReadToolResult,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { peekFreshSummary } from "./cache.ts";
import { notifyUser } from "./error.ts";
import { failureNotice } from "./fallback.ts";
import { countLinesFrom, looksBinary } from "./hash.ts";
import { isRegularFile, resolveFilePath } from "./paths.ts";
import {
	READ_LINE_LIMIT,
	renderSummary,
} from "./render.ts";
import { summarizeFile, type SummarizeOutcome } from "./summarize.ts";

/** Notices raised for the current batch, keyed by tool call id, awaiting their result. */
const pendingNotices = new Map<string, string>();

/**
 * Block `read` calls that would return more than `READ_LINE_LIMIT` lines, and hand back a
 * summary of the file so the model can pick a range instead.
 *
 * The summary is served from cache when one is fresh. When the file has never been
 * summarized the guard summarizes it here and inlines the result, so an oversized `read`
 * is answered with a map rather than a dead end. That means a cold oversized read costs
 * model calls — this is the one place in the extension that spends them without the caller
 * naming a file to `summary` — so the reason states whether the summary came from cache or
 * was just generated, and the work is bounded by `MAX_ATTEMPTS` in `summarize.ts`.
 *
 * When no summary can be produced the read is **allowed through** rather than blocked, and
 * the failure is raised as a notification. Blocking a read because the summarizer broke
 * would deny the model a file it is entitled to see.
 */
export function registerReadGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("read", event)) return;

		const absPath = resolveFilePath(event.input.path, ctx.cwd);
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
		// as the span the model is asking for, which is exactly the unbounded read to stop.
		const span = limit === undefined ? remaining : Math.min(remaining, limit);
		if (span <= READ_LINE_LIMIT) return;

		return buildBlockResult(ctx, absPath, event.toolCallId, offset);
	});

	// A notification only exists in the UI, which is absent in print and RPC runs. When a
	// read was allowed because summarizing failed, put the same one-line notice on the read
	// result so the model learns its map is missing and why.
	pi.on("tool_result", async (event) => {
		if (!isReadToolResult(event)) return;
		const notice = pendingNotices.get(event.toolCallId);
		if (notice === undefined) return;
		pendingNotices.delete(event.toolCallId);

		return {
			content: [...event.content, { type: "text", text: `\n# ${notice}` }],
		};
	});
}

/**
 * Compose the guard's verdict for an oversized read, summarizing the file if needed.
 *
 * `remaining` is the counter's sentinel (`READ_LINE_LIMIT + 1`) meaning "more than the
 * limit", never an exact count - counting a huge file to print a precise number would
 * defeat the cheap early exit - so the wording says "more than" rather than naming a
 * figure it does not know.
 *
 * The summary is inlined whole, with no character cap. A cap here truncated the map to
 * some fraction of its rows and cut the trailing read hint, so a model that was blocked
 * precisely because it needed a map was handed a partial one - and the partial map is
 * indistinguishable from a complete one, since the rows it kept are contiguous. A large
 * reason is the honest answer: the alternative is a plausible map with rows missing.
 *
 * Returns `undefined` to allow the read when there is no summary to justify blocking it.
 */
async function buildBlockResult(
	ctx: ExtensionContext,
	absPath: string,
	toolCallId: string,
	offset: number,
): Promise<ToolCallEventResult | undefined> {
	const span = `would return more than ${READ_LINE_LIMIT} lines, starting at line ${offset}`;

	const summarized = await ensureSummary(ctx, absPath);

	// No summary, so no reason to block. Report why and let the built-in read run.
	if (summarized.error !== undefined) {
		const notice = failureNotice("summary", summarized.error, "Reading the whole file instead.");
		notifyUser(ctx, notice, "error");
		// Stashed for the `tool_result` handler, which appends it to the read output. The
		// map is keyed by tool call id and only written when the read is allowed, so an
		// unrelated read cannot pick up someone else's notice.
		pendingNotices.set(toolCallId, notice);
		return undefined;
	}

	const head = [
		`read is limited to ${READ_LINE_LIMIT} lines per call.`,
		`This call ${span}.`,
		`Add limit=${READ_LINE_LIMIT} and step offset, or read one region from the map below.`,
		"",
		summarized.fromCache
			? "Cached summary of this file (use these line ranges):"
			: "Summary of this file, generated for this read (use these line ranges):",
		"",
		summarized.text,
	];

	return { block: true, reason: head.join("\n") };
}

/** A summary for the block reason, or the reason there is none. */
type EnsureResult =
	| { text: string; fromCache: boolean; error?: undefined }
	| { text?: undefined; fromCache: false; error: unknown };

/**
 * Get a summary for the reason, from cache or by generating one.
 *
 * Nothing here throws: a `read` must not fail because the summarizer did. A cache problem
 * falls through to generating a summary, and a failure to generate is returned so the
 * caller can notify and allow the read.
 */
async function ensureSummary(ctx: ExtensionContext, absPath: string): Promise<EnsureResult> {
	try {
		const peek = await peekFreshSummary(ctx, absPath);
		if (peek) return { text: renderSummary(peek.entry), fromCache: true };
	} catch {
		// Fall through to generating one; an unreadable cache is not fatal.
	}

	let outcome: SummarizeOutcome;
	try {
		outcome = await summarizeFile(ctx, { path: absPath });
	} catch (error) {
		return { fromCache: false, error };
	}
	return { text: renderSummary(outcome.entry), fromCache: false };
}
