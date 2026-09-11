import { uuidv7 } from "@earendil-works/pi-ai";
import { assistantText, SummaryError } from "./error.ts";
import { fingerprint } from "./hash.ts";
import { cacheKey, findProjectRoot, isRegularFile, resolveFilePath } from "./paths.ts";
import {
	type PreparedFile,
	buildRepairPrompt,
	buildSummarizePrompt,
	describeCoverageProblems,
	extractOverview,
	modelLabel,
	parseJsonAnswer,
	prepareFile,
} from "./prompt.ts";
import {
	type EmitSummary,
	describeSchemaErrors,
	hasTopLevelShape,
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
import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { readSummarySettings } from "./settings.ts";

type AnyModel = Model<any>;

/**
 * Total model calls one summarize may spend: the first attempt plus at most two repairs.
 *
 * The cap is the whole reason this loop can exist under the extension's cost filter, which
 * otherwise promises a single call per file. A model that cannot produce the shape in
 * three tries is not going to produce it in ten, and the answer degrades to a blob.
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
	dbPath: string;
	firstTouch: boolean;
	/** How the model's answer was read: validated JSON, or salvaged prose. */
	extraction: "json" | "blob";
	/** True when the answer never became valid JSON and the map is missing. */
	degraded: boolean;
	/** Model calls spent, including repairs. */
	attempts: number;
};

/**
 * Return a summary of `path`: from cache when the file is unchanged, otherwise by asking
 * a model and caching the result.
 *
 * `status` reports which happened so the caller can tell the model whether it just paid
 * for a model call.
 */
export async function summarizeFile(
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
	const { db, dbPath, firstTouch } = openDb(ctx.cwd);
	try {
		ensureSchema(db);
		const cached = readSummary(db, key);

		if (cached && !options.force) {
			if ((await freshnessOf(cached)) === "fresh") {
				return {
					entry: cached,
					status: "fresh",
					dbPath,
					firstTouch,
					extraction: cached.mode === "mapped" ? "json" : "blob",
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
			dbPath,
			firstTouch,
			extraction: result.mode === "mapped" ? "json" : "blob",
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
 * Ask the model for a summary and repair the answer until it validates, or give up.
 *
 * One call per loop iteration, so `MAX_ATTEMPTS` is a real ceiling on spend. Two different
 * failures are handled differently:
 *
 * - A **provider error** is not the model's fault, so a rejected `response_format` is
 *   retried once without it. That retry consumes an attempt, keeping the total bounded.
 * - Invalid **output** is repaired by appending the model's own answer plus the specific
 *   violations and asking again. This is a fix-up loop over one prompt, not an agentic
 *   cycle: the summarizer never chooses what to do next, and it is never given tools.
 *
 * When the cap runs out the answer is salvaged as prose and stored as a blob. That is an
 * honest map-less entry rather than a fabricated one — see `renderMap`.
 */
async function requestSummary(
	ctx: ExtensionContext,
	model: AnyModel,
	key: string,
	prepared: PreparedFile,
	signal: AbortSignal | undefined,
): Promise<SummaryResult> {
	// Messages to resend on the next attempt. Grows only with the model's own answer and
	// the list of problems, so every retry is a fresh complete() call over one prompt.
	const messages: Array<Record<string, unknown>> = [
		userMessage(buildSummarizePrompt(key, prepared)),
	];
	const base = { signal, cacheRetention: "none" as const, sessionId: uuidv7() };

	// JSON mode is best effort: providers that support it return valid JSON, and providers
	// that reject the parameter get the same prompt without it.
	let jsonMode = true;
	let last: AssistantMessage | undefined;
	let lastText = "";
	let problems: string[] = [];

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const response = await ctx.modelRegistry.complete(
			model,
			{ messages: messages as never },
			jsonMode ? { ...base, samplingParams: { response_format: { type: "json_object" } } } : base,
		);

		if (isProviderError(response)) {
			if (jsonMode) {
				// Drop the override and try this same step again. Counted as an attempt so the
				// ceiling holds even when the provider rejects JSON mode every time.
				jsonMode = false;
				continue;
			}
			throw new SummaryError(
				`the summarizer call failed for ${key}: ${response.errorMessage ?? response.stopReason}`,
				"That is the provider's error rather than a summary problem, so retrying may not help.",
			);
		}

		last = response;
		lastText = assistantText(response);

		const parsed = parseJsonAnswer(lastText);
		if (parsed !== undefined && hasTopLevelShape(parsed)) {
			const value = parsed as EmitSummary;
			const sections = normalizeSections(value.sections, prepared.totalLines);
			// A valid envelope with no usable rows is still a blob: there is no map to show,
			// and inventing a single file-spanning region would be indistinguishable from a
			// real one.
			if (sections) {
				// The excerpt is numbered, so a complete map covers every line exactly once: first
				// row at line 1, each row starting where the last ended, last row on the final line.
				// A break means the model worked from a pattern instead of copying the numbers, or
				// stopped short - either way the boundaries are not trustworthy until it is fixed.
				const gaps = describeCoverageProblems(sections, prepared.totalLines);
				if (gaps.length === 0 || attempt >= MAX_ATTEMPTS) {
					return {
						overview: value.overview.trim() || "(no overview provided)",
						sections,
						mode: "mapped",
						usage: response.usage,
						attempts: attempt,
					};
				}
				problems = gaps;
			} else if (value.sections.length === 0) {
				// An explicitly empty `sections` is an answer, not a mistake: the model is saying
				// the file has no map. Accept it as a blob rather than spending calls arguing.
				return {
					overview: value.overview.trim() || "(no overview provided)",
					sections: [],
					mode: "blob",
					usage: response.usage,
					attempts: attempt,
				};
			} else {
				problems = ["\"sections\" contained no usable region"];
			}
		} else {
			problems = describeProblems(parsed);
		}

		if (attempt < MAX_ATTEMPTS) {
			messages.push(assistantTextMessage(response, lastText));
			messages.push(userMessage(buildRepairPrompt(problems)));
		}
	}

	return {
		overview: extractOverview(lastText) || "(the summarizer returned no usable answer)",
		sections: [],
		mode: "blob",
		usage: last?.usage,
		attempts: MAX_ATTEMPTS,
	};
}

/** What to tell the model was wrong. Precise when the shape was parseable, blunt when not. */
function describeProblems(parsed: unknown): string[] {
	if (parsed === undefined) {
		return ["the answer was not parseable as a JSON object"];
	}
	const errors = describeSchemaErrors(parsed);
	return errors.length > 0 ? errors : ['"sections" contained no usable region'];
}

function userMessage(text: string): Record<string, unknown> {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

/**
 * The model's own answer, resent as the assistant turn before the correction.
 *
 * Built from the real response so every field the provider requires is present, with the
 * content replaced by its text. Thinking blocks are dropped: they are not needed to
 * continue a fix-up exchange and would be billed again.
 */
function assistantTextMessage(response: AssistantMessage, text: string): Record<string, unknown> {
	return { ...response, content: [{ type: "text", text }] };
}

/** True when the provider returned an error instead of an answer. */
function isProviderError(response: AssistantMessage): boolean {
	return response.stopReason === "error";
}

/**
 * Pick the summarizer, in order: explicit `provider/model`, the `summary.model` setting,
 * else the session's current model. Auth is checked up front so a missing credential
 * reads as a clear message rather than a provider error.
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

	const slash = trimmed.indexOf("/");
	const provider = slash > 0 ? trimmed.slice(0, slash) : "";
	const modelId = slash > 0 ? trimmed.slice(slash + 1) : "";
	if (!provider || !modelId) {
		throw new SummaryError(
			`model "${explicit}" is not in provider/model form`,
			"Pass model as provider/model, for example: deepseek/deepseek-v4-flash, or omit it to summarize with the current session model.",
		);
	}
	const found = ctx.modelRegistry.find(provider, modelId);
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
 * The `summary.model` setting, if set.
 *
 * A setting that names a model the registry does not know is skipped rather than thrown:
 * an unreadable config should not make the tool unusable, and falling back to the session
 * model keeps `summary` working. The fallback is announced once, because a silently
 * ignored setting is indistinguishable from one that is being honoured - the summarizer
 * just quietly costs a different amount than intended.
 */
function configuredModel(ctx: ExtensionContext): AnyModel | undefined {
	const configured = readSummarySettings(ctx.cwd).model;
	if (!configured) return undefined;
	if (!isProviderModelPair(configured)) {
		warnOnce(ctx, configured, `summary.model "${configured}" is not in provider/model form`);
		return undefined;
	}

	const provider = configured.slice(0, configured.indexOf("/"));
	const modelId = configured.slice(configured.indexOf("/") + 1);
	const found = ctx.modelRegistry.find(provider, modelId);
	if (!found) {
		warnOnce(
			ctx,
			configured,
			`summary.model "${configured}" names no known model; using the session model instead`,
		);
		return undefined;
	}
	if (!ctx.modelRegistry.hasConfiguredAuth(found)) {
		warnOnce(
			ctx,
			configured,
			`summary.model "${configured}" has no configured credentials; using the session model instead`,
		);
		return undefined;
	}
	return found;
}

/** Settings values already reported, so a recurring fallback does not repeat itself. */
const warned = new Set<string>();

/** Announce a bad `summary.model` once per value, when there is a UI to announce it in. */
function warnOnce(ctx: ExtensionContext, key: string, message: string): void {
	if (warned.has(key)) return;
	warned.add(key);
	if (!ctx.hasUI) return;
	try {
		ctx.ui.notify(message, "warning");
	} catch {
		// A notification is a courtesy; never let it break the call.
	}
}

/** True when the value has a non-empty `provider/model` split. */
function isProviderModelPair(value: string): boolean {
	const slash = value.indexOf("/");
	return slash > 0 && slash < value.length - 1;
}

/** Fall back to the session's current model, or explain why there is none. */
function sessionModel(ctx: ExtensionContext): AnyModel {
	const current = ctx.model;
	if (!current) {
		throw new SummaryError(
			"no current model available to summarize with",
			'Pass model, for example: model="deepseek/deepseek-v4-flash", or set it with {"summary":{"model":"..."}} in settings.',
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
