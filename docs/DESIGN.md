# pi-summary — design

An extension that turns "read a big file into context" into "read a cached summary,
then read only the lines that matter".

## 1. The problem

`read` sends whole files to the model. On a 1400-line file that is ~15k tokens for
information the model mostly does not need, and the model has no way to know which
part of the file holds what before paying for all of it.

## 2. Two mechanisms

`M1` **`summary` tool** — one model call per file, cached. Returns what the file does
plus a line map: which region holds which declaration.

`M2` **`read` guard** — `tool_call` handler on `read`. Blocks a call whose line span
exceeds 200, and puts the cached summary into the block reason, so the block is not a
dead end: it is the map the model needed.

Neither mechanism depends on the other. `M1` alone saves tokens on deliberate use.
`M2` alone forces the model to work in ranges. Together, `M2` teaches and `M1` pays.

## 3. Cost filter

The dominant cost in this domain is **model calls**, not SQLite reads. So:

> A tool call must either be a pure cache read, or spend model calls on files the
> caller named explicitly. No implicit fan-out.

`C1` `summary(path)` — zero model calls on a fresh hit. On a miss or stale it spends **one
call normally, at most three** if the model's answer fails validation and has to be
repaired (§9 `E5`). The retry cap exists so this stays a bounded cost rather than an
unbounded loop.

`C2` The read guard — zero model calls, always. It reads the cache and otherwise only
counts lines in a file. A guard that could summarize would turn one oversized `read`
into an unannounced model call, which is the fan-out this filter forbids.

Rejected: search-across-cached-summaries and project-wide refresh. Both are unbounded
fan-out driven by caller text; both were built and removed. Also rejected: having the
guard auto-summarize the file it blocked.

## 4. Storage

SQLite at `<projectRoot>/.pi/summaries.db`, project root found by walking up for
`.git`, WAL, opened per call (no long-lived handle, so parallel tool calls are safe).

```sql
CREATE TABLE file_summary (
  path          TEXT PRIMARY KEY,  -- relative to root, forward slashes, lowercased on win32
  abs_path      TEXT NOT NULL,     -- for change detection after cwd changes
  hash          TEXT NOT NULL,     -- sha256 of contents, first 16 hex chars
  lines         INTEGER NOT NULL,  -- line count at summarize time (drives the guard)
  covered_lines INTEGER NOT NULL,  -- how far the map reaches; < lines means partial
  bytes         INTEGER NOT NULL,
  mtime_ms      INTEGER NOT NULL,
  model         TEXT NOT NULL,     -- "deepseek/deepseek-v4-flash"
  mode          TEXT NOT NULL,     -- 'mapped' | 'blob'
  overview      TEXT NOT NULL,     -- prose: what the file does
  created_at    TEXT NOT NULL
);

CREATE TABLE file_section (
  path       TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  kind       TEXT NOT NULL,      -- import | class | function | method | type | ...
  name       TEXT NOT NULL,
  note       TEXT NOT NULL,
  PRIMARY KEY (path, seq)
);
```

`F1` There is no stored blob and no stored rendered map. A summary *is* `overview` plus
its rows in `file_section`, and the map text is rendered from those rows on every read.
One source of truth, so the prose and the map cannot disagree; a cache hit is two
SELECTs and a string join.

`F1a` `covered_lines` records how far the map reaches. It is below `lines` only when the
file was too big to send whole, and it is what stops the tool from implying it mapped
code it never saw.

`F2` `file_section` is derived: it is written only in the same transaction as
`file_summary`, and is only consulted for paths whose stored `hash` still matches the
file on disk. A rewritten file cannot serve a stale line range.

`F3` `file_section` carries the line map in queryable form rather than as pre-rendered
text. That is what lets the guard answer "what is at line 1200?" with the entry's own
rows instead of parsing prose.

## 5. Freshness

`F4` Cache validity is content-addressed: `sha256(file)`. `mtime` and `bytes` are stored
as a cheap pre-check but never trusted alone — a file rewritten within the same mtime
tick still invalidates on hash. The pre-check exists because hashing is I/O the guard
would otherwise pay on every `read`; the hash is what makes the answer correct.

`F5` `summary(path)` on a stale entry re-summarizes and replaces, and says so. The
caller never has to know the difference; asking for a summary always returns a summary
of the current file.

## 6. `summary` output contract

```
# src/foo.ts  (1420 lines, 48.2KB, sha 9f2c1ab4)
cache: miss
model: deepseek/deepseek-v4-flash

<overview prose>

## map
   1-  24  import   node/fs, node/path; module constants
  25- 140  class    FooClient - HTTP transport with retry
 141- 620  method   FooClient.request() - builds, signs, sends
 621-1420  method   FooClient.retry() - backoff and jitter

# read src/foo.ts with offset/limit inside one range (max 200 lines per call).
```

`cache:` reads `fresh` (served from cache), `miss` (nothing was cached), `forced`
(explicit refresh), or `stale` (the file changed and was re-summarized).

A file larger than the summarizer's input window is truncated before sending, and the
map says so with a `rest (not summarized)` row covering the tail, so a range is never
implied to have been seen when it was not.

## 7. The `read` guard

`G1` Span, not file size, is the test. A read is allowed when the lines it would
return number 200 or fewer:

```
span = min(limit ?? Infinity, totalLines - offset + 1)
```

So `read(big-file)` is blocked, `read(big-file, offset=141, limit=200)` is allowed,
`read(small-file)` is allowed, and `read(big-file, offset=1400, limit=10)` is allowed.
A call already carrying a small `limit` is never blocked, so the guard does not fight a
model that is reading properly.

`G2` Counting lines is bounded. The guard only needs to know whether more than 200
lines remain from `offset`, so it streams the file in 64KB chunks and stops counting
once it has passed `offset + 200`. It never reads a large file fully into memory, and
it reads at most `offset + 200` lines regardless of file size. When it hits the budget
it returns `stopAfter + 1` as a sentinel, which is why the block reason says "more than
200 lines" rather than naming an exact count it never computed.

`G3` Non-text files are not guarded. Binary and image reads are already governed by the
built-in byte cap and by `autoResizeImages`; a 200-line limit on a PNG is meaningless.
The guard skips anything that is not a regular file, and skips content with a NUL byte
in the first 8000.

`G4` The block reason carries the cached summary when one is fresh, truncated to 4000
chars so the error result stays small, and closes with a concrete suggested call. When
there is no fresh summary the reason says to call `summary` first. Either way the reason
names the exact span that triggered the block and the range to ask for instead.

`G5` The guard is implemented with `pi.on("tool_call")`, not by overriding the `read`
tool. A second `read` registration would replace the built-in renderer and any other
extension's `read` override; the event handler composes with both. It also means the
guard runs without patching args, so nothing about the model's own call is rewritten
behind its back.

## 8. Summarization call

`S1` Model resolution order: explicit `model` argument → the session's current model
(`ctx.model`) → fail with an error naming what is unavailable. The placeholders
`current`, `default`, `auto`, `session`, `none`, `null` are treated as "use the session
model", because a model asked for a summarizer by name will happily send the literal
string. Auth is checked with `hasConfiguredAuth` before the call, so a missing
credential produces a clear message instead of a provider error.

`S2` **The call requests structured output as JSON, with no tools.** The prompt states the
contract in prose and the answer is validated locally against a flat schema whose shape is
exactly what the database stores:

```ts
{ overview: string,
  sections: Array<{ start_line: integer, end_line: integer,
                    kind: enum, name: string, note: string }> }
```

No `tools` array is sent to the summarizer, and it is never given tools to call. JSON mode
is attempted opportunistically through `samplingParams:{response_format:{type:"json_object"}}`,
which `openai-completions.js` applies last, after `tools`, so it reaches the wire on
providers that support it. `response_format` is not a typed field on `StreamOptions` — it
rides the same untyped `samplingParams` escape hatch the code already used for
`tool_choice`, and it is only a hint: it guarantees valid JSON, never a valid summary.
That is why validation is not optional here.

`S2a` Strict schema mode is deliberately not used. pi only reaches a provider's strict
JSON-schema enforcement *through* a tool (`resolveJsonSchemaStrictSampling` reads
`tool.constrainedSampling`), and strict mode additionally rejects `$ref`, `allOf`,
`oneOf`, and object unions. Dropping tools therefore trades grammar-level enforcement for
uniformity across providers, and the repair loop below replaces it.

`S3` The call's `Usage` is returned as the tool's `usage`, so nested tokens are counted
in session totals rather than hidden.

## 9. Validation and repair

`E1` The answer is parsed as JSON. A markdown fence or surrounding prose is tolerated
(`parseJsonAnswer` tries the whole string, then the outermost `{…}` span) — that costs
nothing to accept locally and is not worth a model call to fix.

`E2` The payload must have `overview: string` and `sections: array` (`hasTopLevelShape`).
Anything else is malformed and triggers a repair. Rows inside a well-shaped payload are
**normalized, not rejected**: line ranges are clamped to the lines actually shown,
reversed ranges collapse to one line, `kind` is lowercased, and rows with a non-numeric or
out-of-range start are dropped. Spending a model call to correct arithmetic is a worse
trade than clamping it.

`E3` **A valid envelope that normalizes to zero rows is accepted as a blob immediately.**
An empty `sections` array is the model's answer, not a mistake, so it is not argued with.

`E4` **Repair.** On malformed output the model's own answer is resent as its turn, followed
by the specific violations from typebox (`/sections/0/start_line: Expected integer`).
This is a fix-up loop over a single prompt — the summarizer never chooses what to do next
and is never given tools.

`E5` **The loop is bounded at `MAX_ATTEMPTS = 3`** total model calls: one plus at most two
repairs. The extension's cost filter promises a single call per file, so the ceiling is
the only reason a loop can exist at all. A model that cannot produce the shape in three
tries will not produce it in ten.

`E6` When the cap runs out the answer is salvaged as **prose** — `extractOverview` pulls the
`overview` field out of a truncated object, or the fences are stripped from a plain
answer — and stored with **zero section rows** and `mode = 'blob'`.

`E7` A **provider** error is treated differently from bad output, because it is not the
model's fault. A rejected `response_format` is retried once without it; a persistent
provider error fails the tool call rather than storing garbage. The retry consumes an
attempt so the ceiling holds even when a provider rejects JSON mode every time.

`S4` Blob is a deliberate degradation, not a fabricated map. An earlier draft wrote one
section spanning the whole file when parsing failed; that is worse than no map, because
the model cannot tell a real "lines 1-1420 is one region" claim from a parsing failure
and would trust it. A blob entry says so plainly:

```
# src/foo.ts  (1420 lines, 48.2KB, sha 9f2c1ab4)
map: none - summarized as a single blob, so there is no line detail
<overview prose>
# read src/foo.ts in ranges (max 200 lines per call), or grep it for a symbol.
```

`S5` The mode is visible everywhere the entry is used — in `summary` output, in the
guard's block reason, and in the rendered `## map` block — so the model can tell what to
trust. A blob entry still satisfies the guard's block reason, but it tells the model to
grep or read in ranges instead of pretending to know where anything is.

## 10. Decisions taken

`D1` Storage: prose overview plus derived section rows. No stored blob, no stored
rendered map, no FTS index.

`D2` `read` guard blocks oversized spans and inlines the cached summary in the reason.

`D3` Delivered as a publishable pi package: `package.json` with `pi.extensions`,
`pi-package`/`pi-extension` keywords, README, tsconfig, and a `smoke.mjs` that drives
the real tools with a fake extension API.

`D4` Tools shipped: `summary`, plus the `read` guard. The search, list, forget and
refresh tools were built, then removed — each was a cache read that the ordinary
`summary` + `read` path already covers, and `summary_search` was the one that pushed
toward fan-out.

`D5` The summarizer is called as a plain completion with **no tools**. The output contract
is JSON described in the prompt, validated locally with typebox, and repaired by resending
the model's own answer with the specific violations — bounded at three calls. A malformed
answer that survives all three attempts is stored as prose with `mode = 'blob'` rather
than failing the call or fabricating a map.
