import { Type } from "typebox";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ModelCallError, notifyUser, SummaryError } from "./error.ts";
import { describeFailure, failureNotice, loadWholeFile } from "./fallback.ts";
import { resolveFilePath } from "./paths.ts";
import { findRegion, regionExcerpt, regionMiss } from "./region.ts";
import { renderSummary } from "./render.ts";
import { regionOutputOf, summaryOutputOf, summaryOutputSchema } from "./schema.ts";
import { loadCachedSummary, summarizeFile, type SummarizeOutcome } from "./summarize.ts";
import { summaryRenderers } from "./tui.ts";

export type SummaryDetails = {
	path: string;
	status: string;
	mode: string;
	lines: number;
	model: string;
	sections: number;
	/** Model calls spent on this result, including repairs. 0 on a cache hit. */
	attempts: number;
	/** True when the model never returned a usable line map and only prose was stored. */
	degraded: boolean;
};

/**
 * The `summary` tool: a cached structural summary of one file, plus the map of which line
 * ranges hold what.
 *
 * The point is to let the model see a file's shape before spending a read on it: one call
 * returns the ranges, so a model facing a 1400-line file knows which region to ask for.
 *
 * The description is fixed at registration because pi takes one once and never asks again.
 * That is why nothing here reads the settings: `model` is resolved per call, inside the
 * summarize, where the project in force at that moment decides it.
 */
export function registerSummaryTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "summary",
		label: "Summarize file",
		description:
			`Map where a file's contents live without reading it: what the file does, and the line ranges that hold what - one row per region in line order with its span, the symbols, data and behaviors it holds, and what to know before editing it. Use it whenever you need to know what a file contains or where one thing is - a definition, a handler, an invariant - then read only the region that answers. Call it before reading a source file you have not seen: the whole file costs many times the context of one summary and costs again on every re-read. Pass region to drill into one row - its name from the map, or a line number inside it (a name match wins) - with no model call. The first call on a file runs a model; later calls on the same unchanged file are free from cache.`,
		promptSnippet: "Map where a file's contents live before reading it",
		promptGuidelines: [
			`To know what a file contains or where something lives - a definition, a handler, an invariant - call summary and read the region that answers, instead of the whole file.`,
			`Before reading a source file you have not seen, call summary on it first; it returns where every region is, so you read one range instead of the whole file.`,
			`To read one region, pass its name or a line number as region; that costs no model call.`,
		],
		parameters: Type.Object({
			path: Type.String({
				description: "File path, relative to the working directory or absolute.",
			}),
			region: Type.Optional(
				Type.String({
					description:
						"A region of an already-summarized file: a name from the map, or a line number inside it (a name match wins). Returns that region and its numbered excerpt, with no model call.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						'Summarizer as "provider/model". Defaults to the configured summarizer, or the current session model. Ignored when region is given.',
				}),
			),
			refresh: Type.Optional(
				Type.Boolean({
					description:
						"Return a new summary even if one already exists. Ignored when region is given.",
				}),
			),
		}),
		outputSchema: summaryOutputSchema,
		executionMode: "parallel",
		async execute(
			_id,
			params,
			signal,
			_onUpdate,
			ctx,
		): Promise<AgentToolResult<SummaryDetails>> {
			// The drill-down is a separate path on purpose: it never touches the summarizer, so a
			// region lookup can never spend a call and can never be the reason a file gets mapped.
			if (params.region !== undefined) {
				return lookupRegion(ctx, params.path, params.region);
			}

			let outcome: SummarizeOutcome;
			try {
				outcome = await summarizeFile(ctx, {
					path: params.path,
					model: params.model,
					force: params.refresh,
					signal,
				});
			} catch (error) {
				// A failed model call is the tool's failure. The model asked for a summary and must
				// see why it has none, rather than receive a substitute dressed as an answer.
				if (error instanceof ModelCallError) throw error;

				// Every other failure means no call happened or the answer could not be stored:
				// summarizing is a convenience, and the file itself is the answer. Hand back the
				// whole file so the model can still work, and surface the failure as a
				// notification and a visible comment rather than an error result.
				return wholeFileFallback(ctx, params.path, error);
			}
			return {
				content: [{ type: "text", text: renderSummary(outcome.entry) }],
				structuredContent: summaryOutputOf(outcome.entry),
				details: summarizeDetails(outcome),
				usage: outcome.usage,
			};
		},
		...summaryRenderers,
	});
}

function summarizeDetails(outcome: SummarizeOutcome): SummaryDetails {
	return {
		path: outcome.entry.path,
		status: outcome.status,
		mode: outcome.entry.mode,
		lines: outcome.entry.lines,
		model: outcome.entry.model,
		sections: outcome.entry.sections.length,
		attempts: outcome.attempts,
		degraded: outcome.degraded,
	};
}

/**
 * Answer `summary(path, region)`: one cached region and its excerpt, with no model call.
 *
 * Every miss is an error rather than a fallback to the map or to the model. A region the map
 * cannot name is a caller mistake with a specific correction - the names that do exist - and
 * paying for a summarization to answer a typo would be the opposite of the discipline the
 * budget exists to keep. A file with no cache or a stale one is pointed back at layer one.
 */
async function lookupRegion(
	ctx: ExtensionContext,
	path: string,
	region: string,
): Promise<AgentToolResult<SummaryDetails>> {
	const entry = await loadCachedSummary(ctx, path);
	const section = findRegion(entry, region);
	if (!section) throw regionMiss(entry, region);

	const excerpt = await regionExcerpt(entry.absPath, section);
	const text = [
		`# ${entry.path}  ${section.startLine}-${section.endLine}  ${section.kind}  ${section.name}`,
		section.note.trim(),
		"",
		excerpt,
	]
		.filter((part) => part !== "")
		.join("\n");

	return {
		content: [{ type: "text", text }],
		structuredContent: regionOutputOf(entry, section, excerpt),
		// No `usage`: zero model calls were made, and reporting the cached attempt count as if
		// this call had spent it would misstate what the lookup cost.
		details: {
			path: entry.path,
			status: "region",
			mode: entry.mode,
			lines: entry.lines,
			model: entry.model,
			sections: 1,
			attempts: 0,
			degraded: false,
		},
	};
}

/** Details for a call that could not be summarized, shaped like a normal result. */
function failedDetails(absPath: string): SummaryDetails {
	return {
		path: absPath,
		status: "failed",
		mode: "raw",
		lines: 0,
		model: "",
		sections: 0,
		attempts: 0,
		degraded: true,
	};
}

/**
 * Fallback for a `summary` call that failed without a model answer to show: return the file
 * whole, with the error in a notice.
 *
 * Only failures where no call happened or the answer could not be stored reach here - a failed
 * model call throws instead. The failure is reported three ways, because each one reaches a
 * different reader: a UI notification for the person watching, a `#` comment the model sees at
 * the top of the content, and the tool result's `details` for anything reading the session
 * transcript. The result is deliberately not an error - the model asked for the file's
 * contents and it got them, so there is nothing for it to recover from.
 */
async function wholeFileFallback(
	ctx: ExtensionContext,
	path: string,
	error: unknown,
): Promise<AgentToolResult<SummaryDetails>> {
	const absPath = resolveFilePath(path, ctx.cwd);
	const notice = failureNotice("summary", error, "Returning the whole file instead.");
	notifyUser(ctx, notice, "error");

	let body: string;
	let truncated = false;
	let details = failedDetails(absPath);
	try {
		const file = await loadWholeFile(absPath);
		body = file.text;
		truncated = file.truncated;
		details = { ...details, lines: file.totalLines };
		if (file.truncated) {
			body += `\n\n# the file is ${file.totalLines} lines and was cut here; read it in ranges with offset and limit to see the rest.`;
		}
	} catch (readError) {
		// Not even readable - that is a genuine error, and the model should know.
		throw new SummaryError(
			`${describeFailure(error)}; the file could not be read either: ${describeFailure(readError)}`,
		);
	}

	return {
		content: [{ type: "text", text: `# ${notice}\n\n${body}` }],
		// `kind`, `error` and `truncated` are payload semantics rather than generation history:
		// pi resolves an `outputSchema` tool to `structuredContent` alone, so this arm is the
		// only channel that reaches a script, which must be able to tell a fallback from a
		// summary and see that `content` was cut short. What produced the payload - the spend,
		// the cache state, the model - still stays in `details`.
		structuredContent: {
			kind: "file",
			path: absPath,
			lines: details.lines,
			error: notice,
			truncated,
			content: body,
		},
		details,
	};
}
