import {
	type ExtensionAPI,
	type ExtensionContext,
	createReadToolDefinition,
	detectSupportedImageMimeTypeFromFile,
} from "@earendil-works/pi-coding-agent";
import { peekFreshSummary } from "./cache.ts";
import { notifyUser } from "./error.ts";
import { failureNotice } from "./fallback.ts";
import { countLinesFrom, looksBinary } from "./hash.ts";
import { isRegularFile, isUnguardedPath, resolveFilePath } from "./paths.ts";
import { READ_LINE_LIMIT, renderSummary } from "./render.ts";
import { readImageAutoResize } from "./settings.ts";
import { summarizeFile, type SummarizeOutcome } from "./summarize.ts";

/**
 * A read either returns the lines it asked for, or it returns the file's map. Nothing else.
 *
 * A span of `READ_LINE_LIMIT` lines or fewer is left alone and returns exactly what was read.
 * A span of more than that is answered with the map instead, and the read itself never runs.
 *
 * This is registered as a `read` tool, replacing the built-in one, rather than as a `tool_call`
 * handler that blocks. Blocking cannot express this answer: pi hardcodes `isError: true` for a
 * blocked call (`createErrorToolResult` in pi-agent-core's agent loop), and a blocked call
 * skips the `tool_result` hook entirely, so the refusal reaches the model as a failed tool call
 * carrying the map as its text. Registering under the same name and returning the map as
 * ordinary content makes it a success, which is what it is: the call did what this extension
 * promises a read of that size does.
 *
 * The tool's surface is the built-in's. The definition below is built by the same factory pi
 * uses, and its description, schema, renderers and prompt metadata are kept, so the model's
 * instructions and the TUI's syntax highlighting are unchanged. Everything the interception
 * does not claim is handed straight to the built-in `execute`.
 *
 * The map is served from cache when one is fresh. When the file has never been summarized the
 * guard summarizes it here, so a cold oversized `read` costs up to `MAX_ATTEMPTS` model calls —
 * this is the one place in the extension that spends them without the caller naming a file to
 * `summary`.
 *
 * Interception is the choice over clamping because a clamped read is neither of the two useful
 * answers. It spends the context of a real read and still shows a fraction of the file, and a
 * map bolted onto its tail hides that the model was cut off. `read`'s own limit is the rule:
 * ask for more than it, and the answer is the map.
 *
 * When no summary can be produced the read is not intercepted: with no map to offer, withholding
 * the file would take it away and leave nothing behind. The read runs, the failure is raised
 * as a notification, and — for runs with no UI, where a notification goes nowhere — the reason
 * is appended to the result.
 *
 * Prose, notes and extensionless files (`.md`, `.txt`, `Makefile`) are never touched. They are
 * written to be read in order and a map of a README says nothing a skim does not, so the limit
 * buys nothing there and only cuts the file mid-section. The limit is for source files, where
 * not knowing which range holds a symbol costs a wasted call.
 */
export function registerReadTool(pi: ExtensionAPI): void {
	pi.registerTool({
		...createReadToolDefinition(process.cwd()),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const decision = await decide(ctx, params);

			if (decision.kind === "map") {
				// A clean read of the built-in reports `details: undefined`, so the shape of a
				// normal read is kept exactly.
				return { content: [{ type: "text", text: decision.text }], details: undefined };
			}

			const result = await delegate(toolCallId, params, signal, onUpdate, ctx);
			if (decision.kind === "notice") {
				return {
					content: [...result.content, { type: "text", text: `\n# ${decision.notice}` }],
					details: result.details,
				};
			}
			return result;
		},
	});
}

/**
 * Run the built-in read, on the built-in's own terms.
 *
 * The definition is built fresh per call rather than once: the session may have been replaced
 * or the project switched since this tool was registered, and `autoResizeImages` comes from
 * pi's settings, which an extension context does not expose. It is built against the process
 * cwd as a fallback only — the built-in resolves every path against the calling context's cwd,
 * which is passed straight through.
 *
 * Reading that setting costs a synchronous load of pi's settings files. The built-in consults
 * it in one place only — the branch that has already classified the file as an image — so a
 * read is checked for being an image first and every other read skips the setting entirely
 * rather than paying for a value it would discard. Detection is by content, like the built-in
 * does it, so an image with an unexpected extension is still resized on the user's terms.
 */
async function delegate(
	toolCallId: string,
	params: ReadInput,
	signal: AbortSignal | undefined,
	onUpdate: Parameters<ReturnType<typeof createReadToolDefinition>["execute"]>[3],
	ctx: ExtensionContext,
) {
	const options = (await looksLikeImage(params.path, ctx.cwd))
		? { autoResizeImages: readImageAutoResize(ctx.cwd) }
		: {};
	return createReadToolDefinition(process.cwd(), options).execute(
		toolCallId,
		params,
		signal,
		onUpdate,
		ctx,
	);
}

/**
 * Whether the built-in read will treat this path as an image, using its own detection.
 *
 * A path that cannot be opened is not an image: the built-in read is about to report that
 * itself, and reporting it here would replace its message with this one.
 */
async function looksLikeImage(path: string, cwd: string): Promise<boolean> {
	try {
		return (await detectSupportedImageMimeTypeFromFile(resolveFilePath(path, cwd))) !== null;
	} catch {
		return false;
	}
}

/** A `read` call's arguments, as the shared schema defines them. */
type ReadInput = { path: string; offset?: number; limit?: number };

/** What a `read` call should do: run normally, return the map, or run and carry a notice. */
type Decision =
	| { kind: "read" }
	| { kind: "map"; text: string }
	| { kind: "notice"; notice: string };

/**
 * Decide what to do with a read, without reading the file.
 *
 * Everything here can fail on a file that is being rewritten underneath us, and a `read` must
 * not fail because the *guard* failed to look at it, so the probes are inside one try/catch.
 */
async function decide(ctx: ExtensionContext, params: ReadInput): Promise<Decision> {
	const absPath = resolveFilePath(params.path, ctx.cwd);
	if (isUnguardedPath(absPath)) return { kind: "read" };

	try {
		if (!isRegularFile(absPath)) return { kind: "read" };
		if (await looksBinary(absPath)) return { kind: "read" };
	} catch {
		return { kind: "read" };
	}

	const offset =
		typeof params.offset === "number" && Number.isFinite(params.offset)
			? Math.max(1, Math.trunc(params.offset))
			: 1;

	// `Math.trunc` here and `Math.max(1, ...)` above are load-bearing; the `isFinite` guards are
	// not, and neither is the `typeof` check. pi's read schema declares both fields as a bare
	// `{"type":"number"}` with no integer or minimum constraint, so a fractional `offset` and a
	// zero or negative one are all schema-valid and do reach here. What cannot reach here is a
	// non-number, `NaN` or an infinity: `validateToolArguments` runs before `execute` and throws
	// on anything the schema rejects, and that throw is caught in pi's own loop and returned as
	// an immediate error result rather than being passed along (verified in the installed
	// `@earendil-works/pi-agent-core` `agent-loop.js`, where the call sits inside the same `try`
	// whose `catch` builds the error result). The guards are kept as defence in depth: they are
	// one comparison each, and a future pi that stopped validating would otherwise send `NaN`
	// into `countLinesFrom`, which is a byte offset arithmetic path.

	const limit =
		typeof params.limit === "number" && Number.isFinite(params.limit)
			? Math.trunc(params.limit)
			: undefined;

	// A non-positive limit is the built-in tool's problem, not the guard's.
	if (limit !== undefined && limit <= 0) return { kind: "read" };

	let remaining: number;
	try {
		remaining = await countLinesFrom(absPath, offset, READ_LINE_LIMIT);
	} catch {
		return { kind: "read" }; // unreadable now: let the built-in read report it
	}
	if (remaining === 0) return { kind: "read" }; // offset past EOF: the read tool's own error

	// With an explicit limit the call is already bounded; otherwise the whole tail counts
	// as the span the model is asking for, which is exactly the unbounded read to answer.
	const span = limit === undefined ? remaining : Math.min(remaining, limit);
	if (span <= READ_LINE_LIMIT) return { kind: "read" };

	const summarized = await ensureSummary(ctx, absPath);

	// No summary, so answering with a map would leave the model with nothing. Let the read
	// run and say why.
	if (!summarized.ok) {
		const notice = failureNotice("summary", summarized.error, "Reading the file directly.");
		notifyUser(ctx, notice, "error");
		return { kind: "notice", notice };
	}

	return { kind: "map", text: renderMapAnswer(offset, summarized.text) };
}

/**
 * The text an intercepted read returns: what stands in for it, then the map.
 *
 * The map is rendered with its header, so the model still sees the file's size and hash.
 */
function renderMapAnswer(offset: number, map: string): string {
	const where = offset === 1 ? "this file" : `lines ${offset} onward`;
	const banner = [
		`# ${where}: longer than ${READ_LINE_LIMIT} lines; this is the file's map, not its contents.`,
		`# read one of the ranges below with offset/limit, at most ${READ_LINE_LIMIT} lines per call.`,
		"",
	];
	return [...banner, map].join("\n");
}

/** A summary to answer the read with, or the reason there is none. */
type Summarized = { ok: true; text: string } | { ok: false; error: unknown };

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
		if (peek) return { ok: true, text: renderSummary(peek.entry) };
	} catch {
		// Fall through to generating one; an unreadable cache is not fatal.
	}

	let outcome: SummarizeOutcome;
	try {
		outcome = await summarizeFile(ctx, { path: absPath });
	} catch (error) {
		return { ok: false, error };
	}
	return { ok: true, text: renderSummary(outcome.entry) };
}
