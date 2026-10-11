/**
 * `/sleek` → Themes browser, rendered with the extension-manager style popup.
 *
 * Left pane lists the available themes with a friendly display name and a
 * light/dark tag (the terminal-following `Terminal` theme is tagged `custom`),
 * right pane previews the highlighted theme's palette. Moving the selection
 * live-previews the theme instance; `enter` applies (and persists) by name;
 * `esc` restores the theme that was active when the popup opened.
 */
import { readFileSync } from "node:fs";

import { MenuPopup, type MenuFilter, type MenuRow } from "./popup.js";
import { menuOptionMarker, menuPrimaryHint, type MenuTheme } from "./frame.js";
import { hexLuminance } from "../theme/color.js";
import { pageBackgroundFromThemeJson } from "../theme/theme-extras.js";

export interface ThemePickerHost {
	getAllThemes(): { name: string; path?: string | undefined }[];
	getTheme(name: string): unknown;
	setTheme(theme: string | unknown): { success: boolean; error?: string };
	notify(message: string, kind?: "info" | "warning" | "error"): void;
}

export interface ThemePickerArgs {
	tui: { terminal?: { rows?: number }; requestRender(): void };
	theme: MenuTheme;
	host: ThemePickerHost;
	/** Theme active when the popup opened (marked in the list, restored on cancel). */
	currentName: string;
	/** Theme instance to restore on cancel; undefined when the name was unknown. */
	original: unknown;
	done: (result: string | undefined) => void;
}

/** `custom` covers themes that are neither light nor dark (terminal-following themes). */
type ThemeAppearance = "light" | "dark" | "custom";

/** Appearance per theme name. The theme files do not change mid-session. */
const appearanceCache = new Map<string, ThemeAppearance>();

/** "catppuccin-latte" → "Catppuccin Latte". */
export function displayThemeName(name: string): string {
	return name
		.split(/[-_\s]+/)
		.filter((word) => word.length > 0)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

function appearanceFromName(name: string): ThemeAppearance {
	if (/(^|[-_\s])(system|terminal)([-_\s]|$)/.test(name.toLowerCase())) return "custom";
	return /(^|[-_\s])(light|latte|day|dawn)([-_\s]|$)/.test(name.toLowerCase()) ? "light" : "dark";
}

/**
 * Classify a theme by the luminance of its page background — the same colour the
 * OSC 11 page background uses (`vars.bg`, else `export.pageBg`). Reading the JSON
 * directly instead of `getThemePageBackground()` is deliberate: that helper caches
 * by the *active* theme, so querying other themes would thrash the cache the
 * running session depends on. Both paths share `pageBackgroundFromThemeJson`.
 */
function appearanceFromFile(path: string | undefined): ThemeAppearance | undefined {
	if (!path) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as {
			vars?: Record<string, unknown>;
			export?: Record<string, unknown>;
		};
		const luminance = hexLuminance(pageBackgroundFromThemeJson(parsed));
		if (luminance === undefined) return undefined;
		return luminance > 0.5 ? "light" : "dark";
	} catch {
		// Missing/unreadable/unparsable theme file: fall back to the name.
		return undefined;
	}
}

function themeAppearance(name: string, path: string | undefined): ThemeAppearance {
	const cached = appearanceCache.get(name);
	if (cached) return cached;
	const appearance = appearanceFromFile(path) ?? appearanceFromName(name);
	appearanceCache.set(name, appearance);
	return appearance;
}

export function createThemeMenuComponent(args: ThemePickerArgs): MenuPopup {
	const themes = args.host.getAllThemes();
	const entryOf = (name: string): { name: string; path?: string | undefined } | undefined =>
		themes.find((entry) => entry.name === name);
	type PaletteSource = { fg?: (color: string, text: string) => string };
	const paletteOf = (name: string): PaletteSource | undefined => {
		const value = args.host.getTheme(name);
		return value && typeof value === "object" ? (value as PaletteSource) : undefined;
	};

	const rows = (): MenuRow[] =>
		themes.map((entry) => ({
			id: entry.name,
			label: displayThemeName(entry.name),
			meta: themeAppearance(entry.name, entry.path),
			state: entry.name === args.currentName ? "on" : "info",
			marker: menuOptionMarker(args.theme, entry.name === args.currentName),
			search: `${entry.name} ${displayThemeName(entry.name)} ${themeAppearance(entry.name, entry.path)}`,
		}));

	const filters: MenuFilter[] = [
		{
			id: "appearance",
			label: "appearance",
			key: "t",
			values: ["all", "light", "dark", "custom"],
			matches: (row, value) => {
				if (value === "all") return true;
				const entry = entryOf(row.id);
				return entry !== undefined && themeAppearance(entry.name, entry.path) === value;
			},
		},
	];

	// Applying a theme globally forces a full re-render of the transcript, which is
	// expensive in a long session. Debounce the live preview so holding/mashing the
	// arrow keys does not repaint once per keypress.
	const PREVIEW_DEBOUNCE_MS = 150;
	let previewTimer: ReturnType<typeof setTimeout> | undefined;
	const cancelPreview = (): void => {
		if (previewTimer) {
			clearTimeout(previewTimer);
			previewTimer = undefined;
		}
	};
	const preview = (row: MenuRow | undefined): void => {
		cancelPreview();
		if (!row) return;
		const timer = setTimeout(() => {
			previewTimer = undefined;
			const palette = paletteOf(row.id);
			if (palette) args.host.setTheme(palette);
		}, PREVIEW_DEBOUNCE_MS);
		timer.unref?.();
		previewTimer = timer;
	};

	const primaryHint = menuPrimaryHint(args.theme, { select: "select theme", close: "cancel", extra: [["alt+t", "appearance"]] });

	return new MenuPopup(args.theme, {
		title: `Themes · ${themes.length}`,
		columnTitles: { label: "THEME", description: "APPEARANCE" },
		rows,
		filters,
		initialId: args.currentName,
		primaryHint,
		onSelectionChange: (row) => preview(row),
		onDispose: cancelPreview,
		onActivate: (row) => {
			cancelPreview();
			const result = args.host.setTheme(row.id);
			if (!result.success) {
				if (args.original) args.host.setTheme(args.original);
				args.host.notify(`Could not apply theme "${row.id}"${result.error ? `: ${result.error}` : ""}`, "error");
			} else {
				args.host.notify(`Theme: ${row.id}`, "info");
			}
			args.done(result.success ? row.id : undefined);
		},
		onClose: () => {
			cancelPreview();
			if (args.original) args.host.setTheme(args.original);
			args.done(undefined);
		},
		terminalRows: () => args.tui.terminal?.rows ?? 40,
		requestRender: () => args.tui.requestRender(),
	});
}
