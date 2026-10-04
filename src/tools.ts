import { Type } from "typebox";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ModelCallError, notifyUser, SummaryError } from "./error.ts";
import { describeFailure, failureNotice, loadWholeFile } from "./fallback.ts";
import { DEFAULT_TRAP_LIMIT, readSettings, type Settings } from "./settings.ts";
import { resolveFilePath } from "./paths.ts";
import { renderSummary } from "./render.ts";
import { summaryOutputOf, summaryOutputSchema } from "./schema.ts";
import { summarizeFile, type SummarizeOutcome } from "./summarize.ts";
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
 * The point is to make the guarded `read` usable. `read` is answered with a map once the read
 * passes the configured `trap_limit`, so a model facing a 1400-line file needs to know which
 * range to ask for instead.
 *
 * `settings` is the configuration in force when the extension loaded, which is the only one
 * the description can quote: pi takes a description once, at registration, and never asks
 * again. It is passed in rather than read here so this module stays a function of its inputs;
 * see index.ts for where the read happens and what it can and cannot know.
 */
export function registerSummaryTool(pi: ExtensionAPI, settings: Settings): void {
	// What the description may claim about `read` is a function of the trap, not just of the
	// limit: with `trap: "none"` no read is ever diverted, whatever the limit says, and telling
	// the model otherwise would sell it summaries of files it could simply read. The limit is
	// quoted only in the modes that enforce it, and every number below is derived from the
	// settings rather than written out - a description that kept 200's arithmetic while the trap
	// enforced 50 would be wrong the same way an omitted number is, just harder to notice.
	const { trapLimit, trap } = settings;
	const readsFor1400 = Math.ceil(1400 / trapLimit);
	// The example sentence is a fixed one - a 1400-line file - and it was written for the default
	// limit, where it reads "seven reads". That wording is kept at the default rather than
	// becoming "7 reads": the description is prompt surface, and an install that has configured
	// nothing must reach the model exactly as it did before this setting existed. Any other limit
	// is a deliberate change, and gets its own numeral.
	const readsWord = trapLimit === DEFAULT_TRAP_LIMIT ? "seven" : String(readsFor1400);
	const readCost =
		trap === "none"
			? "`read` returns whole files here, so summarizing is only worth it when you want the map itself."
			: `\`read\` returns at most ${trapLimit} lines per call, so a 1400-line file costs ${readsWord} ${readsFor1400 === 1 ? "read" : "reads"} or one summary plus one read.`;
	pi.registerTool({
		name: "summary",
		label: "Summarize file",
		description:
			`Map a code file's line ranges without reading it. Returns what the file does plus every range that holds what. Call it before reading a source file you have not seen, then read one range instead of the whole file. ${readCost} The first call on a file runs a model; later calls on the same unchanged file are free from cache.`,
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
						'Summarizer as "provider/model". Defaults to the configured summarizer, or the current session model.',
				}),
			),
			refresh: Type.Optional(
				Type.Boolean({
					description: "Re-summarize even if the cached summary is still fresh.",
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
			// Read once, before the model call, so the result quotes one configuration rather than
			// a model chosen under one version of the file and a limit read from another.
			const settings = readSettings(ctx.cwd);
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
				content: [{ type: "text", text: renderSummary(outcome.entry, settings.trapLimit) }],
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
		// The failure itself is generation history and stays out of the structured arm; what a
		// script needs is the file the model also got. Because pi resolves an `outputSchema`
		// tool to `structuredContent` alone, this field is the only way a script receives the
		// fallback body at all — leaving it out would hand scripts nothing.
		structuredContent: { path: absPath, lines: details.lines, content: body },
		details,
	};
}
