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

`M2` **`read` guard** — a replacement for the built-in `read` tool. A call whose line
span exceeds 200 is answered with the file's summary, so the model gets the map instead of a
dead end. A call within the limit is returned exactly as asked.

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
never summarized (or the entry is stale) it **summarizes the file and returns the map as the
answer to the read**. That means an oversized `read` spends up to three model calls without
the caller naming the file to `summary`. This is the extension's one unannounced spend, and
it is bounded by the same `MAX_ATTEMPTS` ceiling.

The cache cannot cover a single turn that reads one file several times, because those calls
are in flight together and none of them finds a stored entry yet. So the guard's spend is
bounded **per file**, not per read: concurrent calls for one file share a single run and the
first one's model call pays for all of them. Five reads of an un-summarized file cost one
call, not five, and not the fifteen the `MAX_ATTEMPTS` ceiling would otherwise allow. A
`refresh` is refused that sharing — it neither joins a run nor publishes one — because it was
asked to re-summarize and silently inheriting another call's cached answer is the opposite.

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
  model         TEXT NOT NULL,     -- "provider/model"
  mode          TEXT NOT NULL,     -- 'mapped' | 'blob'
  overview      TEXT NOT NULL,     -- prose: what the file does
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
so there is no "how far did it get" figure to record, and the renderer simply leaves a gap
where the model mapped nothing.

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

`created_at` is gone the same way, for a simpler reason: it was stamped on every write and
read back into the entry, but nothing ever consulted it. The cache is content-addressed, so
an age decides nothing; the migration for it is the same `ensureSchema` drop.

`F5` `summary(path)` on a stale entry re-summarizes and replaces, and says so. The
caller never has to know the difference; asking for a summary always returns a summary
of the current file.

## 6. `summary` output contract

```
# src/foo.ts  (1420 lines, 48.2KB, sha 9f2c1ab4)
cache: miss

<overview prose>

## map
   1-  24  import   node/fs, node/path; module constants
  26- 140  class    FooClient - HTTP transport with retry
 141- 620  method   FooClient.request() - builds, signs, sends
 621-1420  method   FooClient.retry() - backoff and jitter

# read src/foo.ts with offset/limit inside one range above (max 200 lines per call).
```

`cache:` reads `fresh` (served from cache), `miss` (nothing was cached), `forced`
(explicit refresh), or `stale` (the file changed and was re-summarized).

Only mapped rows appear. The summarizer is told to skip lines that do nothing, so a gap in
the numbers is its answer — blank runs, a license header, generated boilerplate — and saying
so on every blank run, else branch and closing brace would bury the rows that carry
information. A gap reads as "nothing mapped here".

`O1` The map is rendered as text, never as JSON. The model's JSON is validated and stored,
then re-rendered into this form on every read; the JSON never reaches the model. Rows are
`start-end  kind  name - note`, numbers right-aligned, so the ranges line up for scanning
without the model having to parse anything.

## 6a. Making the tool get called

The tool is only worth its cost if the model calls it before reading. pi gives a tool three
places to say so, in descending order of influence:

- `promptGuidelines` — bullets in the system prompt's shared `Guidelines:` list, present on
  every turn.
- `description` — the tool's schema text, also present every turn.
- `promptSnippet` — the one-line entry in the system prompt's `Available tools:` list. A tool
  appears in that list *only* if it has a snippet, so this decides visibility, not emphasis.

`P1` The trigger has to be observable before the call. The original guideline — "use summary
before read on any file longer than 200 lines" — named a condition the model cannot evaluate:
it does not know a file's length until it has read it, which is the action being decided. An
trigger the model cannot test reads as inapplicable and is skipped, so the tool went unused.
The trigger is now "a source file you have not seen", which is known at decision time.

`P2` The guidelines must not advertise what the guard lets through. The old text said to
call `summary` on "prose, config, and data" and the description claimed it "works on any text
file". Both are now false of the read path (`G3`), and they dilute the code trigger that the
tool is for. The `summary` tool still summarizes any text file on request — only the wording
stops inviting it for prose.

The same rule killed the bullet that described the guard: "a read longer than 200 lines is
answered with the file's summary instead." True, and useless — it tells the
model that reading a big file costs nothing and yields the map anyway, which is precisely
the reason not to call the tool. The guard's interception says the same thing at the moment it
is true, when the model has already made the mistake. The guideline list states only the
case for calling `summary` first.

`P3` The description leads with the action and the cost. The model already knows `read` works,
so it needs a reason to spend a call instead: "a 1400-line file costs seven reads or one
summary plus one read". Cost is a concrete argument; "structural summary" is a label.

## 7. The `read` guard

`G1` Span, not file size, is the test. A read is allowed when the lines it would
return number 200 or fewer:

```
span = min(limit ?? Infinity, totalLines - offset + 1)
```

So `read(big-file)` returns the map,
`read(big-file, offset=141, limit=200)` is allowed, `read(small-file)` is allowed, and
`read(big-file, offset=1400, limit=10)` is allowed. A call already carrying a small
`limit` is never touched, so the guard does not fight a model that is reading properly.

Verified against the built-in tool: `read(offset=1000, limit=200)` on a 3000-line file
returns lines 1000-1199, followed by `[1802 more lines in file. Use offset=1200 to
continue.]`. The guard's 200-line figure is its own limit, not the built-in
tool's - the built-in caps at 2000 lines / 50KB, so a large file that reaches the guard's
failure path (`G6`) comes back truncated by the built-in cap rather than in full.

`G2` Counting lines is bounded. The guard only needs to know whether more than 200
lines remain from `offset`, so it streams the file in 64KB chunks and stops counting
once it has passed `offset + 200`. It never reads a large file fully into memory, and
it reads at most `offset + 200` lines regardless of file size. When it hits the budget
it returns `stopAfter + 1` as a sentinel, so the guard knows only that the span
exceeded 200 lines. It never needs the exact count: the map's own header carries the file's
line count.

`G3` Non-text and non-code files are not guarded. Binary and image reads are already governed
by the built-in byte cap and by `autoResizeImages`; a 200-line limit on a PNG is meaningless.
The guard skips anything that is not a regular file, and skips content with a NUL byte in the
first 8000.

It also skips `.md`, `.txt`, and any path with no extension — `Makefile`, `.gitignore`,
`LICENSE`. Same reasoning: prose and notes are written to be read in order, and a map of a
README says nothing a skim does not, so intercepting one only takes the file away. The 200-line
limit is for source files, where guessing the wrong range costs a wasted call. Unguarded
paths fall through to the built-in `read`, which has its own 2000-line cap. The `summary`
tool itself still accepts any text file on request; only the read override skips prose. Note
that `.eslintrc.json` *is* guarded — a dotfile's leading dot is not an extension.

`G4` A read either returns the lines it was asked for, or it returns the map. Nothing else.

A span of 200 lines or fewer is left alone and returns exactly what was read. A span of more
returns the map as the result content, preceded by two lines saying this is the file's map
and the model should read one of the ranges below with `offset`/`limit`. The file's own lines
are never returned for such a call.

Intercepting is what makes the two answers unambiguous. The earlier design clamped
`input.limit` to 200 and appended the map to the result: the model then spent the context of
a real read, still saw only a fraction of the file, and had to notice a tail it did not ask
for to learn it had been cut. `read`'s own limit is the rule — ask for more than it and the
answer is the map, not a shortened file with a map attached.

This result is a **success**, not an error. See `G8` for why that required replacing the tool
rather than blocking the call.

The map is rendered whole, uncapped. The cap that used to be here — 6000 chars, applied
twice, once inside the renderer and again over the composed reason — was worse than the
problem it solved. Truncation kept the *first* rows of the map, so what the model received
was contiguous and therefore indistinguishable from a complete map, while the trailing read
hint was always dropped. It cut the map for a 150-row file, and the 1396-line file in the
benchmark produces 150 rows. A model that needs a map should not be handed a plausible
partial one.

`G5` The guard is implemented by registering a `read` tool, replacing the built-in one.

This reverses what was originally decided here. The first design used
`pi.on("tool_call")` on the grounds that a second `read` registration would replace the
built-in renderer. That objection was wrong: built-in renderer inheritance is resolved per
slot by the TUI (`withBuiltInRenderers` merges `renderCall`/`renderResult` into the registered
definition), and pi's own docs describe overriding a built-in as a supported way to wrap one.
An override that omits the renderers keeps them.

What the override does *not* inherit, and must therefore be taken from
`createReadToolDefinition` explicitly: the description, the parameter schema, `promptSnippet`
and `promptGuidelines`. All four come from building the definition with pi's own factory, so
the tool the model sees is the built-in's. Only the oversized span diverges; every other call
is delegated to the built-in `execute`, errors included.

A delegated read must be built with the same options pi builds the built-in one with, or the
replacement silently changes behaviour it was meant to preserve. The one that matters is
`images.autoResize`: pi passes it into the definition it builds, and an extension context does
not expose it, so it is read from pi's own settings files. It is read **only for a read that
is already an image** — the built-in consults it in that branch alone, and loading the settings
files costs about a millisecond of synchronous I/O, which every text read would otherwise pay
for a value it discards. A read is classified by content, with pi's own detector, so an image
with an unexpected extension still gets the user's setting.

`G6` A failed summary **lets the read run** — the file's lines are returned, because with no
map to offer withholding the file would take it away and leave nothing behind. The read keeps
the built-in 2000-line cap, so a large file comes back truncated by that cap. The failure is
reported as a notification and, since a notification does not exist in print or RPC runs,
appended to the read result the model receives. Because the read is performed by our own
`execute`, the notice is appended right there — there is no need for a `tool_result` handler
keyed by tool call id, which is what the blocking design required.

`G8` An intercepted read is reported as a **successful** tool result.

This is the reason for `G5`. pi hardcodes the error flag on a blocked call: `prepareToolCall`
returns `{ result: createErrorToolResult(reason), isError: true }` for anything a `tool_call`
handler blocks, with no way for the handler to say otherwise. A blocked call also never
reaches `finalizeExecutedToolCall`, the only caller of `afterToolCall`, which is the only
caller of the extension `tool_result` hook — so `tool_result` never fires for it and cannot
correct the flag. The map therefore reached the model as a failed call, and rendered red in
the TUI.

A tool whose `execute` resolves normally produces `isError: false`. Returning the map as
ordinary content is thus not a workaround but the accurate report: the tool did exactly what
this extension promises a read of that size does.

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

Only an **absent** setting falls through to the session model. A setting that is present and
unusable — malformed, naming an unknown model, or naming one with no credentials — raises,
and both callers already turn that into the right thing: the `summary` tool reports it and
returns the whole file, and the read guard reports it and lets the read through. Falling back
instead would spend a different model than the user chose while looking like the setting was
honoured; the cost of a summary is exactly what the setting exists to control, so a silently
substituted model is the one outcome the setting cannot survive.

The setting is read from pi's own settings through `SettingsManager.create(cwd)`, checking
project scope first so a project can pin its own summarizer:

```json
{ "summary": { "model": "provider/model" } }
```

Global settings come from `<agentDir>/settings.json`, project settings from
`<cwd>/.pi/settings.json`. A bare string (`"summary": "provider/model"`) is also accepted.
pi's `Settings` interface has no field for extension config, but the file is not filtered:
unknown top-level keys survive load and write, which is what makes this safe.

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
storage, so one runaway field cannot crowd the map out of the read answer.

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

`S5` The mode is visible everywhere the entry is used — in `summary` output and in the
rendered `## map` block — so the model can tell what to trust. A blob entry still answers the
guard, but it tells the model to grep or read in ranges instead of pretending to know
where anything is.

## 10. Decisions taken

`D1` Storage: prose overview plus derived section rows. No stored blob, no stored
rendered map, no FTS index.

`D2` `read` guard answers a span longer than 200 lines with the cached summary, in place of
the file's lines.

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
cost is bounded by `D5`'s ceiling — and per file rather than per read, since concurrent reads
of one file share a single summarization (`C2`).

`D7` The summarizer model is configurable through a `summary.model` key in pi's settings
file, project scope winning over global, defaulting to the session model. A present setting
that cannot be used is an error, never a fallback: the setting exists to control what a
summary costs, so spending a model the user did not name — while reporting success — defeats
the only reason to write the key.

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
that do nothing; the validator no longer reports them; the renderer just leaves a gap
rows. The earlier "rows must tile the file" rule was replaced because it spent model calls
asking the model to map blank lines it had been told to skip.

`D11` `overview` may run to about ten sentences and a note to two sentences / 200
characters — deliberately looser than the original one-to-three-sentence overview and
90-character note, which were too tight to say anything about how a region is used. Both
are cut on the way into storage (`MAX_OVERVIEW_CHARS = 2400`, `MAX_NOTE_CHARS = 200`) so a
single runaway field cannot crowd the map out of the read answer.

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

`D14` A read longer than 200 lines **returns the map instead of the file's lines**, as a
successful result, from a `read` tool that replaces the built-in one. Two earlier designs
were tried and rejected. Clamping
`input.limit` to 200 and appending the map was built and shipped: it spends the context of a
real read, still shows a fraction of the file, and hides the cut in a tail the model did not
ask for. A block that carries only an instruction, with no map, was rejected because it turns
a read into a failure with nothing to show for it. Blocking *with* the map was then built and
shipped, and is now also rejected: pi hardcodes the error flag on a blocked call, so the map
reached the model as a failed call and rendered red in the TUI (`G8`). The model asked to see
more than a read can return; the map is the useful answer, and answering with it is not a
failure.

`D15` Neither the rendered summary nor the interception banner names the summarizer model. It is
recorded in the cache and in the tool result's `details`, where it is useful for diagnosing a
bad map, but it tells the model nothing it can act on and invites it to reason about the map's
trustworthiness from a model name it has no basis to judge.

`D16` The `summary` tool draws its own call and result, with renderers shaped like the built-in
`read`'s (`src/tui.ts`). pi merges a built-in renderer into any tool that does not supply one,
but only for the eight built-in names, and `summary` is not one — so without these the call is
drawn by the generic fallback: the tool name, the raw arguments as JSON, and the first ten
lines of the result. The call that produced a file's map would be the one line of the
transcript that did not show it.

The two renderers follow `read`'s in the part that matters: reuse `context.lastComponent` and
re-text it, rather than allocating a component per frame. That is the protocol pi offers — the
slot is handed back as the previous component — and it is what keeps a streaming call from
replacing the transcript's component on every argument.

The collapsed state is one line of outcome (`cache: miss · 501 lines · 1 range`) rather than
read's silence. read is often not the first thing a session does to a file, so an empty
collapsed result is one of several lines; a summary is usually the first, and a call that
shows nothing reads as a no-op. Expanding shows the text the model received, which is the
summary verbatim — the display does not re-render the map, so what is shown and what was
returned cannot disagree.

A failed summary draws the fallback for what it is: `no summary - the whole file was returned
instead`, with the notice leading the expanded text. Reporting the usual outcome line there
would let a failure that returned the file's lines read as a map. That is the failure the tool
recovers from. The one it does not is a summary that failed *and* could not read the file
either: that throws, pi marks the result an error, and the renderer draws the message itself,
collapsed, which is how `read` handles an error result. A thrown call whose reason is only
visible after expanding is a reason nobody reads.

Everything the renderers read may be absent — a streaming call has a partial args object, a
running call has no result, a result may carry no `details` — and none of it may throw: the TUI
calls renderers inside a `try/catch` and silently falls back to the generic drawing on a throw,
which would cost the display without saying so. `D15` holds here too, so the model name appears
in `details` and in neither rendered state. A path that is present but not a string is the one
argument error the call line reports (`[invalid arg]`, as read does); an absent or empty one is
a call still streaming its arguments, and shows `...`.

`D17` A successful `edit` appends a line locator to its result, naming every run of lines the
edit changed: `Edited lines 250-251; the file now has 254 lines.` Nothing else about the edit
result changes — the built-in confirmation is kept, not replaced.

The gap this closes is that the model is told an edit succeeded and never told where it landed.
`EditToolDetails` carries `diff`, `patch` and `firstChangedLine`, and the `tool_result` hook
receives all three, but `details` is a rendering channel: it is read by the TUI renderers, the
HTML exporter and the session transcript, and by **no provider adapter**. Only `content`
reaches the model. The hook's return value replaces that content, so appending a text block is
the whole mechanism — no new channel needed inventing.

Measured on one session (the reference session: 49 edits), a 253-line file was read 25 times,
and 23 of those reads were ranged. The waste is real but narrower than a bare read count
suggests, and it is worth stating precisely because it changes what "fixed" means. A ranged
read costs nothing: `read(path, offset=140, limit=45)` has span 45, is never intercepted, and
never touches the cache. The model was not checking its spelling; it was looking up line
numbers it had no other way to learn, and it did so with whole-file reads. The re-read is the
symptom, so the fix is the missing information rather than an instruction not to look.

Three alternatives were rejected, each for a measured reason:

- **Appending the diff.** Over the reference session's 49 edits: median 703 chars, max 14,152.
  The median is harmless and the tail is not, and the content is largely the model's own
  `edits[].newText` echoed back. Only the landing position is new information.
- **Deriving the file's length from `patch` or `diff`.** Both truncate every unchanged run to
  ±4 context lines, so a hunk header reports the hunk's extent, not the file's. Measured: a
  one-region edit to a 254-line file derives a length of 11.
- **`promptGuidelines` on a shadowed `edit`.** A guideline whose main verb is `read` reads as an
  instruction to read. The missing information is the defect, so the prompt is the wrong tool.
  The built-in guidelines are also asserted byte-identical to preserve for the shadowed `read`,
  and that invariant has no place here.

Four details are load-bearing.

The line count is `read`'s convention because the number exists to choose an `offset`, and an
off-by-one would send the next read past the end. That convention is the **raw** split: pi's
`read` computes `text.split("\n").length` with no popping (`core/tools/read.js`, its
`totalFileLines`), so a file of `a\nb\nc\n` is 4 lines. `splitLinesForCounting` pops the
trailing empty element, but it belongs to `truncate.js` and decides whether to truncate; it is
not how `read` counts a file. `fingerprint` in hash.ts states the same `newlines + 1` rule.

The locator names every changed run rather than the span between the first and the last. A span
would name the unchanged lines between the runs as edited: measured over the reference session,
25 of 49 edits (51%) landed in two or more disjoint runs, and over every recorded session 230
of 437 (53%). A model told its change is "somewhere in 18-86" has learned nothing it can act
on, which is the re-read this exists to prevent. Naming every run stays cheap — median 53
characters per locator, max 227 across all sessions — against a 703-character median diff.

The locator is not appended at all when it cannot be computed exactly: a wrong line number is
worse than none, because the model would act on it.

A no-op `edit` needs no guard of its own. The built-in tool throws on identical replacement
rather than returning a result, and although pi catches that throw and still runs the hook, it
arrives as an error result and is declined by the `isError` check.

The locator is emitted on every successful `edit`, not only above the read limit. An edit at
line 5 of a 253-line file still precedes an unbounded re-read of 253 lines, so gating on where
the edit landed would suppress the locator exactly where the file is large enough for the
re-read to be intercepted. The only edit that changes nothing is one against a file small
enough that no read of it was ever intercepted.
