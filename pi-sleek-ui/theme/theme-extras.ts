// Theme vars/export reader
// Reads raw theme vars/export values from the active theme's JSON file on disk.
// The framework doesn't expose all of these raw values via theme.definition, so
// we locate and parse the file directly.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fgHex } from "./ansi.js";
import { isHexColor } from "./color.js";

const extensionDir = dirname(fileURLToPath(import.meta.url));

let cachedVars: Record<string, string> | null = null;
let cachedColors: Record<string, string> | null = null;
let cachedThemeExport: Record<string, string> | null = null;
let cachedThemeName: string | null = null;

type ThemeDiscovery = {
	vars: Record<string, string> | null;
	colors: Record<string, string> | null;
	themeExport: Record<string, string> | null;
};

function themeDiscoveryFromContent(content: any): ThemeDiscovery | null {
	const vars = content?.vars && typeof content.vars === "object"
		? content.vars as Record<string, string>
		: null;
	const colors = content?.colors && typeof content.colors === "object"
		? content.colors as Record<string, string>
		: null;
	const themeExport = content?.export && typeof content.export === "object"
		? content.export as Record<string, string>
		: null;
	return vars || colors || themeExport ? { vars, colors, themeExport } : null;
}

function readThemeDiscoveryFromPath(filePath: string): ThemeDiscovery | null {
	try {
		if (!filePath || !existsSync(filePath)) return null;
		const content = JSON.parse(readFileSync(filePath, "utf-8"));
		return themeDiscoveryFromContent(content);
	} catch {
		return null;
	}
}

function resolveThemeSourcePath(theme: any): string {
	return typeof theme?.sourcePath === "string"
		? theme.sourcePath
		: typeof theme?.definition?.sourcePath === "string"
			? theme.definition.sourcePath
			: "";
}

function addThemeDir(searchDirs: Set<string>, dir: string): void {
	if (existsSync(dir)) searchDirs.add(dir);
}

function addBundledThemeDirs(searchDirs: Set<string>): void {
	for (const root of [extensionDir, process.cwd()]) {
		for (const scope of ["@earendil-works", "@mariozechner"]) {
			addThemeDir(searchDirs, resolve(root, "node_modules", scope, "pi-coding-agent", "dist", "modes", "interactive", "theme"));
			addThemeDir(searchDirs, resolve(root, "node_modules", scope, "pi-coding-agent", "dist", "theme"));
		}
	}
}

/**
 * Scan known theme directories for a JSON file whose "name" matches themeName.
 * Returns parsed vars/export data, or null if not found.
 */
function discoverThemeExtras(themeName: string): ThemeDiscovery | null {
	const searchDirs = new Set<string>();

	// Global/project top-level theme dirs, the bundled extension themes and the
	// active theme's own sourcePath (read first in loadThemeCache).
	addThemeDir(searchDirs, join(homedir(), ".pi", "agent", "themes"));
	addThemeDir(searchDirs, resolve(process.cwd(), ".pi", "themes"));
	addBundledThemeDirs(searchDirs);

	// Search all directories for matching theme file
	for (const dir of searchDirs) {
		try {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".json")) continue;
				const filePath = join(dir, file);
				try {
					const content = JSON.parse(readFileSync(filePath, "utf-8"));
					if (content?.name === themeName) {
						const result = themeDiscoveryFromContent(content);
						if (result) return result;
					}
				} catch {}
			}
		} catch {}
	}

	return null;
}

/** Theme display name from the theme object, or "" when it exposes none. */
export function themeName(theme: any): string {
	if (typeof theme?.definition?.name === "string") return theme.definition.name;
	return typeof theme?.name === "string" ? theme.name : "";
}

function resolveThemeName(theme: any): string | null {
	const name = themeName(theme);
	if (name) return name;
	// Try reading from settings as last resort
	try {
		const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
		if (existsSync(settingsPath)) {
			const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			if (typeof settings.theme === "string") return settings.theme;
		}
	} catch {}
	return null;
}

export function setFullTheme(theme: any, force = false): void {
	loadThemeCache(theme, force);
}

/**
 * Cache the vars/colors/export of `theme`.
 *
 * The cache key is the theme (its source path or name) and it is ALWAYS latched, including
 * when the theme could not be read back: re-scanning the theme directories on every call
 * would be a per-frame cost. What matters is that a *different* theme replaces the entry —
 * at startup pi can report a theme that is not on disk yet (or a different initial theme),
 * and the old behaviour latched that failed scan permanently, so every lookup kept returning
 * its fallback for the rest of the session. That is the "colours are wrong until /reload"
 * bug: only a forced refresh repaired it.
 */
function loadThemeCache(theme: any, force = false): void {
	const themeName = resolveThemeName(theme);
	const sourcePath = resolveThemeSourcePath(theme);
	const cacheKey = sourcePath || themeName;
	if (!cacheKey) return;
	// Same theme as the cached one (resolved or not) — keep it and never rescan per call.
	if (!force && cacheKey === cachedThemeName) return;

	const result = readThemeDiscoveryFromPath(sourcePath) ?? (themeName ? discoverThemeExtras(themeName) : null);
	cachedThemeName = cacheKey;
	cachedVars = result?.vars ?? null;
	cachedColors = result?.colors ?? null;
	cachedThemeExport = result?.themeExport ?? null;
}

function ensureThemeExportLoaded(theme: any): void {
	loadThemeCache(theme);
}

export function getThemePageBackground(theme: any): string {
	ensureThemeExportLoaded(theme);
	return pageBackgroundFromThemeJson({ vars: cachedVars ?? undefined, export: cachedThemeExport ?? undefined });
}

/**
 * Page background from a parsed theme JSON: `vars.bg` when it is a hex colour, else
 * `export.pageBg` (following one level of `vars` indirection). Returns "" when neither
 * resolves. Shared by the OSC 11 page background and the theme picker's light/dark tag
 * so the two can never disagree.
 */
export function pageBackgroundFromThemeJson(
	parsed: { vars?: Record<string, unknown>; export?: Record<string, unknown> } | null | undefined,
): string {
	const vars = parsed?.vars ?? {};
	const directBg = typeof vars.bg === "string" ? vars.bg : "";
	if (isHexColor(directBg)) return directBg;
	const pageBg = typeof parsed?.export?.pageBg === "string" ? parsed.export.pageBg : "";
	if (isHexColor(pageBg)) return pageBg;
	const referenced = pageBg ? vars[pageBg] : undefined;
	return typeof referenced === "string" && isHexColor(referenced) ? referenced : "";
}

export function getThemeVarBackground(theme: any, varName: string): string {
	ensureThemeExportLoaded(theme);
	const value = resolveThemeVarRawValue(varName);
	return typeof value === "string" && isHexColor(value) ? value : "";
}

/**
 * Resolve a theme var to its raw leaf value: an ANSI palette index (number), a hex
 * string, or null. `vars` values can be numbers (`Terminal`: `"green": 2`), hexes, or
 * the name of another var/token, so this follows the same single-step indirection the
 * theme loader uses.
 */
function resolveThemeVarRawValue(varName: string): string | number | null {
	let value = cachedVars?.[varName] as string | number | undefined;
	const seen = new Set<string>();
	for (let depth = 0; depth < 8; depth++) {
		if (value === undefined || value === null) return null;
		if (typeof value === "number") return value;
		if (value === "") return null;
		if (isHexColor(value)) return value;
		if (seen.has(value)) return null;
		seen.add(value);
		value = (cachedVars?.[value] ?? cachedColors?.[value]) as string | number | undefined;
	}
	return null;
}

/**
 * ANSI foreground escape for a theme var that resolves to a palette index (0-255),
 * empty otherwise. Palette themes (`Terminal`) name ANSI indices in `vars`, which
 * `getThemeVarBackground` cannot express as hex; emitting the index directly keeps the
 * badge/chip colours on the terminal's own palette instead of dropping them.
 */
export function getThemeVarAnsi(theme: any, varName: string): string {
	ensureThemeExportLoaded(theme);
	const value = resolveThemeVarRawValue(varName);
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) return "";
	return `\x1b[38;5;${value}m`;
}

/**
 * Painter that wraps `text` in a theme var's colour — the JSON var when it is
 * hex, otherwise the live ANSI palette escape. Returns null when neither
 * resolves, so callers can fall back to a semantic token (`theme.fg(...)`).
 */
export function themeVarPainter(theme: any, varName: string): ((text: string) => string) | null {
	const hex = getThemeVarBackground(theme, varName);
	if (isHexColor(hex)) return (text: string) => fgHex(theme, hex, text);
	const ansi = getThemeVarAnsi(theme, varName);
	if (ansi) return (text: string) => `${ansi}${text}\x1b[39m`;
	return null;
}
