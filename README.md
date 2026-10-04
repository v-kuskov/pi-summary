# pi-summary

A pi extension that stops the agent from reading whole files it does not need.

Two things, working together:

- **`summary`** — a tool that returns what a file does plus a map of which line ranges hold
  what. The first call on a file runs a model; asking again returns the cached answer with no
  model call until the file's contents change.
- **The trap** — a replacement for the built-in `read` that answers a read longer than
  `trap_limit` lines with the file's map instead, so the agent reads one region rather than the
  whole file. Shorter reads are returned exactly as asked. A file with no summary yet is
  summarized on the spot.

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
   1-  24  import   node/fs, node/path; module constants
  26- 140  class    FooClient - HTTP transport with retry
 141- 620  method   FooClient.request() - builds, signs, sends
 621-1420  method   FooClient.retry() - backoff and jitter

# read src/foo.ts with offset/limit inside one range above (max 200 lines per call).
```

A later `read path="src/foo.ts"` with no range is answered with that map instead of 1420 lines
of file, as an ordinary successful result. `read path="src/foo.ts" offset=141 limit=200` passes
through untouched. Whenever a read is answered with a map the extension says so in a toast, so
you can see the swap in the transcript.

Prose, notes and extensionless files — `.md`, `.txt`, `Makefile`, `.gitignore` — are never
touched. They are written to be read in order, and a map of a README says nothing a skim does.

The `summary` tool also returns machine-readable structure for scripts, and it tells the agent
where each `edit` landed, so an editing session does not have to read a file back to find out.

## Settings

Create `.pi/pi-summary.json` in a project, or `pi-summary.json` in pi's agent directory
(`~/.pi/agent/`) to set a default everywhere. A project's file wins key by key.

```json
{
  "model": "provider/model",
  "trap": "normal",
  "trap_limit": 200
}
```

| Key | Values | Default | Meaning |
| --- | --- | --- | --- |
| `model` | `"provider/model"` | the current session model | Which model writes summaries. |
| `trap` | `"none"`, `"normal"`, `"always"` | `"normal"` | Which reads may be answered with a map. |
| `trap_limit` | lines, e.g. `50` | `200` | How long a read may be before it gets the map. |

- **`model`** — absent means the model you are already using. A value that names no model you
  have credentials for fails the summary and tells you why, rather than quietly billing a
  different one.
- **`trap`** — `none` turns the read replacement off entirely: every read is a real read, and
  nothing is summarized behind your back. `normal`, the default, intercepts only the agent's own
  reads. `always` also intercepts reads made *by* other tools, such as a codemode script — pick
  it if you would rather a script saw a map than a 5000-line file.
- **`trap_limit`** — lower it to spend less context and more `summary` calls; raise it to read
  more of each file. Any whole number of 1 or more, including values below 50.

## Notes

- Summaries are cached in `.pi/summaries.db`, at the project root. An edited file is noticed by
  its contents rather than its timestamp, so a stale map is never served. Delete that file to
  start over.
- Reaching for an oversized read before a file has been summarized costs model calls you did not
  ask for — one per file, three at most, and cached afterwards.
- The summarizer runs as a plain completion with no tools: it is asked for JSON, the answer is
  checked, and an answer that does not fit is sent back with the specific problem.

## Development

`npm install`, then `npm run check` for the typecheck and the test suite, or `npm run test:llm`
for the same suite plus the cases that call a real model. Requires Node 24 or newer.

Licensed under the GNU GPL, version 3 or later.
