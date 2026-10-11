// Shared ANSI helpers for Sleek.

import { hexToRgb, isHexColor, type Rgb } from "./color.js";


// Strip ANSI escape codes (pre-compiled regexes for performance)
const RE_CSI = /\x1b\[[0-9;]*[a-zA-Z]/g;
const RE_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const RE_APC = /\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(str: string): string {
	return str.replace(RE_CSI, "").replace(RE_OSC, "").replace(RE_APC, "");
}

// ------------------------------------------------------------
// Color helpers (truecolor + 256color fallback)
// ------------------------------------------------------------

const CUBE_VALUES = [0, 95, 135, 175, 215, 255];
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10);

function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
	const dr = r1 - r2;
	const dg = g1 - g2;
	const db = b1 - b2;
	return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

function closestIndex(values: readonly number[], value: number): number {
	let minDist = Number.POSITIVE_INFINITY;
	let minIdx = 0;
	for (let i = 0; i < values.length; i++) {
		const dist = Math.abs(value - values[i]!);
		if (dist < minDist) {
			minDist = dist;
			minIdx = i;
		}
	}
	return minIdx;
}

function rgbTo256(r: number, g: number, b: number): number {
	const rIdx = closestIndex(CUBE_VALUES, r);
	const gIdx = closestIndex(CUBE_VALUES, g);
	const bIdx = closestIndex(CUBE_VALUES, b);
	const cubeR = CUBE_VALUES[rIdx]!;
	const cubeG = CUBE_VALUES[gIdx]!;
	const cubeB = CUBE_VALUES[bIdx]!;
	const cubeIndex = 16 + 36 * rIdx + 6 * gIdx + bIdx;
	const cubeDist = colorDistance(r, g, b, cubeR, cubeG, cubeB);

	const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
	const grayIdx = closestIndex(GRAY_VALUES, gray);
	const grayValue = GRAY_VALUES[grayIdx]!;
	const grayIndex = 232 + grayIdx;
	const grayDist = colorDistance(r, g, b, grayValue, grayValue, grayValue);

	const spread = Math.max(r, g, b) - Math.min(r, g, b);
	if (spread < 10 && grayDist < cubeDist) {
		return grayIndex;
	}
	return cubeIndex;
}

/** The xterm 256-colour cube/gray ramps are the inverse of `rgbTo256` below. */
const BASE16_RGB: readonly Rgb[] = [
	{ r: 0, g: 0, b: 0 },
	{ r: 128, g: 0, b: 0 },
	{ r: 0, g: 128, b: 0 },
	{ r: 128, g: 128, b: 0 },
	{ r: 0, g: 0, b: 128 },
	{ r: 128, g: 0, b: 128 },
	{ r: 0, g: 128, b: 128 },
	{ r: 192, g: 192, b: 192 },
	{ r: 128, g: 128, b: 128 },
	{ r: 255, g: 0, b: 0 },
	{ r: 0, g: 255, b: 0 },
	{ r: 255, g: 255, b: 0 },
	{ r: 0, g: 0, b: 255 },
	{ r: 255, g: 0, b: 255 },
	{ r: 0, g: 255, b: 255 },
	{ r: 255, g: 255, b: 255 },
];

/** Expand a 256-colour palette index to sRGB. */
export function ansi256ToRgb(code: number): Rgb {
	if (code <= 15) return BASE16_RGB[code] ?? { r: 255, g: 255, b: 255 };
	if (code >= 232) {
		const value = Math.max(0, Math.min(255, 8 + (code - 232) * 10));
		return { r: value, g: value, b: value };
	}
	const cube = code - 16;
	const blue = cube % 6;
	const green = Math.floor(cube / 6) % 6;
	const red = Math.floor(cube / 36) % 6;
	return {
		r: CUBE_VALUES[red] ?? 0,
		g: CUBE_VALUES[green] ?? 0,
		b: CUBE_VALUES[blue] ?? 0,
	};
}

/** Parse a foreground/background SGR escape back to sRGB, or null when it holds no colour. */
export function parseAnsiColorCode(ansi: string | undefined): Rgb | null {
	if (!ansi) return null;
	const rgbMatch = /\x1b\[(?:3|4)8;2;(\d{1,3});(\d{1,3});(\d{1,3})m/.exec(ansi);
	if (rgbMatch) {
		return {
			r: Number.parseInt(rgbMatch[1] ?? "0", 10),
			g: Number.parseInt(rgbMatch[2] ?? "0", 10),
			b: Number.parseInt(rgbMatch[3] ?? "0", 10),
		};
	}
	const bitMatch = /\x1b\[(?:3|4)8;5;(\d{1,3})m/.exec(ansi);
	return bitMatch ? ansi256ToRgb(Number.parseInt(bitMatch[1] ?? "0", 10)) : null;
}

const escapeCache = new Map<string, { prefix: string; suffix: string }>();

/** SGR prefix/suffix for a hex colour on foreground (`38`) or background (`48`). */
function sgrEscape(theme: any, hex: string, layer: 38 | 48): { prefix: string; suffix: string } {
	const mode = typeof theme?.getColorMode === "function" ? theme.getColorMode() : "truecolor";
	const cacheKey = `${layer}:${mode}:${hex}`;
	let cached = escapeCache.get(cacheKey);
	if (!cached) {
		const { r, g, b } = hexToRgb(hex);
		const prefix = mode === "256color"
			? `\x1b[${layer};5;${rgbTo256(r, g, b)}m`
			: `\x1b[${layer};2;${r};${g};${b}m`;
		cached = { prefix, suffix: layer === 48 ? RESET_BACKGROUND : "\x1b[39m" };
		escapeCache.set(cacheKey, cached);
	}
	return cached;
}

export const RESET_BACKGROUND = "\x1b[49m";
export const ERASE_LINE = "\x1b[2K";

export function fgHex(theme: any, hex: string, text: string): string {
	if (!isHexColor(hex)) return text;
	const { prefix, suffix } = sgrEscape(theme, hex, 38);
	return `${prefix}${text}${suffix}`;
}

export function fgHexAnsi(theme: any, hex: string): string {
	if (!isHexColor(hex)) return "";
	return sgrEscape(theme, hex, 38).prefix;
}

export function bgHexAnsi(theme: any, hex: string): string {
	if (!isHexColor(hex)) return "";
	return sgrEscape(theme, hex, 48).prefix;
}

function sgrColorParameterEnd(codes: string[], index: number): number {
	const code = Number(codes[index]);
	if (code !== 38 && code !== 48) return index;
	const mode = Number(codes[index + 1]);
	if (mode === 2) return Math.min(codes.length - 1, index + 4);
	if (mode === 5) return Math.min(codes.length - 1, index + 2);
	return index;
}

type BackgroundAction = "none" | "reset" | "set";

function isBasicBackgroundCode(code: number): boolean {
	return (code >= 40 && code <= 47) || (code >= 100 && code <= 107);
}

function finalBackgroundAction(rawCodes: string): BackgroundAction {
	const codes = rawCodes.split(";").filter(Boolean);
	if (codes.length === 0) return "reset";
	let action: BackgroundAction = "none";
	for (let i = 0; i < codes.length; i++) {
		const code = Number(codes[i]);
		if (code === 0 || code === 49) {
			action = "reset";
			continue;
		}
		if (code === 48) {
			action = "set";
			i = sgrColorParameterEnd(codes, i);
			continue;
		}
		if (code === 38) {
			i = sgrColorParameterEnd(codes, i);
			continue;
		}
		if (isBasicBackgroundCode(code)) action = "set";
	}
	return action;
}

function removeStandaloneBackgroundReset(rawCodes: string): string {
	const codes = rawCodes.split(";").filter(Boolean);
	if (codes.length === 0) return "0";

	const rebuilt: string[] = [];
	for (let i = 0; i < codes.length; i++) {
		const code = Number(codes[i]);
		if (code === 49) continue;
		const end = sgrColorParameterEnd(codes, i);
		for (let j = i; j <= end; j++) rebuilt.push(codes[j]!);
		i = end;
	}
	return rebuilt.join(";");
}

export function keepAnsiBackgroundAcrossResets(text: string, bgAnsi: string): string {
	if (!text) return text;
	// Fast path: nothing to rewrite when the line carries no SGR codes at all.
	// This runs per line, per frame over the whole rendered document.
	if (!text.includes("\x1b[")) return text;
	return text.replace(/\x1b\[([0-9;]*)m/g, (sequence, rawCodes) => {
		const codes = String(rawCodes ?? "");
		if (finalBackgroundAction(codes) !== "reset") return sequence;
		const rebuilt = removeStandaloneBackgroundReset(codes);
		return `${rebuilt ? `\x1b[${rebuilt}m` : ""}${bgAnsi}`;
	});
}

export function wrapAnsiBackground(text: string, bgAnsi: string): string {
	if (!bgAnsi || bgAnsi === RESET_BACKGROUND) return text;
	const body = keepAnsiBackgroundAcrossResets(text, bgAnsi);
	return `${bgAnsi}${body}${RESET_BACKGROUND}`;
}

/**
 * The ANSI background escape the live theme resolves for a semantic key (e.g.
 * `"selectedBg"`, `"userMessageBg"`), or `""` when the theme has none or the
 * method throws. Does not distinguish a transparent (reset) background from a
 * missing one, so callers can treat both as "nothing to paint".
 */
export function themeBackgroundAnsi(theme: any, key: string): string {
	try {
		const ansi = typeof theme?.getBgAnsi === "function" ? theme.getBgAnsi(key) : "";
		return typeof ansi === "string" && ansi !== "" && ansi !== RESET_BACKGROUND ? ansi : "";
	} catch {
		return "";
	}
}

// ------------------------------------------------------------
// ANSI-aware text manipulation
// ------------------------------------------------------------

