/**
 * User-message styles — how the user's own messages are drawn in the
 * transcript.
 *
 * pi renders a user message as a full-width `Box` whose background spans the
 * whole chat width (see `UserMessageComponent`), so the tinted block touches
 * both terminal edges and reads as a full-bleed band. This patch re-renders the
 * component at a narrower width and decorates the lines according to the
 * `sleek-userMessageStyle` setting:
 *
 *   bar    accent `▌` rail on the left, one-column margin on the right
 *          (default)
 *   box    a `border`-colored frame drawn around the block
 *   plain  full-width tinted block, no marker or margin
 *
 * The style is read from the config and the accent/border colours from the live
 * theme on every render, so switching either updates the transcript without
 * re-patching. Stateless and installed through `core/patch-registry.ts`, so it
 * is rebuilt on every bind and unwound on shutdown.
 */
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";

import { installPatch } from "../core/patch-registry.js";
import { copyChrome, copyMetadata } from "../core/copy-selection.js";
import { loadConfig } from "../config.js";
import { safeVisibleWidth } from "../render-budget.js";
import { RESET_BACKGROUND, themeBackgroundAnsi } from "../theme/ansi.js";
import { BAR_GLYPH, BLOCK_MIN_WIDTH, BOX_SIDE_GLYPH, blockBoxFrame } from "./block-style.js";

/**
 * pi's per-message OSC 133 shell-integration zone markers (`ESC ] 133 ; A BEL`
 * and friends) are stripped back out by pi-tui, but only while they still start
 * the line — `layout.ts` and the alt-screen renderer both anchor the strip
 * regex at `^`. A style marker (`▌`, a frame column) written in front of them
 * therefore hides the marker from pi-tui and leaks it to the terminal.
 * Terminals that implement semantic prompts (Ghostty, the Orca/Herd IDE
 * terminals, VS Code-style frontends) then treat that row as a shell prompt and
 * leave it unpainted, which is why the block background went missing on the
 * first row in every style that draws a prefix. Keep the markers first and put
 * the style marker after them.
 */
const OSC133_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

/** Background reset emitted by `theme.bg` / `theme.getBgAnsi` consumers. */
const BG_RESET = RESET_BACKGROUND;

/** First background SGR (e.g. `48;2;r;g;b`) in a styled line, if any. */
const BACKGROUND_SGR = /\x1b\[(?:4[0-7]|10[0-7]|48;[0-9;]+)m/;
function backgroundSequence(line: string): string {
	return line.match(BACKGROUND_SGR)?.[0] ?? "";
}

type BaseRender = (this: unknown, width: number) => string[];

export function installUserMessageStyle(getTheme: () => any): void {
	installPatch(
		UserMessageComponent.prototype,
		"render",
		"pi-sleek.user-message-style.render",
		(baseRender: BaseRender) =>
			function patchedUserMessageRender(this: unknown, width: number): string[] {
				if (!Number.isFinite(width) || width <= 0) return baseRender.call(this, width);
				const style = loadConfig().userMessageStyle;
				const lines = style === "bar" ? renderBar(baseRender, this, width, getTheme())
					: style === "box" ? renderBox(baseRender, this, width, getTheme())
						: renderPlain(baseRender, this, width, getTheme());
				const boxed = style === "box" && width - 4 >= BLOCK_MIN_WIDTH;
				const rail = style === "bar" && width - 2 >= BLOCK_MIN_WIDTH;
				const padding = Math.max(0, Number((this as { outputPad?: number }).outputPad) || 0);
				const left = (boxed ? 2 : rail ? 1 : 0) + padding;
				const right = boxed ? 2 : rail ? 1 : 0;
				return lines.map((line, index) => boxed && (index === 0 || index === lines.length - 1)
					? copyChrome(line, width)
					: copyMetadata(line, { width, exclude: [[0, left], [width - right, width]] }));
			},
	);
}

/**
 * Split a rendered line into its leading OSC 133 zone markers and the rest, so
 * a style can re-emit the markers ahead of whatever prefix it draws.
 */
function splitZoneMarkers(line: string): { markers: string; body: string } {
	const match = line.match(OSC133_PREFIX);
	if (!match) return { markers: "", body: line };
	return { markers: match[0], body: line.slice(match[0].length) };
}

/**
 * The block's own background, from the live theme's `userMessageBg`, or the
 * first background already present in the rendered lines.
 */
function getUserMessageBackground(theme: any, lines: string[]): string {
	// `getBgAnsi` may hand back a fully-qualified escape; only its background SGR
	// is wanted here, since the caller re-applies it to whole lines.
	return themeBackgroundAnsi(theme, "userMessageBg").match(BACKGROUND_SGR)?.[0]
		?? lines.map((line) => backgroundSequence(line)).find(Boolean)
		?? "";
}

/** `bar`: accent rail + block + one-column right margin. */
function renderBar(baseRender: BaseRender, context: unknown, width: number, theme: any): string[] {
	const barWidth = BAR_GLYPH.length;
	// Rail + one-column right margin are the only columns taken from the chat
	// width, so the decorated row is exactly `width` wide and pi-tui never
	// slices it (a sliced line loses its trailing background reset).
	const inner = width - barWidth - 1;
	if (inner < BLOCK_MIN_WIDTH) return baseRender.call(context, width);
	const bar = fg(theme, "accent", BAR_GLYPH, " ".repeat(barWidth));
	const lines = baseRender.call(context, inner);
	const blockBg = getUserMessageBackground(theme, lines);

	return lines.map((line) => {
		const { markers, body } = splitZoneMarkers(line);
		if (!blockBg) return `${markers}${bar}${body} `;
		// Paint the rail with the block's own background too, so the tinted band
		// spans the full row (minus the one-column right margin) and the rail
		// sits flush against the left edge instead of in an untinted gutter.
		const cleanBody = stripLeadingBackgroundReset(body);
		const visible = barWidth + safeVisibleWidth(cleanBody);
		const fill = " ".repeat(Math.max(0, width - 1 - visible));
		return `${markers}${blockBg}${bar}${cleanBody}${fill}${BG_RESET} `;
	});
}

/** `box`: a `border`-colored frame around the block. */
function renderBox(baseRender: BaseRender, context: unknown, width: number, theme: any): string[] {
	// 2 border columns + 1 padding column on each side.
	const inside = width - 4;
	if (inside < BLOCK_MIN_WIDTH) return baseRender.call(context, width);
	const side = fg(theme, "border", BOX_SIDE_GLYPH, "");
	const [top, bottom] = blockBoxFrame(width, (text) => fg(theme, "border", text, ""));
	const lines = baseRender.call(context, inside);
	const blockBg = getUserMessageBackground(theme, lines);
	const content = lines.map((line) => {
		const { markers, body } = splitZoneMarkers(line);
		const cleanBody = stripLeadingBackgroundReset(body);
		const decorated = `${side} ${cleanBody} ${side}`;
		return blockBg ? `${markers}${blockBg}${decorated}${BG_RESET}` : `${markers}${decorated}`;
	});
	return [top, ...content, bottom];
}

/** `plain`: full-width user-message background without a style marker. */
function renderPlain(baseRender: BaseRender, context: unknown, width: number, theme: any): string[] {
	const lines = baseRender.call(context, width);
	const blockBg = getUserMessageBackground(theme, lines);
	return blockBg ? lines.map((line) => paintLine(line, blockBg)) : lines;
}

function stripLeadingBackgroundReset(line: string): string {
	return line.replace(/^\x1b\[49m/, "").replace(/\x1b\[49m$/, "");
}

function paintLine(line: string, background: string): string {
	const { markers, body } = splitZoneMarkers(line);
	return `${markers}${background}${stripLeadingBackgroundReset(body)}${BG_RESET}`;
}

/** Paint `text` in a theme colour, or return `fallback` when unavailable. */
function fg(theme: any, color: string, text: string, fallback: string): string {
	if (!theme || typeof theme.fg !== "function") return fallback;
	try {
		return theme.fg(color, text);
	} catch {
		return fallback;
	}
}
