import { validateToolArguments } from "@earendil-works/pi-ai";
import { assistantText, ModelCallError, SummaryError } from "./error.ts";
import { fingerprint } from "./hash.ts";
import { cacheKey, findProjectRoot, isRegularFile, resolveFilePath } from "./paths.ts";
import {
	type PreparedFile,
	buildRepairPrompt,
	buildSummarizePrompt,
	modelLabel,
	prepareFile,
} from "./prompt.ts";
import {
	type EmitSummary,
	emitSummarySchema,
	MAX_OVERVIEW_CHARS,
	normalizeSections,
} from "./schema.ts";
import {
	type CachedSummary,
	type Section,
	ensureSchema,
	freshnessOf,
	openDb,
	readSummary,
	type SummaryMode,
	writeSummary,
} from "./store.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	AssistantMessage,
	Message,
	Model,
	Tool,
	ToolCall,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import { SETTINGS_FILE, readSettings } from "./settings.ts";

type AnyModel = Model<any>;

/**
 * Total model calls one summarize may spend: the first attempt plus at most two repairs.
 *
 * The cap is the whole reason this loop can exist under the extension's cost filter, which
 * otherwise promises a single call per file. A model that cannot produce the shape in
 * three tries is not going to produce it in ten, and the call fails.
 */
export const MAX_ATTEMPTS = 3;

export type SummarizeStatus = "fresh" | "stale" | "miss" | "forced";

export type SummarizeOptions = {
	path: string;
	model?: string;
	force?: boolean;
	signal?: AbortSignal;
};

export type SummarizeOutcome = {
	entry: CachedSummary;
	status: SummarizeStatus;
	usage?: Usage;
	/** True when the answer carried no usable line map, so only prose was stored. */
	degraded: boolean;
	/** Model calls spent, including repairs. */
	attempts: number;
};

/**
 * Read a file's cached summary for a region lookup, without ever running a model.
 *
 * Progressive disclosure has three layers - `summary(path)` for the map, `summary(path, region)`
 * for one region, plain `read` for the text - and this is the second one. It is pure retrieval:
 * a missing cache or a stale one raises, pointing the caller back at the first layer, rather
 * than quietly spending a call. A stale map is never handed out even here, because naming a
 * region from a map that no longer matches the file would send the reader to the wrong lines,
 * which is the one thing the map exists to prevent.
 */
export async function loadCachedSummary(
	ctx: ExtensionContext,
	path: string,
): Promise<CachedSummary> {
	const absPath = resolveFilePath(path, ctx.cwd);
	if (!isRegularFile(absPath)) {
		throw new SummaryError(
			`${path} is not a regular file`,
			"summary works on files. Use ls to find a path first.",
		);
	}

	const root = findProjectRoot(ctx.cwd);
	const key = cacheKey(absPath, root);
	const { db } = openDb(ctx.cwd);
	try {
		ensureSchema(db);
		const cached = readSummary(db, key);
		if (!cached) {
			throw new SummaryError(
				`no cached summary for ${path}`,
				"Call summary on it first; a region lookup reads the cache and never runs a model.",
			);
		}
		if ((await freshnessOf(cached)) !== "fresh") {
			throw new SummaryError(
				`the cached summary of ${path} is stale - the file changed since it was mapped`,
				"Call summary on it again to refresh the map, then look the region up.",
			);
		}
		return cached;
	} finally {
		db.close();
	}
}

/**
 * Runs already under way, so callers asking for the same file at the same time share one.
 *
 * A cold oversized `read` is the case that matters: the model can issue several reads of the
 * same file in a single turn, and without this each one summarizes the file independently.
 * Entries are dropped as soon as the run settles, so a later call reads the cache as usual.
 *
 * A forced refresh neither joins a run nor publishes one. It was asked to re-run, and a caller
 * that expects cached semantics must never silently receive a refresh that started without it.
 */
const inFlight = new Map<string, Promise<SummarizeOutcome>>();

/**
 * Return a summary of `path`: from cache when the file is unchanged, otherwise by asking
 * a model and caching the result.
 *
 * `status` reports which happened so the caller can tell the model whether it just paid
 * for a model call.
 *
 * Concurrent callers for one file share a single run. The model and signal of whichever call
 * started the run are the ones used, so a joiner neither overrides the model nor adds a second
 * cancel, and a joiner's failure is the starter's failure.
 */
export async function summarizeFile(
	ctx: ExtensionContext,
	options: SummarizeOptions,
): Promise<SummarizeOutcome> {
	if (options.force) return runSummarize(ctx, options);

	// Keyed on what makes two runs the same work: the same file in the same project, which is
	// the same cache entry. The root is part of the key because a key on its own is relative
	// to it, so two projects with a `src/foo.ts` would otherwise share a run.
	const root = findProjectRoot(ctx.cwd);
	const file = cacheKey(resolveFilePath(options.path, ctx.cwd), root);
	const runKey = [root, file, options.model ?? ""].join("\u0000");

	const running = inFlight.get(runKey);
	if (running) return running;

	const run = runSummarize(ctx, options);
	inFlight.set(runKey, run);
	try {
		return await run;
	} finally {
		inFlight.delete(runKey);
	}
}

/** The work behind `summarizeFile`, run at most once at a time per file. */
async function runSummarize(
	ctx: ExtensionContext,
	options: SummarizeOptions,
): Promise<SummarizeOutcome> {
	const absPath = resolveFilePath(options.path, ctx.cwd);
	if (!isRegularFile(absPath)) {
		throw new SummaryError(
			`${options.path} is not a regular file`,
			"summary works on files. Use ls to find a path first.",
		);
	}

	const root = findProjectRoot(ctx.cwd);
	const key = cacheKey(absPath, root);
	const { db } = openDb(ctx.cwd);
	try {
		ensureSchema(db);
		const cached = readSummary(db, key);

		if (cached && !options.force) {
			if ((await freshnessOf(cached)) === "fresh") {
				return {
					entry: cached,
					status: "fresh",
					degraded: cached.mode === "blob",
					attempts: 0,
				};
			}
		}

		const status: SummarizeStatus = options.force ? "forced" : cached ? "stale" : "miss";
		const model = resolveSummarizerModel(ctx, options.model);
		const fp = await fingerprint(absPath);
		const prepared = await prepareFile(absPath);

		const result = await requestSummary(ctx, model, key, prepared, options.signal);

		writeSummary(db, {
			path: key,
			absPath,
			fp,
			model: modelLabel(model),
			mode: result.mode,
			overview: result.overview,
			sections: result.sections,
		});

		const stored = readSummary(db, key);
		if (!stored) throw new SummaryError(`failed to store the summary for ${key}`);
		return {
			entry: stored,
			status,
			usage: result.usage,
			degraded: result.mode === "blob",
			attempts: result.attempts,
		};
	} finally {
		db.close();
	}
}

type SummaryResult = {
	overview: string;
	sections: Section[];
	mode: SummaryMode;
	usage?: Usage;
	attempts: number;
};

/**
 * The one channel the summarizer answers through: a tool whose parameters are the map's
 * schema. Asking for a call rather than for JSON prose is what makes the answer enforced
 * and checked before anything here reads it - providers map `constrainedSampling` to their
 * schema-constrained decoding where they have it (`prefer` degrades silently where they
 * do not), and `validateToolArguments` checks the returned arguments against this very
 * schema before a row is read. The field contract therefore lives in the schema's
 * descriptions, which is what the model is shown.
 */
const emitSummaryTool: Tool = {
	name: "emit_summary",
	description: "Submit the finished file map. Call once, with the whole map as the arguments.",
	parameters: emitSummarySchema,
	constrainedSampling: { type: "json_schema", strict: "prefer" },
};

/**
 * Ask the model for a summary and repair the answer until it validates, or give up.
 *
 * The answer is a call to `emit_summary`, so the map is schema-constrained where the
 * provider has that and schema-checked before a row is read. One call per loop iteration,
 * so `MAX_ATTEMPTS` is a real ceiling on spend. Two different failures are handled
 * differently:
 *
 * - A **provider error** is not the model's fault and a retry may not help, so it fails
 *   the call and names the reason.
 * - A missing or invalid **output** is repaired by appending the model's own answer plus
 *   the specific violations and asking again. This is a fix-up loop over one prompt, not
 *   an agentic cycle: the summarizer never chooses what to do next, and its one tool is an
 *   answer channel rather than a capability.
 *
 * When the cap runs out the call fails. Prose stored under the summary's name would claim a
 * map the model never gave, and the caller has no other way to learn why it has nothing.
 */
async function requestSummary(
	ctx: ExtensionContext,
	model: AnyModel,
	key: string,
	prepared: PreparedFile,
	signal: AbortSignal | undefined,
): Promise<SummaryResult> {
	// Messages to resend on the next attempt. Grows only with the model's own answer and
	// the list of problems, so every retry is a fresh streamSimple() call over one prompt.
	const messages: Message[] = [userMessage(buildSummarizePrompt(key, prepared))];
	let problems: string[] = [];

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const response = await ctx.modelRegistry
			.streamSimple(
				model,
				{ messages, tools: [emitSummaryTool] },
				{ signal, cacheRetention: "none" },
			)
			.result();
		if (isProviderError(response)) {
			throw new ModelCallError(
				`the summarizer call failed for ${key}: ${response.errorMessage ?? response.stopReason}`,
				"That is the provider's error rather than a summary problem, so retrying may not help.",
			);
		}

		const call = emitSummaryCall(response);
		if (!call) {
			problems = ["the answer did not call the emit_summary tool"];
		} else {
			try {
				const value = validateToolArguments(emitSummaryTool, call) as EmitSummary;
				// Overlapping rows are trimmed here rather than reported back to the model. The trim
				// is deterministic, and spending a model call to fix arithmetic the code already
				// fixes for free contradicts the cost discipline. Gaps are left alone: they are the
				// model declining to map dead lines, and the renderer shows them as skipped.
				const sections = normalizeSections(value.sections, prepared.totalLines);
				if (sections) {
					return {
						overview: truncateOverview(value.overview.trim() || "(no overview provided)"),
						sections,
						mode: "mapped",
						usage: response.usage,
						attempts: attempt,
					};
				}

				// A valid envelope with no usable rows is a blob: there is no map to show, and
				// inventing a single file-spanning region would be indistinguishable from a real one.
				// An explicitly empty `sections` is the model's answer that the file has no map, so
				// accept it rather than spending calls arguing.
				return {
					overview: truncateOverview(value.overview.trim() || "(no overview provided)"),
					sections: [],
					mode: "blob",
					usage: response.usage,
					attempts: attempt,
				};
			} catch (error) {
				problems = validationProblems(error);
			}
		}

		if (attempt < MAX_ATTEMPTS) {
			messages.push(
				assistantTextMessage(
					response,
					call ? JSON.stringify(call.arguments, null, 2) : assistantText(response),
				),
			);
			messages.push(userMessage(buildRepairPrompt(problems)));
		}
	}

	// The budget is spent and nothing validated. Salvaging the prose as a blob would dress a
	// guess up as the summary that was asked for, so the call fails and says what happened.
	// The action goes in the message because pi drops `hint` from a thrown tool error, while
	// the diagnosis goes in the hint, where the fallback's notice can still show it.
	throw new ModelCallError(
		`the summarizer never produced a usable answer for ${key} after ${MAX_ATTEMPTS} attempts; name a different one with model=provider/model`,
		`The last answer was rejected for: ${problems.join("; ") || "it did not match the required shape"}.`,
	);
}

/**
 * Cut a runaway overview, keeping whole sentences so the prose still reads cleanly.
 *
 * The prompt allows ten sentences, which is a lot; a model that ignores that could return a
 * page of prose and push the map out of the result text entirely.
 */
function truncateOverview(overview: string): string {
	if (overview.length <= MAX_OVERVIEW_CHARS) return overview;
	const cut = overview.slice(0, MAX_OVERVIEW_CHARS);
	const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
	return `${lastStop > 0 ? cut.slice(0, lastStop + 1) : cut} …`;
}

/**
 * The validator's complaints for the corrective prompt, without the arguments dump it
 * appends: the repair turn already resends those arguments, and the dump would dwarf the
 * complaint it is sent with.
 */
function validationProblems(error: unknown): string[] {
	const text = error instanceof Error ? error.message : String(error);
	const head = text.split("\n\nReceived arguments:")[0] ?? text;
	const [, ...violations] = head.split("\n");
	return violations.map((line) => line.trim().replace(/^- /, "")).filter((line) => line.length > 0);
}

/** The model's `emit_summary` call, or undefined when it answered some other way. */
function emitSummaryCall(response: AssistantMessage): ToolCall | undefined {
	return response.content.find(
		(block): block is ToolCall =>
			block.type === "toolCall" && block.name === emitSummaryTool.name,
	);
}

function userMessage(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

/**
 * The model's own answer, resent as the assistant turn before the correction.
 *
 * Built from the real response so every field the provider requires is present, with the
 * content replaced by its text. Thinking blocks are dropped: they are not needed to
 * continue a fix-up exchange and would be billed again.
 */
function assistantTextMessage(response: AssistantMessage, text: string): AssistantMessage {
	return { ...response, content: [{ type: "text", text }] };
}

/** True when the provider returned an error instead of an answer. */
function isProviderError(response: AssistantMessage): boolean {
	return response.stopReason === "error";
}

/**
 * Pick the summarizer, in order: explicit `provider/model`, the settings file's `model`,
 * else the session's current model. Auth is checked up front so a missing credential
 * reads as a clear message rather than a provider error.
 *
 * Only an *absent* setting falls through to the session model. A setting that is present
 * and unusable raises instead: it names the model the user chose, and quietly spending a
 * different one hides that their choice is not being honoured.
 */
function resolveSummarizerModel(ctx: ExtensionContext, explicit: string | undefined): AnyModel {
	return resolveNamedModel(ctx, explicit) ?? configuredModel(ctx) ?? sessionModel(ctx);
}

/** An explicit `provider/model` argument, if one was given and is usable. */
function resolveNamedModel(ctx: ExtensionContext, explicit: string | undefined): AnyModel | undefined {
	// Models sometimes fill an optional field with a placeholder instead of omitting it.
	const placeholder = /^(current|default|auto|session|none|null|undefined)$/i;
	const trimmed = explicit?.trim() ?? "";
	if (trimmed.length === 0 || placeholder.test(trimmed)) return undefined;

	const parsed = parseProviderModel(trimmed);
	if (!parsed) {
		throw new SummaryError(
			`model "${explicit}" is not in provider/model form`,
			"Pass model as provider/model, or omit it to summarize with the current session model.",
		);
	}
	const found = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	if (!found) {
		throw new SummaryError(
			`unknown model "${explicit}"`,
			"Omit model to use the current session model.",
		);
	}
	if (!ctx.modelRegistry.hasConfiguredAuth(found)) {
		throw new SummaryError(
			`no credentials configured for ${explicit}`,
			"Omit model to use the current session model, or pick an authenticated provider.",
		);
	}
	return found;
}

/**
 * The `model` setting, if one is set.
 *
 * `undefined` means the setting is absent, which is the documented default: summarize
 * with the session's current model. A setting that *is* present but unusable raises, so
 * the caller reports why rather than silently billing a model the user did not choose.
 * Unparseable settings are covered too - a typo that cannot be read is exactly the case
 * where silently succeeding looks like the setting was honoured.
 */
function configuredModel(ctx: ExtensionContext): AnyModel | undefined {
	const configured = readSettings(ctx.cwd).model;
	if (!configured) return undefined;
	const parsed = parseProviderModel(configured);
	if (!parsed) {
		throw new SummaryError(
			`${SETTINGS_FILE}: "${configured}" is not in provider/model form`,
			`Fix ${SETTINGS_FILE}, or remove the key to summarize with the current session model.`,
		);
	}
	const found = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	if (!found) {
		throw new SummaryError(
			`${SETTINGS_FILE}: "${configured}" names no known model`,
			`Fix ${SETTINGS_FILE}, or remove the key to summarize with the current session model.`,
		);
	}
	if (!ctx.modelRegistry.hasConfiguredAuth(found)) {
		throw new SummaryError(
			`${SETTINGS_FILE}: "${configured}" has no configured credentials`,
			`Fix ${SETTINGS_FILE}, or remove the key to summarize with the current session model.`,
		);
	}
	return found;
}

/**
 * Split `provider/model` at the first slash, or `undefined` when either side is empty.
 *
 * A provider or model id may itself contain a slash, so only the first one separates them.
 */
function parseProviderModel(value: string): { provider: string; modelId: string } | undefined {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

/** Fall back to the session's current model, or explain why there is none. */
function sessionModel(ctx: ExtensionContext): AnyModel {
	const current = ctx.model;
	if (!current) {
		throw new SummaryError(
			"no current model available to summarize with",
			`Pass model as provider/model, or set one in ${SETTINGS_FILE}.`,
		);
	}
	if (!ctx.modelRegistry.hasConfiguredAuth(current)) {
		throw new SummaryError(
			`no credentials configured for ${current.provider}/${current.id}`,
			"Pass model as provider/model naming an authenticated provider.",
		);
	}
	return current;
}
