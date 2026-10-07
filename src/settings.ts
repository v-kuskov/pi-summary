import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { findProjectRoot } from "./paths.ts";

/**
 * This extension's settings file, named rather than keyed.
 *
 * It is not a key in pi's `settings.json` because this file is ours from the first line:
 * every key in it is a setting of this extension, so a typo is not silently ignored beside
 * pi's own configuration. Two copies exist and the project's wins, key by key - the same
 * shape pi uses for its own global and project scopes, so one scope can pin the model while
 * the other leaves it to the session.
 */
export const SETTINGS_FILE = "pi-summary.json";

/**
 * The settings in force for one working directory, with the defaults already applied.
 *
 * `model` is the one field, and it stays optional, because its absence is a meaningful state -
 * it means "summarize with the session's current model" - and a present-but-unusable value
 * has to reach the summarizer to be reported rather than being quietly replaced here.
 */
export type Settings = {
	/** Summarizer as `provider/model`, or `undefined` for the session's current model. */
	model: string | undefined;
};

/**
 * Read the settings, project scope winning over the agent dir, field by field.
 *
 * Every failure mode here means "nothing configured at this scope": a missing file, a
 * malformed one, a key of the wrong type. The next scope, then the defaults, decide. That is
 * deliberate - settings are read in the middle of a summarize, and refusing to summarize
 * because a settings file has a stray comma would take the model's choice away over a typo.
 * The one thing that is *not* resolved here is the model, which is reported by the summarizer.
 *
 * Both files are read on every call rather than cached: a session can switch project, and a
 * user editing the file mid-session should see it take effect on the next summarize. The
 * reads are two small synchronous file reads.
 *
 * This function does not throw. It is called from the middle of a summarize, and a settings
 * problem must degrade to the defaults rather than turn a summarize that would have succeeded
 * into an error. That is why the paths are resolved defensively too: `findProjectRoot` walks
 * the filesystem and `getAgentDir` reads the environment, so either can fail on a context
 * this code did not anticipate.
 */
export function readSettings(cwd: string): Settings {
	const project = readSettingsFile(projectSettingsPath(cwd));
	const global = readSettingsFile(agentSettingsPath());
	return {
		model: modelOf(project) ?? modelOf(global),
	};
}

/**
 * Where the project's settings live, or a path that reads as "no settings".
 *
 * The fallback is the point: an unresolvable path is caught by `readSettingsFile` and yields
 * the defaults, so a failure here cannot surface as a failed summarize.
 */
function projectSettingsPath(cwd: string): string {
	try {
		return join(findProjectRoot(cwd), ".pi", SETTINGS_FILE);
	} catch {
		return join("\0unresolvable", SETTINGS_FILE);
	}
}

/** The agent dir's settings path, on the same terms. */
function agentSettingsPath(): string {
	try {
		return join(getAgentDir(), SETTINGS_FILE);
	} catch {
		return join("\0unresolvable", SETTINGS_FILE);
	}
}

/** One settings file as a plain object, or an empty object if it cannot supply one. */
function readSettingsFile(path: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return {};
	}
	return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: {};
}

function modelOf(settings: Record<string, unknown>): string | undefined {
	const value = settings.model;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
