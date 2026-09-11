import {
	type ExtensionAPI,
	type ExtensionContext,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { peekFreshSummary } from "./cache.ts";
import { countLinesFrom, looksBinary } from "./hash.ts";
import { isRegularFile, resolveFilePath } from "./paths.ts";
import { renderSummaryForReason, truncateChars } from "./render.ts";
import { summarizeFile, type SummarizeOutcome } from "./summarize.ts";

/** Hard limit on lines a single `read` may return. Larger spans must be split. */
export const READ_LINE_LIMIT = 200;

/** Cap for the blocked-read reason, which carries a whole summary. */
const REASON_CHARS = 6000;

/**
 * Block `read` calls that would return more than `READ_LINE_LIMIT` lines, and hand back a
 * summary of the file so the model can pick a range instead.
 *
 * The summary is served from cache when one is fresh. When the file has never been
 * summarized the guard summarizes it here and inlines the result, so an oversized `read`
 * is answered with a map rather than a dead end. That means a cold oversized read costs
 * model calls — this is the one place in the extension that spends them without the caller
 * naming a file to `summary` — so the reason always states whether the summary came from
 * cache or was just generated, and the work is bounded by `MAX_ATTEMPTS` in `summarize.ts`.
 */
export function registerReadGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("read", event)) return;

		const absPath = resolveFilePath(event.input.path, ctx.cwd);
		// Anything the guard cannot measure is left to the built-in read tool.
		if (!isRegularFile(absPath)) return;
		if (await looksBinary(absPath)) return;

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

		const remaining = await countLinesFrom(absPath, offset, READ_LINE_LIMIT);
		if (remaining === 0) return; // offset past EOF: let the read tool raise its own error

		// With an explicit limit the call is already bounded; otherwise the whole tail counts
		// as the span the model is asking for, which is exactly the unbounded read to stop.
		const span = limit === undefined ? remaining : Math.min(remaining, limit);
		if (span <= READ_LINE_LIMIT) return;

		return {
			block: true,
			reason: await buildBlockReason(ctx, absPath, offset, remaining),
		};
	});
}

/**
 * Compose the reason for a blocked read, summarizing the file if it has not been already.
 *
 * `remaining` is the counter's sentinel (`READ_LINE_LIMIT + 1`) meaning "more than the
 * limit", not an exact count — counting a huge file to print a precise number would
 * defeat the cheap early exit — so the wording says "more than" rather than naming a
 * figure it does not know.
 */
async function buildBlockReason(
	ctx: ExtensionContext,
	absPath: string,
	offset: number,
	remaining: number,
): Promise<string> {
	const exact = remaining <= READ_LINE_LIMIT;
	const span = exact
		? `would return ${remaining} lines (lines ${offset}-${offset + remaining - 1})`
		: `would return more than ${READ_LINE_LIMIT} lines, starting at line ${offset}`;

	const head = [
		`read is limited to ${READ_LINE_LIMIT} lines per call.`,
		`This call ${span}.`,
		`Add limit=${READ_LINE_LIMIT} and step offset, or read one region from the map below.`,
	];

	const summarized = await ensureSummary(ctx, absPath);
	if (summarized) {
		return truncateChars(
			[
				...head,
				"",
				summarized.fromCache
					? "Cached summary of this file (use these line ranges):"
					: "Summary of this file, generated for this read (use these line ranges):",
				"",
				summarized.text,
			].join("\n"),
			REASON_CHARS,
		);
	}

	return truncateChars(
		[
			...head,
			"",
			"No summary is available for this file.",
			`Call summary with path="${absPath}" to get a map of its regions, then read the region you need.`,
		].join("\n"),
		REASON_CHARS,
	);
}

/**
 * Get a summary for the reason, from cache or by generating one.
 *
 * Returns `undefined` when there is nothing to show, which leaves the reason to fall back
 * to telling the model to call `summary` itself. Every failure mode lands there: an
 * unreadable file, a provider error, no configured model. A read must not fail because the
 * summarizer did.
 */
async function ensureSummary(
	ctx: ExtensionContext,
	absPath: string,
): Promise<{ text: string; fromCache: boolean } | undefined> {
	try {
		const peek = await peekFreshSummary(ctx, absPath);
		if (peek) return { text: renderSummaryForReason(peek.entry), fromCache: true };
	} catch {
		// Fall through to generating one; a cache problem is not fatal.
	}

	try {
		const outcome: SummarizeOutcome = await summarizeFile(ctx, { path: absPath });
		return { text: renderSummaryForReason(outcome.entry), fromCache: false };
	} catch {
		return undefined;
	}
}
