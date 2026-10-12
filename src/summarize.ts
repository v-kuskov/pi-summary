import { validateToolArguments } from "@earendil-works/pi-ai";
import { ModelCallError, SummaryError } from "./error.ts";
import { fingerprint } from "./hash.ts";
import { cacheKey, findProjectRoot, isRegularFile, resolveFilePath } from "./paths.ts";
import {
	type PreparedFile,
	buildSummarizePrompt,
	CONTINUATION_PROMPT,
	modelLabel,
	prepareFile,
} from "./prompt.ts";
import {
	type EmitMap,
	emitMapSchema,
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
import {
	createAgentSession,
	defineTool,
	type ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Model, Tool, ToolCall, Usage } from "@earendil-works/pi-ai";
import { SETTINGS_FILE, readSettings } from "./settings.ts";

type AnyModel = Model<any>;

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
};

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
			"map works on files. Use ls to find a path first.",
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
		if (!stored) throw new SummaryError(`failed to store the map for ${key}`);
		return {
			entry: stored,
			status,
			usage: result.usage,
			degraded: result.mode === "blob",
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
const emitMapTool: Tool = {
	name: "emit_map",
	description: "Submit the finished file map. Call once, with the whole map as the arguments.",
	parameters: emitMapSchema,
	constrainedSampling: { type: "json_schema", strict: "prefer" },
};

/**
 * How many turns the summarizer session may spend: the first prompt plus one continuation
 * per turn that ended without a usable call. Bounded because a summarize is a tool call with
 * a cost contract, not a conversation.
 */
export const MAX_TURNS = 3;

/**
 * The declaration above as the child session's tool, with the two pieces of enforcement.
 * `prepareArguments` runs the same validator the old single-call path ran and turns a
 * failure into the tool error the model corrects against - the violations plus a corrective
 * line; the schema itself is not re-printed because it rides along in the declaration on
 * every turn. `execute` is the collector: the first valid call wins, and `terminate` ends
 * the turn right there, so a captured summary costs exactly one model call.
 */
function collectorTool(capture: { value?: EmitMap }) {
	return defineTool({
		...emitMapTool,
		label: "emit_map",
		prepareArguments(args: unknown) {
			try {
				return validateToolArguments(emitMapTool, {
					name: emitMapTool.name,
					arguments: args,
				} as ToolCall) as EmitMap;
			} catch (error) {
				const problems = validationProblems(error);
				throw new Error(
					[
						"The arguments were rejected for:",
						...problems.map((problem) => `  - ${problem}`),
						"",
						"Correct your output and call the emit_map tool again.",
					].join("\n"),
				);
			}
		},
		async execute(_toolCallId, params) {
			if (capture.value === undefined) capture.value = params as EmitMap;
			return {
				content: [{ type: "text", text: "Map collected." }],
				details: undefined,
				terminate: true,
			};
		},
	});
}

/**
 * Summarize through a child pi session: one tool, a turn limit, and no other way to answer.
 *
 * The enforcement is goose's, in its two layers. Tool usage: the only way to answer is a
 * call to `emit_map`, and arguments that fail the schema go back to the model as a tool
 * error. Turn level: a turn that ended without the call gets a user message that continuation
 * is needed, and the session keeps asking until a valid call arrives or `MAX_TURNS` is spent.
 * Prose is never accepted - stored as the answer it would claim a map the model
 * never gave, and the caller has no other way to learn why it has nothing.
 *
 * The child session streams through the extension's own model registry, so model choice,
 * auth and dispatch are exactly what the old single call used; the session contributes the
 * agent loop, the tool pipeline that routes the errors back, and the transcript that carries
 * them. It is in-memory, so the generation stays internal.
 */
async function requestSummary(
	ctx: ExtensionContext,
	model: AnyModel,
	key: string,
	prepared: PreparedFile,
	signal: AbortSignal | undefined,
): Promise<SummaryResult> {
	const capture: { value?: EmitMap } = {};
	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		model,
		tools: [emitMapTool.name],
		customTools: [collectorTool(capture)],
		sessionManager: SessionManager.inMemory(ctx.cwd),
		thinkingLevel: "minimal",
	});
	session.agent.streamFunction = (m, c, o) => ctx.modelRegistry.streamSimple(m, c, o);
	signal?.addEventListener("abort", () => session.agent.abort(), { once: true });

	// The turns are driven at the agent level rather than through AgentSession.prompt(): that
	// entry point insists the session's own freshly built runtime has the model's auth
	// configured, but auth is the registry's job here - it resolves credentials per request,
	// exactly as the single call did - and the parent's runtime and a fresh one can disagree
	// about where the credentials live. The session still owns the loop, the tool pipeline
	// that routes the errors back, and the transcript that carries them.
	for (let turn = 1; ; turn++) {
		await session.agent.prompt(
			turn === 1 ? buildSummarizePrompt(key, prepared) : CONTINUATION_PROMPT,
		);
		await session.agent.waitForIdle();
		if (capture.value !== undefined) break;

		// A provider error is not the model's fault and another turn may not help, so the call
		// fails at once and names the reason instead of spending the turn budget on it.
		const last = lastAssistant(session.messages);
		if (last?.stopReason === "error" || last?.stopReason === "aborted") {
			throw new ModelCallError(
				`the summarizer call failed for ${key}: ${last.errorMessage ?? last.stopReason}`,
				"That is the provider's error rather than a problem with the map.",
			);
		}
		if (turn >= MAX_TURNS) {
			throw new ModelCallError(
				`the summarizer did not produce a usable answer for ${key} after ${MAX_TURNS} turns; name a different one with model=provider/model`,
				"No turn answered with a valid emit_map call.",
			);
		}
	}

	const value = capture.value!;
	// Overlapping rows are trimmed here rather than reported back to the model: the trim is
	// deterministic, and fixing arithmetic the code already fixes for free cannot justify a
	// second call. Gaps are left alone - the model declining to map dead lines - and a valid
	// envelope with no usable rows is a blob: there is no map to show, and inventing one
	// file-spanning region would be indistinguishable from a real one.
	const sections = normalizeSections(value.sections, prepared.totalLines);
	return {
		overview: truncateOverview(value.overview.trim() || "(no overview provided)"),
		sections: sections ?? [],
		mode: sections ? "mapped" : "blob",
		usage: sumUsage(session.messages),
	};
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
 * The validator's complaints for the corrective tool error, without the arguments dump it
 * appends: the model is told what was wrong, not shown its own answer again.
 */
function validationProblems(error: unknown): string[] {
	const text = error instanceof Error ? error.message : String(error);
	const head = text.split("\n\nReceived arguments:")[0] ?? text;
	const [, ...violations] = head.split("\n");
	return violations.map((line) => line.trim().replace(/^- /, "")).filter((line) => line.length > 0);
}

/** All the driver reads from a transcript message; the real type lives in the agent core. */
type TranscriptMessage = {
	role: string;
	usage?: Usage;
	stopReason?: string;
	errorMessage?: string;
};

/**
 * The transcript's last assistant message, which carries the stop reason of the turn that
 * just ended.
 */
function lastAssistant(
	messages: readonly TranscriptMessage[],
): TranscriptMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role === "assistant") return message;
	}
	return undefined;
}

/** The whole session's usage - every turn's response - as one call's bill. */
function sumUsage(messages: readonly TranscriptMessage[]): Usage {
	const total: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const message of messages) {
		const usage = message.usage;
		if (!usage) continue;
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.totalTokens += usage.totalTokens;
		total.cost.input += usage.cost.input;
		total.cost.output += usage.cost.output;
		total.cost.cacheRead += usage.cost.cacheRead;
		total.cost.cacheWrite += usage.cost.cacheWrite;
		total.cost.total += usage.cost.total;
	}
	return total;
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
