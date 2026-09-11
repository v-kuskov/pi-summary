import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderSummary } from "./render.ts";
import { summarizeFile, type SummarizeOutcome } from "./summarize.ts";

export type SummaryDetails = {
	path: string;
	status: string;
	mode: string;
	lines: number;
	coveredLines: number;
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
			const outcome = await summarizeFile(ctx, {
				path: params.path,
				model: params.model,
				force: params.refresh,
				signal,
			});

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
		coveredLines: outcome.entry.coveredLines,
		model: outcome.entry.model,
		extraction: outcome.extraction,
		sections: outcome.entry.sections.length,
		dbPath: outcome.dbPath,
		attempts: outcome.attempts,
		degraded: outcome.degraded,
	};
}
