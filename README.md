# pi-summary

A pi extension that stops the agent from reading whole files it does not need.

Two things, working together:

- **`summary` tool** — normally one model call per file, at most three. Returns what the
  file does and a map of which line ranges hold what. Cached in SQLite; asking again
  returns the cached result without a model call until the file's contents change.
- **`read` guard** — `tool_call` handler that blocks any `read` that would return more
  than 200 lines, and puts a summary of the file into the block reason. The block is not a
  dead end: it is the map the model needed, plus a concrete `read(offset, limit)` to use.
  A file with no summary yet is summarized on the spot and labelled as such.

## Install

As a pi package, from a checkout:

```bash
pi install git:github.com/<you>/pi-summary     # or npm:pi-summary once published
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
model: deepseek/deepseek-v4-flash

An HTTP client for the internal Orders API. Wraps node fetch with signed requests,
retry with jitter, and a rate limiter shared per host. Exports FooClient and the
RetryPolicy type. No top-level side effects. Signing reads process.env.SECRET fresh on

every attempt, so a test that does not set it signs with an empty key.

## map
   1-  24  import   node/fs, node/path; module constants
  25-  25  skipped  (nothing to map)
  26- 140  class    FooClient - HTTP transport with retry
 141- 620  method   FooClient.request() - builds, signs, sends
 621-1420  method   FooClient.retry() - backoff and jitter

# read src/foo.ts with offset/limit inside one range (max 200 lines per call).
```

A later `read path="src/foo.ts"` with no range is blocked:

```
read is limited to 200 lines per call.
This call would return more than 200 lines, starting at line 1.
Add limit=200 and step offset, or read one region from the map below.

Cached summary of this file (use these line ranges):

# src/foo.ts  (1420 lines, 48.2KB, sha 9f2c1ab4)
model: deepseek/deepseek-v4-flash
...
```

`read path="src/foo.ts" offset=141 limit=200` is allowed.

A `read` that already carries a small `limit` is never blocked, so the guard does not
fight a model that is reading properly. `read path="src/foo.ts" limit=2000` is blocked
the same way a bare `read` is — the span that would come back is what counts, not
whether `limit` was passed.

If nothing is cached yet, the guard summarizes the file and says so instead of returning
a dead end:

```
Summary of this file, generated for this read (use these line ranges):

# src/foo.ts  (1420 lines, 48.2KB, sha 9f2c1ab4)
...
```

That makes an oversized `read` of an unfamiliar file cost model calls without you asking
for them — the one place this extension spends unbounded-by-the-caller, capped at three
calls per file and cached afterwards.

## Cache

`<projectRoot>/.pi/summaries.db`, where the project root is the nearest ancestor
containing `.git`. SQLite via `node:sqlite` — no native dependency, Node 24+ only.

Validity is content-addressed (`sha256`). `mtime` and size are stored as a cheap
pre-check, but a file rewritten within the same mtime tick still invalidates on hash, so
a stale summary is never served. Delete the file to start over.

The database stores the overview prose and one row per mapped region. The `## map` text
is rendered from those rows on every read, so the prose and the line numbers cannot
drift apart. If the summarizer returns no usable line map, the entry is stored as a
**blob** — overview only, zero rows — and says so, rather than inventing a single region
spanning the file.

Rows may leave gaps: the summarizer is told to skip lines that do nothing, so a blank
run, a license header, or generated boilerplate is deliberately unmapped rather than
absorbed into a neighbour or covered by a region invented for the purpose. Gaps are
rendered as `skipped (nothing to map)` rows, so the map still accounts for every line and
you never have to notice a jump in the numbers. Rows may not overlap — two notes cannot
describe the same line. Overlaps are trimmed locally, so they never cost a retry.

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
{ "summary": { "model": "routeai/deepseek/deepseek-v4.1-flash" } }
```

- Global: `<agentDir>/settings.json` (`~/.pi/agent/settings.json`)
- Project: `<projectRoot>/.pi/settings.json`

A bare string works too: `{ "summary": "routeai/deepseek/deepseek-v4.1-flash" }`. If the
named model is unknown or the file cannot be parsed, the session model is used instead of
failing.

## Deliberate non-goals

- **No search across cached summaries.** Removed after being built. Answering "where is
  X handled?" by scanning every cached file pushes toward summarizing the whole project,
  which is unbounded model spend driven by a query string.
- **No project-wide refresh.** Same reason.
- **No `read` tool override.** The guard is a `tool_call` handler, so it composes with
  the built-in renderer and with other extensions that already override `read`.

## Development

```bash
npm install
npm run check     # tsc --noEmit && node smoke.mjs
```

`smoke.mjs` drives the real tool and the real guard with a fake `ExtensionAPI` and a
fake `ModelRegistry`, against a temp project directory. It covers cache hit/miss/stale/
forced, the hash-over-mtime rule, the blob degradation, the repair loop and its cap,
settings precedence, and the guard's allow/block boundaries — including that a cold
oversized read summarizes and that a failing summarizer lets the read through and says so.

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
