import { SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * Settings key that holds this extension's own configuration.
 *
 * pi's `Settings` interface has no field for extension config, but the settings file is
 * not filtered: unknown top-level keys are preserved through load and write. Verified by
 * writing `{"summary":{"model":"..."}}`, forcing an unrelated write, and reading the file
 * back intact.
 */
export const SETTINGS_KEY = "summary";

/** Extracted form of the `summary` settings key. */
export type SummarySettings = {
	/** Summarizer as `provider/model`. */
	model?: string;
};

/**
 * Read the `summary` key from pi's settings, project scope winning over global.
 *
 * Accepts either the object form or a bare `"summary": "provider/model"` string, because
 * a single-value key reads better as a string and there is only one field worth setting.
 *
 * A malformed or unreadable config is reported as "not configured" rather than thrown:
 * the caller falls back to the session model, which is a working configuration.
 */
export function readSummarySettings(
	cwd: string,
	manager?: SettingsManager,
): SummarySettings {
	let settings: SettingsManager;
	try {
		settings = manager ?? SettingsManager.create(cwd);
	} catch {
		return {};
	}

	// Project scope is checked first so a project can pin its own summarizer.
	const project = pick((settings.getProjectSettings() as Record<string, unknown>)[SETTINGS_KEY]);
	if (project.model) return project;
	return pick((settings.getGlobalSettings() as Record<string, unknown>)[SETTINGS_KEY]);
}

/** Normalize one settings value into `SummarySettings`, ignoring anything unusable. */
function pick(raw: unknown): SummarySettings {
	if (typeof raw === "string") {
		const model = raw.trim();
		return model.length > 0 ? { model } : {};
	}
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const model = (raw as Record<string, unknown>).model;
		if (typeof model === "string" && model.trim().length > 0) {
			return { model: model.trim() };
		}
	}
	return {};
}
