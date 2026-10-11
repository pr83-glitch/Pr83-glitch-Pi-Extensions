/**
 * Response footer — the muted metrics line that closes an agent reply.
 *
 * Ported from pi-zazz's boxed-answer footer (`↳ ◷ 12.4s | $0.0042 · 42.5 t/s`)
 * and adapted to Sleek's borderless agent block: a single muted line with the
 * turn time on the left and this message's cost / generation speed right-aligned
 * (dropping to the left column alone when the row is too narrow).
 *
 * Timing comes from `response-stats.ts`; a message with no stats yet (still
 * streaming) gets no footer. Every finished reply with stats gets a footer.
 */

import { safeTruncateToWidth, safeVisibleWidth } from "../render-budget.js";
import {
	formatResponseCost,
	formatResponseDuration,
	formatResponseTokensPerSecond,
	getResponseStats,
} from "./response-stats.js";

/**
 * Build the footer line for a finished assistant message, right-aligned to
 * `innerWidth`. Returns `undefined` while the message has no stats (streaming) or
 * when the theme is unavailable.
 */
export function buildResponseFooterLine(theme: any, message: any, innerWidth: number): string | undefined {
	const stats = getResponseStats(message);
	if (!stats) return undefined;

	const muted = (text: string): string => (typeof theme?.fg === "function" ? theme.fg("muted", text) : text);
	const dim = (text: string): string => (typeof theme?.fg === "function" ? theme.fg("dim", text) : text);

	const left = `${muted("↳ ◷")} ${muted(formatResponseDuration(stats.totalMs))}`;
	const rightParts: string[] = [];
	if (stats.costUsd !== null && stats.costUsd > 0) rightParts.push(formatResponseCost(stats.costUsd));
	const speed = formatResponseTokensPerSecond(stats);
	if (speed) rightParts.push(speed);
	const right = rightParts.map(muted).join(` ${dim("·")} `);

	if (right.length === 0) return safeTruncateToWidth(left, innerWidth, "…");
	const gap = innerWidth - safeVisibleWidth(left) - safeVisibleWidth(right);
	// Both columns need room; on a narrow block keep the left one (the turn time is
	// the headline figure) instead of dropping it for the cost.
	if (gap < 1) return safeTruncateToWidth(left, innerWidth, "…");
	return `${left}${" ".repeat(gap)}${right}`;
}
