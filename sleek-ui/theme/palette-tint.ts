/**
 * Terminal-palette-derived surfaces for the Terminal theme.
 *
 * The Terminal theme keeps ANSI palette colours as its base. In dark mode we
 * derive two subtle surfaces from the terminal's reported colours:
 *
 *   - user and agent messages share a darker, accent-tinted surface;
 *   - tool blocks use a separate, slightly lighter neutral surface.
 *
 * The colours are published as an owned public Theme instance, so ANSI output
 * and concrete colors agree without mutating the source theme. Light mode uses the terminal foreground for
 * text and a pale accent-tinted surface for user and agent messages.
 */

import { Theme, type ThemeColor, type ThemeBg } from "@earendil-works/pi-coding-agent";
import { parseAnsiColorCode } from "./ansi.js";
import { blendRgb, relativeLuminance, rgbToHex, type Rgb } from "./color.js";
import { themeName } from "./theme-extras.js";

type Terminal = { write?: (data: string) => unknown };
type TerminalColorScheme = "dark" | "light";
type TerminalColors = {
	background?: Rgb;
	foreground?: Rgb;
	palette?: Rgb[];
};
type QueryTerminalColors = (options: {
	timeoutMs: number;
	onLateReply?: (colors: TerminalColors) => void;
}) => Promise<TerminalColors>;
type ColorSchemeSignals = {
	onColorSchemeChange?: (listener: (scheme: TerminalColorScheme) => void) => () => void;
	enableColorSchemeNotifications?: () => void;
};
type Ui = {
	theme?: Theme;
	setTheme?: (theme: Theme) => unknown;
	onTerminalInput?: (
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	) => () => void;
};

const BACKGROUND_KEYS = [
	"userMessageBg",
	"selectedBg",
	"customMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
] as const;
const MESSAGE_TINT_RATIO = 0.12;
const LIGHT_MESSAGE_TINT_RATIO = 0.16;
const LIGHT_TOOL_TINT_RATIO = 0.08;
const MESSAGE_DARKEN_RATIO = 0.18;
const TOOL_TINT_RATIO = 0.18;
const TOOL_DARKEN_RATIO = 0.08;
const OSC4_QUERY_TIMEOUT_MS = 350;
const TERMINAL_COLORS_QUERY_TIMEOUT_MS = 300;
const OSC4_RESPONSE =
	/\x1b\]4;(\d+);rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})(?:\x07|\x1b\\)/g;

function paletteIndex(ansi: string, mode: 38 | 48): number | undefined {
	const match = new RegExp(`\\x1b\\[${mode};5;(\\d+)m`).exec(ansi);
	if (!match) return undefined;
	const value = Number(match[1]);
	return Number.isInteger(value) && value >= 0 && value <= 15 ? value : undefined;
}

function parseChannel(value: string): number {
	const max = 16 ** value.length - 1;
	return Math.round((Number.parseInt(value, 16) / max) * 255);
}

function isRgb(value: unknown): value is Rgb {
	if (!value || typeof value !== "object") return false;
	const color = value as Rgb;
	return [color.r, color.g, color.b].every((channel) => Number.isFinite(channel));
}

/** Recover the public token value without turning terminal defaults into guessed RGB. */
function tokenValue(ansi: string): string | number {
	const index = /\x1b\[(?:3|4)8;5;(\d+)m/.exec(ansi);
	if (index) return Number(index[1]);
	const rgb = parseAnsiColorCode(ansi);
	return rgb ? rgbToHex(rgb) : "";
}
function isTerminalTheme(theme: any): boolean {
	return themeName(theme).toLowerCase() === "terminal";
}

export function createPaletteTintController() {
	let ui: Ui | undefined;
	let terminal: Terminal | undefined;
	let requestRender: (() => void) | undefined;
	let queryTerminalColors: QueryTerminalColors | undefined;
	let theme: any;
	let base: Theme | undefined;
	let ownedTheme: Theme | undefined;
	let sourceColors: Theme["colors"] | undefined;
	let foregrounds: Record<string, string | number> = {};
	let backgrounds: Record<string, string | number> = {};
	let dim: ThemeColor[] = [];
	let surfaceIndex: number | undefined;
	let accentIndex: number | undefined;
	let pending = new Map<number, Rgb>();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let querySerial = 0;
	let terminalScheme: TerminalColorScheme | undefined;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeScheme: (() => void) | undefined;
	let disposing = false;

	const clearQuery = (): void => {
		querySerial++;
		if (timeout) clearTimeout(timeout);
		timeout = undefined;
		pending = new Map();
	};

	const buildTheme = (fg = foregrounds, bg = backgrounds, appearance = base?.appearance): Theme => new Theme(
		fg as ConstructorParameters<typeof Theme>[0], bg as ConstructorParameters<typeof Theme>[1],
		base?.getColorMode() ?? "truecolor",
		{ name: base?.name, sourcePath: base?.sourcePath, sourceInfo: base?.sourceInfo, appearance, dim },
	);
	const publish = (next: Theme): void => {
		// setTheme installs a coherent Theme: ANSI, style() and colors agree.
		ownedTheme = next;
		ui?.setTheme?.(next);
		requestRender?.();
	};
	const applyTerminalColors = (colors: TerminalColors): void => {
		if (!base || !isTerminalTheme(theme) || !ui?.setTheme) return;
		const palette = colors.palette;
		const background = isRgb(colors.background) ? colors.background
			: surfaceIndex !== undefined && isRgb(palette?.[surfaceIndex]) ? palette[surfaceIndex] : undefined;
		const accent = accentIndex !== undefined && isRgb(palette?.[accentIndex]) ? palette[accentIndex] : undefined;
		if (!background || !accent) { publish(base); return; }
		const dark = terminalScheme ? terminalScheme === "dark" : relativeLuminance(background) < 0.5;
		const fg = { ...foregrounds };
		const bg = { ...backgrounds };
		if (!dark && isRgb(colors.foreground)) {
			for (const key of ["text", "toolOutput", "customMessageText"]) fg[key] = rgbToHex(colors.foreground);
		}
		const black = { r: 0, g: 0, b: 0 };
		const toolColor = isRgb(palette?.[8]) ? palette[8] : isRgb(colors.foreground) ? colors.foreground : accent;
		const message = dark
			? blendRgb(blendRgb(background, black, MESSAGE_DARKEN_RATIO), accent, MESSAGE_TINT_RATIO)
			: blendRgb(background, accent, LIGHT_MESSAGE_TINT_RATIO);
		const tool = dark
			? blendRgb(blendRgb(background, black, TOOL_DARKEN_RATIO), toolColor, TOOL_TINT_RATIO)
			: blendRgb(background, accent, LIGHT_TOOL_TINT_RATIO);
		for (const key of ["userMessageBg", "selectedBg"]) bg[key] = rgbToHex(message);
		for (const key of ["customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"]) bg[key] = rgbToHex(tool);
		publish(buildTheme(fg, bg, dark ? "dark" : "light"));
	};

	const applyLegacyPalette = (): void => {
		const surface = surfaceIndex === undefined ? undefined : pending.get(surfaceIndex);
		const accent = accentIndex === undefined ? undefined : pending.get(accentIndex);
		const tool = pending.get(8);
		if (!surface || !accent) return;
		applyTerminalColors({
			background: surface,
			foreground: tool,
			palette: Object.assign([], { [surfaceIndex ?? 0]: surface, [accentIndex ?? 6]: accent, 8: tool }),
		});
	};

	const onInput = (data: string): { consume?: boolean; data?: string } | undefined => {
		let matched = false;
		OSC4_RESPONSE.lastIndex = 0;
		for (const match of data.matchAll(OSC4_RESPONSE)) {
			const index = Number(match[1]);
			if (index !== surfaceIndex && index !== accentIndex && index !== 8) continue;
			matched = true;
			pending.set(index, {
				r: parseChannel(match[2]),
				g: parseChannel(match[3]),
				b: parseChannel(match[4]),
			});
		}
		if (!matched) return undefined;
		if (pending.has(surfaceIndex!) && pending.has(accentIndex!) && pending.has(8)) {
			if (timeout) clearTimeout(timeout);
			timeout = undefined;
			applyLegacyPalette();
		}
		const remaining = data.replace(OSC4_RESPONSE, "");
		return remaining.length > 0 ? { data: remaining } : { consume: true };
	};

	const ensureListener = (): void => {
		if (unsubscribe || typeof ui?.onTerminalInput !== "function") return;
		unsubscribe = ui.onTerminalInput(onInput);
	};

	const query = (): void => {
		if (!terminal || surfaceIndex === undefined || accentIndex === undefined) return;
		if (queryTerminalColors) {
			const serial = ++querySerial;
			void queryTerminalColors({
				timeoutMs: TERMINAL_COLORS_QUERY_TIMEOUT_MS,
				onLateReply: (colors) => {
					if (serial === querySerial) applyTerminalColors(colors);
				},
			}).then((colors) => {
				if (serial === querySerial) applyTerminalColors(colors);
			}).catch(() => {
				// Some terminals do not answer colour queries; keep the ANSI fallback.
			});
			return;
		}
		ensureListener();
		clearQuery();
		terminal.write?.(`\x1b]4;${surfaceIndex};?\x07\x1b]4;${accentIndex};?\x07\x1b]4;8;?\x07`);
		timeout = setTimeout(clearQuery, OSC4_QUERY_TIMEOUT_MS);
	};

	return {
		bindUi(nextUi: Ui): void {
			disposing = false;
			unsubscribe?.();
			unsubscribe = undefined;
			ui = nextUi;
			ensureListener();
		},
		bindTerminal(
			nextTerminal: Terminal,
			nextRequestRender: () => void,
			nextQueryTerminalColors?: QueryTerminalColors,
			signals?: ColorSchemeSignals,
		): void {
			terminal = nextTerminal;
			requestRender = nextRequestRender;
			queryTerminalColors = nextQueryTerminalColors;
			unsubscribeScheme?.();
			unsubscribeScheme = signals?.onColorSchemeChange?.((scheme) => {
				terminalScheme = scheme;
				query();
			});
			signals?.enableColorSchemeNotifications?.();
			query();
		},
		notifyTerminalFocus(focused: boolean): void {
			if (focused) query();
		},
		configure(nextTheme: Theme): void {
			if (disposing) return;
			if (ownedTheme && nextTheme.colors === ownedTheme.colors) return; // our own setTheme callback
			const changed = nextTheme.colors !== sourceColors;
			theme = nextTheme;
			if (!isTerminalTheme(theme)) { clearQuery(); sourceColors = undefined; return; }
			if (changed) {
				clearQuery();
				sourceColors = nextTheme.colors;
				foregrounds = {};
				backgrounds = {};
				dim = [];
				for (const key of Object.keys(nextTheme.colors)) {
					const isBackground = [...BACKGROUND_KEYS, "searchMatchBg"].includes(key as ThemeBg);
					const ansi = isBackground ? nextTheme.getBgAnsi(key as ThemeBg) : nextTheme.getFgAnsi(key as ThemeColor);
					(isBackground ? backgrounds : foregrounds)[key] = tokenValue(ansi);
					if (!isBackground && ansi.includes("\x1b[2m")) dim.push(key as ThemeColor);
				}
				// Preserve metadata and public color mode in the owned copy.
				base = nextTheme;
				base = buildTheme();
				accentIndex = paletteIndex(nextTheme.getFgAnsi("accent"), 38);
				surfaceIndex = paletteIndex(nextTheme.getBgAnsi("userMessageBg"), 48);
				terminalScheme = undefined;
			}
			if (accentIndex === undefined || surfaceIndex === undefined) { clearQuery(); return; }
			query();
		},
		dispose(): void {
			disposing = true;
			clearQuery();
			if (base && ownedTheme && ui?.theme?.colors === ownedTheme.colors) ui.setTheme?.(base);
			unsubscribe?.();
			unsubscribe = undefined;
			unsubscribeScheme?.();
			unsubscribeScheme = undefined;
			ui = undefined;
			terminal = undefined;
			queryTerminalColors = undefined;
			requestRender = undefined;
			theme = undefined;
			base = undefined;
			ownedTheme = undefined;
			sourceColors = undefined;
			foregrounds = {};
			backgrounds = {};
			terminalScheme = undefined;
			accentIndex = undefined;
			surfaceIndex = undefined;
		},
	};
}
