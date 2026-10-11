/**
 * Glyphs and the box frame shared by the user- and agent-message block styles,
 * kept in one place so the two renderers stay visually identical.
 */

/** Left rail for the `bar` style (left half block, U+258C), matching the edit diff marker. */
export const BAR_GLYPH = "\u{258C}";
/** Side column for the `box` frame. */
export const BOX_SIDE_GLYPH = "│";
/** Shared minimum content width; below it a variant degrades to `plain`. */
export const BLOCK_MIN_WIDTH = 8;

/** Top and bottom rows of a `width`-wide box frame, each painted by `paint`. */
export function blockBoxFrame(width: number, paint: (text: string) => string): [string, string] {
	const crossbar = "─".repeat(Math.max(0, width - 2));
	return [paint(`╭${crossbar}╮`), paint(`╰${crossbar}╯`)];
}
