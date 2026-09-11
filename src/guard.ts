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

/** Text to append to a read result, keyed by tool call id, awaiting that result. */
const pendingAppends = new Map<string, string>();

/**
 * Cap an oversized `read` at `READ_LINE_LIMIT` lines and hand back the file's map alongside
 * the content it did return.
 *
 * The map is served from cache when one is fresh. When the file has never been summarized the
 * guard summarizes it here, so an oversized `read` is answered with a map rather than a dead
 * end. That means a cold oversized read costs model calls — this is the one place in the
 * extension that spends them without the caller naming a file to `summary` — so the appended
 * text states whether the map came from cache or was just generated, and the work is bounded
 * by `MAX_ATTEMPTS` in `summarize.ts`.
 *
 * The call is *not* blocked. A blocked call is reported to the model as a tool error by pi's
 * core (`createErrorToolResult`), and no `tool_result` handler runs for it, so there is no way
 * to return the map without also returning a failure. Instead the guard clamps `input.limit` —
 * allowed, since `tool_call` handlers may mutate `input` — and appends the map to the real
 * result, which stays a success because the read did happen.
 *
 * When no summary can be produced the call is left alone, and the failure is raised as a
 * notification without touching the read: with no map to offer, clamping would only take lines
 * away from the model.
 *
 * Prose, notes and extensionless files (`.md`, `.txt`, `Makefile`) are never touched. They are
 * written to be read in order and a map of a README says nothing a skim does not, so the 200
 * line cap buys nothing there and only cuts the file mid-section. The cap is for source files,
 * where not knowing which range holds a symbol costs a wasted call.
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
		// as the span the model is asking for, which is exactly the unbounded read to cap.
		const span = limit === undefined ? remaining : Math.min(remaining, limit);
		if (span <= READ_LINE_LIMIT) return;

		const summarized = await ensureSummary(ctx, absPath);

		// No summary, so nothing to add to the read and no reason to shorten it.
		if (summarized.error !== undefined) {
			const notice = failureNotice("summary", summarized.error, "Reading the whole file instead.");
			notifyUser(ctx, notice, "error");
			pendingAppends.set(event.toolCallId, `# ${notice}`);
			return;
		}

		// The read now returns exactly the first `READ_LINE_LIMIT` lines from the offset. The
		// clamp is what makes the appended map actionable: the model is looking at lines it can
		// place on the map, and can ask for another range by number.
		event.input.limit = READ_LINE_LIMIT;

		const last = offset + READ_LINE_LIMIT - 1;
		const head = [
			"",
			`# this call would have returned more than ${READ_LINE_LIMIT} lines, so it was capped at`,
			`# limit=${READ_LINE_LIMIT}: lines ${offset}-${last} are above. Use offset/limit to read`,
			"# further, or read one region below.",
			"",
			summarized.fromCache
				? "Cached summary of this file (use these line ranges):"
				: "Summary of this file, generated for this read (use these line ranges):",
			"",
			summarized.text,
		];
		pendingAppends.set(event.toolCallId, head.join("\n"));
	});

	// A notification only exists in the UI, which is absent in print and RPC runs. The appended
	// text is what reaches the model, so the notice and the map both travel this path.
	pi.on("tool_result", async (event) => {
		if (!isReadToolResult(event)) return;
		const append = pendingAppends.get(event.toolCallId);
		if (append === undefined) return;
		pendingAppends.delete(event.toolCallId);

		return {
			content: [...event.content, { type: "text", text: `\n${append}` }],
		};
	});
}

/** A summary for the appended text, or the reason there is none. */
type EnsureResult =
	| { text: string; fromCache: boolean; error?: undefined }
	| { text?: undefined; fromCache: false; error: unknown };

/**
 * Get a summary to append, from cache or by generating one.
 *
 * Nothing here throws: a `read` must not fail because the summarizer did. A cache problem
 * falls through to generating a summary, and a failure to generate is returned so the
 * caller can notify and leave the read unmodified.
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
