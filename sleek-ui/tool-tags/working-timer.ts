/**
 * Live turn timer on the working/thinking status row.
 *
 * Pi shows the selected thinking style as the working status while a turn runs.
 * Unlike pi-zazz — whose editor leaves the status in its own container — Sleek's
 * `PlaceholderEditor` embeds it in the editor's top border, so the indicator is
 * painted through `renderInBorder(width)` (and never through its own `render`).
 * This module puts the elapsed turn time at the right edge of that border, on the
 * same clock the response footer reports once the answer lands
 * (`responseStatsClock.getTurnElapsedMs()`, i.e. from `agent_start`, so request
 * latency and tool waits are included) — the number does not jump when the answer
 * finishes.
 *
 * No extra timer loop is needed in the normal case: the indicator's own frame
 * animation re-renders the border. Only a single-frame style needs a fallback
 * tick, because such an indicator never redraws by itself.
 */

import { safeVisibleWidth } from "../render-budget.js";
import { formatResponseDuration, responseStatsClock } from "../messages/response-stats.js";
import { installPatch } from "../core/patch-registry.js";

/** Fallback redraw cadence for a single-frame indicator (otherwise it never repaints). */
const SINGLE_FRAME_TICK_MS = 1000;

/** Same elapsed-time glyph the response footer uses (`◷ 12.4s`), single width. */
const TIMER_GLYPH = "◷";

type WorkingIndicatorLike = {
	kind?: unknown;
	frames?: unknown;
	ui?: { requestRender?: () => void };
	messageColorFn?: (text: string) => string;
	render?: (width: number) => string[];
	renderInBorder?: (width: number) => string;
	dispose?: () => void;
};

/** Idempotency: `showWorkingStatusIndicator` builds a fresh indicator per turn. */
const attached = new WeakSet<object>();

function colorizeTimer(indicator: WorkingIndicatorLike, text: string): string {
	try {
		return typeof indicator.messageColorFn === "function" ? indicator.messageColorFn(text) : text;
	} catch {
		return text;
	}
}

/**
 * Replace the trailing padding of the row's content line with the timer.
 * Returns the lines untouched when there is no room, so a narrow terminal keeps
 * the plain status row instead of clipping the message.
 *
 * `gapFill` (used in the editor border) fills the gap with the border rule so the
 * `─` line does not break between the status text and the timer, leaving one
 * space before the timer for breathing room.
 */
function withRightAlignedTimer(
	lines: string[],
	width: number,
	elapsedMs: number,
	colorize: (text: string) => string,
	gapFill?: string,
): string[] {
	if (width <= 0 || lines.length === 0) return lines;

	let index = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		const ink = lines[i]!.replace(/ +$/u, "");
		if (safeVisibleWidth(ink) > 0) {
			index = i;
			break;
		}
	}
	if (index === -1) return lines;

	const ink = lines[index]!.replace(/ +$/u, "");
	const timer = colorize(`${TIMER_GLYPH} ${formatResponseDuration(elapsedMs)}`);
	const gap = width - safeVisibleWidth(ink) - safeVisibleWidth(timer);
	if (gap < 1) return lines;

	const next = [...lines];
	if (gapFill) {
		// A space either side of the rule so the text and timer do not touch it.
		const fillWidth = Math.max(0, gap - 2);
		const trailing = Math.max(0, gap - fillWidth - 1);
		next[index] = `${ink} ${colorize(gapFill.repeat(fillWidth))}${" ".repeat(trailing)}${timer}`;
	} else {
		next[index] = `${ink}${" ".repeat(gap)}${timer}`;
	}
	return next;
}

/**
 * Attach the live timer to a working status indicator. Safe to call more than
 * once for the same instance; a `dispose()` wrapper clears the fallback tick.
 */
function attachWorkingTimer(indicator: unknown): void {
	if (!indicator || typeof indicator !== "object") return;
	const target = indicator as WorkingIndicatorLike;
	if (typeof target.render !== "function") return;
	if (attached.has(target as object)) return;
	attached.add(target as object);

	const originalRender = target.render.bind(target);
	const originalRenderInBorder = typeof target.renderInBorder === "function" ? target.renderInBorder.bind(target) : undefined;
	const originalDispose = typeof target.dispose === "function" ? target.dispose.bind(target) : undefined;

	// Status-container (non-embedded) fallback; Sleek embeds the indicator, so
	// the border hook below is the one actually seen in the TUI.
	target.render = (width: number): string[] => {
		const lines = originalRender(width);
		const elapsedMs = responseStatsClock.getTurnElapsedMs();
		if (elapsedMs === null) return lines;
		return withRightAlignedTimer(lines, width, elapsedMs, (text) => colorizeTimer(target, text));
	};

	// Embedded editor-border hook: `StatusIndicator.renderInBorder` calls the Loader's
	// prototype `render` (not the instance override above), so it needs its own wrap.
	// The gap is filled with the border rule so the `─` line stays continuous.
	if (originalRenderInBorder) {
		target.renderInBorder = (width: number): string => {
			const line = originalRenderInBorder(width);
			const elapsedMs = responseStatsClock.getTurnElapsedMs();
			if (elapsedMs === null) return line;
			const lines = withRightAlignedTimer([line], width, elapsedMs, (text) => colorizeTimer(target, text), "─");
			return lines[0] ?? line;
		};
	}

	// A single-frame (or frameless) indicator never repaints on its own, so the
	// timer would freeze at its first value without this tick.
	let tick: ReturnType<typeof setInterval> | undefined;
	const frameCount = Array.isArray(target.frames) ? target.frames.length : 0;
	if (frameCount <= 1 && typeof target.ui?.requestRender === "function") {
		tick = setInterval(() => {
			try {
				target.ui?.requestRender?.();
			} catch {
				// Rendering is best effort; never let the timer break the session.
			}
		}, SINGLE_FRAME_TICK_MS);
		tick.unref?.();
	}

	target.dispose = () => {
		if (tick) {
			clearInterval(tick);
			tick = undefined;
		}
		originalDispose?.();
	};
}

type InteractiveModeLike = { prototype?: unknown };

/**
 * Attach the timer to every working indicator pi shows. They are all routed
 * through the single funnel `InteractiveMode.showStatusIndicator`, so wrapping
 * that method covers the turn indicator without touching pi's message pipeline.
 */
export function installWorkingTimer(InteractiveModeClass: InteractiveModeLike | undefined): void {
	installPatch(
		InteractiveModeClass?.prototype,
		"showStatusIndicator",
		"pi-sleek.working-timer.showStatusIndicator",
		(original) =>
			function (this: unknown, indicator: WorkingIndicatorLike) {
				const result = original.call(this, indicator);
				if (indicator?.kind === "working") attachWorkingTimer(indicator);
				return result;
			},
	);
}
