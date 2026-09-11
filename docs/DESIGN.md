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

`C2` The read guard — zero model calls when a fresh summary is cached. When the file was
never summarized (or the entry is stale) it **summarizes the file and inlines the map**, so
an oversized `read` is answered with a map instead of a dead end. That means a cold
oversized `read` spends up to three model calls without the caller naming the file to
`summary`. This is the extension's one unannounced spend, and it is bounded by the same
`MAX_ATTEMPTS` ceiling. The reason always says which happened: `generated for this read`
versus `Cached summary of this file`.

Rejected: search-across-cached-summaries and project-wide refresh. Both are unbounded
fan-out driven by caller text; both were built and removed.

## 4. Storage

SQLite at `<projectRoot>/.pi/summaries.db`, project root found by walking up for
`.git`, WAL, opened per call (no long-lived handle, so parallel tool calls are safe).

```sql
CREATE TABLE file_summary (
  path          TEXT PRIMARY KEY,  -- relative to root, forward slashes, lowercased on win32
  abs_path      TEXT NOT NULL,     -- for change detection after cwd changes
  hash          TEXT NOT NULL,     -- sha256 of contents, first 16 hex chars
  lines         INTEGER NOT NULL,  -- line count at summarize time (drives the guard)
  bytes         INTEGER NOT NULL,
  model         TEXT NOT NULL,     -- "routeai/deepseek/deepseek-v4.1-flash"
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

`F1a` There is no `covered_lines` column. A summary is `overview` plus rows, and rows may
leave gaps where the model judged lines to be dead. The whole file is always sent (`S6`),
so there is no "how far did it get" figure to record, and a gap is visible in the rendered
map as a `skipped` row rather than as a number nobody checks.

`F2` `file_section` is derived: it is written only in the same transaction as
`file_summary`, and is only consulted for paths whose stored `hash` still matches the
file on disk. A rewritten file cannot serve a stale line range.

`F3` `file_section` carries the line map in queryable form rather than as pre-rendered
text. That is what lets the guard answer "what is at line 1200?" with the entry's own
rows instead of parsing prose.

## 5. Freshness

`F4` Cache validity is content-addressed: `sha256(file)`. `bytes` is a cheap pre-check that
can only return `stale` early — a size mismatch is conclusive, and the hash decides every
other case.

Nothing cheaper than the hash is trusted, and nothing cheaper is stored: there is no `mtime`
column. An earlier version stored one and treated a matching `mtime` as proof of an unchanged
file, skipping the hash; that is wrong, and it was reproduced serving a stale map: an edit of
the same length landing in the same millisecond, a `cp -p`/`touch -r` restoring a timestamp,
and volumes with coarse mtime resolution all produce a matching `mtime` over different
content. Hashing one file is cheap next to the model call the shortcut was trying to avoid,
so both the shortcut and the column are gone. A database from that version is migrated by
`ensureSchema`, which drops the column — `CREATE TABLE IF NOT EXISTS` would otherwise leave
it in place as `NOT NULL` and fail every insert.

`F5` `summary(path)` on a stale entry re-summarizes and replaces, and says so. The
caller never has to know the difference; asking for a summary always returns a summary
of the current file.

## 6. `summary` output contract

```
# src/foo.ts  (1420 lines, 48.2KB, sha 9f2c1ab4)
cache: miss
model: routeai/deepseek/deepseek-v4.1-flash

<overview prose>

## map
   1-  24  import   node/fs, node/path; module constants
  25-  25  skipped  (nothing to map)
  26- 140  class    FooClient - HTTP transport with retry
 141- 620  method   FooClient.request() - builds, signs, sends
 621-1420  method   FooClient.retry() - backoff and jitter

# read src/foo.ts with offset/limit inside one range above (max 200 lines per call).
```

`cache:` reads `fresh` (served from cache), `miss` (nothing was cached), `forced`
(explicit refresh), or `stale` (the file changed and was re-summarized).

Unclaimed line ranges are rendered as `skipped` rows, so the map accounts for every line
of the file. A gap means the summarizer judged those lines to do nothing — blank lines, a
license header, generated boilerplate — which is what the prompt asks for (`S2`). Rendering
the gap explicitly means the caller does not have to notice a jump in the numbers to know a
range is unmapped.

`O1` The map is rendered as text, never as JSON. The model's JSON is validated and stored,
then re-rendered into this form on every read; the JSON never reaches the model. Rows are
`start-end  kind  name - note`, numbers right-aligned, so the ranges line up for scanning
without the model having to parse anything.

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

Verified against the built-in tool: `read(offset=1000, limit=200)` on a 3000-line file
returns lines 1000-1199, followed by `[1802 more lines in file. Use offset=1200 to
continue.]`. Content is returned from the requested offset; a guarded file is never
replaced by the map. The guard's 200-line figure is its own limit, not the built-in
tool's - the built-in caps at 2000 lines / 50KB, which is why an allowed read of a large
file still comes back truncated (`G6`).

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

`G4` The block reason carries the whole summary, uncapped, and closes with a concrete
suggested call. Because the line counter stops early (`G2`), the reason can only say "more
than 200 lines, starting at line N" — it never names an exact span, since computing one would
mean counting a file the guard deliberately avoids counting. It labels the map as cached or
just generated.

The cap that used to be here — 6000 chars, applied twice, once inside the renderer and again
over the composed reason — was worse than the problem it solved. Truncation kept the *first*
rows of the map, so what the model received was contiguous and therefore indistinguishable
from a complete map, while the trailing read hint was always dropped. It cut the map for a
150-row file, and the 1396-line file in the benchmark produces 150 rows. A model blocked
precisely because it needs a map should not be handed a plausible partial one.

`G5` The guard is implemented with `pi.on("tool_call")`, not by overriding the `read`
tool. A second `read` registration would replace the built-in renderer and any other
extension's `read` override; the event handler composes with both. It also means the
guard runs without patching args, so nothing about the model's own call is rewritten
behind its back.

`G6` A failed summary **allows the read through** instead of blocking it. Blocking a read
because the summarizer broke would deny the model a file it is entitled to see, and the
file is a better answer than nothing. The failure is reported as a notification and, since
a notification does not exist in print or RPC runs, appended to the read result through a
`tool_result` handler keyed by tool call id. The read keeps the built-in 2000-line cap, so
a large file is returned truncated rather than in full.

`G7` The guard never turns a failure into a raised error. `summary` failing is recoverable
by definition - the file is still there - so the read path always produces a result.

The guard's own file access is guarded for the same reason. It stats the file, then opens it
to look for binary content and again to count lines; the file can vanish or lose read
permission in between - an editor rewriting it, a delete, an ACL change - and an unguarded
`open` would reject and fail the *read* because the guard could not do its job. Both probes
are wrapped, and a failure falls through to the built-in tool.

## 8. Summarization call

`S1` Model resolution order: explicit `model` argument → the `summary.model` setting → the
session's current model (`ctx.model`) → fail with an error naming what is unavailable.

The placeholders `current`, `default`, `auto`, `session`, `none`, `null` are treated as
"use the session model", because a model asked for a summarizer by name will happily send
the literal string. Auth is checked with `hasConfiguredAuth` before the call, so a missing
credential produces a clear message instead of a provider error.

The setting is read from pi's own settings through `SettingsManager.create(cwd)`, checking
project scope first so a project can pin its own summarizer:

```json
{ "summary": { "model": "routeai/deepseek/deepseek-v4.1-flash" } }
```

Global settings come from `<agentDir>/settings.json`, project settings from
`<cwd>/.pi/settings.json`. A bare string (`"summary": "provider/model"`) is also accepted.
pi's `Settings` interface has no field for extension config, but the file is not filtered:
unknown top-level keys survive load and write, which is what makes this safe. A setting that
names an unknown model, is malformed, or sits in an unparseable file is skipped in favour of
the session model rather than thrown — an unreadable config should not make the tool
unusable.

`S2` **The call requests structured output as JSON, with no tools.** The prompt states the
contract in prose and the answer is validated locally against a flat schema whose shape is
exactly what the database stores:

```ts
{ overview: string,   // up to 10 sentences
  sections: Array<{ start_line: integer, end_line: integer,
                    kind: enum, name: string, note: string }>  // note: up to 2 sentences / 200 chars }
```

The excerpt is **line-numbered** — every line is prefixed with its own number in a fixed
width column — and the prompt tells the model to copy numbers out of that column rather
than count lines. This is the fix for the one measured failure mode: with raw unnumbered
text, `qwen3.8-flash` extrapolated a spacing rule and drifted a mean of 24 lines (max 68)
on a 1396-line file, while `deepseek-v4.1-flash` counted accurately. Numbering turns a
counting task into a copying task. See `S6`.

`sections` may **leave gaps**: the prompt asks the model to skip runs of lines that do
nothing (blank lines, license headers, generated boilerplate) rather than invent a region
to cover them. Rows must not overlap; overlaps are trimmed locally (`E2`). Notes and the
overview are cut at `MAX_NOTE_CHARS = 200` and `MAX_OVERVIEW_CHARS = 2400` on the way into
storage, so one runaway field cannot crowd the map out of a read-block reason.

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
**normalized, not rejected**: line ranges are clamped to the file's length, reversed ranges
collapse to one line, `kind` is lowercased, rows with a non-numeric or out-of-range start
are dropped, and **overlapping rows are trimmed** so the earlier row ends one line before
the later one begins (a container row emitted alongside its contents is cut back to the
lines before its first child; a fully shadowed row is dropped). Spending a model call to
correct arithmetic is a worse trade than clamping it, and the trim is deterministic —
verified by test that an overlapping answer still costs exactly one call. Notes over
`MAX_NOTE_CHARS` are cut at a word boundary with an ellipsis.

Gaps are **preserved, never filled**. A jump in the line numbers is the model declining to
map dead lines, which is what the prompt asks for; filling it would invent a region and
reporting it would spend a repair call asking the model to map blank lines it was told to
skip.

`E3` **A valid envelope that normalizes to zero rows is accepted as a blob immediately.**
An empty `sections` array is the model's answer, not a mistake, so it is not argued with.

`E4` **Repair fires only on malformed output** — an answer that is not JSON, or that is JSON
without `overview: string` and `sections: array`. The model's own answer is resent as its
turn, followed by the specific violations from typebox
(`/sections/0/start_line Expected integer`). This is a fix-up loop over a single prompt —
the summarizer never chooses what to do next and is never given tools.

**Nothing validates the map's content.** Structure and schema are checked; correctness is
not. A contiguous, well-formed map can still name the wrong lines — measured directly:
`qwen3.8-flash` produced a perfectly contiguous map with zero gaps and zero overlaps that
drifted a mean of 24 lines. `S2`'s numbering addresses the cause, but no local check
detects a drift, because the only thing that can is comparing against the source.

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

`S6` **The whole file is sent, with no line or byte cap.** An earlier version capped the
excerpt at 4000 lines / 160 KB and sent raw text; both are gone. The summarizer models in
use have a 1M-token context, and a partial map is close to useless — the cache holds one
entry per file, so a tail left unmapped can never be filled in without re-reading the file
anyway. A file too large for the configured model's context is rejected by the provider,
which surfaces as an ordinary summarizer error (`G`).

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

`D6` The read guard summarizes a file it has no fresh summary for, so an oversized `read`
always comes back with a map. This overrides the earlier "the guard never calls a model"
rule: the user asked for the guard to create the summary rather than return an error. The
cost is bounded by `D5`'s ceiling, and the block reason states whether the map was cached
or just generated.

`D7` The summarizer model is configurable through a `summary.model` key in pi's settings
file, project scope winning over global, defaulting to the session model.

`D8` A failed `summary` call returns the whole file rather than raising an error, with the
failure in a notification and in a `#` comment above the content. The caller asked for the
file's contents and got them, so there is nothing to recover from. A path that cannot be
read at all stays a hard error, because a fallback there would mean returning an empty
body and hiding the real problem. The same rule applies to a bad `model` argument: it is a
caller mistake, the file is still readable, so the model gets the file and the mistake is
shown.

`D9` The whole file is sent to the summarizer, with no line or byte cap. The models in use
have a 1M-token context, and the cache holds one entry per file, so a partially mapped file
could never be completed without re-reading it. The earlier 4000-line / 160 KB cap and its
`rest (not summarized)` row are gone.

`D10` Gaps in the map are legal and meaningful. The prompt asks the model to skip lines
that do nothing; the validator no longer reports them; the renderer shows them as `skipped`
rows. The earlier "rows must tile the file" rule was replaced because it spent model calls
asking the model to map blank lines it had been told to skip.

`D11` `overview` may run to about ten sentences and a note to two sentences / 200
characters — deliberately looser than the original one-to-three-sentence overview and
90-character note, which were too tight to say anything about how a region is used. Both
are cut on the way into storage (`MAX_OVERVIEW_CHARS = 2400`, `MAX_NOTE_CHARS = 200`) so a
single runaway field cannot crowd the map out of the read-block reason.

`D12` The excerpt is line-numbered and the prompt says to copy numbers out of the left
column rather than count lines. This is the response to a measured failure: given raw
unnumbered text, `qwen3.8-flash` invented a spacing rule and drifted a mean of 24 lines on
a 1396-line file, while `deepseek-v4.1-flash` counted accurately. Numbering converts a
counting task into a copying task.

`D13` The two `PRAGMA` statements in `openDb` are ordered `busy_timeout` before
`journal_mode`, and the order is load-bearing. Switching journal mode takes an exclusive
lock; with the default zero timeout a second process opening the same cache fails
immediately with `SQLITE_BUSY` instead of waiting. Measured with 12 concurrent writers:
the original order lost a row in 4 of 6 runs, the corrected order in 0 of 6.
