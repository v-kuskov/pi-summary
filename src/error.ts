import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** An error meant to be shown to the model verbatim, with an optional corrective hint. */
export class SummaryError extends Error {
	readonly hint?: string;
	constructor(message: string, hint?: string) {
		super(message);
		this.name = "SummaryError";
		this.hint = hint;
	}
}

/** Concatenated text blocks of an assistant message, trimmed. */
export function assistantText(message: {
	content: Array<{ type: string; text?: string }>;
}): string {
	return message.content
		.filter(
			(c): c is { type: "text"; text: string } =>
				c.type === "text" && typeof c.text === "string",
		)
		.map((c) => c.text)
		.join("\n")
		.trim();
}

/**
 * Show a message in the UI, when there is a UI to show it in.
 *
 * A notification is a courtesy: it is absent in print and RPC runs, and the notify call
 * itself can fail, so neither case may break the tool call it was reporting on.
 */
export function notifyUser(
	ctx: ExtensionContext,
	message: string,
	level: "info" | "warning" | "error" = "error",
): void {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.notify(message, level);
	} catch {
		// Never let a courtesy break the call.
	}
}
