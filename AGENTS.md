# AGENTS.md

pi-summary is a pi extension that summarizes a source file once, caches the result, and
hands the model the file's **map** — what it does and which line ranges hold what.

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

`index.ts` is the pi entry point: it registers two things and opens nothing at load time.

- `src/tools.ts` — the `summary` tool (one model call per file, at most three), with an
  `outputSchema` whose `structuredContent` is the summary alone. It also answers
  `summary(path, region)`: a zero-model-call drill-down into one cached region, resolved by
  `src/region.ts`.
- `src/locator.ts` — appends the changed line numbers to a successful `edit`.

Support: `src/summarize.ts` (the model call, validation, repair loop, and the cache-only
lookup the drill-down uses), `src/prompt.ts`, `src/schema.ts` (typebox), `src/store.ts`
(SQLite at `<projectRoot>/.pi/summaries.db`), `src/region.ts` (region resolution and excerpt),
`src/hash.ts` (sha256 freshness), `src/settings.ts`, `src/paths.ts`, `src/render.ts`,
`src/tui.ts`, `src/fallback.ts`, `src/error.ts`.

## Settings

`pi-summary.json` in `<projectRoot>/.pi/` (project) and `<agentDir>/` (global), merged key by
key with the project winning. One key: `model`. The default is the behaviour that shipped
before the file existed — the session model — so an install with no settings file is
unchanged. `src/settings.ts` resolves the default; nothing else may invent one.

## Invariants

These are deliberate and have regressed before; do not weaken one without stating the
reason where the change is made.

- **Bounded model spend.** Summarizing costs one call normally, three at most. No
  project-wide refresh, no search across summaries. The `region` drill-down is a cache read
  and costs zero calls; a region that cannot be resolved errors rather than summarizing.
- **Freshness is the content hash, never mtime.** A size mismatch may short-circuit to
  stale; every other case goes through sha256.
- **Generation history stays internal.** Cache state, the summarizer model, the attempt
  count and the degradation flag live only in `details`; the model's text, the TUI outcome
  and `structuredContent` carry the summary alone.
- **The map is derived, not stored.** The database holds the overview and one row per
  region; the `## map` text is rendered from those rows, so prose and line numbers cannot
  drift apart. Gaps are legal; rows must not overlap.
- **Importance is display-only, and its absence is legal.** A row stores the full note; the
  tier (1|2|3, assigned by the model in the same call) decides only how much of that note the
  map shows, while the drill-down always returns the whole row. A row written before the field
  existed reads as tier 2 on load, so no cache migration rewrites it — only the column default
  is added.
- **Settings only ever choose the summarizer.** No setting may change what a summary *is*.
- **A failed summary falls back to the file.** A call that could not summarize still hands
  back the whole file and reports why — it never withholds the file over a failed summary.
- **The whole file is sent to the summarizer.** No line or byte cap; the excerpt is
  line-numbered so the model copies numbers instead of counting.

## Conventions

- TypeScript, ESM, `strict` with `noUncheckedIndexedAccess`. Import local modules with the
  `.ts` extension (`NodeNext`).
- Tabs for indentation; double quotes; semicolons.
- Comments explain **why** — the gotcha, the measured reason, the rejected alternative — not
  what the line does. Match the surrounding density.
- `smoke.mjs` is the test suite: it drives the real tools against a temp project with a fake
  `ExtensionAPI` and `ModelRegistry`. Add cases there, under the existing section comments
  (`units`, `summary tool`, `edit locator`, `renderers`, `real model`). It checks structure
  and schema, never the map's content — that correctness lives in the prompt. Cases in the
  `real model` section run only under `--llm` and are the one place a model other than the
  fake is used; they must name `LLM_MODEL` and nothing else.

## Commits

Plain natural-language sentences describing the change, no `type(scope):` prefixes — see
`git log` for the register.
