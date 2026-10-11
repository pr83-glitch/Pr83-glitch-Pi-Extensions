/**
 * ANSI frame-background painting — the cross-platform fallback for renderable
 * cells when OSC 11 is unavailable or ignored (Windows Terminal, some WSL
 * setups), and the thing that makes pi's chat region carry the theme's page
 * colour rather than only the terminal padding.
 *
 * Ported from pi-zazz (`theme/frame-background.ts`), minus its debug
 * instrumentation. The one behavioural addition: painting is gated by a
 * module-level enabled flag so the `/sleek` "Theme background" toggle can turn
 * the background off completely (letting a transparent terminal show through),
 * not just skip the OSC 11 write.
 */
import { ERASE_LINE, RESET_BACKGROUND, bgHexAnsi, keepAnsiBackgroundAcrossResets } from "./ansi.js";
import { safeVisibleWidth } from "../render-budget.js";
import { getThemePageBackground } from "./theme-extras.js";

const KITTY_IMAGE_PREFIX = "\x1b_G";
const ITERM2_IMAGE_PREFIX = "\x1b]1337;File=";

/** When false, `resolveFrameBackgroundAnsi` yields no escape and painters pass through. */
let frameBackgroundEnabled = true;

/** Set from the `sleek-useThemeBackground` config value (and the `/sleek` toggle). */
export function setFrameBackgroundEnabled(enabled: boolean): void {
	frameBackgroundEnabled = enabled !== false;
}

function isImageRenderLine(line: string): boolean {
	return line.includes(KITTY_IMAGE_PREFIX) || line.includes(ITERM2_IMAGE_PREFIX);
}

export function resolveFrameBackgroundAnsi(theme: any): string {
	if (!frameBackgroundEnabled) return "";
	const pageBg = getThemePageBackground(theme);
	return pageBg ? bgHexAnsi(theme, pageBg) : "";
}

// Bounded memo for painted lines. The document is repainted every frame, while
// most of it is unchanged, so caching by (bgAnsi, width, line) turns the
// per-line regex/width work into lookups. Cleared when the paint parameters
// change or the cache grows past the cap (streaming adds unique lines).
const PAINT_CACHE_LIMIT = 4000;
// Evict this fraction of the oldest entries when the cap is reached. A full
// clear() here used to force one frame to repaint every visible line from
// scratch (regex + width work) mid-stream; evicting oldest-first keeps the
// stable document lines cached. Map preserves insertion order, so the first
// keys are the oldest.
const PAINT_CACHE_EVICT_FRACTION = 0.25;
let paintCacheBg = "";
let paintCacheWidth = -1;
const paintCache = new Map<string, string>();

function evictOldestPaintEntries(): void {
	const target = Math.max(1, Math.floor(PAINT_CACHE_LIMIT * PAINT_CACHE_EVICT_FRACTION));
	let removed = 0;
	for (const oldest of paintCache.keys()) {
		paintCache.delete(oldest);
		if (++removed >= target) break;
	}
}

function paintFrameBackgroundLine(line: string, bgAnsi: string, targetWidth = 0): string {
	const text = String(line);
	if (!bgAnsi || isImageRenderLine(text)) return text;
	const width = Number.isFinite(targetWidth) ? Math.max(0, Math.floor(targetWidth)) : 0;

	if (paintCacheBg !== bgAnsi || paintCacheWidth !== width) {
		paintCache.clear();
		paintCacheBg = bgAnsi;
		paintCacheWidth = width;
	}
	const cached = paintCache.get(text);
	if (cached !== undefined) return cached;

	// Fast path for plain (ANSI-free) lines: no regex rewrite needed.
	const body = text.includes("\x1b[") ? keepAnsiBackgroundAcrossResets(text, bgAnsi) : text;
	const fill = width > 0 ? " ".repeat(Math.max(0, width - safeVisibleWidth(body))) : "";
	const painted = `${bgAnsi}${ERASE_LINE}${body}${bgAnsi}${fill}${RESET_BACKGROUND}`;

	if (paintCache.size >= PAINT_CACHE_LIMIT) evictOldestPaintEntries();
	paintCache.set(text, painted);
	return painted;
}

export function paintFrameBackgroundClears(text: string, bgAnsi: string): string {
	if (!bgAnsi) return String(text);
	const value = String(text);
	// Fast path: only lines that actually erase to end-of-line need rewriting.
	if (!value.includes("\x1b[2K")) return value;
	return value.replace(/\x1b\[2K/g, `${bgAnsi}${ERASE_LINE}`);
}

export function paintFrameBackgroundLines(lines: readonly string[], bgAnsi: string, targetWidth = 0): string[] {
	return lines.map((line) => paintFrameBackgroundLine(line, bgAnsi, targetWidth));
}

export function padFrameRows(lines: readonly string[], minRows: number): string[] {
	const frameLines = lines.map((line) => String(line));
	while (frameLines.length < minRows) frameLines.push("");
	return frameLines;
}
