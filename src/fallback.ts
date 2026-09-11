import { readFile } from "node:fs/promises";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";

/** A file read whole, as the last resort when summarization fails. */
export type RawFile = {
	/** File text, capped so a huge file cannot blow up the context. */
	text: string;
	/** Lines in the file on disk, before any cap. */
	totalLines: number;
	truncated: boolean;
};

/**
 * Read a file in full for the fallback path.
 *
 * The cap matches the built-in `read` tool (2000 lines / 50KB), so the fallback behaves
 * like the tool it is standing in for rather than an unbounded dump.
 */
export async function loadWholeFile(absPath: string): Promise<RawFile> {
	const text = (await readFile(absPath)).toString("utf-8");
	const totalLines = text.split("\n").length;
	const clipped = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	return { text: clipped.content, totalLines, truncated: clipped.truncated };
}

/** One-line description of a failure, message plus any corrective hint. */
export function describeFailure(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const hint = (error as { hint?: unknown } | undefined)?.hint;
	return typeof hint === "string" && hint.length > 0 ? `${message} - ${hint}` : message;
}

/**
 * Notice shown to the user when summarization fails.
 *
 * Kept short and free of newlines: it is rendered as a toast, as a `#` comment above a
 * whole-file dump, and as a trailing note on an allowed read, and one line reads correctly
 * in all three.
 */
export function failureNotice(what: string, error: unknown, action: string): string {
	// The message may already end in a period (provider errors usually do), so only add one
	// when it is missing rather than producing "may not help..".
	const detail = describeFailure(error).replace(/\.+\s*$/, "");
	return `${what} failed: ${detail}. ${action}`;
}
