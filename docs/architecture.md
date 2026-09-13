# Cached file summarizer + read guard

A high-level architecture brief. It names no source files, modules, or identifiers — it
states the components, their invariants, and the cost rules, which is what a
re-implementation needs to reproduce the same behavior without copying the same structure.

## The idea

Reading a file into context is the most expensive routine action an agent takes, and it is
all-or-nothing: the model must pay for the whole file before it can know which part it
needed. This system replaces "read the file" with "read a map, then read the 200 lines
that matter."

## Architecture

Three parts, none of which requires the others:

1. **A summarizer** — given one file, produces prose describing what it does plus a map of
   line ranges: which range holds which declaration. That is one model call, and the result
   is cached per project.
2. **A cache** — keyed by file path, validated by content hash. It stores the prose and the
   map as rows, never as rendered text, so the two cannot disagree with each other. A cache
   hit costs nothing.
3. **A read guard** — intercepts every file read. If the call would return more than 200
   lines, the read is not performed: the model gets the file's map instead, and reads one of
   its ranges. A call asking for 200 lines or fewer is returned exactly as asked. If the file
   was never summarized, the guard summarizes it on the spot, which turns a blind oversized
   read into a map instead of a dead end.

The pieces compose in both directions: the tool alone saves tokens when the model chooses
it; the guard alone forces range-based reading; together the guard creates the map and the
tool pays for it. Neither is a fallback for the other — they answer different questions.
"Show me this file" is answered by the map, and a range of at most 200 lines is what the
model reads when the map points somewhere.

## The rule that shapes everything

The scarce resource is **model calls**, not database reads. So: every action is either a
pure cache read, or it spends model calls on a file the caller explicitly named. No action
fans out over files the caller did not name.

That gives a hard budget: zero calls on a fresh cache hit, one call on a miss, and at most
three if the model's output is malformed and must be repaired. The guard's on-the-spot
summarization is the single exception — it spends calls nobody asked for — and it is bound
by the same three-call ceiling.

The same rule explains what is deliberately absent: no search across cached summaries, no
project-wide refresh. Both sound useful and both turn a query string into unbounded model
spend.

## The summarizer

It is a plain completion, not an agent: it is given one file and asked for a structured
answer, and it is never given tools or a next step to choose. The prompt states the
answer's shape in prose and the answer is validated locally, so a malformed answer is a bug
to be fixed up rather than a cascade to be debugged.

The answer has two halves: a short prose description of what the file does, and a list of
regions, each with a line range, a kind (import, class, function, method, type, and so on),
a name, and a note on how it is used. Both halves are size-capped on the way into storage,
so one runaway field cannot crowd the map out of the text the model eventually reads.

Two prompt properties matter more than anything else in it:

- **The excerpt is line-numbered**, and the model is told to copy numbers out of that column
  rather than count lines. This converts a counting task into a copying task, and counting
  is where the interesting failures come from.
- **Regions may leave gaps.** The model is told to skip lines that do nothing — blank runs,
  license headers, generated boilerplate — rather than invent a region to cover them. A gap
  in the numbers is therefore an answer, not an omission.

The whole file is sent, uncapped. A partial map is close to useless, because the cache
holds one entry per file: an unmapped tail can never be filled in without re-reading the
file anyway, so capping would only guarantee that some files can never be mapped.

## The cache

Per project, so a summary is shared across sessions in the same tree and nothing leaks
between projects.

Validity is content-addressed. Size is a cheap pre-check that can only ever conclude
*stale*; the hash decides every other case. Nothing cheaper than the hash is trusted, and
nothing cheaper is even stored — every cheap freshness signal can be preserved over changed
content, so a shortcut there serves a stale map for a file that is about to be edited.
Hashing one file is cheap next to the model call the shortcut would avoid.

The stored form is prose plus region rows, with the rendered map produced from the rows on
every read. One source of truth: the prose and the line numbers cannot drift apart because
there is no second copy to drift from. The same storage choice is what lets the guard
answer "what is at line 1200?" from the entry's own data instead of parsing the text it
previously printed.

## The read guard

Its test is **span, not file size**: how many lines the call would actually return. A call
already asking for a small range is never touched, so the guard does not fight a model that
is reading properly.

It refuses rather than caps, and the distinction is the point. A capped read is neither of
the two useful answers: it spends the context of a real read, still shows a fraction of the
file, and reports the cut in a tail the model did not ask for. `read`'s own limit is the
rule — ask for more than it and the answer is the map. The refusal is reported by the host
as a failed call, which is accurate: the read did not happen. The reason text is the only
channel out of a refusal, so the map travels inside it.

The map is whole. An earlier version capped its length, which kept the *first*
rows: a contiguous partial map is indistinguishable from a complete one, so the model could
not tell it was being misled. A model that needs a map must not be handed a plausible
fragment.

Counting lines is bounded: the guard only needs to know whether more than 200 lines remain,
so it streams and stops once it is past that point, and never holds a large file in memory.

It declines to guard prose, notes, extensionless files, and binaries. Prose is written to
be read in order, and a map of it says nothing a skim does not, so refusing one only takes
the file away. A 200-line limit on an image is meaningless.

When there is no summary and none can be produced, the read is performed exactly as the
model asked and the failure is reported to both the user and the model. With no map to
offer, refusing the read would only take the file away.

## Guarantees

- **A summary is never wrong about freshness.** Validity is the content hash alone.
  Timestamps, sizes, and similar cheap signals are used only to conclude *stale* early,
  never to conclude *fresh*.
- **A read either returns what it was asked for, or the map.** A span within the limit is
  returned untouched; a longer span is refused, and the refusal carries the map. The guard
  never fails a read it cannot answer: a file it cannot inspect, or a file whose summary
  could not be produced, is passed through to the built-in tool. Its own file probes are
  individually guarded, so a read cannot fail because the guard failed to inspect the file.
- **A failed summary costs nothing but the failure.** The read proceeds as asked, and the
  failure is reported to the user and to the model — the latter through the result itself,
  since a UI notification does not exist in non-interactive runs.
- **A partial map is never presented as a complete one.** When the model cannot produce a
  usable map, the entry degrades to prose-only and says so in every place it is used,
  rather than inventing a region covering the whole file.
- **A bad answer is repaired twice, then accepted as prose.** Three calls total. A model
  that cannot produce the shape in three tries will not produce it in ten, and the ceiling
  is the only reason a repair loop can exist under a one-call-per-file budget.
- **Structure is validated, correctness is not.** A contiguous, well-formed map can still
  name the wrong lines, and no local check can tell, because the only thing that can is the
  source. The defence is the numbering in the prompt.
- **Malformed is not the same as wrong-shaped.** Bad arithmetic inside a well-shaped answer
  is normalized locally — ranges clamped, reversed ranges collapsed, overlaps trimmed —
  rather than sent back for repair. Spending a model call on arithmetic is a worse trade
  than clamping it.

## Getting it used

A tool nobody calls saves nothing, and the obvious guideline for this one does not work:
"summarize files longer than 200 lines" names a condition the model cannot evaluate without
reading the file, that is, without performing the action being decided. An untestable
trigger reads as inapplicable and is skipped. The usable trigger is "a source file you have
not seen," which is known at decision time.

Everything the model sees about the tool is therefore load-bearing: the one-line listing
decides whether the tool is visible at all, the description is present every turn, and the
cost argument belongs in front — a 1400-line file costs seven reads or one summary plus one
read. Finally, the surrounding text must not advertise file types the guard declines to
intervene in; that dilutes the trigger the tool exists for.

## Scope

Target source code. The summarizer will accept any text file on request; only the read path
declines to intervene. No search across cached summaries, no project-wide refresh, no
replacement of the read operation itself — it hooks the read rather than overriding it, so
it composes with the host's own rendering and with anything else that wraps the same call.
