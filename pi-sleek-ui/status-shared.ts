/**
 * Small status pieces shared by the status bar and the side panel: identity
 * glyphs, compact number formatting, the thin meter bar, the cache-hit ratio
 * and the pi-blackhole meter restyler.
 *
 * Kept separate from `status-bar.ts` so the side panel does not pull the footer
 * patch (and pi's `FooterComponent`) into its module graph.
 */

/** Nerd Font folder glyph (U+F024B) and git-branch glyph (U+F126). */
export const FOLDER_GLYPH = "\u{F024B}";
export const BRANCH_GLYPH = "\u{F126}";
/** The single separator between status items (`·`, U+00B7). */
export const DOT = "\u{B7}";

/**
 * Compact token count: `999`, `1.2k`, `12k`, `1.2M`, `12M`. Absent or
 * non-finite values render as `unknown` (`0` for usage counters, `?` for the
 * side panel's unknown context window).
 */
export function formatCompactTokens(count: number | null | undefined, unknown = "0"): string {
	if (typeof count !== "number" || !Number.isFinite(count)) return unknown;
	if (count < 1000) return String(Math.round(count));
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

/** Thin `━` meter, `ratio` filled in `fillColor` and the rest in `borderMuted`. */
export function meterBar(cells: number, ratio: number, fillColor: string, fg: (color: string, text: string) => string): string {
	const clamped = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
	const filled = clamped <= 0 ? 0 : Math.max(1, Math.round(clamped * cells));
	return `${fg(fillColor, "━".repeat(filled))}${fg("borderMuted", "━".repeat(cells - filled))}`;
}

/** Cache-hit percentage from a usage record, or null when no prompt tokens were seen. */
export function cacheHitPercent(usage: { input: number; cacheRead: number; cacheWrite: number }): number | null {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	return promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : null;
}

/**
 * Restyle pi-blackhole's chunky meters (`▕████░░░░▏`) into the thin `━━━` bar the
 * context meter uses: the filled run keeps the bar's own colour, the empty run uses
 * the theme's `borderMuted`, and the `▕`/`▏` end caps go. Only the spans between
 * U+2595 and U+258F are touched, so labels and running-task markers pass through.
 */
const METER_PATTERN = /\u2595([^\u2595\u258F]*)\u258F/g;
const BLOCK_FILL_PATTERN = /\u2588/g;
const BLOCK_EMPTY_PATTERN = /\u2591/g;

export function slimStatusText(text: string, fg: (color: string, text: string) => string, maxMeterWidth = Infinity): string {
	if (!text.includes("\u2595")) return text;
	return text.replace(METER_PATTERN, (match, inner: string) => {
		let filled = (inner.match(BLOCK_FILL_PATTERN) ?? []).length;
		let empty = (inner.match(BLOCK_EMPTY_PATTERN) ?? []).length;
		const total = filled + empty;
		if (total === 0) return match;
		if (total > maxMeterWidth) {
			filled = Math.round(filled / total * maxMeterWidth);
			empty = maxMeterWidth - filled;
		}
		const fillColor = inner.match(/\x1b\[[0-9;]*m(?=\u2588)/)?.[0] ?? "";
		const reset = "\x1b[39m";
		const full = filled > 0 ? `${fillColor}${"\u2501".repeat(filled)}${reset}` : "";
		const rest = empty > 0 ? fg("borderMuted", "\u2501".repeat(empty)) : "";
		// Leading space separates the label (`O`/`P`/`X`) from its bar.
		return ` ${full}${rest}`;
	});
}
