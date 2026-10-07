# pi-summary

A pi extension that stops the agent from reading whole files it does not need.

Two things, working together:

- **`summary`** — a tool that returns what a file does plus a map of which line ranges hold
  what, ordered most important first. The first call on a file runs a model; asking again
  returns the cached answer with no model call until the file's contents change. Ask for one
  range by name or line number and it is served from cache alone.
- **The edit locator** — a note appended to every successful `edit` naming the lines it
  changed and the file's new length, so the agent does not read a file back to find out
  where its edit landed.

## Install

```bash
pi install git:github.com/v-kuskov/pi-summary
pi -e /path/to/pi-summary/index.ts   # or load a checkout directly
```

## What the agent sees

`summary path="src/foo.ts"` returns something like:

```
# src/foo.ts  (1420 lines, 48.2KB, sha 9f2c1ab4)

An HTTP client for the internal Orders API. Wraps node fetch with signed requests,
retry with jitter, and a rate limiter shared per host. Exports FooClient and the
RetryPolicy type.

## map
  26- 140  class    FooClient - HTTP transport with retry
 141- 620  method   FooClient.request() - builds, signs, sends
 621-1420  method   FooClient.retry() - backoff with jitter and a shared per-host limiter
   1-  24           setup
```

The map is **tiered by importance**, which the summarizer assigns in the same call that writes
it:

- **3** — main exports, core state, entry points, and the invariants a change must respect.
  Shown with the full note.
- **2** — supporting functions and types that serve the 3s. Shown with the note's first
  sentence.
- **1** — incidental glue and accessors. Shown as a range and a name only.

Rows lead with the 3s and end with the 1s; within a tier they stay in line order. The tier is
a display choice and nothing more: the full note is always stored.

The agent calls `summary` before reading a source file it has not seen, then reads only the
range it needs — or asks for it directly:

```
summary path="src/foo.ts" region="FooClient.request()"
summary path="src/foo.ts" region="141"        # a line inside that range works too
```

A region lookup returns the cached row (kind, name, note, importance, span) plus a
line-numbered excerpt of just that span, from the current file. It is pure retrieval — no model
call — so it costs nothing when the map is already cached. Names win over numbers: a `region`
is matched as a row name first (exactly, then case-insensitively) and read as a line number
only when no row carries it. A name that matches no row, or a line
that falls in a gap, is an error naming what the map does hold, never a fresh summarization.

That is three layers of increasing cost: `summary(path)` for the map, `summary(path, region)`
for one region, plain `read` for the whole text.

The result also carries machine-readable structure for scripts: one JSON object tagged
with `kind` — `map` (overview plus the rows), `region` (one row plus its excerpt), or `file`
(the whole file, returned only when summarization failed, with `error` saying why and
`truncated` saying whether the content was cut). Branch on `kind` before reading the other
fields.

A successful `edit` reports where the change landed:

```
Successfully replaced 2 block(s) in src/foo.ts.
Edited lines 141-142 and 630; the file now has 1419 lines.
```

## Settings

Create `.pi/pi-summary.json` in a project, or `pi-summary.json` in pi's agent directory
(`~/.pi/agent/`) to set a default everywhere. A project's file wins key by key.

```json
{
  "model": "provider/model"
}
```

| Key | Values | Default | Meaning |
| --- | --- | --- | --- |
| `model` | `"provider/model"` | the current session model | Which model writes summaries. |

- **`model`** — absent means the model you are already using. A value that names no model you
  have credentials for fails the summary and tells you why, rather than quietly billing a
  different one.

## Notes

- Summaries are cached in `.pi/summaries.db`, at the project root. An edited file is noticed by
  its contents rather than its timestamp, so a stale map is never served. Delete that file to
  start over.
- The map is a retrieval index, not a caption: every row answers "where does X live". A
  row's name is the symbol spelled exactly as the file spells it — so it can be passed
  straight back as `region` — and its note names the behaviors and data a reader would
  search for.
- The summarizer runs as a plain completion with no tools: it is asked for JSON, the answer is
  checked, and an answer that does not fit is sent back with the specific problem. It skips
  imports, re-exports and boilerplate — those are what plain `read` is for.
- A summary written before importance tiers existed still works: its rows read as tier 2.

## Development

`npm install`, then `npm run check` for the typecheck and the test suite, or `npm run test:llm`
for the same suite plus the cases that call a real model. Requires Node 24 or newer.

Licensed under the GNU GPL, version 3 or later.
