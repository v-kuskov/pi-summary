# AGENTS.md

pi-summary is a pi extension that summarizes a source file once, caches the result, and
answers any `read` of more than 200 lines with the file's **map** instead of its contents.

`README.md` is the user-facing description. `docs/DESIGN.md` is the reasoning: read it
before changing behavior — every load-bearing choice (cost bounds, hash freshness, blob
degradation, the read override) is recorded there with the alternatives that were rejected.

## Commands

```
npm install
npm run check      # tsc --noEmit && node smoke.mjs — the gate; run it before finishing
npm run typecheck  # tsc --noEmit
npm test           # node smoke.mjs
```

`npm run check` is the only command that must pass. It typechecks the whole project and runs
the smoke suite.

## Architecture

`index.ts` is the pi entry point: it registers three things and opens nothing at load time.

- `src/tools.ts` — the `summary` tool (one model call per file, at most three).
- `src/guard.ts` — replaces the built-in `read`; `decide()` is the single place that decides
  whether a span is answered with the map or passed through.
- `src/locator.ts` — appends the changed line numbers to a successful `edit`.

Support: `src/summarize.ts` (the model call, validation, repair loop), `src/prompt.ts`,
`src/schema.ts` (typebox), `src/store.ts` + `src/cache.ts` (SQLite at
`<projectRoot>/.pi/summaries.db`), `src/hash.ts` (sha256 freshness), `src/settings.ts`,
`src/paths.ts`, `src/render.ts`, `src/tui.ts`, `src/fallback.ts`, `src/error.ts`.

## Invariants

These are deliberate and have regressed before; do not weaken one without reading its
`D`-numbered decision in `docs/DESIGN.md` first.

- **Bounded model spend.** Summarizing costs one call normally, three at most; the guard
  never spends unbounded by the caller. No project-wide refresh, no search across summaries.
- **Freshness is the content hash, never mtime.** A size mismatch may short-circuit to
  stale; every other case goes through sha256.
- **The map is derived, not stored.** The database holds the overview and one row per
  region; the `## map` text is rendered from those rows, so prose and line numbers cannot
  drift apart. Gaps are legal; rows must not overlap.
- **An intercepted read is a successful result.** The guard replaces `read` rather than
  blocking the call, because pi hardcodes an error for a blocked tool call. A failed
  summary lets the read through and reports why — it never withholds the file.
- **The whole file is sent to the summarizer.** No line or byte cap; the excerpt is
  line-numbered so the model copies numbers instead of counting.
- **The guard never raises.** `decide()` is wrapped so a read racing a rewrite still
  succeeds.

## Conventions

- TypeScript, ESM, `strict` with `noUncheckedIndexedAccess`. Import local modules with the
  `.ts` extension (`NodeNext`).
- Tabs for indentation; double quotes; semicolons.
- Comments explain **why** — the gotcha, the measured reason, the rejected alternative — not
  what the line does. Match the surrounding density.
- `createReadToolDefinition` from pi is the source of truth for the read tool's description,
  schema and renderers; reuse it rather than restating it.
- `smoke.mjs` is the test suite: it drives the real tools against a temp project with a fake
  `ExtensionAPI` and `ModelRegistry`. Add cases there, under the existing section comments
  (`units`, `summary tool`, `read guard`). It checks structure and schema, never the map's
  content — that correctness lives in the prompt.

## Commits

Plain natural-language sentences describing the change, no `type(scope):` prefixes — see
`git log` for the register.