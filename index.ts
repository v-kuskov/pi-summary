import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerEditLocator } from "./src/locator.ts";
import { registerSummaryTool } from "./src/tools.ts";

/**
 * pi-summary: file summaries a model can afford to read.
 *
 * Registers the `summary` tool, backed by a per-project SQLite cache, and tells the model
 * where each `edit` landed — the line numbers an edit produces are otherwise visible only
 * to the TUI; see src/locator.ts for why that was making an editing session re-read whole
 * files.
 *
 * It opens no database and starts no task at load: the tool reads its settings per call, so
 * there is nothing here that a config typo could turn into a failed extension load.
 */
export default function piSummary(pi: ExtensionAPI): void {
	registerSummaryTool(pi);
	registerEditLocator(pi);
}
