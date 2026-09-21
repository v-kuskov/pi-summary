# pi-summary

A pi extension that stops the agent from reading whole files it does not need.

Two things, working together:

- **`summary` tool** — normally one model call per file, at most three. Returns what the
  file does and a map of which line ranges hold what. Cached in SQLite; asking again
  returns the cached result without a model call until the file's contents change.
- **`read` guard** — a replacement for the built-in `read` tool that answers any `read`
  longer than 200 lines with the file's summary instead, so the model reads one of the map's
  ranges rather than the whole file. A read of 200 lines or fewer is returned exactly as
  asked. A file with no summary yet is summarized on the spot. Prose, notes and extensionless
  files (`.md`, `.txt`, `Makefile`, `.gitignore`) are never touched — they read whole.

## Install

As a pi package, from a checkout:

```bash
pi install git:github.com/v-kuskov/pi-summary    # or npm:pi-summary once published
```

The summarizer is a plain completion with **no tools**: it is asked for JSON, the answer is
validated, and output that is not the agreed shape is sent back to the model with the
specific violations, up to three attempts in total, before the result degrades to a
prose-only blob. It never chooses its own next step and is never given a tool to call.

Or load a local checkout directly:

```bash
pi -e /path/to/pi-summary/index.ts
```

The extension declares its entry point in `package.json` under `pi.extensions`, and its
only runtime dependency is `typebox` (resolved by pi's extension loader).

## What the model sees

```
summary path="src/foo.ts"
```

```
# src/foo.ts  (1420 lines, 48.2KB, sha 9f2c1ab4)
cache: miss

An HTTP client for the internal Orders API. Wraps node fetch with signed requests,
retry with jitter, and a rate limiter shared per host. Exports FooClient and the
RetryPolicy type. No top-level side effects. Signing reads process.env.SECRET fresh on

every attempt, so a test that does not set it signs with an empty key.

## map
   1-  24  import   node/fs, node/path; module constants
  26- 140  class    FooClient - HTTP transport with retry
 141- 620  method   FooClient.request() - builds, signs, sends
 621-1420  method   FooClient.retry() - backoff and jitter

# read src/foo.ts with offset/limit inside one range (max 200 lines per call).
```

A later `read path="src/foo.ts"` with no range is answered with the map instead of the
file's lines, as a normal successful result:

```
# this file: longer than 200 lines; this is the file's map, not its contents.
# read one of the ranges below with offset/limit, at most 200 lines per call.

# src/foo.ts  (1420 lines, 48.2KB, sha 9f2c1ab4)

An HTTP client for the internal Orders API. ...

## map
   1-  24  import   node/fs, node/path; module constants
  26- 140  class    FooClient - HTTP transport with retry
 141- 620  method   FooClient.request() - builds, signs, sends
 621-1420  method   FooClient.retry() - backoff and jitter

# read src/foo.ts with offset/limit inside one range above (max 200 lines per call).
```

`read path="src/foo.ts" offset=141 limit=200` passes through untouched.

A `read` that already carries a small `limit` is never touched, so the guard does not
fight a model that is reading properly. `read path="src/foo.ts" limit=2000` returns the
map the same way a bare `read` does — the span that would come back is what counts, not
whether `limit` was passed. A file whose summary cannot be produced is read as asked, with
the failure reported instead: with no map to offer, withholding the file would take it away
and leave nothing behind.

Until the file is summarized, an oversized `read` costs model calls without you asking
for them — the one place this extension spends unbounded-by-the-caller, capped at three
calls per file and cached afterwards.

## After an edit

A successful `edit` gains one line the model would otherwise have no way to learn:

```
Successfully replaced 1 block(s) in src/foo.ts. Edited line 250; the file now has 253 lines.
```

When one call lands in several places, each run is named — `Edited lines 6, 40 and 251; the
file now has 253 lines.` A span from the first run to the last would name the unchanged lines
between them as edited, which is worse than saying nothing.

pi computes the diff and the first changed line for every edit, but hands them to the TUI
and the session transcript rather than to the model — `details` is a rendering channel, and
no provider adapter reads it. So the model was told an edit succeeded and never told where it
landed, and the only way to find out was to read the file back. When that file is past the
read limit, every such read-back is intercepted by the guard and pays for a fresh summary:
measured over one session of 49 edits, a 253-line file was read 25 times and 23 of those reads
were ranged — cheap, but the whole-file ones are what pay.

The locator answers that question directly, so the re-read has no reason to happen. It is
appended rather than substituted — the confirmation and its block count are kept — and it is
empty when it cannot be exact, since a wrong line number is worse than none. The count uses
`read`'s own convention, so `offset` from it lands where the model expects.

This is model-facing only. The TUI draws an edit result from the diff, so the transcript
looks the same as it did before.

## Cache

`<projectRoot>/.pi/summaries.db`, where the project root is the nearest ancestor
containing `.git`. SQLite via `node:sqlite` — no native dependency, Node 24+ only.

Validity is content-addressed (`sha256`). Size is stored as a cheap pre-check: a size
mismatch is conclusive, so it returns `stale` without reading the file, and the hash
decides every other case. Nothing cheaper than the hash is trusted — no `mtime`, not even
stored — because a same-length edit in the same millisecond, a `cp -p`, or a coarse-mtime
volume all show an unchanged timestamp over changed content, which would serve a stale
summary for a file you are about to edit. Delete the file to start over.

The database stores the overview prose and one row per mapped region. The `## map` text
is rendered from those rows on every read, so the prose and the line numbers cannot
drift apart. If the summarizer returns no usable line map, the entry is stored as a
**blob** — overview only, zero rows — and says so, rather than inventing a single region
spanning the file.

Rows may leave gaps: the summarizer is told to skip lines that do nothing, so a blank
run, a license header, or generated boilerplate is deliberately unmapped rather than
absorbed into a neighbour or covered by a region invented for the purpose. A gap is a jump
in the numbers and nothing more — the map shows only what was mapped, so a blank run does
not get a line of its own. Rows may not overlap — two notes cannot describe the same line.
Overlaps are trimmed locally, so they never cost a retry.

## Options

| Argument  | Meaning                                                              |
| --------- | -------------------------------------------------------------------- |
| `path`    | File to summarize. Relative to cwd, or absolute.                     |
| `model`   | Summarizer as `provider/model`. Overrides the setting and the session model. |
| `refresh` | Re-summarize even if the cached summary is still fresh.               |

The guard takes no options: 200 lines is the limit.

## Configuration

The summarizer defaults to the current session model. To pin a cheaper or faster one, add
it to pi's settings file — project scope wins over global:

```json
{ "summary": { "model": "provider/model" } }
```

- Global: `<agentDir>/settings.json` (`~/.pi/agent/settings.json`)
- Project: `<projectRoot>/.pi/settings.json`

A bare string works too: `{ "summary": "provider/model" }`. A setting that is present but
unusable — malformed, naming an unknown model, or naming one with no credentials — fails
the summary and reports why, rather than quietly charging a different model. Only an absent
setting means the session model.

## Deliberate non-goals

- **No search across cached summaries.** Removed after being built. Answering "where is
  X handled?" by scanning every cached file pushes toward summarizing the whole project,
  which is unbounded model spend driven by a query string.
- **No project-wide refresh.** Same reason.
- **No shortened `read` input.** The guard replaces the `read` tool rather than rewriting
  an oversized call into a bounded one, so what the model asked for is either answered or
  answered with the map — never silently trimmed.

  Replacing `read` rather than blocking the call is what makes the map a *successful*
  result. pi hardcodes an error result for a blocked tool call, and skips the `tool_result`
  hook for it, so a refusal could only ever reach the model as a failed call. Registering
  under the same name and returning the map as content makes it what it is: an ordinary
  answer. The built-in renderer, schema, description and prompt guidance are kept, so the
  swap is invisible apart from the limit.

  `summary` draws its own call and result (see `D16` in `DESIGN.md`): collapsing a call shows a
  one-line outcome, and expanding it shows the map the model received. A call that failed hard
  enough to throw shows the reason collapsed, rather than nothing.

## Development

```bash
npm install
npm run check     # tsc --noEmit && node smoke.mjs
```

`smoke.mjs` drives the real tools with a fake `ExtensionAPI` and a
fake `ModelRegistry`, against a temp project directory. It covers cache hit/miss/stale/
forced, the hash-over-mtime rule, the blob degradation, the repair loop and its cap,
the `mtime_ms` migration, settings precedence, and the guard's boundaries —
including that a cold oversized read summarizes and returns the map, that an intercepted
read is a successful result and not an error, that the map carries every row uncut, that
prose and extensionless files are left outside the limit, that a failing summarizer
lets the read through and says so, and that `summary` draws its call and its result —
collapsed, expanded, still running, and failed — in a terminal.

Nothing checks the map's *content*. Structure and schema are validated, and a
contiguous, well-formed map can still name the wrong lines. The defence is in the prompt
itself: the excerpt is line-numbered and the model is told to copy numbers out of the
left column rather than count lines. That was measured, not assumed — given raw
unnumbered text one model invented a spacing rule and drifted a mean of 24 lines on a
1396-line file, while another counted accurately.

`docs/DESIGN.md` records the reasoning, including the cost filter and the rejected
designs.

## License

MIT
