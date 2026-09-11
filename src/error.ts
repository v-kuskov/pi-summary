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
