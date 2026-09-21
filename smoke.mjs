import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir as osHomedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setCapabilities, getCapabilities } from "@earendil-works/pi-tui";
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

/**
 * Isolation from the developer's own pi install.
 *
 * The extension reads `summary.model` out of pi's settings, and a read with no project
 * settings falls all the way through to the global file at `<agentDir>/settings.json`.
 * That makes the suite depend on whatever the machine running it happens to have
 * configured: a `summary.model` naming a model the fake harness cannot resolve now fails
 * the summary, so a working setting would be honoured and a typo would break unrelated
 * cases. Point `<agentDir>` at an empty directory before anything reads it, so every case
 * starts from the same unconfigured state and only the cases that write settings
 * deliberately are affected. Cases that set `PI_CODING_AGENT_DIR` themselves still win,
 * since they assign it inside their own try block.
 */
const isolatedAgentDir = mkdtempSync(join(tmpdir(), "pi-agent-isolated-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;

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
	return Number(prompt.match(/File: .*\((\d+) lines;/)[1]);
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

		write("provider/model");
		assert.deepEqual(readSummarySettings(root), { model: "provider/model" });

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

		// A present setting that names no known model is an error, not a silent substitution:
		// the setting exists to control what a summary costs, so spending the session model
		// instead would defeat it while looking like it was honoured. The file is still
		// readable, so the caller gets the file and the reason.
		writeFileSync(
			join(agent, "settings.json"),
			JSON.stringify({ summary: { model: "nope/missing" } }),
		);
		h.ctx.hasUI = true;
		h.ctx.ui = { notify: (message, type) => h.notices.push({ message, type }) };

		const bad = await runTool(h, "summary", { path: "src/a.ts", refresh: true });
		assert.equal(bad.details.status, "failed", "a bad setting does not summarize");
		assert.match(bad.content[0].text, /nope\/missing/, "the offending value is named");
		assert.match(bad.content[0].text, /names no known model/);
		assert.match(bad.content[0].text, /line 1/, "the file body still follows");
		assert.equal(h.notices.length, 1, "it is reported");
		assert.equal(h.notices[0].type, "error");

		// Meaningful on every call, because it is a failure rather than a note about which
		// of two working models was picked.
		await runTool(h, "summary", { path: "src/a.ts", refresh: true });
		assert.equal(h.notices.length, 2, "the failure is reported each time");

		// Only an absent setting means the session model. That is the documented default, not
		// a fallback, so it is not announced.
		writeFileSync(join(agent, "settings.json"), JSON.stringify({}));
		const unset = await runTool(h, "summary", { path: "src/a.ts", refresh: true });
		assert.equal(unset.details.model, "test/test-model", "the session model is the default");
		assert.equal(h.notices.length, 2, "the default needs no announcement");
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

await check("the cached schema carries neither retired column, and an old database is migrated", async () => {
	// `mtime_ms` was stored until the freshness check stopped consulting it, and `created_at`
	// until nothing was left that read it. A database from an earlier version still has both,
	// NOT NULL, so dropping them is a migration and not just a schema edit: without it every
	// insert fails the constraint.
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
		assert.ok(!columns.includes("created_at"), "the unread timestamp is dropped too");
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
		assert.match(context.messages[0].content[0].text, /one JSON object and nothing else/);
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
			// An OpenAI-compatible provider that rejects response_format but answers fine without it.
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
		assert.match(prompt, /File: src\/huge\.ts \(5001 lines; line 5001 is the last\)/);
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
		assert.match(prompt, /Copy line numbers from the left column/i);
		assert.match(prompt, /do not count lines yourself/i);

		// The whole file is here, and the prompt says so.
		assert.match(prompt, /File: src\/a\.ts \(13 lines; line 13 is the last\)/);
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
		// The cache file is an implementation detail of this extension, so its path is not part
		// of the result at all - not in `details`, and not worth a line of context to the model.
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

await check("an unusable cache falls back to the whole file, and the reason names the store", async () => {
	// The uncovered route into the fallback: the model answered fine, but the answer could not
	// be stored. `.pi` is created as a *file*, so `openDb`'s `mkdirSync` of the cache directory
	// fails with EEXIST before any model call - the storage failure `summarizeFile` reports as
	// `failed to store the summary`. Walking that to the user-visible result is what proves the
	// fallback closes over the store as well as the model, which is the invariant the read
	// guard rests on: an intercepted read is a success even when nothing could be cached.
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(500));
		writeFileSync(join(root, ".pi"), "not a directory");
		const h = makeHarness({ cwd: root });

		const result = await runRead(h, { path: "src/a.ts" });
		const text = result.content.map((c) => c.text ?? "").join("");
		assert.equal(await readMap(h, { path: "src/a.ts" }), undefined, "no map was claimed");
		assert.match(text, /line 1\b/, "the file's own lines are returned");
		assert.match(text, /^# summary failed:/m, "the failure rides the result");
		assert.match(text, /EEXIST|file already exists/, "and names the storage failure");

		// `summary` itself must not throw either: it hands back the file the same way.
		const direct = await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(direct.details.status, "failed");
		assert.match(direct.content[0].text, /Returning the whole file instead/);
		assert.match(direct.content[0].text, /line 1/, "the file body follows");
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

/**
 * Run the `edit` locator the way pi does: execute the real built-in edit, then hand its
 * result to the handler and return what the handler decided.
 *
 * The handler under test is registered by the extension itself, so this reaches it through
 * the harness's handler list rather than importing it - the wiring is part of what is being
 * checked.
 */
async function runEdit(h, path, edits) {
	const { createEditToolDefinition } = await import("@earendil-works/pi-coding-agent");
	const tool = createEditToolDefinition(h.ctx.cwd);
	const result = await tool.execute("id", { path, edits }, undefined, undefined, h.ctx);
	const locator = h.handlers.find((entry) => entry.event === "tool_result");
	assert.ok(locator, "the extension registers a tool_result handler");

	const hookResult = await locator.handler(
		{
			type: "tool_result",
			toolName: "edit",
			toolCallId: "call-1",
			input: { path, edits },
			content: result.content,
			details: result.details,
			isError: false,
		},
		h.ctx,
	);

	// `undefined` means the handler declined, which leaves the built-in result untouched.
	const text = hookResult
		? hookResult.content
				.slice(result.content.length)
				.map((c) => c.text)
				.join("")
		: "";
	return { text, builtinText: result.content.map((c) => c.text).join(""), result, hookResult };
}

/** A 253-line file: over the read limit, so a re-read of it would be intercepted. */
const locatorFile = (root, lines = 253) => {
	writeFileSync(join(root, "src", "long.ts"), numbered(lines));
	return "src/long.ts";
};

await check("the edit locator names the changed line and the file's new length", async () => {
	const root = tempProject();
	try {
		// Replace the last line: 253 lines in, 253 out.
		const path = locatorFile(root);
		const h = makeHarness({ cwd: root });
		const { text, builtinText } = await runEdit(h, path, [
			{ oldText: "line 253\n", newText: "line 253 changed\n" },
		]);

		assert.match(text, /line 253/, "the changed line is named");
		assert.match(text, /254 lines/, "the file's own length is named");
		// The model's line numbers only line up with `read` if this holds. `read` computes
		// `text.split("\n").length` with no popping (core/tools/read.js, `totalFileLines`),
		// so `numbered(253)` - which ends in a newline - is 254 lines to `read`.
		assert.equal(
			readFileSync(join(root, path), "utf-8").split("\n").length,
			254,
			"the count matches read's convention",
		);
		assert.match(text, /the file now has 254 lines/, "the locator quotes that same number");
		assert.match(
			builtinText,
			/^Successfully replaced 1 block\(s\)/,
			"the built-in confirmation is still there",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the edit locator reports the length after an edit that adds a line", async () => {
	const root = tempProject();
	try {
		const path = locatorFile(root);
		const h = makeHarness({ cwd: root });
		const { text } = await runEdit(h, path, [
			{ oldText: "line 250\n", newText: "first\nsecond\n" },
		]);

		// 253 lines, one replaced by two: the file grew by one.
		assert.match(text, /255 lines/, "the new length counts the added line");
		assert.match(text, /lines 250-251/, "both written lines are named");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the edit locator counts lines the way read does, at the end of a file", async () => {
	const root = tempProject();
	try {
		// Appending past the last line is the case where a popped count would report one line
		// too few and an offset derived from it would land short.
		const path = locatorFile(root);
		const h = makeHarness({ cwd: root });
		const { text } = await runEdit(h, path, [
			{ oldText: "line 253\n", newText: "line 253\nappended\n" },
		]);

		assert.match(text, /line 254/, "the appended line is named as the changed line");
		assert.match(text, /255 lines/, "the length agrees with the line just named");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the edit locator ignores a deletion as a landing position", async () => {
	const root = tempProject();
	try {
		// A deletion renders as a `+` row with no text, because `diffLines` reports the empty
		// remainder after the removed run as an addition. Counting it would name a line
		// nothing was written to: here the insert is at line 6 and the deletion is at 250, so
		// the phantom row would stretch the answer to `lines 6-250`.
		const path = locatorFile(root);
		const h = makeHarness({ cwd: root });
		const { text } = await runEdit(h, path, [
			{ oldText: "line 5\nline 6", newText: "line 5\ninserted\nline 6" },
			{ oldText: "line 249\nline 250\nline 251", newText: "" },
		]);

		assert.match(text, /Edited line 6;/, "only the inserted line is named");
		assert.doesNotMatch(text, /250/, "a deleted line is not a landing position");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the edit locator names each changed run, not the span between them", async () => {
	const root = tempProject();
	try {
		// Two disjoint edits in one call. A span would say `lines 6-250`, naming 243 lines
		// that did not change as edited; the model cannot act on that, which is the re-read
		// this exists to prevent. Measured on one real session, 231 of 447 edits (52%) landed
		// in two or more runs.
		const path = locatorFile(root);
		const h = makeHarness({ cwd: root });
		const { text } = await runEdit(h, path, [
			{ oldText: "line 6\n", newText: "line 6 changed\n" },
			{ oldText: "line 250\n", newText: "line 250 changed\n" },
		]);

		assert.match(text, /lines 6 and 250;/, "both runs are named separately");
		assert.doesNotMatch(text, /6-250/, "the unchanged lines between them are not claimed");
		assert.match(text, /254 lines/, "the length is still reported");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the edit locator joins three runs with commas and a final and", async () => {
	const root = tempProject();
	try {
		const path = locatorFile(root);
		const h = makeHarness({ cwd: root });
		const { text } = await runEdit(h, path, [
			{ oldText: "line 6\n", newText: "line 6 changed\n" },
			{ oldText: "line 40\n", newText: "line 40 changed\n" },
			{ oldText: "line 250\n", newText: "line 250 changed\n" },
		]);

		assert.match(text, /Edited lines 6, 40 and 250;/, "every run is named, in order");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the edit locator falls back to the first line when a call only deletes", async () => {
	const root = tempProject();
	try {
		// A pure deletion has no real `+` row at all: every one is the no-text phantom, so
		// there are no runs to name. The answer is where the removed text began, which is
		// still the line the model needs.
		const path = locatorFile(root);
		const h = makeHarness({ cwd: root });
		const { text } = await runEdit(h, path, [
			{ oldText: "line 250\nline 251\n", newText: "" },
		]);

		assert.match(text, /Edited line 250;/, "the deletion is reported at its start line");
		assert.match(text, /252 lines/, "the length reflects the removed lines");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the edit locator returns only content, so the diff survives", async () => {
	// pi maps the hook's return value with `details: hookResult?.details`, so returning a
	// `details` key - even the same one - replaces what the TUI reads. The edit renderer
	// draws the result from `details.diff`, so clobbering it would leave a successful edit
	// with no diff on screen. Returning only `content` is what keeps that intact.
	const root = tempProject();
	try {
		const path = locatorFile(root);
		const h = makeHarness({ cwd: root });
		const { hookResult, result } = await runEdit(h, path, [
			{ oldText: "line 250\n", newText: "changed\n" },
		]);

		assert.ok(hookResult, "the locator is appended");
		assert.deepEqual(
			Object.keys(hookResult).sort(),
			["content"],
			"the handler sets content and nothing else",
		);
		assert.ok(result.details.diff, "the built-in diff is still produced");
		assert.equal(result.details.firstChangedLine, 250, "the built-in line number is untouched");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the edit locator stays quiet when it cannot be exact", async () => {
	const root = tempProject();
	try {
		const h = makeHarness({ cwd: root });
		const locator = h.handlers.find((entry) => entry.event === "tool_result");
		const base = {
			type: "tool_result",
			toolCallId: "call-1",
			toolName: "edit",
			input: { path: "src/long.ts", edits: [] },
			content: [{ type: "text", text: "ok" }],
			details: { diff: "", patch: "", firstChangedLine: 5 },
			isError: false,
		};

		// A different tool's result is not ours to edit.
		assert.equal(
			await locator.handler({ ...base, toolName: "write", details: undefined }, h.ctx),
			undefined,
			"a write result is left alone",
		);
		// An error has no landing position to report. The file exists here on purpose: with a
		// missing one the handler would decline anyway, and the test would pass without the
		// isError check being there at all.
		const real = locatorFile(root);
		assert.equal(
			await locator.handler(
				{ ...base, input: { path: real, edits: [] }, isError: true },
				h.ctx,
			),
			undefined,
			"a failed edit is left alone",
		);
		// `firstChangedLine` is optional in pi's own type, so an absent one is expected. The
		// file exists here so the handler cannot decline merely because it could not read it.
		const present = locatorFile(root);
		assert.equal(
			await locator.handler(
				{
					...base,
					input: { path: present, edits: [] },
					details: { diff: "", patch: "" },
				},
				h.ctx,
			),
			undefined,
			"an edit with no line number is left alone",
		);
		// A line number past the end of the file means the file on disk is not the one that
		// was edited, so nothing derived from it can be trusted.
		assert.equal(
			await locator.handler(
				{
					...base,
					input: { path: present, edits: [] },
					details: { diff: "", patch: "", firstChangedLine: 9999 },
				},
				h.ctx,
			),
			undefined,
			"a line number past the end of the file is left alone",
		);
		// The edit succeeded but the file is gone by the time the hook looks.
		assert.equal(
			await locator.handler({ ...base, input: { path: "src/gone.ts" } }, h.ctx),
			undefined,
			"an unreadable file leaves the result alone",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the edit locator says line, not lines, when the file is emptied", async () => {
	const root = tempProject();
	try {
		// `read` counts an empty file as 1 line, so deleting a file's only line lands on the
		// singular. Getting this wrong reads as "1 lines".
		writeFileSync(join(root, "src", "one.ts"), "only line\n");
		const h = makeHarness({ cwd: root });
		const { text } = await runEdit(h, "src/one.ts", [
			{ oldText: "only line\n", newText: "" },
		]);

		assert.match(text, /now has 1 line\./, "the singular is used for a one-line file");
		assert.doesNotMatch(text, /1 lines/, "not the plural");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the edit locator declines a line number that is not a positive integer", async () => {
	const root = tempProject();
	try {
		// `firstChangedLine` is typed as an optional number, so only the `undefined` case is
		// guaranteed by the type. A zero, a fraction or a negative would name a line that
		// cannot exist, which is the one thing this must never do.
		const path = locatorFile(root);
		const h = makeHarness({ cwd: root });
		const locator = h.handlers.find((entry) => entry.event === "tool_result");
		const base = {
			type: "tool_result",
			toolCallId: "call-1",
			toolName: "edit",
			input: { path, edits: [] },
			content: [{ type: "text", text: "ok" }],
			details: { diff: "", patch: "" },
			isError: false,
		};

		for (const bad of [0, -3, 2.5, Number.NaN]) {
			assert.equal(
				await locator.handler(
					{ ...base, details: { diff: "", patch: "", firstChangedLine: bad } },
					h.ctx,
				),
				undefined,
				`a firstChangedLine of ${bad} is refused`,
			);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the edit locator is registered once", async () => {
	const h = makeHarness({ cwd: tempProject() });
	const registered = h.handlers.filter((entry) => entry.event === "tool_result");
	assert.equal(registered.length, 1, "one handler appends one locator, never two");
});

/**
 * A theme that styles nothing.
 *
 * The renderers are the subject here, not the colors: an identity `fg`/`bold` leaves the text
 * the renderer composed readable in an assertion, and the codes it would have emitted are pi's
 * contract, tested in pi.
 */
const stubTheme = { fg: (_color, text) => text, bold: (text) => text };

/**
 * The render context the TUI hands a renderer, with the fields the renderers read.
 *
 * `lastComponent` starts undefined, which is how a first render arrives.
 */
function renderContext(overrides = {}) {
	return {
		args: {},
		toolCallId: "id",
		invalidate: () => {},
		lastComponent: undefined,
		state: undefined,
		cwd: process.cwd(),
		executionStarted: false,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	};
}

/** The visible rows a component renders to, trimmed and without blank padding. */
function renderRows(component, width = 120) {
	return component
		.render(width)
		.map((line) => line.trimEnd())
		.filter((line) => line !== "")
		.join("\n");
}

await check("the summary tool draws itself, and reuses the slot the TUI gives it", async () => {
	// Without renderers a summary call is drawn generically, so the call that produced the map
	// is the one line of the transcript that says nothing about what happened.
	const h = makeHarness({ cwd: tempProject() });
	const summary = h.tools.get("summary");

	assert.equal(typeof summary.renderCall, "function", "summary has a call renderer");
	assert.equal(typeof summary.renderResult, "function", "summary has a result renderer");

	const called = renderRows(
		summary.renderCall({ path: "src/big.ts" }, stubTheme, renderContext()),
	);
	assert.match(called, /summary/, "the call names the tool");
	assert.match(called, /src\/big\.ts/, "and the file it is about");

	// Arguments arrive a field at a time while the model is still writing the call, so a path
	// that is not a string yet is the normal first frame, not a malformed call.
	const streaming = renderRows(summary.renderCall({}, stubTheme, renderContext()));
	assert.match(streaming, /summary/, "a call still streaming its arguments still renders");
	assert.match(streaming, /\.\.\./, "with a placeholder where the path will be");

	// A present argument of the wrong type is not a call still streaming, and read says so
	// rather than showing the same placeholder forever.
	const malformed = renderRows(summary.renderCall({ path: 42 }, stubTheme, renderContext()));
	assert.match(malformed, /invalid arg/, "a path that is not a string is called out as invalid");

	const refreshing = renderRows(
		summary.renderCall({ path: "src/big.ts", refresh: true }, stubTheme, renderContext()),
	);
	assert.match(refreshing, /refresh/, "an explicit refresh is visible on the call");

	// The TUI hands back the component the slot returned last time; reusing it is what keeps a
	// streaming call from allocating a component per frame.
	const first = summary.renderCall({ path: "src/big.ts" }, stubTheme, renderContext());
	const second = summary.renderCall(
		{ path: "src/other.ts" },
		stubTheme,
		renderContext({ lastComponent: first }),
	);
	assert.equal(second, first, "the previous component is reused rather than replaced");
	assert.match(renderRows(second), /src\/other\.ts/, "and re-texted with the new arguments");
});

await check("the call links to the real file, not to the path as it is displayed", async () => {
	// The display shortens the home directory to `~`; a link built from the shortened text
	// resolves `~` against cwd and points at `<cwd>/~/file`, which opens nothing. pi keeps the
	// two strings apart for this reason, so a path under $HOME is the case that catches it.
	const root = tempProject();
	const previous = { ...getCapabilities() };
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(5));
		setCapabilities({ images: null, trueColor: false, hyperlinks: true });

		const h = makeHarness({ cwd: root });
		const summary = h.tools.get("summary");
		const linked = (rawPath, cwd = root) =>
			summary.renderCall({ path: rawPath }, stubTheme, renderContext({ cwd })).render(200).join("");

		// A file inside cwd: the link is the absolute path, and the display is not shortened.
		const relative = linked("src/a.ts");
		assert.match(
			relative,
			new RegExp(pathToFileURL(join(root, "src", "a.ts")).href),
			"a relative path links to the file it resolves to",
		);

		// A file under the home directory: shown as `~/...`, linked in full.
		const inHome = join(osHomedir(), "pi-summary-home-probe.ts");
		const rendered = linked(inHome);
		assert.match(rendered, /~[/\\]pi-summary-home-probe\.ts/, "a home path is displayed shortened");
		assert.match(
			rendered,
			new RegExp(pathToFileURL(inHome).href),
			"and linked to the real path rather than to the `~` shown to the reader",
		);
		assert.doesNotMatch(
			rendered,
			/%7E/,
			"no link target resolves a literal `~` against cwd",
		);

		// The leading `@` many callers write means the same here as everywhere else.
		assert.match(
			linked("@src/a.ts"),
			new RegExp(pathToFileURL(join(root, "src", "a.ts")).href),
			"and the link resolves a leading @ the way the tools do",
		);

		// A terminal that cannot open links gets the styled text alone, with no escape sequence
		// the reader would see as noise.
		setCapabilities({ ...previous, hyperlinks: false });
		assert.doesNotMatch(
			linked("src/a.ts"),
			/\x1b\]8;;/,
			"a terminal without hyperlink support gets plain styled text",
		);
	} finally {
		setCapabilities({ ...previous });
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a summary result renders its outcome collapsed and its text expanded", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(500));
		const h = makeHarness({ cwd: root });
		const summary = h.tools.get("summary");
		const result = await runTool(h, "summary", { path: "src/a.ts" });

		const collapsed = renderRows(
			summary.renderResult(result, { expanded: false, isPartial: false }, stubTheme, renderContext()),
		);
		assert.match(collapsed, /cache: miss/, "the collapsed line reports where the map came from");
		assert.match(
			collapsed,
			new RegExp(`${result.details.lines} lines`),
			"and how big the file is",
		);
		assert.match(collapsed, /1 range\b/, "and how many ranges it holds");
		assert.doesNotMatch(
			collapsed,
			/## map/,
			"the map itself waits for an expansion rather than burying the transcript in rows",
		);

		// `D15`: the model a file was summarized with is in the details for diagnosis, and in the
		// transcript it would only invite the reader to second-guess a map over a model name.
		assert.match(result.details.model, /test-model/, "the details do record the summarizer");

		const expanded = renderRows(
			summary.renderResult(result, { expanded: true, isPartial: false }, stubTheme, renderContext()),
		);
		assert.match(expanded, /## map/, "expanding shows the map");
		assert.match(expanded, /Does a thing\./, "including the prose");
		assert.doesNotMatch(expanded, /test-model/, "and no model name anywhere in it");

		// A call that is still running has no details yet.
		const pending = summary.renderResult(
			{ content: [] },
			{ expanded: false, isPartial: true },
			stubTheme,
			renderContext(),
		);
		assert.match(renderRows(pending), /summariz/, "a call in flight says so");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a failed summary is drawn as the whole-file fallback it is", async () => {
	// The fallback returns the file's lines, not a map. A display that showed the usual outcome
	// line would let a failure read as a summary.
	const h = makeHarness({ cwd: tempProject() });
	const summary = h.tools.get("summary");
	const fallback = {
		content: [{ type: "text", text: "# summary failed: no credentials\n\nline 1\nline 2" }],
		details: {
			path: "src/a.ts",
			status: "failed",
			mode: "raw",
			lines: 2,
			model: "",
			sections: 0,
			attempts: 0,
			degraded: true,
		},
	};

	const collapsed = renderRows(
		summary.renderResult(fallback, { expanded: false, isPartial: false }, stubTheme, renderContext()),
	);
	assert.match(collapsed, /no summary/, "the collapsed line says no summary was made");
	assert.doesNotMatch(collapsed, /cache:/, "and does not report a cache state it never reached");

	const expanded = renderRows(
		summary.renderResult(fallback, { expanded: true, isPartial: false }, stubTheme, renderContext()),
	);
	assert.match(expanded, /no credentials/, "expanding shows the reason");
	assert.match(expanded, /line 1/, "and the file content that replaced the map");

	// pi marks a result an error when the tool threw, and read draws its first ten lines even
	// collapsed, because an error the caller has to expand to read is an error nobody reads.
	// This tool throws only when the file could not be read either.
	const failed = {
		content: [{ type: "text", text: "summary failed: ENOENT: no such file or directory" }],
	};
	const asError = renderRows(
		summary.renderResult(failed, { expanded: false, isPartial: false }, stubTheme, renderContext({ isError: true })),
	);
	assert.match(asError, /ENOENT/, "an error result shows its message without being expanded");

	// The renderer runs inside a try/catch in the TUI, where a throw costs the display silently
	// and leaves the generic fallback drawing the call. Nothing here may throw, including a
	// result stripped of the fields it usually has.
	assert.doesNotThrow(() => summary.renderCall(undefined, stubTheme, renderContext()));
	assert.doesNotThrow(() =>
		summary.renderResult({ content: [] }, { expanded: true, isPartial: false }, stubTheme, renderContext()),
	);
	assert.doesNotThrow(() =>
		summary.renderResult({ content: [] }, { expanded: false, isPartial: false }, stubTheme, renderContext()),
	);
	// The error path reads the same fields as every other; an empty one must not throw either.
	assert.doesNotThrow(() =>
		summary.renderResult({ content: [] }, { expanded: false, isPartial: false }, stubTheme, renderContext({ isError: true })),
	);
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

await check("a concurrent cold read of one file is summarized once", async () => {
	// A model can ask for the same file several times in a single turn, and nothing about a
	// `read` call serializes them. Each one used to summarize the file on its own, paying for
	// a model call per read - five reads of an un-summarized file cost five calls.
	const root = tempProject();
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agent = mkdtempSync(join(tmpdir(), "pi-agent-"));
	process.env.PI_CODING_AGENT_DIR = agent;
	try {
		writeFileSync(join(agent, "settings.json"), "{}");
		writeFileSync(join(root, "src", "a.ts"), numbered(500));
		let summarizerCalls = 0;
		const h = makeHarness({
			cwd: root,
			respond: (context) => {
				summarizerCalls++;
				return jsonResponse({
					overview: "One client.",
					sections: [
						{ start_line: 1, end_line: lastShownLine(context), kind: "class", name: "Client", note: "" },
					],
				});
			},
		});

		// Deliberately not awaited one at a time: all five are in flight together, which is
		// the window the cache cannot cover.
		const results = await Promise.all(
			Array.from({ length: 5 }, () => runRead(h, { path: "src/a.ts" })),
		);

		assert.equal(summarizerCalls, 1, "five concurrent cold reads share one summarization");
		for (const result of results) {
			assert.equal(result.isError, undefined, "every read still succeeded");
			assert.match(result.content[0].text, /Client/, "and every read got the map");
		}

		// The shared run is done, so this is the cache answering and not a stale join.
		assert.equal(h.calls.length, 1, "a later read costs nothing");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
		rmSync(agent, { recursive: true, force: true });
	}
});

await check("a refresh neither joins nor is joined by a run in flight", async () => {
	// The dedupe map is published by ordinary calls only. A forced run must not join one:
	// it was asked to re-summarize, and inheriting an ordinary run's answer would return the
	// cached entry it exists to replace. Driven through `summary` because `refresh` is that
	// tool's parameter - the guard has no way to ask for a refresh.
	const root = tempProject();
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agent = mkdtempSync(join(tmpdir(), "pi-agent-"));
	process.env.PI_CODING_AGENT_DIR = agent;
	try {
		writeFileSync(join(agent, "settings.json"), "{}");
		writeFileSync(join(root, "src", "a.ts"), numbered(500));

		// Hold the first summarization open so the second call is genuinely concurrent with
		// it, rather than racing to finish first.
		let release;
		const held = new Promise((resolve) => {
			release = resolve;
		});
		let summarizerCalls = 0;
		let firstCall = true;
		const h = makeHarness({
			cwd: root,
			respond: async (context) => {
				summarizerCalls++;
				if (firstCall) {
					firstCall = false;
					await held;
				}
				return jsonResponse({
					overview: "One client.",
					sections: [
						{ start_line: 1, end_line: lastShownLine(context), kind: "class", name: "Client", note: "" },
					],
				});
			},
		});

		const ordinary = runTool(h, "summary", { path: "src/a.ts" });
		const forced = runTool(h, "summary", { path: "src/a.ts", refresh: true });
		release();
		await Promise.all([ordinary, forced]);

		assert.equal(summarizerCalls, 2, "a refresh summarizes again instead of joining the run");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
		rmSync(agent, { recursive: true, force: true });
	}
});

await check("an image read gets pi's own images.autoResize setting", async () => {
	// The replacement builds the delegated read itself, and that definition takes this
	// setting. It is read only for images - the built-in consults it in the image branch
	// alone - so this pins that the value still arrives there. With resizing off the
	// built-in returns the bytes untouched, which makes the setting observable in the
	// result rather than only in a timing difference.
	const root = tempProject();
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agent = mkdtempSync(join(tmpdir(), "pi-agent-"));
	process.env.PI_CODING_AGENT_DIR = agent;
	// A 1x1 greyscale PNG is small enough to inline whole when it is not resized.
	const PNG = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACUlEQVR4nGIAAAACAAH6zsgUAAAAAElFTkSuQmCC",
		"base64",
	);
	try {
		writeFileSync(join(agent, "settings.json"), "{}");
		writeFileSync(join(root, "src", "pic.png"), PNG);
		const h = makeHarness({ cwd: root });

		// Resizing on: the built-in processes the image, so the bytes are not passed through.
		const resized = await runRead(h, { path: "src/pic.png" });
		assert.match(resized.content[0].text, /Read image file/, "the built-in handled the image");
		assert.notEqual(
			resized.content.find((c) => c.type === "image")?.data,
			PNG.toString("base64"),
			"with the default setting the image goes through the resize path",
		);

		// Resizing off, set globally the way pi reads it. The untouched bytes are the proof
		// that the setting reached the definition the guard built.
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ images: { autoResize: false } }));
		const untouched = await runRead(h, { path: "src/pic.png" });
		assert.equal(
			untouched.content.find((c) => c.type === "image")?.data,
			PNG.toString("base64"),
			"autoResize:false is honoured, so the image is returned unresized",
		);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
		rmSync(agent, { recursive: true, force: true });
	}
});

console.log(`\n${passed} passed, ${failures} failed`);
rmSync(isolatedAgentDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
