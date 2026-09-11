import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReadGuard } from "./src/guard.ts";
import { registerSummaryTool } from "./src/tools.ts";

/**
 * pi-summary: file summaries a model can afford to read.
 *
 * Registers the `summary` tool, backed by a per-project SQLite cache, and guards the
 * built-in `read` tool so a single call cannot return more than 200 lines.
 *
 * Nothing here opens a database or starts a background task at load time: the tool opens
 * the cache per call, which keeps parallel tool calls safe and stops the extension from
 * holding a file handle in a project the user only walked through.
 */
export default function piSummary(pi: ExtensionAPI): void {
	registerSummaryTool(pi);
	registerReadGuard(pi);
}
