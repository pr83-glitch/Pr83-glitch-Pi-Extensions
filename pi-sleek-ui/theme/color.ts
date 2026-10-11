/**
 * Shared sRGB colour maths.
 *
 * `theme/ansi.ts` turns a colour into terminal escapes; this module is the
 * arithmetic underneath: hex parsing, blending, and the WCAG relative luminance
 * that decides whether a background reads as light or dark. The Terminal-theme
 * surface derivation, the theme picker's appearance tag and the thinking-style
 * ramps all use it, so the light/dark threshold cannot drift between them.
 */

export interface Rgb {
	r: number;
	g: number;
	b: number;
}

/** Whether `hex` is a 3-, 6- or 8-digit hex colour (with or without `#`). */
export function isHexColor(hex: string): boolean {
	const cleaned = hex.replace("#", "");
	return cleaned.length === 3
		? /^[0-9a-fA-F]{3}$/.test(cleaned)
		: (cleaned.length === 6 || cleaned.length === 8) && /^[0-9a-fA-F]+$/.test(cleaned);
}

/**
 * Parse any of the supported hex forms into sRGB channels. Unparseable input
 * returns black, matching what the ANSI generators need when a colour is absent;
 * check `isHexColor` first when presence matters.
 */
export function hexToRgb(hex: string): Rgb {
	const cleaned = hex.replace("#", "");
	if (cleaned.length === 3) {
		const r = Number.parseInt(cleaned[0]! + cleaned[0], 16);
		const g = Number.parseInt(cleaned[1]! + cleaned[1], 16);
		const b = Number.parseInt(cleaned[2]! + cleaned[2], 16);
		return { r, g, b };
	}
	if ((cleaned.length !== 6 && cleaned.length !== 8) || !/^[0-9a-fA-F]+$/.test(cleaned)) {
		return { r: 0, g: 0, b: 0 };
	}
	const r = Number.parseInt(cleaned.slice(0, 2), 16);
	const g = Number.parseInt(cleaned.slice(2, 4), 16);
	const b = Number.parseInt(cleaned.slice(4, 6), 16);
	return { r, g, b };
}

/** `#rrggbb` (lower-case), or `null` for anything that is not a plain 6-digit hex colour. */
export function normalizeHex(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const clean = value.trim().replace(/^#/, "");
	return /^[0-9a-fA-F]{6}$/.test(clean) ? `#${clean.toLowerCase()}` : null;
}

/** `{ r, g, b }` → `#rrggbb`. */
export function rgbToHex(color: Rgb): string {
	return `#${[color.r, color.g, color.b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** Linear blend of two colours (`ratio` 0 → `from`, 1 → `to`). */
export function blendRgb(from: Rgb, to: Rgb, ratio: number): Rgb {
	const mix = (a: number, b: number): number => Math.round(a + (b - a) * ratio);
	return { r: mix(from.r, to.r), g: mix(from.g, to.g), b: mix(from.b, to.b) };
}

/**
 * WCAG relative luminance of an sRGB colour, in `0..1`. Backgrounds above 0.5
 * read as light; that threshold is what pi and the bundled themes use.
 */
export function relativeLuminance(color: Rgb): number {
	const channel = (value: number): number => {
		const c = value / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** Relative luminance of a `#rrggbb` colour, or `undefined` when it is not one. */
export function hexLuminance(hex: string): number | undefined {
	const clean = normalizeHex(hex);
	return clean ? relativeLuminance(hexToRgb(clean)) : undefined;
}
