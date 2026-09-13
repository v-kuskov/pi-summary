import { Type } from "typebox";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { notifyUser, SummaryError } from "./error.ts";
import { describeFailure, failureNotice, loadWholeFile } from "./fallback.ts";
import { resolveFilePath } from "./paths.ts";
import { renderSummary, READ_LINE_LIMIT } from "./render.ts";
import { summarizeFile, type SummarizeOutcome } from "./summarize.ts";

export type SummaryDetails = {
	path: string;
	status: string;
	mode: string;
	lines: number;
	model: string;
	extraction: string;
	sections: number;
	dbPath: string;
	/** Model calls spent on this result, including repairs. 0 on a cache hit. */
	attempts: number;
	/** True when the model never returned a usable line map and only prose was stored. */
	degraded: boolean;
};

/**
 * The `summary` tool: a cached structural summary of one file, plus the map of which line
 * ranges hold what.
 *
 * The point is to make the guarded `read` usable. `read` returns at most `READ_LINE_LIMIT`
 * lines, so a model facing a 1400-line file needs to know which 200 to ask for.
 */
export function registerSummaryTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "summary",
		label: "Summarize file",
		description:
			`Map a code file's line ranges without reading it. Returns what the file does plus every range that holds what. Call it before reading a source file you have not seen, then read one range instead of the whole file. \`read\` returns at most ${READ_LINE_LIMIT} lines per call, so a 1400-line file costs seven reads or one summary plus one read. The first call on a file runs a model; later calls on the same unchanged file are free from cache.`,
		promptSnippet: "Map a code file's line ranges before reading it",
		promptGuidelines: [
			`Before reading a source file you have not seen, call summary on it first. It returns the line ranges, so you read one region instead of the whole file.`,
		],
		parameters: Type.Object({
			path: Type.String({
				description: "File path, relative to the working directory or absolute.",
			}),
			model: Type.Optional(
				Type.String({
					description:
						'Summarizer as "provider/model", for example "routeai/deepseek/deepseek-v4.1-flash". Defaults to the configured summarizer, or the current session model.',
				}),
			),
			refresh: Type.Optional(
				Type.Boolean({
					description: "Re-summarize even if the cached summary is still fresh.",
				}),
			),
		}),
		executionMode: "parallel",
		async execute(
			_id,
			params,
			signal,
			_onUpdate,
			ctx,
		): Promise<AgentToolResult<SummaryDetails>> {
			let outcome: SummarizeOutcome;
			try {
				outcome = await summarizeFile(ctx, {
					path: params.path,
					model: params.model,
					force: params.refresh,
					signal,
				});
			} catch (error) {
				// Summarizing is a convenience; the file itself is the answer. Hand back the
				// whole file so the model can still work, and surface the failure as a
				// notification and a visible comment rather than an error result.
				return wholeFileFallback(ctx, params.path, error);
			}
			const lines: string[] = [];
			lines.push(renderSummary(outcome.entry, { freshness: outcome.status }));
			if (outcome.degraded) {
				lines.push(
					`# the summarizer did not return a usable line map after ${outcome.attempts} attempts, so only the prose above is cached`,
				);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: summarizeDetails(outcome),
				usage: outcome.usage,
			};
		},
	});
}

function summarizeDetails(outcome: SummarizeOutcome): SummaryDetails {
	return {
		path: outcome.entry.path,
		status: outcome.status,
		mode: outcome.entry.mode,
		lines: outcome.entry.lines,
		model: outcome.entry.model,
		extraction: outcome.extraction,
		sections: outcome.entry.sections.length,
		dbPath: outcome.dbPath,
		attempts: outcome.attempts,
		degraded: outcome.degraded,
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
		extraction: "none",
		sections: 0,
		dbPath: "",
		attempts: 0,
		degraded: true,
	};
}

/**
 * Fallback for a failed `summary` call: return the file whole, with the error in a notice.
 *
 * The failure is reported three ways, because each one reaches a different reader: a UI
 * notification for the person watching, a `#` comment the model sees at the top of the
 * content, and the tool result's `details` for anything reading the session transcript.
 * The result is deliberately not an error - the model asked for the file's contents and it
 * got them, so there is nothing for it to recover from.
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
	let details = failedDetails(absPath);
	try {
		const file = await loadWholeFile(absPath);
		body = file.text;
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
		details,
	};
}
