import { Type } from "typebox";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SummaryError } from "./error.ts";
import { describeFailure, failureNotice, loadWholeFile } from "./fallback.ts";
import { resolveFilePath } from "./paths.ts";
import { renderSummary } from "./render.ts";
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
 * The point is to make the guarded `read` usable. `read` returns at most 200 lines, so a
 * model facing a 1400-line file needs to know which 200 to ask for.
 */
export function registerSummaryTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "summary",
		label: "Summarize file",
		description:
			"Get a structural summary of a file: what it does, plus a map of which line ranges hold what. The file is summarized by a model the first time and then served from a local cache until the file changes. Use this before reading an unfamiliar or large file, then read only the range you need.",
		promptSnippet: "Summarize a file: its purpose and a map of its line ranges",
		promptGuidelines: [
			"Use summary before read on a file you have not seen, to get its purpose and the line range of the part you need.",
			"After summary, read only the range you need with offset and limit instead of the whole file.",
		],
		parameters: Type.Object({
			path: Type.String({
				description: "File path, relative to the working directory or absolute.",
			}),
			model: Type.Optional(
				Type.String({
					description:
						'Summarizer as "provider/model", for example "deepseek/deepseek-v4-flash". Defaults to the current session model.',
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
			if (outcome.firstTouch) lines.push(`# cache: ${outcome.dbPath}`);
			lines.push(renderSummary(outcome.entry, { header: true, freshness: outcome.status }));
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
function failedDetails(absPath: string, error: unknown): SummaryDetails {
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
	notifyError(ctx, notice);

	let body: string;
	let details = failedDetails(absPath, error);
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

/** Show an error in the UI when there is one to show it in. */
function notifyError(ctx: ExtensionContext, message: string): void {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.notify(message, "error");
	} catch {
		// A notification is a courtesy; never let it break the tool call.
	}
}
