import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { findProjectRoot } from "./paths.ts";

/**
 * This extension's settings file, named rather than keyed.
 *
 * It is not a key in pi's `settings.json` because this file is ours from the first line:
 * every key in it is a setting of this extension, so a typo is not silently ignored beside
 * pi's own configuration. Two copies exist and the project's wins, key by key - the same
 * shape pi uses for its own global and project scopes, so one scope can pin the model while
 * the other pins the trap.
 */
export const SETTINGS_FILE = "pi-summary.json";

/**
 * When the read guard answers an oversized read with the file's map.
 *
 * - `none` — never. Every read runs, whatever its size.
 * - `normal` — only for a read the model itself issued. A read from another tool (a
 *   codemode script, anything calling `ctx.executeTool()`) is answered with the file.
 * - `always` — for both.
 */
export type TrapMode = "none" | "normal" | "always";

/** Every trap mode, in the order the README lists them. */
export const TRAP_MODES: readonly TrapMode[] = ["none", "normal", "always"];

/** The trap mode when nothing is configured: the behaviour this extension shipped before the setting existed. */
export const DEFAULT_TRAP: TrapMode = "normal";

/**
 * Line limit when nothing is configured.
 *
 * 200 is the number this extension shipped with, so an unconfigured install behaves exactly
 * as it did. It is a floor as much as a ceiling: a value below it is honoured, which is how
 * a file of 100 lines gets a map in a session that has decided whole files are too expensive.
 */
export const DEFAULT_TRAP_LIMIT = 200;

/**
 * The settings in force for one working directory, with the defaults already applied.
 *
 * `model` is the one field that stays optional, because its absence is a meaningful state -
 * it means "summarize with the session's current model" - and a present-but-unusable value
 * has to reach the summarizer to be reported rather than being quietly replaced here. Every
 * other field is resolved: a caller never handles an unconfigured trap or an absent limit.
 */
export type Settings = {
	/** Summarizer as `provider/model`, or `undefined` for the session's current model. */
	model: string | undefined;
	/** When an oversized read is answered with the file's map. */
	trap: TrapMode;
	/** Lines a read may span before the trap answers with the map instead. */
	trapLimit: number;
};

/**
 * Read the settings, project scope winning over the agent dir, field by field.
 *
 * Every failure mode here means "nothing configured at this scope": a missing file, a
 * malformed one, a key of the wrong type. The next scope, then the defaults, decide. That is
 * deliberate - settings are read in the middle of a read that must not fail, and refusing a
 * read because a settings file has a stray comma would take the file away over a typo. The
 * one thing that is *not* resolved here is the model, which is reported by the summarizer.
 *
 * Both files are read on every call rather than cached: a session can switch project, and a
 * user editing the file mid-session should see it take effect on the next read. The reads are
 * two small synchronous file reads, next to the hashing the trap already does.
 *
 * This function does not throw. It is called from inside a `read` and from the middle of a
 * summarize, and in both places a settings problem must degrade to the defaults rather than
 * turn a read that would have succeeded into an error. That is why the paths are resolved
 * defensively too: `findProjectRoot` walks the filesystem and `getAgentDir` reads the
 * environment, so either can fail on a context this code did not anticipate.
 */
export function readSettings(cwd: string): Settings {
	const project = readSettingsFile(projectSettingsPath(cwd));
	const global = readSettingsFile(agentSettingsPath());
	return {
		model: modelOf(project) ?? modelOf(global),
		trap: trapOf(project) ?? trapOf(global) ?? DEFAULT_TRAP,
		trapLimit: trapLimitOf(project) ?? trapLimitOf(global) ?? DEFAULT_TRAP_LIMIT,
	};
}

/**
 * Where the project's settings live, or a path that reads as "no settings".
 *
 * The fallback is the point: an unresolvable path is caught by `readSettingsFile` and yields
 * the defaults, so a failure here cannot surface as a failed read.
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

function trapOf(settings: Record<string, unknown>): TrapMode | undefined {
	const value = settings.trap;
	return typeof value === "string" && (TRAP_MODES as readonly string[]).includes(value)
		? (value as TrapMode)
		: undefined;
}

/**
 * A positive whole number of lines, or nothing.
 *
 * A fractional or zero value is a typo rather than a limit, and a trap that intercepted
 * every read of more than zero lines would answer reads with maps nobody asked for.
 */
function trapLimitOf(settings: Record<string, unknown>): number | undefined {
	const value = settings.trap_limit;
	return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/**
 * pi's `images.autoResize` setting, project scope winning over global.
 *
 * The extension replaces the built-in `read` tool, and pi builds that tool with this setting.
 * The value is not reachable from an extension context, so it is read from the same settings
 * files pi reads. It matters because the replacement delegates real reads to a definition it
 * builds itself, and building it with the default would quietly ignore the user's choice.
 *
 * This is pi's setting, not ours, so it lives in pi's `settings.json` and gets no copy in
 * `pi-summary.json`.
 *
 * Reading it loads both settings files synchronously, so callers should ask only when the
 * value will be used - the built-in `read` consults it for images alone.
 *
 * Anything unreadable means the default, which is what pi uses when the key is absent.
 */
export function readImageAutoResize(cwd: string): boolean {
	let settings: SettingsManager;
	try {
		settings = SettingsManager.create(cwd);
	} catch {
		return true;
	}

	const project = imageAutoResizeOf(settings.getProjectSettings() as Record<string, unknown>);
	return project ?? imageAutoResizeOf(settings.getGlobalSettings() as Record<string, unknown>) ?? true;
}

function imageAutoResizeOf(settings: Record<string, unknown>): boolean | undefined {
	const images = settings.images;
	if (!images || typeof images !== "object" || Array.isArray(images)) return undefined;
	const autoResize = (images as Record<string, unknown>).autoResize;
	return typeof autoResize === "boolean" ? autoResize : undefined;
}
