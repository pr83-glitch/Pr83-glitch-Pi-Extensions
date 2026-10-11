/**
 * Two-tone detail shimmer for newly spawned or still-running tool blocks.
 *
 * Mirrors `/login`'s "Sign in with Radius" option — a soft colour band sweeping
 * left to right across the text — but blends between the theme's `dim` and
 * `text` colours instead of the Radius logo palette. The colours are resolved
 * per theme and mixed with Sleek's own sRGB maths, so it stays correct on
 * Terminal/palette themes (ANSI 256) and hex themes alike.
 *
 * `density.ts` owns each block's monotonic start time and the shared repaint
 * ticker. A new block starts its own sweep without restarting its neighbours.
 */
import * as tui from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { fgHexAnsi, parseAnsiColorCode, stripAnsi } from "../theme/ansi.js";
import { blendRgb, hexToRgb, rgbToHex } from "../theme/color.js";
import { getThemeVarBackground, themeName } from "../theme/theme-extras.js";

/** Eight graphemes per dim/bright half-wave: twice Radius's spatial width. */
const BAND_CHARS = 8;
/** Keep the relaxed 1.6-second cycle despite the wider waves. */
const CHARS_PER_SECOND = 10;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Ticker cadence; `density.ts` drives it and must use the same value. */
export const SHIMMER_FRAME_MS = 60;

/** One complete dim↔text sweep. */
export const SHIMMER_LOOP_MS = (BAND_CHARS * 2 / CHARS_PER_SECOND) * 1000;
/** Six repaint steps to settle the last shine into the original muted styling. */
export const SHIMMER_FADE_MS = 360;
export type ToolShimmerFrame = { offset: number; fade: number };

/** Private bridge through Pi's existing per-call renderer state. */
export const TOOL_DETAIL_ANIMATION = Symbol.for("pi-sleek.tool-detail.animation");

/** Offset for a block's elapsed animation time, in characters. */
export function shimmerOffsetChars(elapsedMs: number): number {
	return elapsedMs / 1000 * CHARS_PER_SECOND;
}

/** Preserve the original styled detail when idle or colours cannot be resolved. */
export function shimmerToolDetail(text: string, theme: any, state: any): string {
	const frame: ToolShimmerFrame | null = state?.[TOOL_DETAIL_ANIMATION]?.(text) ?? null;
	return frame ? shimmerText(text, theme, frame.offset, frame.fade) : text;
}

/** Refresh only the detail each render, retaining Text/Box wrapping and padding. */
export function animatedToolCall(theme: any, context: any, build: (detail: (text: string) => string) => Component): Component {
	let component: Component | undefined;
	let previousFrame: ToolShimmerFrame | null | undefined;
	return {
		render(width: number): string[] {
			let frame: ToolShimmerFrame | null = context?.state?.[TOOL_DETAIL_ANIMATION]?.() ?? null;
			if (!component || frame !== previousFrame) {
				component = build((text) => {
					frame = context?.state?.[TOOL_DETAIL_ANIMATION]?.(text) ?? null;
					return frame ? shimmerText(text, theme, frame.offset, frame.fade) : text;
				});
				previousFrame = frame;
			}
			return component.render(width);
		},
		invalidate(): void {
			component?.invalidate();
			previousFrame = undefined;
		},
	};
}

/**
 * Resolve concrete theme colours first (including terminal-default/faint tokens),
 * then legacy JSON vars and live ANSI token escapes.
 */
function themeTokenHex(theme: any, token: string): string | null {
	// Older supported Pi releases lack concrete colour utilities; retain their ANSI fallback.
	const convert = (tui as unknown as { colorToRgb?: (color: unknown) => { r: number; g: number; b: number } }).colorToRgb;
	try {
		const color = theme?.colors?.[token];
		if (color && convert) return rgbToHex(convert(color));
	} catch { /* Unknown theme object: try the legacy resolver. */ }
	const hex = themeName(theme) || theme?.sourcePath || theme?.definition?.sourcePath
		? getThemeVarBackground(theme, token) : "";
	if (hex) return hex;
	let ansi = "";
	try {
		ansi = theme?.getFgAnsi?.(token) ?? "";
	} catch {
		return null;
	}
	const rgb = parseAnsiColorCode(ansi);
	return rgb ? rgbToHex(rgb) : null;
}

/** Do not drive repainting when colour resolution cannot produce a visible sweep. */
export function canShimmer(theme: any, idleToken = "muted"): boolean {
	const base = themeTokenHex(theme, "dim");
	const peak = themeTokenHex(theme, "text");
	return Boolean(base && peak && base !== peak && themeTokenHex(theme, idleToken));
}

/**
 * Colour `text` with a band of `text` sweeping across a `dim` base.
 * Returns the input unchanged when either token cannot be resolved to a colour
 * (e.g. an unknown/hostile theme object), so callers never lose their detail.
 */
export function shimmerText(text: string, theme: any, offsetChars = 0, fade = 0, idleToken = "muted"): string {
	if (fade >= 1) return text;
	const plain = stripAnsi(text);
	if (!plain) return text;
	const baseHex = themeTokenHex(theme, "dim");
	const peakHex = themeTokenHex(theme, "text");
	if (!baseHex || !peakHex || baseHex === peakHex) return text;
	const base = hexToRgb(baseHex);
	const peak = hexToRgb(peakHex);
	const idleHex = fade > 0 ? themeTokenHex(theme, idleToken) : null;
	const idle = idleHex ? hexToRgb(idleHex) : null;
	if (fade > 0 && !idle) return text;
	const settle = 1 - (1 - Math.max(0, Math.min(1, fade))) ** 2;
	const cycle = BAND_CHARS * 2;
	let result = "";
	let index = 0;
	for (const { segment: char } of graphemes.segment(plain)) {
		const position = (((index - offsetChars) % cycle) + cycle) % cycle;
		const band = Math.floor(position / BAND_CHARS);
		const t = position / BAND_CHARS - band;
		// Smoothstep keeps each band readable while still blending into the next.
		const amount = t * t * (3 - 2 * t);
		let color = band === 0 ? blendRgb(base, peak, amount) : blendRgb(peak, base, amount);
		if (idle) color = blendRgb(color, idle, settle);
		result += `${fgHexAnsi(theme, rgbToHex(color))}${char}`;
		index++;
	}
	return `${result}\x1b[39m`;
}
