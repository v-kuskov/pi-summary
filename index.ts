import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReadTool } from "./src/guard.ts";
import { registerSummaryTool } from "./src/tools.ts";

/**
 * pi-summary: file summaries a model can afford to read.
 *
 * Registers the `summary` tool, backed by a per-project SQLite cache, and replaces the
 * built-in `read` tool with one that answers any call past `READ_LINE_LIMIT` with that
 * file's map instead of the whole file.
 *
 * Replacing `read` is what lets an intercepted call come back as a normal result rather
 * than as a failure; see src/guard.ts for why blocking the call could not.
 *
 * Nothing here opens a database or starts a background task at load time: the tool opens
 * the cache per call, which keeps parallel tool calls safe and stops the extension from
 * holding a file handle in a project the user only walked through.
 */
export default function piSummary(pi: ExtensionAPI): void {
	registerSummaryTool(pi);
	registerReadTool(pi);
}
