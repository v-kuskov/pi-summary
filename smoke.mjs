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
import { ensureSchema, openDb, readSummary, writeSummary } from "./src/store.ts";
import { readSettings } from "./src/settings.ts";
import { registerSummaryTool } from "./src/tools.ts";
import { parseJsonAnswer } from "./src/prompt.ts";
import { Value } from "typebox/value";
import {
	hasTopLevelShape,
	normalizeSections,
	MAX_NOTE_CHARS,
	summaryOutputSchema,
} from "./src/schema.ts";
import { renderMap } from "./src/render.ts";

/**
 * Isolation from the developer's own pi install.
 *
 * The extension reads its settings from `<projectRoot>/.pi/pi-summary.json` and, when that
 * says nothing, from `<agentDir>/pi-summary.json`. Left alone, the suite would depend on
 * whatever the machine running it happens to have configured: a `model` naming a model the
 * fake harness cannot resolve fails the summary. Point `<agentDir>` at an empty directory
 * before anything reads it, so every case starts from the same unconfigured state and only
 * the cases that write settings deliberately are affected. Cases that set `PI_CODING_AGENT_DIR`
 * themselves still win, since they assign it inside their own try block. The real-model suite
 * deliberately puts it back, because the provider it needs is registered by a package in the
 * developer's own install.
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

function tempProject() {
	const root = mkdtempSync(join(tmpdir(), "pi-summary-"));
	mkdirSync(join(root, ".git"), { recursive: true });
	mkdirSync(join(root, "src"), { recursive: true });
	return root;
}

/**
 * Write this extension's settings file into `dir` (a project root or an agent dir).
 *
 * Every settings case goes through this, so the file name and the directory convention live
 * in one place: a case that wrote `settings.json` by hand would be testing pi's file, not
 * ours, and would pass for the wrong reason.
 */
function writeSettings(dir, settings) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "pi-summary.json"), JSON.stringify(settings));
}

const numbered = (lines) =>
	Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

/**
 * A file with the shape of real code, for the cases that run a real model.
 *
 * `numbered` is what the fake harness is driven with: every line differs, so a map's rows are
 * checkable without the model. A real model needs something it has not been fitted to, and
 * what the cases then assert is structure - rows in range, in order, inside the file - rather
 * than a particular answer. Repetitive declarations keep the file's size predictable while
 * still giving the model something a line-numbered excerpt can be mapped as.
 */
function realClientSource(lines) {
	const parts = [
		"/** A small HTTP client for the internal Orders API. */",
		'import { createHmac } from "node:crypto";',
		"",
		"export type RetryPolicy = { attempts: number; baseDelayMs: number };",
		"",
		"const DEFAULT_POLICY: RetryPolicy = { attempts: 3, baseDelayMs: 50 };",
		"",
		"export class OrdersClient {",
		"\tconstructor(private readonly baseUrl: string, private readonly secret: string) {}",
		"",
		"\tprivate sign(body: string, nonce: string): string {",
		'\t\treturn createHmac("sha256", this.secret).update(`${nonce}.${body}`).digest("hex");',
		"\t}",
		"",
		"\tasync post(path: string, body: unknown): Promise<unknown> {",
		"\t\tconst payload = JSON.stringify(body);",
		"\t\tconst nonce = String(this.attempt++);",
		"\t\tconst response = await fetch(`${this.baseUrl}${path}`, {",
		'\t\t\tmethod: "POST",',
		'\t\t\theaders: { "content-type": "application/json", "x-signature": this.sign(payload, nonce) },',
		"\t\t\tbody: payload,",
		"\t\t});",
		"\t\tif (!response.ok) throw new OrdersError(response.status, await response.text());",
		"\t\treturn response.json();",
		"\t}",
		"",
		"\tattempt = 0;",
		"}",
		"",
		"export class OrdersError extends Error {",
		"\tconstructor(readonly status: number, readonly detail: string) {",
		'\t\tsuper(`Orders API ${status}: ${detail}`);',
		"\t}",
		"}",
		"",
	];
	// Pad with distinguishable declarations so the file reaches the requested size while every
	// region the model can name remains real code.
	let index = 0;
	while (parts.length < lines) {
		parts.push(
			`/** Handles ${index}. */`,
			`export function handler${index}(input: string): string {`,
			`\tconst trimmed = input.trim().toLowerCase();`,
			`\treturn trimmed.length > ${index} ? trimmed.slice(${index}) : trimmed;`,
			"}",
			"",
		);
		index++;
	}
	return parts.slice(0, lines).join("\n") + "\n";
}

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

await check("normalizeSections repairs missing and invalid importance to 2", async () => {
	// Importance is a free field the model may omit, mistype or fill with a stale number. None
	// of those is worth a repair call: the row is still a real region, so the reading that keeps
	// the most information is the middle tier. Only the three literals survive; everything else,
	// including a same-looking string, becomes 2.
	const rows = normalizeSections(
		[
			{ start_line: 1, end_line: 1, kind: "function", name: "a", note: "" },
			{ start_line: 2, end_line: 2, kind: "function", name: "b", note: "", importance: 3 },
			{ start_line: 3, end_line: 3, kind: "function", name: "c", note: "", importance: 1 },
			{ start_line: 4, end_line: 4, kind: "function", name: "d", note: "", importance: 0 },
			{ start_line: 5, end_line: 5, kind: "function", name: "e", note: "", importance: "3" },
			{ start_line: 6, end_line: 6, kind: "function", name: "f", note: "", importance: 4 },
		],
		10,
	);
	assert.deepEqual(
		rows.map((s) => s.importance),
		[2, 3, 1, 2, 2, 2],
		"a valid tier survives; a missing or nonsensical one is 2",
	);
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

await check("the settings file is read from the project, then the agent dir", async () => {
	const agent = mkdtempSync(join(tmpdir(), "pi-agent-"));
	const root = tempProject();
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agent;

		// Nothing anywhere means the documented default, which is what the extension did
		// before the file existed. This is the case every other settings case is measured
		// against, so it is asserted first.
		assert.deepEqual(readSettings(root), { model: undefined });

		writeSettings(agent, { model: "global/model" });
		assert.equal(readSettings(root).model, "global/model");

		writeSettings(join(root, ".pi"), { model: "project/model" });
		const merged = readSettings(root);
		assert.equal(merged.model, "project/model", "the project's model wins");

		// The settings are a file of this extension's own, not a key inside pi's settings.json.
		writeFileSync(
			join(root, ".pi", "settings.json"),
			JSON.stringify({ summary: { model: "pi-settings/model" } }),
		);
		assert.equal(readSettings(root).model, "project/model", "pi's settings.json is not consulted");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agent, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

await check("an unusable settings file falls back to the defaults rather than throwing", async () => {
	// Every one of these is a file a user can produce by editing. None may fail a summarize,
	// so each means "nothing configured at this scope" and the default decides.
	const agent = mkdtempSync(join(tmpdir(), "pi-agent-"));
	const root = tempProject();
	const previous = process.env.PI_CODING_AGENT_DIR;
	const defaults = { model: undefined };
	try {
		process.env.PI_CODING_AGENT_DIR = agent;
		mkdirSync(join(root, ".pi"), { recursive: true });

		for (const junk of ["{ not json", "[]", "\"a string\"", "null", "42"]) {
			writeFileSync(join(agent, "pi-summary.json"), junk);
			assert.deepEqual(readSettings(root), defaults, `junk file ${junk} ignored`);
		}

		// A key of the wrong type is ignored on its own, so the rest of the file still applies.
		for (const junk of [null, 42, [], {}, "", "   "]) {
			writeSettings(agent, { model: junk });
			assert.equal(readSettings(root).model, undefined, `junk model ${JSON.stringify(junk)} ignored`);
		}
		writeSettings(agent, { model: "  spaced/model  " });
		assert.equal(readSettings(root).model, "spaced/model", "a model is trimmed");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agent, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the model setting picks the summarizer, and model= overrides it", async () => {
	const agent = mkdtempSync(join(tmpdir(), "pi-agent-"));
	const root = tempProject();
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agent;
		writeSettings(agent, { model: "test/test-model" });
		writeFileSync(join(root, "src", "a.ts"), numbered(10));
		const h = makeHarness({ cwd: root });

		const result = await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(result.details.model, "test/test-model", "the configured model was used");

		// A present setting that names no known model is an error, not a silent substitution:
		// the setting exists to control what a summary costs, so spending the session model
		// instead would defeat it while looking like it was honoured. The file is still
		// readable, so the caller gets the file and the reason.
		writeSettings(agent, { model: "nope/missing" });
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
		writeFileSync(join(agent, "pi-summary.json"), JSON.stringify({}));
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
		// The section table as it looked before `importance`: no such column. This is the shape a
		// cache written by an earlier version really has, and the one the migration has to grow.
		old.exec(`CREATE TABLE file_section (
		  path TEXT NOT NULL, seq INTEGER NOT NULL, start_line INTEGER NOT NULL,
		  end_line INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, note TEXT NOT NULL,
		  PRIMARY KEY (path, seq)
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
		old.prepare("INSERT INTO file_section VALUES (?,?,?,?,?,?,?)").run(
			"src/old.ts",
			0,
			1,
			5,
			"function",
			"legacy()",
			"an old note",
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
		// The new column is added, and a row written without it reads as the middle tier rather
		// than NULL - that default is the whole migration, so a live cache keeps working.
		const sectionColumns = db.prepare("PRAGMA table_info(file_section)").all().map((c) => c.name);
		assert.ok(sectionColumns.includes("importance"), "the importance column is added");
		const legacy = readSummary(db, "src/old.ts");
		assert.equal(legacy.sections.length, 1, "the old row survives");
		assert.equal(legacy.sections[0].importance, 2, "a row with no importance reads as 2");
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
	// check for the SQLITE_BUSY bug above.
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
		assert.doesNotMatch(first.content[0].text, /cache:/, "cache state is internal, not model-facing");
		assert.match(first.content[0].text, /## map/);
		assert.match(first.content[0].text, /run\(\)/);
		assert.match(first.content[0].text, /401 lines/);

		const second = await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(h.calls.length, 1, "no second model call");
		assert.equal(second.details.status, "fresh");
		assert.doesNotMatch(second.content[0].text, /cache:/, "and a served cache says no more than a fresh one");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the structured result carries the summary and nothing else", async () => {
	// Scripts receive structuredContent instead of the text, so this is their whole view of
	// the tool: the file, its prose and its map. Generation history — model, cache state,
	// attempts, degradation — is internal and must not appear.
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(400));
		const h = makeHarness({ cwd: root });

		const first = await runTool(h, "summary", { path: "src/a.ts" });
		assert.ok(Value.Check(summaryOutputSchema, first.structuredContent), "matches the schema");
		const out = first.structuredContent;
		assert.equal(out.path, "src/a.ts", "the summary names the file");
		assert.equal(out.lines, first.details.lines, "and its length");
		assert.equal(out.overview, "Does a thing.", "the prose is there");
		assert.equal(out.sections.length, 1, "and the map rows");
		assert.equal(out.sections[0].startLine, 1, "from the first line");
		assert.equal(out.sections[0].endLine, out.lines, "to the last");
		assert.equal(out.sections[0].kind, "function", "with the row's fields");
		assert.ok(
			[1, 2, 3].includes(out.sections[0].importance),
			"and a valid importance tier",
		);
		for (const field of ["model", "status", "attempts", "degraded", "mode", "seq"]) {
			assert.equal(field in out, false, `${field} is generation history, not summary`);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("summary lines carry importance, and a missing one reads as 2", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(400));
		// The model returns a tier on every row here; one row deliberately omits it, and a row
		// with a value outside 1..3 is exercised in the units section. What matters at the tool
		// boundary is that every stored and emitted row has a valid tier.
		const h = makeHarness({
			cwd: root,
			respond: (context) =>
				jsonResponse({
					overview: "Two regions.",
					sections: [
						{ start_line: 1, end_line: 200, kind: "class", name: "A", note: "core", importance: 3 },
						{ start_line: 201, end_line: lastShownLine(context), kind: "function", name: "b", note: "glue" },
					],
				}),
		});

		const result = await runTool(h, "summary", { path: "src/a.ts" });
		assert.ok(Value.Check(summaryOutputSchema, result.structuredContent), "matches the schema");
		assert.deepEqual(
			result.structuredContent.sections.map((s) => s.importance),
			[3, 2],
			"a tier the model gave survives; an omitted one reads as 2",
		);
		for (const s of result.structuredContent.sections) {
			assert.ok([1, 2, 3].includes(s.importance), "every row's importance is a valid tier");
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("summary(path, region) returns the row and its numbered excerpt with no model call", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(400));
		const h = makeHarness({
			cwd: root,
			respond: (context) =>
				jsonResponse({
					overview: "Two regions.",
					sections: [
						{ start_line: 1, end_line: 10, kind: "class", name: "Widget", note: "holds state.", importance: 3 },
						{ start_line: 20, end_line: lastShownLine(context), kind: "function", name: "run()", note: "does it.", importance: 2 },
					],
				}),
		});

		// Layer 1 first, so there is a cache to drill into.
		await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(h.calls.length, 1, "the map cost one call");

		const byName = await runTool(h, "summary", { path: "src/a.ts", region: "Widget" });
		assert.equal(h.calls.length, 1, "the drill-down is served from cache, never a model call");
		assert.ok(Value.Check(summaryOutputSchema, byName.structuredContent), "matches the schema");
		assert.equal(byName.structuredContent.region.name, "Widget");
		assert.equal(byName.structuredContent.region.importance, 3, "the row's tier comes through");
		assert.equal(byName.structuredContent.region.startLine, 1);
		assert.equal(byName.structuredContent.region.endLine, 10);
		// The excerpt is numbered the same way the summarizer's input was, so a boundary can be
		// copied straight into a `read`.
		assert.match(byName.structuredContent.excerpt, /^\s*1\tline 1/m, "the excerpt is numbered from the region's start");
		assert.match(byName.structuredContent.excerpt, /^\s*10\tline 10/m);
		assert.doesNotMatch(byName.structuredContent.excerpt, /line 11/, "only the span is excerpted");

		// A line number inside another row's span finds that row, so a reader with a line in hand
		// does not have to find the name first.
		const byLine = await runTool(h, "summary", { path: "src/a.ts", region: "25" });
		assert.equal(h.calls.length, 1, "still no model call");
		assert.equal(byLine.structuredContent.region.name, "run()", "a line resolves to its containing row");

		// A name is matched case-insensitively, which is how a reader who typed it by eye lands.
		const byCase = await runTool(h, "summary", { path: "src/a.ts", region: "widget" });
		assert.equal(byCase.structuredContent.region.name, "Widget");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("an unknown region errors with the names that exist, and spends no call", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(400));
		const h = makeHarness({
			cwd: root,
			respond: (context) =>
				jsonResponse({
					overview: "Two regions.",
					sections: [
						{ start_line: 1, end_line: 10, kind: "class", name: "Widget", note: "", importance: 3 },
						{ start_line: 20, end_line: lastShownLine(context), kind: "function", name: "run()", note: "", importance: 2 },
					],
				}),
		});
		await runTool(h, "summary", { path: "src/a.ts" });
		assert.equal(h.calls.length, 1);

		// An unknown name, and a line in the gap between the two rows, are both misses.
		for (const region of ["Nope", "15"]) {
			await assert.rejects(
				() => runTool(h, "summary", { path: "src/a.ts", region }),
				/new region|no region/i,
				`region ${region} is a miss`,
			);
		}
		assert.equal(h.calls.length, 1, "a miss never runs a model, even though it could have mapped the file");

		// The error names what does exist, so the caller can pick a real region instead of guessing.
		try {
			await runTool(h, "summary", { path: "src/a.ts", region: "Nope" });
			assert.fail("an unknown region must reject");
		} catch (error) {
			assert.match(error.message, /Widget/);
			assert.match(error.message, /run\(\)/);
		}

		// A region asked for before the file was ever summarized points back at layer one rather
		// than summarizing on the caller's behalf.
		writeFileSync(join(root, "src", "b.ts"), numbered(10));
		await assert.rejects(
			() => runTool(h, "summary", { path: "src/b.ts", region: "anything" }),
			/no cached summary/,
		);
		assert.equal(h.calls.length, 1, "an uncached region lookup costs nothing");
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

await check("a prose-only answer is repaired twice, then the call fails", async () => {
	const root = tempProject();
	try {
		writeFileSync(join(root, "src", "a.ts"), numbered(400));
		const h = makeHarness({
			cwd: root,
			respond: () =>
				textResponse("This file implements the sync client and its retry loop."),
		});

		// The budget is spent and nothing validated: prose stored as a summary would claim a map
		// the model never gave, so the call fails and says so.
		await assert.rejects(
			() => runTool(h, "summary", { path: "src/a.ts" }),
			/never produced a usable answer/,
		);
		assert.equal(h.calls.length, MAX_ATTEMPTS, "spend is capped, not unbounded");

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

await check("a provider that fails every time fails the call and names the reason", async () => {
	const root = tempProject();
	try {
		const file = join(root, "src", "a.ts");
		writeFileSync(file, numbered(10));
		const h = makeHarness({
			cwd: root,
			respond: () => errorResponse("upstream exploded"),
		});

		// A failed model call is the tool's failure: the model asked for a summary and gets the
		// reason, not a file standing in for one.
		await assert.rejects(
			() => runTool(h, "summary", { path: "src/a.ts" }),
			/upstream exploded/,
		);
		assert.equal(h.calls.length, 2, "JSON mode is retried once, then it fails");
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

await check("concurrent cold calls for one file share a single summarization", async () => {
	// A model can ask for the same file several times in a single turn, and nothing about a
	// call serializes them. Each one used to summarize the file on its own, paying for a
	// model call per call - five cold calls for one file cost five model calls.
	const root = tempProject();
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agent = mkdtempSync(join(tmpdir(), "pi-agent-"));
	process.env.PI_CODING_AGENT_DIR = agent;
	try {
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
			Array.from({ length: 5 }, () => runTool(h, "summary", { path: "src/a.ts" })),
		);

		assert.equal(summarizerCalls, 1, "five concurrent cold calls share one summarization");
		for (const result of results) {
			assert.match(result.content[0].text, /Client/, "and every call got the map");
		}

		// The shared run is done, so this is the cache answering and not a stale join.
		assert.equal(h.calls.length, 1, "a later call costs nothing");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
		rmSync(agent, { recursive: true, force: true });
	}
});

await check("the summary description carries no trap wording", async () => {
	// The description is prompt surface: a model reads it and decides whether to spend a call.
	// It used to promise that an oversized `read` would be answered with the map. That read
	// replacement is gone, so any such claim would be a lie about what the tool does.
	const registered = new Map();
	registerSummaryTool({ registerTool: (def) => registered.set(def.name, def) });
	const description = registered.get("summary").description;

	for (const word of ["trap", "intercept", "guard", "lines per call"]) {
		assert.doesNotMatch(description, new RegExp(word, "i"), `the description does not claim "${word}"`);
	}
	// And it still says what the tool is for.
	assert.match(description, /line ranges/i);
	assert.match(description, /free from cache/i);
});

await check("a refresh neither joins nor is joined by a run in flight", async () => {
	// The dedupe map is published by ordinary calls only. A forced run must not join one:
	// it was asked to re-summarize, and inheriting an ordinary run's answer would return the
	// cached entry it exists to replace. Driven through `summary` because `refresh` is that
	// tool's parameter.
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

// ------------------------------------------------------------------ edit locator

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

/** A 253-line file, so the locator's line numbers are well clear of the end. */
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

// ------------------------------------------------------------------ renderers

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
		assert.doesNotMatch(collapsed, /cache:/, "cache state is internal and never drawn");
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

		// The model a file was summarized with is in the details for diagnosis, and in the
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
	// This tool throws when the model call failed, or when the file could not be read either.
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

await check("the map orders rows 3 then 2 then 1, and by line within a tier", async () => {
	// The tiers are the whole point of the field: a reader should meet the few regions that
	// matter first, whatever order they happen to sit in the file. Line order is preserved
	// inside a tier, so a tier still reads as a sequence down the file.
	const rows = normalizeSections(
		[
			{ start_line: 1, end_line: 5, kind: "function", name: "glue1", note: "", importance: 1 },
			{ start_line: 10, end_line: 20, kind: "function", name: "support", note: "", importance: 2 },
			{ start_line: 30, end_line: 40, kind: "class", name: "Core", note: "", importance: 3 },
			{ start_line: 50, end_line: 55, kind: "function", name: "glue2", note: "", importance: 1 },
			{ start_line: 60, end_line: 70, kind: "function", name: "Support2", note: "", importance: 2 },
			{ start_line: 80, end_line: 90, kind: "function", name: "Core2", note: "", importance: 3 },
		],
		100,
	);

	const map = renderMap(rows);
	const order = ["Core2", "support", "Support2", "glue1", "glue2"];
	const at = (token) => map.indexOf(token);

	// Tier 3 before tier 2 before tier 1.
	assert.ok(at("Core") < at("support"), "tier 3 comes before tier 2");
	assert.ok(at("support") < at("glue1"), "tier 2 comes before tier 1");
	// Line order inside a tier: the two 3s, then the two 2s, then the two 1s.
	assert.ok(at("Core") < at("Core2"), "tier 3 in line order");
	assert.ok(at("support") < at("Support2"), "tier 2 in line order");
	assert.ok(at("glue1") < at("glue2"), "tier 1 in line order");
	// Every row is present exactly once.
	for (const token of order) assert.notEqual(at(token), -1, `${token} is rendered`);
});

await check("tier 3 shows the note, tier 2 its first sentence, tier 1 the name alone", async () => {
	const three = "Loads the store. Retries on failure.";
	const two = "Balances an index. Also fixes the odd case.";
	// A tier-2 note with no sentence boundary must still be a single short phrase, so the whole
	// note is never what a `2` shows. 40 words with no full stop is longer than the cap.
	const noBoundary = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
	const rows = normalizeSections(
		[
			{ start_line: 1, end_line: 5, kind: "class", name: "Core", note: three, importance: 3 },
			{ start_line: 10, end_line: 20, kind: "function", name: "helper()", note: two, importance: 2 },
			{ start_line: 30, end_line: 30, kind: "function", name: "trivial()", note: "ignored", importance: 1 },
			{ start_line: 40, end_line: 40, kind: "function", name: "runon()", note: noBoundary, importance: 2 },
		],
		100,
	);

	const map = renderMap(rows);

	// Tier 3: the full note.
	assert.match(map, /1-\s*5\s+class\s+Core - Loads the store\. Retries on failure\./);

	// Tier 2: only the first sentence.
	assert.match(map, /10-\s*20\s+function\s+helper\(\) - Balances an index\./);
	assert.doesNotMatch(map, /Also fixes the odd case/, "the second sentence is not shown at tier 2");

	// Tier 2 with no boundary: a hard cap, marked as cut.
	const runonLine = map.split("\n").find((line) => line.includes("runon()"));
	assert.ok(runonLine, "the run-on row renders");
	assert.ok(runonLine.endsWith("…"), "the run-on is cut and the cut is marked");
	assert.doesNotMatch(runonLine, /word39/, "and the tail is gone, so the whole note is not shown");

	// Tier 1: the name and span only - no kind, no note.
	assert.match(map, /30-\s*30\s+trivial\(\)/);
	assert.doesNotMatch(map, /trivial\(\)[^\n]*ignored/, "a tier-1 note is never shown");
	assert.doesNotMatch(map, /30-\s*30\s+function/, "a tier-1 row carries no kind column");
});

await check("a row stored before importance existed renders as tier 2", async () => {
	// The map is derived from rows, and an old cache has rows with no importance. Rather than a
	// migration rewriting them, the reader treats a missing value as 2, so an existing summary
	// keeps working and renders in the middle tier.
	const rows = normalizeSections(
		[
			{ start_line: 1, end_line: 5, kind: "class", name: "Legacy", note: "kept whole. second sentence." },
		],
		10,
	);
	assert.equal(rows[0].importance, 2, "a row without the field reads as 2");
	const map = renderMap(rows);
	assert.match(map, /1-\s*5\s+class\s+Legacy - kept whole\./, "rendered as a tier-2 row");
	assert.doesNotMatch(map, /second sentence/, "with only the first sentence shown");
});

// ------------------------------------------------------------------ real model
/**
 * The model the end-to-end cases summarize with, and the only one they may use.
 *
 * The fake harness above proves the wiring; it cannot prove that a real model returns
 * something this extension accepts, or that a configured model is the one actually billed.
 * These cases close that gap, and they are the reason the suite has a flag at all: they
 * spend real tokens against a real provider.
 */
const LLM_MODEL = "routerai/deepseek/deepseek-v4.1-flash";

/**
 * Run the end-to-end cases only when asked, because they cost money and need credentials.
 *
 * `node smoke.mjs --llm`. Without the flag the suite stays hermetic, which is what
 * `npm run check` must be: a gate that cannot pass on a machine with no API key is not a gate.
 */
const runLlm = process.argv.includes("--llm");

if (runLlm) {
	// The real provider catalogue is registered by the developer's own install, so the isolated
	// `<agentDir>` is put aside for exactly as long as it takes to build the services. Settings
	// are then read from the isolated dir again, which keeps these cases independent of whatever
	// `pi-summary.json` the developer has and does not weaken the assertions below: every value
	// under test is written into the temp project's own `.pi`.
	const { ModelRegistry, createAgentSessionServices, getAgentDir } = await import(
		"@earendil-works/pi-coding-agent"
	);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	let services;
	try {
		delete process.env.PI_CODING_AGENT_DIR;
		services = await createAgentSessionServices({
			cwd: tempProject(),
			agentDir: getAgentDir(),
		});
	} finally {
		process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}

	// The extension talks to a `ModelRegistry` - `find`, `hasConfiguredAuth`, `complete` - and
	// the services hand back the `ModelRuntime` underneath it, so the facade is rebuilt here.
	// That is exactly what a session does, which is why the end-to-end cases are a session's
	// path rather than the fake harness's.
	const registry = new ModelRegistry(services.modelRuntime);
	const llmModel = registry.find("routerai", "deepseek/deepseek-v4.1-flash");
	if (!llmModel) {
		console.log(`\nSKIP real-model cases: ${LLM_MODEL} is not in the model catalogue`);
	}

	/**
	 * A harness wired to the real registry: every completion reaches the provider.
	 *
	 * The registry is wrapped rather than replaced so the extension calls exactly what it would
	 * in a session - auth resolution, provider composition and all - while the cases still get
	 * to see which model each call named. That is the only way to tell "the setting was honoured"
	 * from "the request happened to look the same".
	 */
	function makeLlmHarness(options = {}) {
		const tools = new Map();
		const handlers = [];
		const calls = [];
		const registryWithCalls = new Proxy(registry, {
			get(target, property, receiver) {
				if (property === "complete") {
					return async (model, context, opts) => {
						calls.push({ model, context, opts });
						return target.complete(model, context, opts);
					};
				}
				const value = Reflect.get(target, property, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});

		extensionFactory({ registerTool: (def) => tools.set(def.name, def), on: (e, h) => handlers.push({ event: e, handler: h }) });

		const ctx = {
			cwd: options.cwd,
			mode: "json",
			hasUI: false,
			model: llmModel,
			modelRegistry: registryWithCalls,
		};
		return { tools, handlers, calls, ctx };
	}

	await check("the real summarizer maps a real file", async () => {
		if (!llmModel) return;
		const root = tempProject();
		try {
			// Real code, not "line N": the point is to see what a real model does with the prompt
			// against a file it has no fixture-shaped answers for.
			writeFileSync(join(root, "src", "client.ts"), realClientSource(360));
			const h = makeLlmHarness({ cwd: root });

			const result = await runTool(h, "summary", { path: "src/client.ts" });
			assert.equal(result.details.status, "miss");
			// Not "exactly one attempt": whether the first answer validates is the model's business,
			// and it is not stable run to run. What the extension guarantees is the budget - at most
			// MAX_ATTEMPTS calls - and that a usable map came back within it.
			assert.ok(result.details.attempts >= 1, "at least one call was made");
			assert.ok(
				result.details.attempts <= MAX_ATTEMPTS,
				`${MAX_ATTEMPTS} attempts at most, took ${result.details.attempts}`,
			);
			assert.equal(result.details.degraded, false, "and it mapped the file rather than degrading");
			assert.ok(result.details.sections > 0, "there is a map to read");
			assert.match(result.content[0].text, /## map/);
			assert.equal(result.details.model, LLM_MODEL, "the model that ran is the one named");

			// Every stored row has to be inside the file, or the map sends the model past the end.
			// The bounds come from the result rather than the fixture, so the assertion is about
			// the map and not about how this fixture happens to count lines.
			assert.ok(
				Value.Check(summaryOutputSchema, result.structuredContent),
				"the real answer matches the output schema a script receives",
			);
			const sections = result.structuredContent.sections;
			const total = result.structuredContent.lines;
			assert.ok(sections.length > 0);
			for (const s of sections) {
				assert.ok(s.startLine >= 1, `row ${s.name} starts at ${s.startLine}`);
				assert.ok(s.endLine <= total, `row ${s.name} ends at ${s.endLine}, file is ${total}`);
				assert.ok(s.startLine <= s.endLine, `row ${s.name} is not reversed`);
				// The tier is whatever the model judged, but it must be one of the three the schema
				// and the renderer understand - a real answer is the place that is checked.
				assert.ok(
					[1, 2, 3].includes(s.importance),
					`row ${s.name} has a valid importance, got ${s.importance}`,
				);
			}
			// Rows are stored in line order and never overlap, which is what makes the rendered
			// map readable as a sequence of regions rather than a pile of claims.
			for (let i = 1; i < sections.length; i++) {
				assert.ok(
					sections[i].startLine > sections[i - 1].endLine,
					`row ${i} starts after row ${i - 1} ends`,
				);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	await check("an absent model setting summarizes with the session's own model", async () => {
		if (!llmModel) return;
		const root = tempProject();
		try {
			writeFileSync(join(root, "src", "client.ts"), realClientSource(80));
			const h = makeLlmHarness({ cwd: root });

			// No settings file at all: the documented default is the model the session is using,
			// which is the one this harness hands the context.
			assert.equal(readSettings(root).model, undefined);
			const result = await runTool(h, "summary", { path: "src/client.ts" });
			assert.equal(result.details.model, LLM_MODEL, "the session model was used");
			assert.ok(h.calls.length >= 1, "and it was really called");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	await check("an unusable model setting is reported, not silently substituted", async () => {
		if (!llmModel) return;
		const root = tempProject();
		try {
			writeFileSync(join(root, "src", "client.ts"), realClientSource(80));
			writeSettings(join(root, ".pi"), { model: "routerai/definitely-not-a-model" });
			const h = makeLlmHarness({ cwd: root });

			const result = await runTool(h, "summary", { path: "src/client.ts" });
			assert.equal(result.details.status, "failed");
			assert.match(result.content[0].text, /definitely-not-a-model/);
			assert.match(result.content[0].text, /names no known model/);
			assert.equal(h.calls.length, 0, "and nothing was billed to a model nobody chose");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

console.log(`\n${passed} passed, ${failures} failed`);
rmSync(isolatedAgentDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
