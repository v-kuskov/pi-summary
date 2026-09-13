import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { Text, getCapabilities, hyperlink, type Component } from "@earendil-works/pi-tui";
import { keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { resolveFilePath } from "./paths.ts";
import type { SummaryDetails } from "./tools.ts";

/**
 * Presentation for the `summary` tool.
 *
 * Shaped like the built-in `read` renderer, because the two answer the same question: a
 * `read` that was intercepted is drawn by read's renderer, and reading the file directly
 * should look like the call that did it. Both reuse the slot's previous component and
 * re-text it rather than allocating a new one, which is what the TUI hands back in
 * `context.lastComponent` and what keeps a streaming call from thrashing the transcript.
 *
 * The collapsed state is a single line of outcome rather than read's silence: a summary is
 * usually the *first* thing a session does to a file, so a call that shows nothing at all
 * reads as a no-op. What the line may not contain is the summarizer model (`D15`) — it is
 * in the result's `details` for whoever needs to diagnose a bad map, and it tells the
 * person watching nothing they can act on.
 *
 * Everything here is total. A renderer that throws is caught by the TUI and silently
 * replaced by the generic fallback, so an unhandled shape costs the whole feature its
 * display rather than one line of it.
 */
/**
 * Arguments as they arrive. Undefined while the call is streaming, and a field at a time
 * within that, so every read of them has to tolerate a partial object.
 */
type CallArgs = { path?: unknown; refresh?: unknown } | undefined;

/**
 * The render context, narrowed to the fields this presentation reads. pi does not export
 * `ToolRenderContext`, and a narrower parameter type still accepts the real one.
 */
type RenderContext = {
	cwd: string;
	isError: boolean;
	lastComponent?: Component;
};

/**
 * The subset of `SummaryDetails` the display uses.
 *
 * Picked from the tool's own type rather than restated here, so a field that changes meaning
 * there cannot drift from what gets drawn. It is a type-only import and erases at compile
 * time, so it does not make the tool module and this one import each other.
 */
type ResultDetails = Pick<SummaryDetails, "status" | "mode" | "lines" | "sections" | "degraded">;

type RenderResult = {
	content: Array<{ type: string; text?: string }>;
	details?: ResultDetails;
};

/**
 * The slot the TUI hands back: whatever this renderer returned last time, if anything.
 *
 * pi types `lastComponent` as a bare `Component`, but the reuse protocol read keeps is
 * `setText` on a `Text`. The check is done rather than asserted: the TUI owns that slot, and
 * a component from somewhere else costs a fresh `Text`, not a throw.
 */
type ReusableText = Component & { setText(text: string): void };

function textSlot(previous: Component | undefined): ReusableText {
	const reusable = previous as Partial<ReusableText> | undefined;
	if (typeof reusable?.setText === "function") return reusable as ReusableText;
	return new Text("", 0, 0);
}

/** How a call is labelled. */
function formatCall(args: CallArgs, theme: Theme, cwd: string): string {
	const label = theme.fg("toolTitle", theme.bold("summary"));
	const refresh = args?.refresh === true ? theme.fg("warning", " (refresh)") : "";
	return `${label} ${styledPath(args?.path, theme, cwd)}${refresh}`;
}

/**
 * The path as a link, the way `read` draws one.
 *
 * pi sorts its own path rendering into `render-utils.js`, which the package does not export,
 * so the six lines are repeated here instead of reaching into `dist` by path. Keep them in
 * step with `renderToolPath`: accent for the path, `~` for the home directory, a hyperlink
 * when the terminal supports one.
 *
 * The shortened and the linked path are deliberately two different strings, which is what pi
 * does: `~` is for the eye, and resolving it would put a literal `~` in the link target. The
 * link is built from the raw path, and resolved with the extension's own path resolver so a
 * leading `@` means here what it means everywhere else in this project.
 */
function styledPath(rawPath: unknown, theme: Theme, cwd: string): string {
	// Absent or empty is a call still streaming its arguments, not a bad one.
	if (rawPath === undefined || rawPath === null || rawPath === "") {
		return theme.fg("toolOutput", "...");
	}
	// Something present that is not a string is a malformed argument, and saying so is worth
	// more than a placeholder that reads as streaming. read draws the same distinction.
	if (typeof rawPath !== "string") return theme.fg("error", "[invalid arg]");

	const styled = theme.fg("accent", shortenHome(rawPath));
	if (!getCapabilities().hyperlinks) return styled;
	return hyperlink(styled, pathToFileURL(resolveFilePath(rawPath, cwd)).href);
}

function shortenHome(path: string): string {
	const home = os.homedir();
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/**
 * "hold the key to expand", built from the theme in hand.
 *
 * pi's `keyHint` is not used because it draws with the module-level theme singleton, which
 * throws until `initTheme` has run — a throw inside a renderer drops the display silently.
 * The key *name* is safe to ask for; only the styling needs the theme.
 * The key text is empty outside the interactive TUI, so the hint is dropped rather than
 * left as a bare "to expand" with a separator in front of it.
 */
function expandHint(theme: Theme): string {
	const keys = keyText("app.tools.expand");
	if (keys === "") return "";
	return `${theme.fg("dim", keys)}${theme.fg("muted", " to expand")}`;
}

/** A hint joined by the same separator as the outcome line's cells. */
function withHint(cells: string[], theme: Theme): string {
	const hint = expandHint(theme);
	if (hint !== "") cells.push(hint);
	return cells.join(theme.fg("dim", " · "));
}

/** One line saying what this call produced, without naming a model (`D15`). */
function formatOutcome(
	details: ResultDetails | undefined,
	isPartial: boolean,
	theme: Theme,
): string {
	if (details === undefined) {
		return isPartial ? theme.fg("muted", "summarizing...") : "";
	}
	// A summary that failed returned the file instead, and saying so is the point: the rows
	// the caller expected are not in there, and a line that looks like a map would be read
	// as one.
	if (details.status === "failed") {
		return withHint(
			[theme.fg("warning", "no summary - the whole file was returned instead")],
			theme,
		);
	}

	const parts = [`cache: ${details.status}`, `${details.lines} lines`];
	// "1 ranges" is not English, and a one-row map is common enough to be worth the branch.
	parts.push(
		details.mode === "blob"
			? "no line map"
			: `${details.sections} ${details.sections === 1 ? "range" : "ranges"}`,
	);
	if (details.degraded) parts.push("prose only");

	// Every part but the trailing hint is muted chrome; the hint carries its own styling, and
	// is absent outside the interactive TUI.
	return withHint(
		parts.map((part) => theme.fg("muted", part)),
		theme,
	);
}

/**
 * The text the model received, as lines, ready to be styled.
 *
 * `trimTrailingEmptyLines` is read's rule, kept here for the same reason it exists there: the
 * content ends in a newline often enough that the trailing gap is noise on every render.
 */
function contentLines(result: RenderResult): string[] {
	const text = result.content
		.filter((block): block is { type: string; text: string } => typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
	if (text.trim() === "") return [];

	const lines = text.replace(/\r/g, "").split("\n");
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** One styled line of the text the model received. */
function styledLine(line: string, theme: Theme, warning = false): string {
	return theme.fg(warning ? "warning" : "toolOutput", line.replace(/\t/g, "   "));
}

/** The text the model received, which is what the caller expands to see. */
function formatExpanded(result: RenderResult, details: ResultDetails | undefined, theme: Theme): string {
	const lines = contentLines(result);
	if (lines.length === 0) return "";

	// A failed call leads with the notice in place of a summary.
	const body = lines.map((line, index) =>
		styledLine(line, theme, details?.status === "failed" && index === 0),
	);
	return `\n${body.join("\n")}`;
}

/**
 * A failed call drawn collapsed, the way read draws one.
 *
 * read shows its first ten lines when the result is an error even while collapsed, because an
 * error the caller has to expand to read is an error nobody reads. Here the error is the
 * tool's own: a summary failure that could not even fall back to the file. Without this the
 * call line would be the whole display, and the reason would be nowhere on screen.
 */
function formatErrorResult(result: RenderResult, theme: Theme): string {
	const lines = contentLines(result);
	if (lines.length === 0) return "";

	const maxLines = 10;
	const shown = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${shown.map((line) => styledLine(line, theme, true)).join("\n")}`;
	if (remaining > 0) {
		const more = theme.fg("muted", `\n... (${remaining} more lines,`);
		text += `${more} ${expandHint(theme)}${theme.fg("muted", ")")}`;
	}
	return text;
}

export const summaryRenderers = {
	renderCall(rawArgs: CallArgs, theme: Theme, context: RenderContext): Component {
		const text = textSlot(context.lastComponent);
		text.setText(formatCall(rawArgs, theme, context.cwd));
		return text;
	},

	renderResult(
		result: RenderResult,
		options: { expanded: boolean; isPartial: boolean },
		theme: Theme,
		context: RenderContext,
	): Component {
		const text = textSlot(context.lastComponent);
		text.setText(
			options.expanded
				? formatExpanded(result, result.details, theme)
				: context.isError
					? formatErrorResult(result, theme)
					: formatOutcome(result.details, options.isPartial, theme),
		);
		return text;
	},
};
