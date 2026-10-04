# AGENTS.md

pi-summary is a pi extension that summarizes a source file once, caches the result, and
answers any `read` of more than 200 lines with the file's **map** instead of its contents.

`README.md` is the user-facing description; the reasoning behind each choice lives in the
comment next to it.

## Commands

```
npm install
npm run check      # tsc --noEmit && node smoke.mjs — the gate; run it before finishing
npm run typecheck  # tsc --noEmit
npm test           # node smoke.mjs
npm run test:llm   # node smoke.mjs --llm — also calls a real model; needs credentials
```

`npm run check` is the only command that must pass. It typechecks the whole project and runs
the smoke suite. `npm run test:llm` adds the end-to-end cases, which spend real tokens against
`routerai/deepseek/deepseek-v4.1-flash`; without `--llm` the suite is hermetic.

## Architecture

`index.ts` is the pi entry point: it registers three things and opens nothing at load time.

- `src/tools.ts` — the `summary` tool (one model call per file, at most three), with an
  `outputSchema` whose `structuredContent` is the summary alone.
- `src/guard.ts` — replaces the built-in `read`; `trap` decides whether it intercepts at all
  and whose reads it claims, a read issued by another tool passes through under `normal`, and
  `decide()` is the single place that decides whether a remaining span is answered with the map
  or passed through.
- `src/locator.ts` — appends the changed line numbers to a successful `edit`.

Support: `src/summarize.ts` (the model call, validation, repair loop), `src/prompt.ts`,
`src/schema.ts` (typebox), `src/store.ts` + `src/cache.ts` (SQLite at
`<projectRoot>/.pi/summaries.db`), `src/hash.ts` (sha256 freshness), `src/settings.ts`,
`src/paths.ts`, `src/render.ts`, `src/tui.ts`, `src/fallback.ts`, `src/error.ts`.

## Settings

`pi-summary.json` in `<projectRoot>/.pi/` (project) and `<agentDir>/` (global), merged key by
key with the project winning. Keys: `model`, `trap` (`none`|`normal`|`always`), `trap_limit`
(lines). Defaults are the behaviour that shipped before the file existed — session model,
`normal`, 200 — so an install with no settings file is unchanged. `src/settings.ts` resolves
every default; nothing else may invent one. pi's own `images.autoResize` is read from pi's
`settings.json`, because it is pi's setting and not ours.

## Invariants

These are deliberate and have regressed before; do not weaken one without stating the
reason where the change is made.

- **Bounded model spend.** Summarizing costs one call normally, three at most; the guard
  never spends unbounded by the caller. No project-wide refresh, no search across summaries.
- **Freshness is the content hash, never mtime.** A size mismatch may short-circuit to
  stale; every other case goes through sha256.
- **Generation history stays internal.** Cache state, the summarizer model, the attempt
  count and the degradation flag live only in `details`; the model's text, the TUI outcome
  and `structuredContent` carry the summary alone.
- **The map is derived, not stored.** The database holds the overview and one row per
  region; the `## map` text is rendered from those rows, so prose and line numbers cannot
  drift apart. Gaps are legal; rows must not overlap.
- **Settings only ever widen or narrow the trap.** No setting may change what a summary *is*,
  and no default may differ from the behaviour that shipped before the file existed. A read
  that was a read before is still a read; a map that was served before is still served.
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
  (`units`, `summary tool`, `read guard`, `real model`). It checks structure and schema,
  never the map's content — that correctness lives in the prompt. Cases in the `real model`
  section run only under `--llm` and are the one place a model other than the fake is used;
  they must name `LLM_MODEL` and nothing else.

## Commits

Plain natural-language sentences describing the change, no `type(scope):` prefixes — see
`git log` for the register.