import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";

/** How many hex characters of the sha256 we keep. Enough to detect change, short to print. */
const HASH_CHARS = 16;

/** Chunk size for a streamed line count. 64KB keeps a 200-line probe to one or two reads. */
export const BYTES_PER_CHUNK = 64 * 1024;

export type FileFingerprint = {
	hash: string;
	lines: number;
	bytes: number;
};

/**
 * Hash a file's bytes and count its lines.
 *
 * Line count matches how the built-in `read` tool splits content: `text.split("\n")`,
 * so an empty file is 1 line and a trailing newline produces a final empty element.
 * The edit locator reports this number, so it must agree with what `read` shows the model.
 */
export async function fingerprint(absPath: string): Promise<FileFingerprint> {
	const buffer = await readFile(absPath);
	const stats = await stat(absPath);
	const lines = buffer.toString("utf-8").split("\n").length;
	return {
		hash: createHash("sha256").update(buffer).digest("hex").slice(0, HASH_CHARS),
		lines,
		bytes: stats.size,
	};
}

/**
 * Count the lines in `absPath` from line `offset` (1-indexed) to the end, stopping as
 * soon as the count is known to exceed `stopAfter` and returning `stopAfter + 1`.
 *
 * This lets the edit locator answer "how many lines does this file have now?" without
 * loading a large file: it reads in 64KB chunks and bails out early.
 *
 * The arithmetic relies on `text.split("\n").length === newlineCount + 1` for every
 * input, including the empty file, which is how the built-in `read` tool counts lines.
 * Returns 0 when `offset` is past the end, matching `read`'s own boundary condition.
 */
export async function countLinesFrom(
	absPath: string,
	offset: number,
	stopAfter: number,
): Promise<number> {
	const handle = await open(absPath, "r");
	try {
		const buffer = Buffer.allocUnsafe(BYTES_PER_CHUNK);
		// total = newlines + 1, so lines from `offset` = newlines - offset + 2, and this
		// exceeds `stopAfter` once newlines passes the threshold below.
		const threshold = stopAfter + offset - 2;
		let position = 0;
		let newlines = 0;

		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
			if (bytesRead === 0) break;
			for (let i = 0; i < bytesRead; i++) {
				if (buffer[i] === 10) {
					newlines++;
					if (newlines > threshold) return stopAfter + 1;
				}
			}
			position += bytesRead;
		}

		const count = newlines - offset + 2;
		return count > 0 ? count : 0;
	} finally {
		await handle.close();
	}
}
