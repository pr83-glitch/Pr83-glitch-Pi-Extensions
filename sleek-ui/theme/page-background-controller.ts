/**
 * Centralizes the OSC 11 page-background sync so every lifecycle point (session
 * start, editor creation, theme change, the `/sleek` "Theme background" toggle,
 * and shutdown) goes through the same logic.
 *
 * OSC 11 recolours the terminal's *default* background, which covers the
 * terminal-owned padding/remainder areas that ANSI cell painting cannot reach;
 * OSC 111 restores the terminal's own default. ANSI frame/component painting
 * stays the cross-platform fallback for renderable cells (see
 * `performance/render-frame-background.ts`).
 */
import { isHexColor } from "./color.js";
import { getThemePageBackground } from "./theme-extras.js";

type PageBackgroundSyncOptions = {
	/**
	 * When false the terminal page background is reset to the terminal's own
	 * default background instead of being colored. Default: true.
	 */
	enabled?: boolean;
	/** Force OSC 11 even on Windows, WSL, and Windows Terminal hosts. */
	forceOsc11?: boolean;
};

export type PageBackgroundTerminal = {
	write?: (data: string) => unknown;
};

type PageBackgroundController = {
	/**
	 * Align the terminal page background with the current theme's page
	 * background. Resets to the terminal default when the theme has no page
	 * background or the feature is disabled. Idempotent: consecutive syncs with
	 * the same outcome do not rewrite the terminal.
	 */
	sync(theme: unknown, terminal: PageBackgroundTerminal | undefined, options?: PageBackgroundSyncOptions): void;
	/** Restore the terminal's own default background (used on quit). */
	reset(terminal: PageBackgroundTerminal | undefined): void;
};

const OSC11_SET_BACKGROUND_PREFIX = "\x1b]11;";
const OSC111_RESET_BACKGROUND = "\x1b]111\x07";

/** Windows Terminal and WSL hosts usually ignore OSC 11 unless forced. */
function isWindowsHost(): boolean {
	return process.platform === "win32" || Boolean(process.env.WT_SESSION || process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function normalizeOscHexColor(value: string): string {
	let hex = value.trim().replace(/^#/, "");
	if (hex.length === 3) hex = hex.split("").map((char) => `${char}${char}`).join("");
	if (hex.length > 6) hex = hex.slice(0, 6);
	return `#${hex}`;
}

function osc11Background(hex: string): string {
	return `${OSC11_SET_BACKGROUND_PREFIX}${normalizeOscHexColor(hex)}\x07`;
}

export function createPageBackgroundController(): PageBackgroundController {
	// Tracks the last outcome so repeated syncs are no-ops. "reset" means the
	// terminal is currently on its own default background.
	let lastWrite: string | undefined;

	const write = (terminal: PageBackgroundTerminal | undefined, data: string): void => {
		if (typeof terminal?.write !== "function") return;
		try {
			terminal.write(data);
		} catch {
			// Terminal integration must never affect the extension lifecycle.
		}
	};

	const resetToDefault = (terminal: PageBackgroundTerminal | undefined): void => {
		if (lastWrite === "reset") return;
		lastWrite = "reset";
		write(terminal, OSC111_RESET_BACKGROUND);
	};

	return {
		sync(theme, terminal, options = {}) {
			// No terminal yet (syncTheme runs before the editor factory): do not
			// record an outcome, or the later real write would be suppressed.
			if (typeof terminal?.write !== "function") return;
			if (!(options.forceOsc11 === true || !isWindowsHost())) return;
			const pageBg = options.enabled === false ? "" : getThemePageBackground(theme);
			if (isHexColor(pageBg)) {
				if (lastWrite === pageBg) return;
				lastWrite = pageBg;
				write(terminal, osc11Background(pageBg));
				return;
			}
			resetToDefault(terminal);
		},
		reset(terminal) {
			resetToDefault(terminal);
		},
	};
}
