/**
 * Shared styling helpers for the menu popups: padding, wrapping, row markers
 * and state tokens. Colours go through the active theme so Sleek theme
 * switches keep working; glyphs are single-width so the row maths stays correct.
 */
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** The subset of pi's `Theme` these helpers render with. */
export interface MenuTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
	inverse(text: string): string;
}

/** Pad (or truncate) a possibly ANSI-styled string to exactly `width` cells. */
export function menuPad(text: string, width: number): string {
	const truncated = truncateToWidth(String(text ?? ""), Math.max(0, width), "");
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

/** Wrap a line to `width`, preserving ANSI and never emitting a zero-line result. */
export function menuWrapLine(line: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const normalized = String(line ?? "").replace(/\t/g, "  ");
	const wrapped = normalized.split(/\r?\n/).flatMap((part) => {
		const rows = wrapTextWithAnsi(part, safeWidth);
		return rows.length > 0 ? rows : [""];
	});
	return wrapped.map((part) => truncateToWidth(part, safeWidth, ""));
}

export interface MenuPrimaryHintOptions {
	/** Label after `enter`; defaults to `select`. */
	select?: string;
	/** Trailing action label; defaults to `close`. */
	close?: string;
	/** Extra `key label` pairs inserted before the close hint. */
	extra?: ReadonlyArray<readonly [key: string, label: string]>;
}

/** Shared primary hint line for the `/sleek` popups. */
export function menuPrimaryHint(theme: MenuTheme, options: MenuPrimaryHintOptions = {}): string {
	const parts = [
		`${theme.fg("warning", "↑/↓")} ${theme.fg("dim", "navigate · ")}`,
		`${theme.fg("warning", "enter")} ${theme.fg("dim", `${options.select ?? "select"} · `)}`,
		`${theme.fg("warning", "type")} ${theme.fg("dim", "to search · ")}`,
	];
	for (const [key, label] of options.extra ?? []) parts.push(`${theme.fg("warning", key)} ${theme.fg("dim", `${label} · `)}`);
	parts.push(`${theme.fg("warning", "esc")} ${theme.fg("dim", options.close ?? "close")}`);
	return parts.join("");
}

/** Full-width `selectedBg` row highlight. */
export function menuSelectedLine(theme: MenuTheme, line: string, width: number): string {
	return theme.bg("selectedBg", menuPad(line, width));
}

/** Row state marker: `●` on, `○` off, `◆` informational. All single width. */
export function menuStateToken(theme: MenuTheme, state: "on" | "off" | "info" | undefined): string {
	if (state === "on") return theme.fg("success", "●");
	if (state === "info") return theme.fg("accent", "◆");
	return theme.fg("warning", "○");
}

/**
 * Radio-style option markers for the pickers (Nerd Font, plane 0). Written as
 * escapes so the invisible PUA characters survive diffs/editors.
 */
const MENU_ACTIVE_OPTION_MARKER = "\u{F192}"; // nf-fa-dot_circle_o (selected)
const MENU_INACTIVE_OPTION_MARKER = "\u{F1DB}"; // nf-fa-circle_thin (unselected)

/** Styled radio marker for a picker row: filled dot when active, thin ring otherwise. */
export function menuOptionMarker(theme: MenuTheme, active: boolean): string {
	return theme.fg(active ? "success" : "accent", active ? MENU_ACTIVE_OPTION_MARKER : MENU_INACTIVE_OPTION_MARKER);
}

