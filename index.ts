import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReadTool } from "./src/guard.ts";
import { registerEditLocator } from "./src/locator.ts";
import { readSettings } from "./src/settings.ts";
import { registerSummaryTool } from "./src/tools.ts";

/**
 * pi-summary: file summaries a model can afford to read.
 *
 * Registers the `summary` tool, backed by a per-project SQLite cache, and replaces the
 * built-in `read` tool with one that answers any call past the configured `trap_limit`
 * with that file's map instead of the whole file.
 *
 * Replacing `read` is what lets an intercepted call come back as a normal result rather
 * than as a failure; see src/guard.ts for why blocking the call could not. `trap` in
 * `pi-summary.json` decides whether that happens at all, and to whom.
 *
 * It also tells the model where each `edit` landed, because the line numbers an edit
 * produces are otherwise visible only to the TUI; see src/locator.ts for why that was
 * making an editing session re-read whole files.
 *
 * The `summary` tool's description quotes the settings in force when the extension loads,
 * because pi takes a description once at registration. The directory read is the process cwd:
 * `ExtensionAPI` exposes no cwd - it is captured inside pi's loader - and this is the same
 * directory pi loaded the extension for, and the same one `createReadToolDefinition` was
 * already built from below. That is the one settings read this module does - the per-call
 * reads belong to the callers - and it opens no database and starts no task. A failed read is
 * not fatal: `readSettings` resolves to the defaults rather than throwing, so an extension
 * load never dies over a config typo.
 */
export default function piSummary(pi: ExtensionAPI): void {
	registerSummaryTool(pi, readSettings(process.cwd()));
	registerReadTool(pi);
	registerEditLocator(pi);
}
