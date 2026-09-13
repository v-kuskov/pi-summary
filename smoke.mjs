import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";

import extensionFactory from "./index.ts";
import { countLinesFrom } from "./src/hash.ts";
import { MAX_ATTEMPTS } from "./src/summarize.ts";
import { ensureSchema, openDb, writeSummary } from "./src/store.ts";
import { readImageAutoResize, readSummarySettings } from "./src/settings.ts";
import { extractOverview, parseJsonAnswer } from "./src/prompt.ts";
import { hasTopLevelShape, normalizeSections, MAX_NOTE_CHARS } from "./src/schema.ts";
import { renderMap } from "./src/render.ts";
import { isUnguardedPath } from "./src/paths.ts";

let failures = 0;
let passed = 0;
async function check(name, fn) {
	try {
		await fn();
		passed++;
	} catch (error) {
		failures++;
		console.log(`FAIL ${name}\n     ${error.message}`);
	}
}

// ------------------------------------------------------------------ fake platform

// The summarizer is a plain completion: its answer is JSON in the text channel.
const jsonResponse = (payload) => ({
	role: "assistant",
	content: [{ type: "text", text: JSON.stringify(payload) }],
	usage: { input: 10, output: 5, totalTokens: 15 },
});
const textResponse = (text) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	usage: { input: 10, output: 5, totalTokens: 15 },
});
const errorResponse = (message) => ({
	role: "assistant",
	content: [],
	stopReason: "error",
	errorMessage: message,
	usage: { input: 10, output: 5, totalTokens: 15 },
});
// The fake summarizer answers with a map that tiles the excerpt it was given: one row
// spanning the whole thing. A fixture whose rows leave gaps or overlap would now cost a
// repair call, so helpers here build tiling answers unless a test wants otherwise.
const lastShownLine = (context) => {
	const prompt = context.messages[0].content[0].text;
	return Number(prompt.match(/The file is (\d+) lines/)[1]);
};
const tilingAnswer = (overview, kind = "function", name = "run()", note = "does it") =>
	(context) =>
		jsonResponse({
			overview,
			sections: [{ start_line: 1, end_line: lastShownLine(context), kind, name, note }],
		});
const defaultAnswer = tilingAnswer("Does a thing.");

function makeHarness(options = {}) {
	const tools = new Map();
	const handlers = [];
	const calls = [];
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		on: (event, handler) => handlers.push({ event, handler }),
	};
	extensionFactory(pi);

	const respond = options.respond ?? defaultAnswer;
	// `input` is read by the built-in read tool to decide whether to note that the model
	// cannot see images, so the fake model needs it.
	const model = { provider: "test", id: "test-model", input: ["text"] };
	const ctx = {
		cwd: options.cwd ?? "",
		mode: "json",
		hasUI: false,
		model,
		modelRegistry: {
			find: (p, id) => (p === "test" && id === "test-model" ? model : undefined),
			hasConfiguredAuth: () => true,
			complete: async (m, context, opts) => {
				calls.push({ model: m, context, opts });
				return respond(context, opts, calls.length);
			},
		},
	};

	return { tools, handlers, calls, ctx, notices: [] };
}

const runTool = (h, name, params) =>
	h.tools.get(name).execute("id", params, undefined, undefined, h.ctx);

/**
 * Run the `read` tool and return its result.
 *
 * The extension replaces the built-in `read` rather than blocking a call, so a read is
executed like any other tool: it either resolves with a result or rejects. There is no
block reason to read and no pending notice to consume.
 */
const runRead = (h, params) => runTool(h, "read", params);

/** The text a read returned. */
async function readText(h, params) {
	const { content } = await runRead(h, params);
	return content.map((c) => c.text ?? "").join("");
}

/** The banner an intercepted read carries in place of the file's lines. */
const MAP_BANNER = /longer than 200 lines/;

/**
 * The map text when this read was answered with one, or undefined when the read ran normally.
 *
 * A read that returns the file's own lines is one the guard did not claim, so the caller's
 * assertion is the same either way: undefined means "the built-in read handled it".
 */
async function readMap(h, params) {
	const text = await readText(h, params);
	return MAP_BANNER.test(text) ? text : undefined;
}

/**
 * Whether a read rejects, and with what.
 *
 * Reads the guard does not claim are the built-in tool's, including its failures: a missing
 * file must still reject with the read tool's own message rather than being swallowed.
 */
async function readError(h, params) {
	try {
		await runRead(h, params);
		return undefined;
	} catch (error) {
		return error.message;
	}
}

function tempProject() {
	const root = mkdtempSync(join(tmpdir(), "pi-summary-"));
	mkdirSync(join(root, ".git"), { recursive: true });
	mkdirSync(join(root, "src"), { recursive: true });
	return root;
}

const numbered = (lines) =>
	Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

// ------------------------------------------------------------------ units

await check("normalizeSections clamps, trims overlaps, and drops unrecoverable rows", async () => {
	const rows = normalizeSections(
		[
			{ start_line: 50, end_line: 60, kind: "function", name: "b()", note: "" },
			{ start_line: 10, end_line: 900, kind: "Class", name: "A", note: "" },
			{ start_line: 900, end_line: 910, kind: "other", name: "past what was shown", note: "" },
			{ start_line: 70, end_line: 65, kind: "other", name: "reversed", note: "" },
			{ start_line: "nope", end_line: 10, kind: "other", name: "nan", note: "" },
		],
		100,
	);
	assert.deepEqual(
		rows.map((s) => s.name),
		["A", "b()", "reversed"],
		"unusable rows are dropped",
	);
	assert.deepEqual(rows.map((s) => s.seq), [0, 1, 2]);
	assert.equal(rows[0].endLine, 49, "A stops one line before the row that begins inside it");
	assert.equal(rows[0].kind, "class", "kind is normalized");
	assert.equal(rows[2].endLine, 70, "a reversed range collapses to one line, not dropped");

	assert.equal(normalizeSections([], 100), undefined, "no rows means no map");
	assert.equal(normalizeSections(null, 100), undefined);
	assert.equal(normalizeSections("nope", 100), undefined);
});

await check("normalizeSections resolves a container row against its contents", async () => {
	// The real drift signature: a model emits a wrapper range and the rows inside it.
	const rows = normalizeSections(
		[
			{ start_line: 1, end_line: 24, kind: "comment", name: "module 1", note: "" },
			{ start_line: 2, end_line: 2, kind: "import", name: "helper1", note: "" },
			{ start_line: 4, end_line: 23, kind: "class", name: "Widget1", note: "" },
		],
		1396,
	);
	assert.deepEqual(
		rows.map((s) => [s.startLine, s.endLine, s.name]),
		[
			[1, 1, "module 1"],
			[2, 2, "helper1"],
			[4, 23, "Widget1"],
		],
		"the wrapper keeps only the line before its first child, so no row overlaps",
	);
	let overlapping = 0;
	for (let i = 1; i < rows.length; i++) {
		if (rows[i].startLine <= rows[i - 1].endLine) overlapping++;
	}
	assert.equal(overlapping, 0, "no overlapping rows survive");

	// A row entirely inside a later row is dropped, not left contradicting it.
	const shadowed = normalizeSections(
		[
			{ start_line: 1, end_line: 9, kind: "other", name: "outer", note: "" },
			{ start_line: 1, end_line: 9, kind: "other", name: "same", note: "" },
		],
		100,
	);
	assert.deepEqual(shadowed.map((s) => s.name), ["same"], "the duplicate to be dropped is arbitrary");
});

await check("hasTopLevelShape separates repairable shape from repairable rows", async () => {
	assert.equal(hasTopLevelShape({ overview: "x", sections: [] }), true);
	assert.equal(hasTopLevelShape({ overview: "x", sections: "nope" }), false);
	assert.equal(hasTopLevelShape({ overview: 42, sections: [] }), false);
	assert.equal(hasTopLevelShape({ sections: [] }), false);
	assert.equal(hasTopLevelShape(null), false);
	assert.equal(hasTopLevelShape([]), false);
});

await check("parseJsonAnswer tolerates a fence and surrounding prose", async () => {
	const payload = { overview: "x", sections: [] };
	assert.deepEqual(parseJsonAnswer(JSON.stringify(payload)), payload);
	assert.deepEqual(parseJsonAnswer("```json\n" + JSON.stringify(payload) + "\n```"), payload);
	assert.deepEqual(parseJsonAnswer("Sure!\n" + JSON.stringify(payload) + "\nHope that helps."), payload);
	assert.equal(parseJsonAnswer("not json at all"), undefined);
	assert.equal(parseJsonAnswer(""), undefined);
});

await check("extractOverview salvages prose from a truncated answer", async () => {
	assert.equal(
		extractOverview('{"overview":"Implements the sync client.","sections":[{"start_line":1'),
		"Implements the sync client.",
	);
	assert.equal(extractOverview("```\nA plain prose answer.\n```"), "A plain prose answer.");
});

await check("readSummarySettings reads the object form and prefers project over global", async () => {
	const agent = mkdtempSync(join(tmpdir(), "pi-agent-"));
	const root = tempProject();
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agent;
		writeFileSync(
			join(agent, "settings.json"),
			JSON.stringify({ summary: { model: "global/model" } }),
		);
		assert.deepEqual(readSummarySettings(root), { model: "global/model" });

		mkdirSync(join(root, ".pi"), { recursive: true });
		writeFileSync(
			join(root, ".pi", "settings.json"),
			JSON.stringify({ summary: { model: "project/model" } }),
		);
		assert.deepEqual(readSummarySettings(root), { model: "project/model" }, "project wins");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agent, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

await check("readSummarySettings tolerates a bare string and junk values", async () => {
	const agent = mkdtempSync(join(tmpdir(), "pi-agent-"));
	const root = tempProject();
	const previous = process.env.PI_CODING_AGENT_DIR;
	const write = (value) =>
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ summary: value }));
	try {
		process.env.PI_CODING_AGENT_DIR = agent;

		write("deepseek/deepseek-v4-flash");
		assert.deepEqual(readSummarySettings(root), { model: "deepseek/deepseek-v4-flash" });

		write({ model: "  spaced/model  " });
		assert.deepEqual(readSummarySettings(root), { model: "spaced/model" }, "trimmed");

		for (const junk of [null, 42, [], {}, { model: 7 }, { model: "" }, ""]) {
			write(junk);
			assert.deepEqual(readSummarySettings(root), {}, `junk ${JSON.stringify(junk)} ignored`);
		}

		// A corrupt settings file must not throw out of a summarization.
		writeFileSync(join(agent, "settings.json"), "{ not json");
		assert.deepEqual(readSummarySettings(root), {});
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agent, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

await check("readImageAutoResize reads pi's own setting, project scope first", async () => {
	// The extension replaces the built-in read tool, so it has to build the delegated read
	// itself - and that definition takes the user's images.autoResize setting. The value is
	// not reachable from an extension context, so it is read from pi's settings files.
	const agent = mkdtempSync(join(tmpdir(), "pi-agent-"));
	const root = tempProject();
	const previous = process.env.PI_CODING_AGENT_DIR;
	const globalSettings = (value) =>
		writeFileSync(join(agent, "settings.json"), JSON.stringify(value));
	const projectSettings = (value) => {
		mkdirSync(join(root, ".pi"), { recursive: true });
		writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify(value));
	};
	try {
		process.env.PI_CODING_AGENT_DIR = agent;

		writeFileSync(join(agent, "settings.json"), "{}");
		assert.equal(readImageAutoResize(root), true, "absent means pi's default of on");

		globalSettings({ images: { autoResize: false } });
		assert.equal(readImageAutoResize(root), false, "the global setting is honoured");

		projectSettings({ images: { autoResize: true } });
		assert.equal(readImageAutoResize(root), true, "the project setting wins");

		// Junk where the setting should be means the default, never a crash or a wrong read.
		// Global is set to a valid value first, so this also pins the fallback order: a project
		// file without a usable value must not shadow the global one that has it.
		globalSettings({ images: { autoResize: true } });
		for (const junk of [{ images: "no" }, { images: [] }, { images: { autoResize: "yes" } }, {}]) {
			projectSettings(junk);
			assert.equal(readImageAutoResize(root), true, `junk ${JSON.stringify(junk)} ignored`);
		}

		// With nothing valid anywhere, the default stands.
		globalSettings({ images: { autoResize: null } });
		projectSettings({ images: { autoResize: "yes" } });
		assert.equal(readImageAutoResize(root), true, "no usable value anywhere means the default");

		writeFileSync(join(root, ".pi", "settings.json"), "{ not json");
		assert.equal(readImageAutoResize(root), true, "a corrupt file falls back to the default");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agent, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the summary.model setting picks the summarizer, and model= overrides it", async () => {
	const agent = mkdtempSync(join(tmpdir(), "pi-agent-"));
	const root = tempProject();
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agent;
		writeFileSync(
			join(agent, "settings.json"),
			JSON.stringify({ summary: { model: "test/test-model" } }),
		);
		writeFileSync(join(root, "src", "a.ts"), numbered(10));
		const h = makeHarness({ cwd: root });

		const result = await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(result.details.model, "test/test-model", "the configured model was used");

		// An unknown configured model is skipped rather than failing the tool, and since a
		// silently ignored setting looks exactly like an honoured one, it is announced.
		writeFileSync(
			join(agent, "settings.json"),
			JSON.stringify({ summary: { model: "nope/missing" } }),
		);
		h.ctx.hasUI = true;
		h.ctx.ui = { notify: (message, type) => h.notices.push({ message, type }) };

		const fallback = await runTool(h, "summary", { path: "src/a.ts", refresh: true });
		assert.equal(fallback.details.model, "test/test-model", "fell back to the session model");
		assert.equal(h.notices.length, 1, "the ignored setting is reported");
		assert.equal(h.notices[0].type, "warning");
		assert.match(h.notices[0].message, /nope\/missing/);
		assert.match(h.notices[0].message, /names no known model/);

		// Reported once, not on every call.
		await runTool(h, "summary", { path: "src/a.ts", refresh: true });
		assert.equal(h.notices.length, 1, "the warning does not repeat");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agent, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

await check("openDb sets busy_timeout before switching to WAL", async () => {
	// Order matters here. Switching the journal mode needs an exclusive lock, and with the
	// default zero timeout a competing process fails immediately with SQLITE_BUSY
	// ("database is locked") instead of waiting. A probe with 12 concurrent writers lost a
	// row in 4 of 6 runs before this ordering and 0 of 6 after.
	const root = tempProject();
	try {
		const { db, dbPath } = openDb(root);
		assert.equal(dbPath, join(root, ".pi", "summaries.db"));
		assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 3000, "timeout is in force");
		assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
		db.close();

		const again = openDb(root);
		assert.equal(again.dbPath, join(root, ".pi", "summaries.db"), "stable across opens");
		assert.equal(again.db.prepare("PRAGMA busy_timeout").get().timeout, 3000);
		again.db.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the cached schema carries no mtime column, and an old database is migrated", async () => {
	// `mtime_ms` was stored until the freshness check stopped consulting it. A database from
	// an earlier version still has it, NOT NULL, so dropping it is a migration and not just a
	// schema edit: without it every insert fails the constraint.
	const root = tempProject();
	try {
		const dbPath = join(root, ".pi", "summaries.db");
		mkdirSync(join(root, ".pi"), { recursive: true });
		const old = new DatabaseSync(dbPath);
		old.exec(`CREATE TABLE file_summary (
		  path TEXT PRIMARY KEY, abs_path TEXT NOT NULL, hash TEXT NOT NULL,
		  lines INTEGER NOT NULL, bytes INTEGER NOT NULL, mtime_ms INTEGER NOT NULL,
		  model TEXT NOT NULL, mode TEXT NOT NULL, overview TEXT NOT NULL,
		  created_at TEXT NOT NULL
		)`);
		old.prepare("INSERT INTO file_summary VALUES (?,?,?,?,?,?,?,?,?,?)").run(
			"src/old.ts",
			"/x/src/old.ts",
			"deadbeef",
			5,
			10,
			1,
			"m",
			"mapped",
			"kept",
			"2025-01-01T00:00:00.000Z",
		);
		old.close();

		const { db } = openDb(root);
		ensureSchema(db);
		const columns = db.prepare("PRAGMA table_info(file_summary)").all().map((c) => c.name);
		assert.ok(!columns.includes("mtime_ms"), "the stale column is dropped");
		assert.equal(
			db.prepare("SELECT overview FROM file_summary WHERE path = ?").get("src/old.ts").overview,
			"kept",
			"existing rows survive the migration",
		);
		// The insert shape the code now uses must work against the migrated table.
		writeSummary(db, {
			path: "src/new.ts",
			absPath: "/x/src/new.ts",
			fp: { hash: "h", lines: 5, bytes: 1 },
			model: "m",
			mode: "mapped",
			overview: "o",
			sections: [],
		});
		db.close();
	} finally {
		// Closing the SQLite handle does not release the directory the instant it returns on
		// Windows; a retry rides that out, and failing to delete a temp dir after the assertions
		// passed is not a test failure.
		try {
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		} catch {
			// Left for the OS temp cleaner.
		}
	}
});

await check("concurrent writers to distinct paths all land in the cache", async () => {
	// Each writer is its own child process, so busy_timeout is exercised for real rather
	// than being satisfied by a single process's in-process lock. This is the end-to-end
	// guard for the SQLITE_BUSY bug above.
	const root = tempProject();
	try {
		const { spawn } = await import("node:child_process");
		const storeUrl = new URL("./src/store.ts", import.meta.url).href;
		const worker = [
			`import { openDb, ensureSchema, writeSummary } from ${JSON.stringify(storeUrl)};`,
			`const name = process.argv[2];`,
			`try {`,
			`  const { db } = openDb(${JSON.stringify(root)});`,
			`  ensureSchema(db);`,
			`  writeSummary(db, { path: name, absPath: "/x/" + name, fp: { hash: "h", lines: 5, bytes: 1 }, model: "m", mode: "mapped", overview: "o", sections: [{ seq: 0, startLine: 1, endLine: 5, kind: "other", name: "x", note: "" }] });`,
			`  db.close();`,
			`  console.log("ok");`,
			`} catch (e) { console.log("err " + e.message); }`,
		].join("\n");
		writeFileSync(join(root, "w.mjs"), worker);

		const results = await Promise.all(
			Array.from(
				{ length: 8 },
				(_, i) =>
					new Promise((resolve) => {
						const p = spawn(process.execPath, [join(root, "w.mjs"), `f${i}.ts`], {
							cwd: root,
							stdio: ["ignore", "pipe", "pipe"],
						});
						let out = "";
						p.stdout.on("data", (d) => (out += d));
						p.on("close", () => resolve(out.trim()));
					}),
			),
		);

		assert.deepEqual(
			results.filter((r) => r !== "ok"),
			[],
			"no writer is locked out",
		);

		const db = new DatabaseSync(join(root, ".pi", "summaries.db"));
		assert.equal(db.prepare("SELECT COUNT(*) c FROM file_summary").get().c, 8, "every row arrived");
		db.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("countLinesFrom matches split semantics and the 200-line threshold", async () => {
	const root = tempProject();
	try {
		const p = join(root, "f.txt");
		writeFileSync(p, numbered(500));
		assert.equal(await countLinesFrom(p, 1, 200), 201, "500 lines from line 1 exceeds 200");
		assert.equal(await countLinesFrom(p, 301, 200), 201, "201 lines remain, exceeds");
		assert.equal(await countLinesFrom(p, 302, 200), 200, "200 lines remain, exactly at the limit");
		assert.equal(await countLinesFrom(p, 303, 200), 199, "199 lines remain, within limit");
		assert.equal(await countLinesFrom(p, 501, 200), 1, "last line");
		assert.equal(await countLinesFrom(p, 502, 200), 0, "past EOF");

		const tiny = join(root, "tiny.txt");
		writeFileSync(tiny, "a\nb\n");
		assert.equal(await countLinesFrom(tiny, 1, 200), 3, "trailing newline counts as a line");
		assert.equal(await countLinesFrom(tiny, 3, 200), 1);

		const empty = join(root, "empty.txt");
		writeFileSync(empty, "");
		assert.equal(await countLinesFrom(empty, 1, 200), 1, "empty file is one line, like read");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ------------------------------------------------------------------ summary tool

await check("summary calls the model once, then serves the cache", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(400));
		const h = makeHarness({ cwd: root });

		const first = await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(h.calls.length, 1, "one model call");
		assert.equal(first.details.status, "miss");
		assert.match(first.content[0].text, /cache: miss/);
		assert.match(first.content[0].text, /## map/);
		assert.match(first.content[0].text, /run\(\)/);
		assert.match(first.content[0].text, /401 lines/);

		const second = await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(h.calls.length, 1, "no second model call");
		assert.equal(second.details.status, "fresh");
		assert.match(second.content[0].text, /cache: fresh/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("summary asks for JSON only, with no tools, and reports nested usage", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(10));
		const h = makeHarness({ cwd: root });

		const result = await runTool(h, "summary", { path: "src/a.ts" });
		const { context, opts } = h.calls[0];
		assert.equal(context.tools, undefined, "no tool schema is sent to the summarizer");
		assert.deepEqual(opts.samplingParams, { response_format: { type: "json_object" } });
		assert.equal(opts.cacheRetention, "none");
		assert.match(context.messages[0].content[0].text, /single JSON object/);
		assert.equal(result.usage.totalTokens, 15, "nested tokens are surfaced");
		assert.equal(result.details.attempts, 1);
		assert.equal(result.details.degraded, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a changed file is re-summarized", async () => {
	const root = tempProject();
	try {
		const file = join(root, "src", "a.ts");
		writeFileSync(file, numbered(50));
		const h = makeHarness({ cwd: root });

		await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(h.calls.length, 1);

		writeFileSync(file, numbered(50) + "extra\n");
		const after = await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(h.calls.length, 2, "re-summarized");
		assert.equal(after.details.status, "stale");
		assert.equal(after.details.lines, 52);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("an mtime-only touch does not re-summarize", async () => {
	const root = tempProject();
	try {
		const file = join(root, "src", "a.ts");
		writeFileSync(file, numbered(50));
		const h = makeHarness({ cwd: root });

		await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(h.calls.length, 1);

		// Same bytes, new mtime: only the hash decides, and it matches.
		writeFileSync(file, numbered(50));
		const later = new Date(Date.now() + 5000);
		utimesSync(file, later, later);

		const again = await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(h.calls.length, 1, "hash matched, so no model call");
		assert.equal(again.details.status, "fresh");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a same-size rewrite with a matching mtime is still detected as stale", async () => {
	// The bug this locks down: the cache used to treat a matching size + mtime as proof the
	// file was unchanged and skip hashing. A same-length edit landing in the same millisecond
	// then served a stale line map for a file the model was about to edit - confirmed by
	// reproducing it before the fix. The hash is now the only thing that decides.
	const root = tempProject();
	try {
		const file = join(root, "src", "a.ts");
		const original = `${numbered(50)}`;
		writeFileSync(file, original);
		const h = makeHarness({ cwd: root });

		const first = await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(h.calls.length, 1);
		const firstHash = first.content[0].text.match(/sha (\w+)/)[1];
		const stored = statSync(file);

		// Same byte length, different content, mtime forced back to the stored value.
		const edited = original.replace("line 1\n", "LINE 1\n");
		assert.equal(edited.length, original.length, "fixture must keep the byte length equal");
		writeFileSync(file, edited);
		utimesSync(file, stored.atimeMs / 1000, stored.mtimeMs / 1000);
		assert.equal(statSync(file).size, stored.size, "size matches what was stored");
		assert.equal(
			Math.round(statSync(file).mtimeMs),
			Math.round(stored.mtimeMs),
			"mtime matches what was stored - the shortcut would say 'fresh'",
		);

		const again = await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(h.calls.length, 2, "content changed, so it must re-summarize");
		const againHash = again.content[0].text.match(/sha (\w+)/)[1];
		assert.notEqual(againHash, firstHash, "and store the new hash");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("refresh forces a new summary", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(50));
		const h = makeHarness({ cwd: root });

		await runTool(h, "summary", { path: "src/a.ts" });
		const forced = await runTool(h, "summary", { path: "src/a.ts", refresh: true });
		assert.equal(h.calls.length, 2);
		assert.equal(forced.details.status, "forced");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a prose-only answer is repaired twice, then stored as an honest blob", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(400));
		const h = makeHarness({
			cwd: root,
			respond: () =>
				textResponse("This file implements the sync client and its retry loop."),
		});

		const result = await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(h.calls.length, MAX_ATTEMPTS, "spend is capped, not unbounded");
		assert.equal(result.details.mode, "blob");
		assert.equal(result.details.sections, 0);
		assert.equal(result.details.degraded, true);
		assert.equal(result.details.attempts, MAX_ATTEMPTS);
		assert.match(result.content[0].text, /map: none/);
		assert.match(result.content[0].text, /no line detail/);
		assert.match(result.content[0].text, /implements the sync client/);
		assert.doesNotMatch(
			result.content[0].text,
			/^\s*1-\s*401\s/m,
			"must not fabricate a region spanning the file",
		);

		// The repair turn carries the model's own answer and the specific complaint.
		const repair = h.calls[1].context.messages;
		assert.equal(repair[1].role, "assistant", "the model's answer is resent as its own turn");
		assert.match(repair[2].content[0].text, /previous answer was rejected/);
		assert.match(repair[2].content[0].text, /not parseable as a JSON object/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a bad first answer is repaired into a good map without degrading", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(300));
		const h = makeHarness({
			cwd: root,
			respond: (_context, _opts, n) =>
				n === 1
					? textResponse("Here is the summary you asked for!")
					: tilingAnswer("Sync client.")(_context),
		});

		const result = await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(h.calls.length, 2, "one repair, then success");
		assert.equal(result.details.mode, "mapped");
		assert.equal(result.details.extraction, "json");
		assert.equal(result.details.degraded, false);
		assert.equal(result.details.attempts, 2);
		assert.equal(result.details.sections, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a valid envelope with unusable rows degrades instead of repeating the repair", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(300));
		// The shape is right, so there is nothing for the model to fix; the rows are simply
		// absent, which is a blob rather than a reason to call again.
		const h = makeHarness({
			cwd: root,
			respond: () => jsonResponse({ overview: "No rows at all.", sections: [] }),
		});

		const result = await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(h.calls.length, 1, "a well shaped answer is accepted immediately");
		assert.equal(result.details.mode, "blob");
		assert.equal(result.details.degraded, true);
		assert.match(result.content[0].text, /No rows at all\./);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a rejected JSON mode is retried without it, and stays within the cap", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(10));
		const h = makeHarness({
			cwd: root,
			// RouteAI-style provider that rejects response_format but answers fine without it.
			respond: (_context, opts) =>
				opts?.samplingParams ? errorResponse("response_format is not supported") : defaultAnswer(_context, opts),
		});

		const result = await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(h.calls.length, 2, "one rejected attempt, one clean attempt");
		assert.ok(h.calls[0].opts.samplingParams, "first call tried JSON mode");
		assert.equal(h.calls[1].opts.samplingParams, undefined, "retry drops the override");
		assert.equal(result.details.mode, "mapped");
		assert.equal(result.details.attempts, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a provider that rejects JSON mode every time returns the file, not an error", async () => {
	const root = tempProject();
	try {
		const file = join(root, "src", "a.ts");
		writeFileSync(file, numbered(10));
		const h = makeHarness({
			cwd: root,
			respond: () => errorResponse("upstream exploded"),
		});

		const result = await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(result.details.status, "failed");
		assert.equal(result.details.mode, "raw");
		assert.match(result.content[0].text, /summary failed:/);
		assert.match(result.content[0].text, /upstream exploded/);
		assert.match(result.content[0].text, /Returning the whole file instead/);
		assert.match(result.content[0].text, /line 1/, "the file body follows");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a failed summary notifies the user", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(10));
		const h = makeHarness({ cwd: root, respond: () => errorResponse("no balance") });
		h.ctx.hasUI = true;
		h.ctx.ui = { notify: (message, type) => h.notices.push({ message, type }) };

		await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(h.notices.length, 1);
		assert.equal(h.notices[0].type, "error");
		assert.match(h.notices[0].message, /no balance/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("an unreadable file is still a real error", async () => {
	const root = tempProject();
	try {
		const h = makeHarness({ cwd: root, respond: () => defaultAnswer() });
		await assert.rejects(
			() => runTool(h, "summary", { path: "src/missing.ts" }),
			/not a regular file/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a map with a gap is accepted without spending a repair", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(400));
		// Lines 101-400 are left out. Under the old contract that cost a repair; gaps are now
		// the model declining to map dead lines, so it is accepted as-is.
		const h = makeHarness({
			cwd: root,
			respond: () =>
				jsonResponse({
					overview: "Skips the generated tail.",
					sections: [{ start_line: 1, end_line: 100, kind: "function", name: "a()", note: "" }],
				}),
		});

		const result = await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(h.calls.length, 1, "a gap is not worth a model call");
		assert.equal(result.details.mode, "mapped");
		assert.equal(result.details.degraded, false);
		assert.equal(result.details.attempts, 1);
		// The unclaimed lines are simply absent from the map.
		assert.match(result.content[0].text, /1-\s*100\s+function/);
		assert.doesNotMatch(result.content[0].text, /skipped/, "gaps are not narrated");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a fenced answer parses without spending a repair", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(300));
		const h = makeHarness({
			cwd: root,
			respond: (context) =>
				textResponse(
					"```json\n" +
						JSON.stringify({
							overview: "Sync client.",
							sections: [
								{ start_line: 1, end_line: lastShownLine(context), kind: "function", name: "connect()", note: "dials" },
							],
						}) +
						"\n```",
				),
		});

		const result = await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(h.calls.length, 1, "a fence is not worth a model call to fix");
		assert.equal(result.details.mode, "mapped");
		assert.equal(result.details.sections, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a whole file is sent, with no cap and no truncation language", async () => {
	const root = tempProject();
	try {
		// Well past the old 4000-line cap: every line must still go in.
		writeFileSync(join(root, "src", "huge.ts"), numbered(5000));
		const h = makeHarness({ cwd: root });
		await runTool(h, "summary", { path: "src/huge.ts" });

		const prompt = h.calls[0].context.messages[0].content[0].text;
		// numbered(5000) is 5000 lines plus a trailing newline, so 5001 by read's counting.
		assert.match(prompt, /The file is 5001 lines, and all of it is below/);
		assert.match(prompt, /line 5001 is the last/);
		assert.doesNotMatch(prompt, /continues past/, "nothing is held back");
		assert.doesNotMatch(prompt, /left unmapped/, "no line was held back from the model");

		// The excerpt really does carry the final line. numbered(5000) ends with a newline, so
		// line 5001 exists and is empty - the same counting `read` reports.
		const excerpt = prompt.slice(prompt.indexOf("<file>"), prompt.indexOf("</file>"));
		assert.match(excerpt, /5001\t\n/, "the last line is present");
		assert.match(excerpt, /5000\tline 5000\n/);
		assert.match(excerpt, / 1\tline 1\n/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the excerpt is numbered so rows can be copied rather than counted", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(12));
		const h = makeHarness({ cwd: root });
		await runTool(h, "summary", { path: "src/a.ts" });

		const prompt = h.calls[0].context.messages[0].content[0].text;
		const excerpt = prompt.slice(prompt.indexOf("<file>"), prompt.indexOf("</file>"));
		// Numbered, tab-separated, starting at 1 - not raw text.
		assert.match(excerpt, /^<file>\n 1\tline 1\n 2\tline 2/m, "lines carry their numbers");
		assert.match(prompt, /copy the number printed beside the/i);
		assert.match(prompt, /do not count lines yourself or compute them from a pattern/i);

		// The whole file is here, and the prompt says so.
		assert.match(prompt, /The file is 13 lines/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("gaps survive storage and are simply left out of the map", async () => {
	// The map shows only what was mapped. A deliberate gap is the summarizer declining to
	// describe dead lines, so it is a jump in the numbers rather than a row that says so.
	const rows = normalizeSections(
		[
			{ start_line: 1, end_line: 3, kind: "import", name: "a", note: "" },
			{ start_line: 7, end_line: 9, kind: "function", name: "b", note: "" },
		],
		12,
	);
	assert.deepEqual(
		rows.map((s) => [s.startLine, s.endLine]),
		[
			[1, 3],
			[7, 9],
		],
		"the gap between 4 and 6 is preserved, not filled",
	);

	const map = renderMap(rows);
	assert.match(map, /1-\s*3\s+import/, "the first row renders");
	assert.match(map, /7-\s*9\s+function/, "the row after the gap renders");
	assert.doesNotMatch(map, /skipped/, "the gap is not narrated");
	assert.doesNotMatch(map, /10-\s*12/, "the unclaimed tail is not invented");
});

await check("a runaway note is cut to the stated budget", async () => {
	const longNote = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
	const rows = normalizeSections(
		[{ start_line: 1, end_line: 5, kind: "function", name: "a", note: longNote }],
		5,
	);
	assert.ok(rows[0].note.length <= MAX_NOTE_CHARS + 1, "note is cut");
	assert.ok(rows[0].note.endsWith("…"), "the cut is marked");
	assert.doesNotMatch(rows[0].note, /word79/, "the tail is gone");

	const short = normalizeSections(
		[{ start_line: 1, end_line: 5, kind: "function", name: "a", note: "short" }],
		5,
	);
	assert.equal(short[0].note, "short", "a note inside the budget is untouched");
});

await check("overlapping rows are trimmed locally, without spending a repair", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(100));
		// Two rows claim lines 40-60. The trim is deterministic, so paying a model call to
		// correct arithmetic the code already fixes would contradict the cost discipline.
		const h = makeHarness({
			cwd: root,
			respond: () =>
				jsonResponse({
					overview: "Overlapped.",
					sections: [
						{ start_line: 1, end_line: 60, kind: "class", name: "a" },
						{ start_line: 40, end_line: 101, kind: "function", name: "b", note: "" },
					],
				}),
		});

		const result = await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(h.calls.length, 1, "a fixable overlap is not worth a model call");
		assert.equal(result.details.mode, "mapped");
		assert.equal(result.details.attempts, 1);
		// The earlier row is cut to the line before its child begins.
		assert.match(result.content[0].text, /1-\s*39\s+class/);
		assert.match(result.content[0].text, /40-\s*101\s+function/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("no stored map can contain overlapping rows, however the model answers", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(500));
		const h = makeHarness({
			cwd: root,
			respond: () =>
				jsonResponse({
					overview: "Always overlaps.",
					sections: [
						{ start_line: 1, end_line: 100, kind: "class", name: "A" },
						{ start_line: 60, end_line: 200, kind: "function", name: "B" },
					],
				}),
		});

		const result = await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(h.calls.length, 1, "one call: the overlap is not a repair problem");
		assert.equal(result.details.mode, "mapped");
		assert.equal(result.details.sections, 2);
		assert.match(result.content[0].text, /1-\s*59\s+class/);
		assert.match(result.content[0].text, /60-\s*200\s+function/);
		assert.doesNotMatch(result.content[0].text, /skipped/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a bad model argument falls back to the file, with the reason in the notice", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(10));
		const h = makeHarness({ cwd: root });

		// A model the registry does not know, and a model not in provider/model form, are
		// both caller mistakes. The file is still readable, so the model gets the file and
		// the mistake is shown rather than thrown - the caller can correct it from there.
		const unknown = await runTool(h, "summary", { path: "src/a.ts", model: "nope/missing" });
		assert.equal(unknown.details.status, "failed");
		assert.match(unknown.content[0].text, /unknown model/);
		assert.match(unknown.content[0].text, /line 1/, "the file body still follows");

		const malformed = await runTool(h, "summary", { path: "src/a.ts", model: "justmodel" });
		assert.match(malformed.content[0].text, /provider\/model/);

		h.ctx.modelRegistry.hasConfiguredAuth = () => false;
		const noAuth = await runTool(h, "summary", { path: "src/a.ts" });
		assert.match(noAuth.content[0].text, /no credentials configured/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("an unreadable path is still an error, not a fallback", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(10));
		const h = makeHarness({ cwd: root });

		// Nothing to fall back to: a directory and a missing file cannot be read either, so
		// these stay hard errors rather than returning an empty body.
		await assert.rejects(() => runTool(h, "summary", { path: "src" }), /is not a regular file/);
		await assert.rejects(
			() => runTool(h, "summary", { path: "src/gone.ts" }),
			/is not a regular file/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the cache lives in the project's .pi dir and is keyed from the root", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(10));
		const h = makeHarness({ cwd: join(root, "src") });

		const result = await runTool(h, "summary", { path: "a.ts" });
		// The database path lives in `details`, which the model never sees - it is not worth
		// a line of context to tell the model where the cache file is.
		assert.match(result.details.dbPath, /\.pi[\\/]summaries\.db$/);
		assert.doesNotMatch(result.content[0].text, /summaries\.db/, "no cache path in the text");
		assert.equal(result.details.path, "src/a.ts", "keyed relative to the project root");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a file outside the project root is still cached", async () => {
	const root = tempProject();
	const outside = mkdtempSync(join(tmpdir(), "pi-summary-out-"));
	try {
		writeFileSync(join(outside, "x.ts"), numbered(10));
		const h = makeHarness({ cwd: root });
		const result = await runTool(h, "summary", { path: join(outside, "x.ts") });
		assert.equal(result.details.status, "miss");
		assert.equal(result.details.path.includes("x.ts"), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

// ------------------------------------------------------------------ read guard

await check("the guard refuses a read longer than it returns", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(400));
		const h = makeHarness({ cwd: root });

		const reason = await readMap(h, { path: "src/a.ts" });
		assert.match(reason, /longer than 200 lines/);
		assert.match(reason, /at most 200 lines per call/);
		assert.match(reason, /## map/, "the map is the answer, not just a refusal");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the refused map carries every row, with nothing cut off", async () => {
	// A cap here used to truncate the map to a fraction of its rows and drop the trailing
	// read hint. The partial map was indistinguishable from a complete one because the rows
	// it kept were contiguous, so a model capped for needing a map got a plausible map with
	// rows missing. The appended text must now carry every row the summary has.
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "big.ts"), numbered(2000));
		// One row per two lines, each with a full note: enough rows that the old 6000-char cap
		// would have cut the map and lost its tail.
		const rows = Array.from({ length: 400 }, (_, i) => ({
			start_line: i * 5 + 1,
			end_line: i * 5 + 4,
			kind: "function",
			name: `handleThing${i}()`,
			note: `Does the thing number ${i} and returns it. Second sentence of detail here.`,
		}));
		const h = makeHarness({
			cwd: root,
			respond: () => jsonResponse({ overview: "Many functions.", sections: rows }),
		});

		const text = await readMap(h, { path: "src/big.ts" });
		assert.ok(!text.includes("truncated"), "no truncation marker");
		for (const index of [0, 199, 399]) {
			assert.match(text, new RegExp(`handleThing${index}\\(\\)`), `row ${index} is present`);
		}
		assert.match(text, /# read src\/big\.ts with offset\/limit/, "the closing hint survives");
		assert.match(text, /1996-\s*1999\s+function/, "including the last row's range");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the guard leaves bounded reads and small files alone", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "big.ts"), numbered(400));
		writeFileSync(join(root, "src", "small.ts"), numbered(20));
		const h = makeHarness({ cwd: root });
		const allowed = async (input, what) =>
			assert.equal(await readMap(h, input), undefined, what);

		await allowed({ path: "src/big.ts", limit: 200 }, "exactly 200 lines is a read");
		await allowed({ path: "src/big.ts", limit: 100 }, "a smaller limit is a read");
		await allowed({ path: "src/small.ts" }, "a small file is a read");
		await allowed({ path: "src/big.ts", offset: 401 }, "past EOF is left to the read tool");
		// A missing file is the read tool's error to raise, and it must still be raised.
		assert.match(await readError(h, { path: "src/nope.ts" }), /ENOENT|no such file/i);
		assert.equal(h.calls.length, 0, "and no allowed read spends a model call");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("an oversized tail is refused and the offset named", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "big.ts"), numbered(400));
		const h = makeHarness({ cwd: root });

		const tail = await readMap(h, { path: "src/big.ts", offset: 150 });
		assert.match(tail, /lines 150 onward/);
		assert.match(tail, /## map/);

		assert.equal(
			await readMap(h, { path: "src/big.ts", offset: 202 }),
			undefined,
			"exactly 200 lines from the offset is a read",
		);
		// numbered(400) counts as 401 lines, so 201..401 is 201 lines and must be intercepted.
		assert.match(
			await readMap(h, { path: "src/big.ts", offset: 201 }),
			/longer than 200 lines/,
			"one line over the limit is intercepted",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a cold oversized read is summarized by the guard and answered with the map", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(500));
		const h = makeHarness({
			cwd: root,
			respond: (context) =>
				jsonResponse({
					overview: "Sync client.",
					sections: [
						{ start_line: 1, end_line: lastShownLine(context), kind: "class", name: "SyncClient", note: "" },
					],
				}),
		});

		const result = await runRead(h, { path: "src/a.ts" });
		assert.equal(h.calls.length, 1, "the guard paid for one summarization");
		const text = result.content.map((c) => c.text).join("");
		assert.match(text, /longer than 200 lines/, "the file's lines are not returned");
		assert.match(text, /SyncClient/, "the map it just made is the answer");
		assert.equal(result.details, undefined, "the result has the shape of a clean read");

		// The work it did is cached, so the next oversized read costs nothing.
		const again = await readMap(h, { path: "src/a.ts" });
		assert.equal(h.calls.length, 1, "the second read is served from cache");
		assert.match(again, /SyncClient/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("an intercepted read is a successful result, not an error", async () => {
	// The whole point of replacing the read tool instead of blocking the call: pi hardcodes
	// isError:true on a blocked tool call, so the map arrived at the model as a failed call.
	// A tool that returns the map normally produces isError:false by construction.
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(500));
		const h = makeHarness({ cwd: root });

		const result = await runRead(h, { path: "src/a.ts" });
		assert.ok(result.content.length > 0, "the call resolves rather than being blocked");
		assert.equal(result.isError, undefined, "nothing marks the result as an error");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a failing summarizer lets the read through and notifies", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(500));
		const h = makeHarness({
			cwd: root,
			respond: () => errorResponse("upstream is down"),
		});
		h.ctx.hasUI = true;
		h.ctx.ui = { notify: (message, type) => h.notices.push({ message, type }) };

		const result = await runRead(h, { path: "src/a.ts" });
		const text = result.content.map((c) => c.text).join("");
		assert.match(text, /line 1\b/, "the file's own lines are returned instead");
		assert.equal(h.notices.length, 1, "the failure is surfaced");
		assert.equal(h.notices[0].type, "error");
		assert.match(h.notices[0].message, /upstream is down/);
		assert.match(h.notices[0].message, /Reading the file directly/);

		// Without a UI a notification reaches nobody, so the same notice rides the read
		// result the model actually receives.
		assert.match(text, /^# summary failed:/m, "and the notice is on the result");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the guard is silent for reads inside the limit", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(500));
		const h = makeHarness({ cwd: root });

		for (const input of [
			{ path: "src/a.ts", limit: 200 },
			{ path: "src/a.ts", limit: 50 },
			{ path: "src/a.ts", offset: 480 },
		]) {
			assert.equal(await readMap(h, input), undefined, `${JSON.stringify(input)} is a read`);
		}
		assert.equal(h.calls.length, 0, "an allowed read never spends a model call");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a read of a summarized file returns the cached map", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(400));
		const h = makeHarness({
			cwd: root,
			respond: (context) => {
				const last = lastShownLine(context);
				return jsonResponse({
					overview: "HTTP client for the sync layer.",
					sections: [
						{ start_line: 1, end_line: 60, kind: "class", name: "SyncClient", note: "transport" },
						{ start_line: 61, end_line: last, kind: "method", name: "retry()", note: "backoff" },
					],
				});
			},
		});

		// Calling the tool is what puts the map in the cache, and the read is then answered
		// from it, without a second model call.
		await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(h.calls.length, 1);

		const text = await readMap(h, { path: "src/a.ts" });
		assert.equal(h.calls.length, 1, "the read is answered from the cache");
		assert.match(text, /longer than 200 lines/);
		assert.match(text, /## map/);
		assert.match(text, /SyncClient/);
		assert.match(text, /retry\(\)/);
		assert.match(text, /offset\/limit/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the guard replaces a stale summary instead of quoting it", async () => {
	const root = tempProject();
	try {
		const file = join(root, "src", "a.ts");
		writeFileSync(file, numbered(400));
		const h = makeHarness({
			cwd: root,
			respond: (_context, _opts, n) =>
				jsonResponse({
					overview: `Generation ${n}.`,
					sections: [
						{ start_line: 1, end_line: lastShownLine(_context), kind: "other", name: "whole", note: "" },
					],
				}),
		});
		await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(h.calls.length, 1);

		// The file grows, so the cached entry is stale and describes the wrong line count.
		writeFileSync(file, numbered(600));
		const text = await readMap(h, { path: "src/a.ts" });
		assert.equal(h.calls.length, 2, "a stale entry is refreshed, not quoted");
		assert.match(text, /Generation 2\./, "the fresh overview is what is shown");
		assert.doesNotMatch(text, /Generation 1\./, "the stale overview was not reused");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the guard leaves prose, notes and extensionless files to read", async () => {
	// The 200 line limit is for source files, where guessing the wrong range costs a call. A
	// README is written to be read in order, and a map of one says nothing a skim does not,
	// so refusing it only takes the file away. Unguarded paths fall through to the built-in
	// read, which has its own 2000-line cap.
	const root = tempProject();
	try {
		for (const name of ["README.md", "notes.txt", "Makefile", ".gitignore", "LICENSE"]) {
			writeFileSync(join(root, name), numbered(4000));
		}
		writeFileSync(join(root, "src", "a.ts"), numbered(4000));
		const h = makeHarness({ cwd: root });

		for (const name of ["README.md", "notes.txt", "Makefile", ".gitignore", "LICENSE"]) {
			assert.equal(await readMap(h, { path: name }), undefined, `${name} is a read`);
		}
		assert.equal(h.calls.length, 0, "and none of them is summarized");

		// A source file beside them is intercepted, so the filter is the extension, not the size.
		assert.match(
			await readMap(h, { path: "src/a.ts" }),
			/longer than 200 lines/,
			"a .ts file of the same size returns a map instead",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("isUnguardedPath picks the extension, case-insensitively", async () => {
	for (const path of ["a.md", "a.txt", "a.MD", "a.TXT", "Makefile", ".gitignore", "LICENSE", "x"]) {
		assert.equal(isUnguardedPath(path), true, `${path} is unguarded`);
	}
	for (const path of ["a.ts", "a.mjs", "a.json", "a.yaml", ".eslintrc.json", "a.test.ts"]) {
		assert.equal(isUnguardedPath(path), false, `${path} is guarded`);
	}
});

await check("the guard never touches a binary file", async () => {
	const root = tempProject();
	try {
		writeFileSync(
			join(root, "src", "blob.bin"),
			Buffer.concat([Buffer.from([0, 1, 2]), Buffer.alloc(40000, 7)]),
		);
		const h = makeHarness({ cwd: root });
		assert.equal(await readMap(h, { path: "src/blob.bin" }), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the guard allows the read when it cannot read the file itself", async () => {
	// The guard stats the file, then opens it to count lines. If it loses read permission in
	// between - or the file is deleted, which is what an editor rewrite looks like - an
	// unguarded `open` rejects and the *guard* fails the read. It must not claim the call:
	// the read goes to the built-in tool, whose own error is what the model should see.
	// Read-deny via ACL gives stat=true, open=EPERM.
	const root = tempProject();
	try {
		const file = join(root, "src", "denied.ts");
		writeFileSync(file, numbered(400));
		const { execFileSync } = await import("node:child_process");
		const user = process.env.USERNAME;
		if (process.platform !== "win32" || !user) {
			console.log("     (skipped: read-deny fixture needs Windows and USERNAME)");
			return;
		}

		const h = makeHarness({ cwd: root });
		execFileSync("icacls", [file, "/deny", `${user}:(R)`], { stdio: "pipe" });
		try {
			// The read is left to the built-in tool, so it rejects with the real reason
			// instead of being answered with a map the guard could not have built.
			assert.match(await readError(h, { path: "src/denied.ts" }), /EPERM/);
			assert.equal(h.calls.length, 0, "and never reaches the summarizer");
		} finally {
			execFileSync("icacls", [file, "/remove:d", user], { stdio: "pipe" });
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
await check("the guard respects the offset+limit the model already chose", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "big.ts"), numbered(4000));
		const h = makeHarness({ cwd: root });
		assert.equal(await readMap(h, { path: "src/big.ts", offset: 500, limit: 50 }), undefined);
		// Well within an explicitly bounded span, even though the file is large.
		assert.equal(await readMap(h, { path: "src/big.ts", offset: 2000, limit: 200 }), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the replaced read keeps the built-in tool's surface", async () => {
	// The extension swaps execution, not the tool's contract. pi does not inherit any of this
	// from the built-in when a tool is overridden, so losing it silently would drop read's
	// prompt guidance from the system prompt and its schema from the model's tool list.
	const { createReadToolDefinition } = await import("@earendil-works/pi-coding-agent");
	const h = makeHarness({ cwd: tempProject() });
	const registered = h.tools.get("read");
	const builtin = createReadToolDefinition(process.cwd());

	assert.ok(registered, "a tool named read is registered, replacing the built-in");
	assert.equal(registered.description, builtin.description, "the description is kept");
	assert.equal(registered.promptSnippet, builtin.promptSnippet, "the prompt snippet is kept");
	assert.deepEqual(
		registered.promptGuidelines,
		builtin.promptGuidelines,
		"the prompt guidelines are kept",
	);
	assert.equal(
		JSON.stringify(registered.parameters),
		JSON.stringify(builtin.parameters),
		"the parameter schema is kept",
	);
	// Renderers are resolved per slot by the TUI, so the built-in one draws our results too.
	assert.equal(typeof registered.renderCall, "function", "the built-in call renderer is kept");
	assert.equal(typeof registered.renderResult, "function", "the built-in result renderer is kept");
});

await check("a read the guard does not claim behaves exactly like the built-in read", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(20));
		const h = makeHarness({ cwd: root });

		// Reading the middle of a file, which is the shape the built-in read produces: the
		// slice the caller asked for, its continuation note, and no truncation.
		const result = await runRead(h, { path: "src/a.ts", offset: 5, limit: 3 });
		assert.equal(
			result.content[0].text,
			"line 5\nline 6\nline 7\n\n[14 more lines in file. Use offset=8 to continue.]",
		);
		assert.equal(result.details, undefined, "a clean read reports no truncation");

		// Past the end, the built-in read names the offset it could not honour.
		assert.match(
			await readError(h, { path: "src/a.ts", offset: 99 }),
			/Offset 99 is beyond end of file/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
