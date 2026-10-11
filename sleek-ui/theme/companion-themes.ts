import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { installPatch } from "../core/patch-registry.js";

type BundledTheme = {
	name: string;
	path: string;
};

type InteractiveModeLike = {
	prototype?: {
		bindCurrentSessionExtensions?: (...args: unknown[]) => Promise<unknown>;
		init?: (...args: unknown[]) => Promise<unknown>;
		[COMPANION_THEME_STATE]?: CompanionThemeState;
	};
};

type ThemeControllerLike = {
	showError?: (message: string) => void;
};

type CompanionThemeState = {
	pendingThemeReapply: boolean;
	bundledNames: ReadonlySet<string>;
};

/**
 * Companion themes live in `themes/` (24 JSON files — see themes/README.md), so a
 * fresh clone works without `npm install` and with no dependency on another
 * package or extension.
 */
const BUNDLED_THEMES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "themes");
const COMPANION_THEME_STATE = Symbol.for("pi-sleek.companion-themes.state");

// The extension factory runs on every session bind (startup/new/resume/fork/
// reload), so cache the parsed list for the lifetime of ONE module instance.
// Deliberately NOT keyed on globalThis: /reload re-imports this module, and a
// process-wide cache would keep returning the theme list from the previous
// version, so themes added/removed/renamed on disk only appeared after a full
// pi restart. Module-local means /reload re-reads the directory (a readdir +
// 24 small JSON parses per bind, which is negligible). A throw leaves nothing
// cached, so the next bind retries.
let bundledThemesCache: BundledTheme[] | undefined;

function readBundledThemes(): BundledTheme[] {
	if (!existsSync(BUNDLED_THEMES_DIR)) return [];
	return readdirSync(BUNDLED_THEMES_DIR)
		.filter((file) => file.endsWith(".json"))
		.sort()
		.map((file) => {
			const path = join(BUNDLED_THEMES_DIR, file);
			const parsed = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown };
			if (typeof parsed.name !== "string" || parsed.name.length === 0) {
				throw new Error(`Bundled theme has no valid name: ${path}`);
			}
			return { name: parsed.name, path };
		});
}

function loadBundledThemes(): BundledTheme[] {
	return (bundledThemesCache ??= readBundledThemes());
}

function installThemeReapplyPatch(InteractiveMode: unknown, state: CompanionThemeState): void {
	const prototype = (InteractiveMode as InteractiveModeLike | null | undefined)?.prototype;
	if (!prototype) return;
	prototype[COMPANION_THEME_STATE] = state;
	installPatch(prototype, "bindCurrentSessionExtensions", "companion-themes.bindCurrentSessionExtensions", (original) =>
		async function (this: { themeController?: { applyFromSettings?: () => Promise<void> } }, ...args: unknown[]) {
			const result = await original.apply(this, args);
			const activeState = prototype[COMPANION_THEME_STATE];
			if (activeState?.pendingThemeReapply) {
				activeState.pendingThemeReapply = false;
				await this.themeController?.applyFromSettings?.();
			}
			return result;
		},
	);
}

/**
 * Pi applies the settings theme inside `init()` before extensions can answer
 * `resources_discover`, so a bundled theme selected in settings fails once with a
 * visible "Failed to load theme" banner and is re-applied after discovery. Silence
 * only that transient failure for bundled theme names during `init()`.
 */
function installStartupThemeErrorSuppression(InteractiveMode: unknown, state: CompanionThemeState): void {
	const prototype = (InteractiveMode as InteractiveModeLike | null | undefined)?.prototype;
	if (!prototype) return;
	installPatch(prototype, "init", "companion-themes.init", (original) =>
		async function (this: { themeController?: ThemeControllerLike }, ...args: unknown[]) {
			const controller = this.themeController;
			const showError = controller?.showError;
			if (!controller || typeof showError !== "function") return original.apply(this, args);
			controller.showError = (message: string) => {
				const activeState = prototype[COMPANION_THEME_STATE] ?? state;
				if (isBundledThemeLoadError(message, activeState.bundledNames)) return;
				showError.call(controller, message);
			};
			try {
				return await original.apply(this, args);
			} finally {
				controller.showError = showError;
			}
		},
	);
}

function isBundledThemeLoadError(message: string, bundledNames: ReadonlySet<string>): boolean {
	const match = /^Failed to load theme "([^"]+)"/.exec(message);
	return match !== null && bundledNames.has(match[1]);
}

export function registerCompanionThemes(pi: ExtensionAPI, InteractiveMode: unknown): void {
	const bundledThemes = loadBundledThemes();
	const state: CompanionThemeState = {
		pendingThemeReapply: false,
		bundledNames: new Set(bundledThemes.map((theme) => theme.name)),
	};
	installThemeReapplyPatch(InteractiveMode, state);
	installStartupThemeErrorSuppression(InteractiveMode, state);
	pi.on("resources_discover", (_event, _ctx) => {
		// Register the bundled companion themes on every session bind. Pi rebuilds
		// the session resource loader for each session runtime (resume/new/fork)
		// and on reloads, so previously registered themes must be returned again.
		// Deduping against the global registry (ctx.ui.getAllThemes()) would skip
		// re-registration: that registry still holds the previous session's themes
		// when this runs, and pi replaces it with the new loader's theme set right
		// after binding, so the companion themes would vanish and the settings
		// theme would fall back to the built-in dark theme. resources_discover
		// fires once per session bind and pi merges returned paths, so returning
		// all bundled paths unconditionally is safe.
		state.pendingThemeReapply = true;
		return { themePaths: bundledThemes.map((theme) => theme.path) };
	});
}
