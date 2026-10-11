import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Spacer, Text, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { safeTruncateToWidth, safeVisibleWidth } from "./render-budget.js";
import { getActiveLogoAnimationStyleId, type LogoAnimationStyleId } from "./tool-tags/logo-animation-styles.js";
import { loadConfig, type LogoColorMode } from "./config.js";

import { installPatch } from "./core/patch-registry.js";
const SYSTEM_CONTEXT_PANEL_MIN_WIDTH = 64;
const TOOLS_PANEL_MIN_WIDTH = 64;
const CORE_TOOL_SOURCE_LABEL = "core";
const MESSAGE_TEXT_INDENT = "   ";
const STARTUP_PANEL_SIDE_PADDING = 2;
const SYSTEM_CONTEXT_TYPE_WIDTH = safeVisibleWidth("System & Context");
const SYSTEM_CONTEXT_METRIC_WIDTH = safeVisibleWidth("Words/Lines");
const RESOURCE_ROW_GAP = "  ·  ";
// Pi's official 4×4 logo grid. `r` replaces Pi's coral with red for Sleek.
const PI_STATIC_LOGO_PIXELS = ["rrr.", "b.r.", "bb.y", "b..y"] as const;
// Per-column widths match the requested 17-cell logo shape.
const STATIC_LOGO_COLUMN_WIDTHS = [4, 5, 4, 4] as const;
const ANIMATED_LOGO_SCALE_Y = 2;
const PI_LOGO_RESET = "\x1b[0m";

// The animation grid uses the same official pixels and width as the static logo.
const PI_LOGO_PIXEL_LINES = PI_STATIC_LOGO_PIXELS.flatMap((pixelRow) => {
	const scaledRow = [...pixelRow]
		.map((pixel, column) => pixel.repeat(STATIC_LOGO_COLUMN_WIDTHS[column] ?? 4))
		.join("");
	return Array.from({ length: ANIMATED_LOGO_SCALE_Y }, () => scaledRow);
});
const LOGO_GRID_WIDTH = PI_LOGO_PIXEL_LINES[0]?.length ?? 0;
const LOGO_GRID_HEIGHT = PI_LOGO_PIXEL_LINES.length;

let activeTheme: ThemeLike | undefined;
const FALLBACK_THEME: ThemeLike = {
	bold: (text) => text,
	fg: (_color, text) => text,
};

type ThemeLike = {
	bold(text: string): string;
	fg(color: string, text: string): string;
	getFgAnsi?(color: string): string;
	getColorMode?(): string;
};

function activeLogoColorMode(): LogoColorMode {
	return loadConfig().logoColorMode;
}

function logoPixelToken(pixel: string, colorMode = activeLogoColorMode()): string {
	if (pixel === ".") return "";
	if (colorMode === "accent") return "accent";
	if (pixel === "r") return "error";
	if (pixel === "b") return "mdLink";
	if (pixel === "y") return "warning";
	return "";
}

function logoPixelForeground(theme: ThemeLike, pixel: string, colorMode = activeLogoColorMode()): string {
	const token = logoPixelToken(pixel, colorMode);
	return token ? (theme.getFgAnsi?.(token) ?? "") : "";
}

function styledLogoPixel(theme: ThemeLike, pixel: string, colorMode = activeLogoColorMode()): string {
	const foreground = logoPixelForeground(theme, pixel, colorMode);
	return foreground ? `${foreground}█${PI_LOGO_RESET}` : "█";
}

/** Render the logo grid, drawing a themed pixel wherever `visible(row, column)` is true. */
function renderLogoGrid(theme: ThemeLike, visible: (row: number, column: number) => boolean): string[] {
	return PI_LOGO_PIXEL_LINES.map((line, row) =>
		[...line].map((pixel, column) => (pixel !== "." && visible(row, column) ? styledLogoPixel(theme, pixel) : " ")).join(""),
	);
}

let logoSolidCacheKey: string | undefined;
let logoSolidCacheLines: string[] | undefined;

function styledLogoLines(theme: ThemeLike): string[] {
	const mode = theme.getColorMode?.() ?? "truecolor";
	const colorMode = activeLogoColorMode();
	const colorKey = ["error", "mdLink", "warning", "accent"]
		.map((token) => theme.getFgAnsi?.(token) ?? "")
		.join("|");
	const cacheKey = `${colorMode}|${colorKey}|${mode}`;
	if (cacheKey === logoSolidCacheKey && logoSolidCacheLines) return logoSolidCacheLines;
	logoSolidCacheLines = PI_LOGO_PIXEL_LINES.map((line) =>
		[...line].map((pixel) => (pixel === "." ? " " : styledLogoPixel(theme, pixel, colorMode))).join(""),
	);
	logoSolidCacheKey = cacheKey;
	return logoSolidCacheLines;
}

type ResourceRow = {
	label: string;
	items: string[];
};

type SystemContextItem = {
	priority: number;
	kind: string;
	path: string;
	words: number;
	lines: number;
};

type AvailableTool = {
	source: string;
	name: string;
};

type ToolGroup = {
	source: string;
	tools: string[];
};

/** Centre an already-rendered block of lines horizontally (trailing padding trimmed first). */
function centerLines(lines: string[], width: number): string[] {
	const trimmed = lines.map((line) => line.replace(/ +$/u, ""));
	const blockWidth = Math.max(0, ...trimmed.map((line) => safeVisibleWidth(line)));
	const pad = Math.max(0, Math.floor((Math.max(1, width) - blockWidth) / 2));
	if (pad === 0) return trimmed;
	const prefix = " ".repeat(pad);
	return trimmed.map((line) => `${prefix}${line}`);
}

class ExpandableText extends Text {
	private expanded: boolean;

	constructor(
		private readonly getCollapsedText: () => string,
		private readonly getExpandedText: () => string,
		expanded = false,
	) {
		super(expanded ? getExpandedText() : getCollapsedText(), 0, 0);
		this.expanded = expanded;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.setText(expanded ? this.getExpandedText() : this.getCollapsedText());
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (this.expanded) return lines;
		return centerLines(lines, width);
	}
}

/**
 * A collapsed-by-default conflict report. The header is painted in the theme's
 * warning colour (the same tone pi uses for `[Theme conflicts]`), and a left
 * click toggles the full report. `setExpanded` is also implemented so pi's
 * Ctrl+O handler (which walks the loaded-resources children) can toggle it.
 */
class CollapsibleDiagnostics extends Text {
	private expanded = false;
	constructor(
		private readonly getTheme: () => ThemeLike,
		private readonly title: string,
		private readonly report: string,
		private readonly requestRender: () => void,
	) {
		super("", 0, 0);
	}

	private header(): string {
		const action = this.expanded ? "Click or Press Ctrl+O to collapse" : "Click or Press Ctrl+O to expand";
		return this.getTheme().fg("warning", `[${this.title} ◆ ${action}]`);
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.expanded = !this.expanded;
		this.requestRender();
		return { handled: true };
	}

	render(width: number): string[] {
		this.setText(this.expanded ? `${this.header()}\n${this.report}` : this.header());
		const lines = super.render(width);
		return this.expanded ? lines : centerLines(lines, width);
	}
}

/** A single status line rendered horizontally centred (used for the /reload confirmation). */
class CenteredStatusText extends Text {
	render(width: number): string[] {
		return centerLines(super.render(width), width);
	}
}

function readJson(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

function isQuietStartup(cwd: string): boolean {
	const globalSettings = readJson(join(getAgentDir(), "settings.json"));
	const projectSettings = readJson(join(cwd, ".pi", "settings.json"));
	return Boolean((projectSettings.quietStartup ?? globalSettings.quietStartup) ?? false);
}

function discoverPromptFile(cwd: string, agentDir: string, filename: string): string | undefined {
	const projectPath = join(cwd, ".pi", filename);
	if (existsSync(projectPath)) return projectPath;

	const globalPath = join(agentDir, filename);
	if (existsSync(globalPath)) return globalPath;

	return undefined;
}

function countWords(text: string): number {
	return text.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0;
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	const lines = text.split(/\r\n|\r|\n/).length;
	return /\r\n$|\r$|\n$/.test(text) ? lines - 1 : lines;
}

function indentStartupLines(lines: string[]): string[] {
	return lines.map((line) => `${MESSAGE_TEXT_INDENT}${line}`);
}

function startupBodyWidth(width: number): number {
	return Math.max(1, width - safeVisibleWidth(MESSAGE_TEXT_INDENT));
}

function normalizeToolNames(names: unknown): string[] {
	return Array.isArray(names) ? names.filter((name) => typeof name === "string" && name.length > 0) : [];
}

function stripKnownExtension(name: string): string {
	return name.replace(/\.(?:mjs|cjs|js|jsx|ts|tsx)$/i, "");
}

function compactSourcePathLabel(path: string): string {
	const trimmed = path.trim();
	if (!trimmed) return "";
	const synthetic = /^<([^:>]+)(?::[^>]*)?>$/.exec(trimmed);
	if (synthetic?.[1]) return synthetic[1];
	const segments = trimmed.replace(/\\/g, "/").split("/").filter((segment) => segment.length > 0 && segment !== "." && segment !== "~");
	const last = segments.at(-1) ?? trimmed;
	if (/^index\.(?:mjs|cjs|js|jsx|ts|tsx)$/i.test(last) && segments.length > 1) return segments[segments.length - 2]!;
	return stripKnownExtension(last);
}

function compactPackageSourceLabel(source: string): string {
	if (source.startsWith("npm:")) return source.slice("npm:".length) || source;
	if (source.startsWith("git:")) return compactSourcePathLabel(source.replace(/\.git(?:#.*)?$/i, "")) || source;
	return source;
}

function toolSourceLabel(toolInfo: any): string {
	const sourceInfo = toolInfo?.sourceInfo;
	if (!sourceInfo || typeof sourceInfo !== "object") return CORE_TOOL_SOURCE_LABEL;
	const source = typeof sourceInfo.source === "string" ? sourceInfo.source : "";
	if (source === "builtin") return CORE_TOOL_SOURCE_LABEL;
	if (source === "sdk") return "sdk";
	if (source.startsWith("npm:") || source.startsWith("git:")) return compactPackageSourceLabel(source);
	const baseDir = typeof sourceInfo.baseDir === "string" ? sourceInfo.baseDir : "";
	if (baseDir) return compactSourcePathLabel(baseDir) || source || "extension";
	const path = typeof sourceInfo.path === "string" ? sourceInfo.path : "";
	if (path) return compactSourcePathLabel(path) || source || "extension";
	return source || "extension";
}

function getAvailableTools(session: any): AvailableTool[] {
	const hasActiveTools = typeof session?.getActiveToolNames === "function";
	const activeNames = normalizeToolNames(hasActiveTools ? session.getActiveToolNames() : undefined);
	const configuredTools = typeof session?.getAllTools === "function" ? session.getAllTools() : [];
	const allTools = Array.isArray(configuredTools) ? configuredTools : [];
	if (allTools.length > 0) {
		const activeSet = new Set(activeNames);
		return allTools
			.filter((tool: any) => typeof tool?.name === "string" && (!hasActiveTools || activeSet.has(tool.name)))
			.map((tool: any) => ({ source: toolSourceLabel(tool), name: tool.name }));
	}
	return activeNames.map((name) => ({ source: CORE_TOOL_SOURCE_LABEL, name }));
}

function groupAvailableTools(tools: AvailableTool[]): ToolGroup[] {
	const groups = new Map<string, Set<string>>();
	for (const tool of tools) {
		const source = tool.source.trim() || "extension";
		const name = tool.name.trim();
		if (!name) continue;
		const names = groups.get(source) ?? new Set<string>();
		names.add(name);
		groups.set(source, names);
	}

	return [...groups.entries()]
		.map(([source, names]) => ({ source, tools: [...names].sort((a, b) => a.localeCompare(b)) }))
		.sort((a, b) => {
			if (a.source === CORE_TOOL_SOURCE_LABEL) return -1;
			if (b.source === CORE_TOOL_SOURCE_LABEL) return 1;
			return a.source.localeCompare(b.source);
		});
}

function renderPanelBorder(theme: ThemeLike, left: string, right: string, panelWidth: number): string {
	return theme.fg("dim", `${left}${"─".repeat(panelWidth + STARTUP_PANEL_SIDE_PADDING * 2)}${right}`);
}

function renderPanelLine(theme: ThemeLike, content: string, panelWidth: number): string {
	const sidePadding = " ".repeat(STARTUP_PANEL_SIDE_PADDING);
	const padding = " ".repeat(Math.max(0, panelWidth - safeVisibleWidth(content)));
	return `${theme.fg("dim", "│")}${sidePadding}${content}${padding}${sidePadding}${theme.fg("dim", "│")}`;
}

function renderToolsPanel(theme: ThemeLike, tools: AvailableTool[], minTotalWidth = 0): string[] {
	const groups = groupAvailableTools(tools);
	if (groups.length === 0) return [];

	const titleLine = theme.bold(theme.fg("accent", "Available Tools"));
	const outerWidth = STARTUP_PANEL_SIDE_PADDING * 2 + 2;
	const sourceHeader = "Source";
	const countHeader = "Count";
	const toolsHeader = "Tools";
	const countWidth = Math.max(countHeader.length, ...groups.map((group) => String(group.tools.length).length));
	const columnDivider = ` ${theme.fg("muted", "|")} `;
	const columnDividerWidth = safeVisibleWidth(columnDivider);
	const panelWidth = Math.max(TOOLS_PANEL_MIN_WIDTH, minTotalWidth - outerWidth, safeVisibleWidth(titleLine));
	const availableTextWidth = Math.max(sourceHeader.length + toolsHeader.length, panelWidth - countWidth - columnDividerWidth * 2);
	const maxSourceWidth = Math.max(sourceHeader.length, ...groups.map((group) => safeVisibleWidth(group.source)));
	const sourceWidth = Math.min(maxSourceWidth, Math.max(sourceHeader.length, Math.floor(availableTextWidth * 0.28)));
	const toolsWidth = Math.max(toolsHeader.length, availableTextWidth - sourceWidth);

	const header = `${theme.fg("text", sourceHeader.padEnd(sourceWidth))}${columnDivider}${theme.fg("text", countHeader.padStart(countWidth))}${columnDivider}${theme.fg("text", toolsHeader.padEnd(toolsWidth))}`;
	const separator = `${theme.fg("dim", "─".repeat(sourceWidth))}${columnDivider}${theme.fg("dim", "─".repeat(countWidth))}${columnDivider}${theme.fg("dim", "─".repeat(toolsWidth))}`;
	const lines = [
		renderPanelBorder(theme, "┌", "┐", panelWidth),
		renderPanelLine(theme, titleLine, panelWidth),
		renderPanelLine(theme, header, panelWidth),
		renderPanelLine(theme, separator, panelWidth),
	];

	for (const group of groups) {
		const count = String(group.tools.length);
		const toolList = safeTruncateToWidth(group.tools.join(", "), toolsWidth, "...", true);
		const source = safeTruncateToWidth(group.source, sourceWidth, "...", true);
		const countPadding = " ".repeat(Math.max(0, countWidth - count.length));
		lines.push(renderPanelLine(
			theme,
			`${theme.fg("text", source)}${columnDivider}${countPadding}${theme.bold(theme.fg("success", count))}${columnDivider}${theme.fg("text", toolList)}`,
			panelWidth,
		));
	}

	lines.push(renderPanelBorder(theme, "└", "┘", panelWidth));
	return lines;
}

function renderSystemContextPanel(theme: ThemeLike, items: SystemContextItem[], minTotalWidth = 0): string[] {
	const sortedItems = [...items].sort((a, b) => a.priority - b.priority);
	const titleLabel = "System & Context";
	const titleLine = theme.bold(theme.fg("accent", titleLabel));
	const outerWidth = STARTUP_PANEL_SIDE_PADDING * 2 + 2;

	if (sortedItems.length === 0) {
		const message = theme.fg("text", "No system or context files loaded");
		const panelWidth = Math.max(SYSTEM_CONTEXT_PANEL_MIN_WIDTH, minTotalWidth - outerWidth, safeVisibleWidth(titleLine), safeVisibleWidth(message));
		return [
			renderPanelBorder(theme, "┌", "┐", panelWidth),
			renderPanelLine(theme, titleLine, panelWidth),
			renderPanelLine(theme, message, panelWidth),
			renderPanelBorder(theme, "└", "┘", panelWidth),
		];
	}

	const typeHeader = "Type";
	const pathHeader = "Path";
	const metricLabel = "Words/Lines";
	const typeWidth = Math.max(SYSTEM_CONTEXT_TYPE_WIDTH, typeHeader.length, ...sortedItems.map((item) => safeVisibleWidth(item.kind)));
	const columnDivider = ` ${theme.fg("muted", "|")} `;
	const columnDividerWidth = safeVisibleWidth(columnDivider);
	const metricWidth = Math.max(SYSTEM_CONTEXT_METRIC_WIDTH, metricLabel.length, ...sortedItems.map((item) => `${item.words}/${item.lines}`.length));
	const fixedColumnsWidth = typeWidth + columnDividerWidth + columnDividerWidth + metricWidth;
	const panelWidth = Math.max(SYSTEM_CONTEXT_PANEL_MIN_WIDTH, minTotalWidth - outerWidth, safeVisibleWidth(titleLine));
	const pathWidth = Math.max(pathHeader.length, panelWidth - fixedColumnsWidth);
	const header = `${theme.fg("text", typeHeader.padEnd(typeWidth))}${columnDivider}${theme.fg("text", pathHeader.padEnd(pathWidth))}${columnDivider}${theme.fg("text", metricLabel.padStart(metricWidth))}`;
	const separator = `${theme.fg("dim", "─".repeat(typeWidth))}${columnDivider}${theme.fg("dim", "─".repeat(pathWidth))}${columnDivider}${theme.fg("dim", "─".repeat(metricWidth))}`;
	const lines = [
		renderPanelBorder(theme, "┌", "┐", panelWidth),
		renderPanelLine(theme, titleLine, panelWidth),
		renderPanelLine(theme, header, panelWidth),
		renderPanelLine(theme, separator, panelWidth),
	];

	for (const item of sortedItems) {
		const metric = `${item.words}/${item.lines}`;
		const typePadding = " ".repeat(Math.max(0, typeWidth - safeVisibleWidth(item.kind)));
		const path = safeTruncateToWidth(item.path, pathWidth, "...", true);
		const metricPadding = " ".repeat(Math.max(0, metricWidth - safeVisibleWidth(metric)));
		lines.push(renderPanelLine(
			theme,
			`${theme.fg("text", item.kind)}${typePadding}${columnDivider}${theme.fg("text", path)}${columnDivider}${metricPadding}${theme.fg("text", metric)}`,
			panelWidth,
		));
	}

	lines.push(renderPanelBorder(theme, "└", "┘", panelWidth));
	return lines;
}

function renderResourceChip(theme: ThemeLike, row: ResourceRow): string {
	return `${theme.fg("muted", row.label)} ${theme.bold(theme.fg("success", String(row.items.length)))}`;
}

function renderResourceTable(theme: ThemeLike, rows: ResourceRow[], systemContextItems: SystemContextItem[], tools: AvailableTool[], expanded: boolean): string {
	// Every chip label uses the same muted tone. Previously one row (the
	// system context, or `rows[0]` when there is none) was brightened to
	// `text`, which made `models` look different whenever it happened to be
	// the first row.
	const total = rows
		.map((row) => renderResourceChip(theme, row))
		.join(theme.fg("dim", RESOURCE_ROW_GAP));
	const summary = theme.bold(theme.fg("accent", "◆")) + MESSAGE_TEXT_INDENT.slice(1) + theme.bold(theme.fg("accent", "Resources")) + theme.fg("dim", total ? RESOURCE_ROW_GAP : "") + total;
	if (!expanded) return summary;

	const panelBodyWidth = Math.max(1, safeVisibleWidth(summary) - safeVisibleWidth(MESSAGE_TEXT_INDENT));
	const toolPanel = renderToolsPanel(theme, tools, panelBodyWidth);
	return [
		summary,
		"",
		...indentStartupLines(renderSystemContextPanel(theme, systemContextItems, panelBodyWidth)),
		...(toolPanel.length > 0 ? ["", ...indentStartupLines(toolPanel)] : []),
	].join("\n");
}



// Every logo animation targets the same total duration: the per-style frame
// interval is derived from the frame count, so new styles fit automatically.
const LOGO_ANIMATION_TARGET_MS = 1000;
const LOGO_ANIMATION_MIN_FRAME_MS = 12;

// Materialize: cells pop in random order (theme red/blue/yellow), hold for a beat,
// flicker off/on twice, then settle into the static logo.
// 30 reveal + 3 hold + 2×2 flicker + 3 final = 40 frames.
const MATERIALIZE_REVEAL_FRAMES = 30;
const MATERIALIZE_HOLD_FRAMES = 3;
const MATERIALIZE_FLICKERS = 2;
const MATERIALIZE_FINAL_FRAMES = 3;

// Reveal: the logo fills like a glass — each column's liquid level follows a
// traveling sine wave, so the surface stays wavy while it rises bottom → top.
// 43 fill + 3 hold = 46 frames.
const REVEAL_FILL_FRAMES = 43;
const REVEAL_HOLD_FRAMES = 3;
const REVEAL_AMPLITUDE = 0.9;
const REVEAL_WAVELENGTH = 6;
const REVEAL_WAVE_SPEED = 0.45;

// Wipe: the logo is wiped in from top to bottom a whole row at a time, at an
// accelerating rate (slow start, fast finish), drawn in the theme colors. Then
// it flickers off/on twice and settles into the static logo.
// 33 wipe + 2×2 flicker + 3 tail = 40 frames.
const WIPE_FRAMES = 33;
const WIPE_TAIL_FRAMES = 3;

type LogoAnimationRun = {
	timer: ReturnType<typeof setInterval>;
	frameIndex: number;
	frames: string[][];
};

let logoAnimationRun: LogoAnimationRun | null = null;
let logoAnimationAutoPlayed = false;
let logoAnimationAutoplayArmed = false;

/**
 * Called at the top of every session_start; `play` decides whether autoplay is
 * armed. Resetting `logoAnimationAutoPlayed` here is what lets the animation
 * play again on a later /reload of an empty session, not just once per process.
 */
export function beginLogoAnimationSession(play: boolean): void {
	stopLogoAnimation();
	logoAnimationAutoplayArmed = play;
	if (play) logoAnimationAutoPlayed = false;
}

export function stopLogoAnimation(): void {
	const run = logoAnimationRun;
	logoAnimationRun = null;
	if (!run) return;
	try {
		clearInterval(run.timer);
	} catch {
		// best effort
	}
}

/**
 * Build Materialize frames: the logo's cells pop into place in random order
 * (theme red/blue/yellow), then the whole logo flickers twice and settles into the
 * static logo. The final frame is identical to the static logo (seamless
 * cutover).
 */
function buildMaterializeLogoFrames(theme: ThemeLike): string[][] {
	const cells: Array<{ row: number; column: number }> = [];
	for (let row = 0; row < LOGO_GRID_HEIGHT; row++) {
		[...PI_LOGO_PIXEL_LINES[row]!].forEach((pixel, column) => {
			if (pixel !== ".") cells.push({ row, column });
		});
	}
	if (cells.length === 0) return [];

	// Random pop order (per play; frames are built once when the animation starts).
	for (let index = cells.length - 1; index > 0; index--) {
		const swap = Math.floor(Math.random() * (index + 1));
		[cells[index], cells[swap]] = [cells[swap]!, cells[index]!];
	}

	const visible = new Set<string>();
	const render = (active: ReadonlySet<string>): string[] => renderLogoGrid(theme, (row, column) => active.has(`${row}:${column}`));

	const allCells = new Set(cells.map((cell) => `${cell.row}:${cell.column}`));
	const noCells = new Set<string>();
	const frames: string[][] = [];
	for (let frame = 0; frame < MATERIALIZE_REVEAL_FRAMES; frame++) {
		const revealedCount = Math.floor(((frame + 1) * cells.length) / MATERIALIZE_REVEAL_FRAMES);
		for (let index = 0; index < revealedCount; index++) {
			const cell = cells[index]!;
			visible.add(`${cell.row}:${cell.column}`);
		}
		frames.push(render(visible));
	}

	// Hold the completed logo for a beat, then flicker off/on.
	for (let frame = 0; frame < MATERIALIZE_HOLD_FRAMES; frame++) frames.push(render(visible));
	for (let flicker = 0; flicker < MATERIALIZE_FLICKERS; flicker++) {
		frames.push(render(noCells));
		frames.push(render(allCells));
	}

	// Finally it settles into the static logo.
	for (let frame = 0; frame < MATERIALIZE_FINAL_FRAMES; frame++) frames.push(render(allCells));
	return frames;
}

/**
 * Build Reveal frames: the logo fills from the bottom up like a glass,
 * with a wavy surface. Every column's liquid level is a traveling sine, and a
 * cell is only revealed once the level passes it. Every revealed cell is the
 * same themed pixels, so the last frames equal the static logo and the cutover
 * is seamless.
 */
function buildRevealLogoFrames(theme: ThemeLike): string[][] {
	const frames: string[][] = [];
	for (let frame = 0; frame < REVEAL_FILL_FRAMES; frame++) {
		const progress = REVEAL_FILL_FRAMES <= 1 ? 1 : frame / (REVEAL_FILL_FRAMES - 1);
		const base = -REVEAL_AMPLITUDE + progress * (LOGO_GRID_HEIGHT + 2 * REVEAL_AMPLITUDE);

		// Per-column liquid level.
		const surface: number[] = [];
		for (let column = 0; column < LOGO_GRID_WIDTH; column++) {
			surface[column] = base + REVEAL_AMPLITUDE * Math.sin((2 * Math.PI * column) / REVEAL_WAVELENGTH + frame * REVEAL_WAVE_SPEED);
		}

		frames.push(renderLogoGrid(theme, (row, column) => LOGO_GRID_HEIGHT - 1 - row < surface[column]!));
	}

	const settled = styledLogoLines(theme);
	for (let hold = 0; hold < REVEAL_HOLD_FRAMES; hold++) frames.push(settled);
	return frames;
}

/**
 * Build Wipe frames: the logo is wiped in from top to bottom, one whole row at
 * a time (no horizontal wipe), accelerating (progress²) so it starts slowly and
 * finishes fast, drawn in the theme colors. Then the logo flickers off and back
 * on twice. The last frames are identical to the static logo (seamless cutover).
 */
function buildWipeLogoFrames(theme: ThemeLike): string[][] {
	const render = (visible: boolean, boundary = Number.POSITIVE_INFINITY): string[] =>
		renderLogoGrid(theme, (row) => visible && boundary >= row + 1);

	const frames: string[][] = [];
	for (let frame = 0; frame < WIPE_FRAMES; frame++) {
		const progress = (frame + 1) / WIPE_FRAMES;
		frames.push(render(true, progress * progress * (LOGO_GRID_HEIGHT + 1)));
	}

	// Two flickers: the logo blinks off, then back on.
	frames.push(render(false));
	frames.push(render(true));
	frames.push(render(false));
	frames.push(render(true));
	for (let frame = 0; frame < WIPE_TAIL_FRAMES; frame++) frames.push(render(true));
	return frames;
}

/** Frames for one concrete style, or null for "static"/invalid. */
function buildLogoAnimationForStyle(styleId: LogoAnimationStyleId, theme: ThemeLike): string[][] | null {
	if (styleId === "materialize") return buildMaterializeLogoFrames(theme);
	if (styleId === "reveal") return buildRevealLogoFrames(theme);
	if (styleId === "wipe") return buildWipeLogoFrames(theme);
	return null;
}

/** Fit a frame count into the shared target duration. */
function logoAnimationIntervalMs(frameCount: number): number {
	if (frameCount <= 0) return LOGO_ANIMATION_TARGET_MS;
	return Math.max(LOGO_ANIMATION_MIN_FRAME_MS, Math.round(LOGO_ANIMATION_TARGET_MS / frameCount));
}

interface LogoPreviewFrames {
	frames: string[][];
	intervalMs: number;
}

/**
 * Looping preview frames for one concrete logo-animation style, for the picker's
 * Ctrl+P preview. Returns null for "static".
 */
export function buildLogoPreviewFrames(styleId: LogoAnimationStyleId, theme: ThemeLike): LogoPreviewFrames | null {
	const frames = buildLogoAnimationForStyle(styleId, theme);
	if (!frames || frames.length === 0) return null;
	return { frames, intervalMs: logoAnimationIntervalMs(frames.length) };
}

/** Active style's frames + cadence, or null for "static"/invalid. */
function buildLogoAnimation(theme: ThemeLike): LogoPreviewFrames | null {
	// Static/invalid styles return null; index.ts resolves the saved id first.
	return buildLogoPreviewFrames(getActiveLogoAnimationStyleId(), theme);
}

function maybeStartLogoAnimation(tui: any, theme: ThemeLike, width: number): void {
	if (logoAnimationRun) return;
	const autoplay = logoAnimationAutoplayArmed && !logoAnimationAutoPlayed;
	if (!autoplay) return;
	if (startupBodyWidth(width) < LOGO_GRID_WIDTH) return;
	const animation = buildLogoAnimation(theme);
	if (!animation || animation.frames.length === 0) return;
	const frames = animation.frames;
	logoAnimationAutoPlayed = true;
	// NOTE: the run object is shared with the tick closure — updating
	// `run.frameIndex` is what makes the header render advance. Keeping a
	// separate local counter here would leave the header stuck on frame 0.
	const run: LogoAnimationRun = { timer: undefined as unknown as ReturnType<typeof setInterval>, frameIndex: 0, frames };
	const timer = setInterval(() => {
		run.frameIndex += 1;
		if (run.frameIndex >= frames.length) {
			// The last frame is identical to the static logo, so stopping here swaps
			// to the cached static render seamlessly.
			stopLogoAnimation();
		}
		try {
			tui?.requestRender?.();
		} catch {
			stopLogoAnimation();
		}
	}, animation.intervalMs);
	if (typeof timer === "object" && timer !== null && typeof (timer as NodeJS.Timeout).unref === "function") {
		(timer as NodeJS.Timeout).unref();
	}
	run.timer = timer;
	logoAnimationRun = run;
}

function currentLogoAnimationLines(): string[] | null {
	const run = logoAnimationRun;
	if (!run) return null;
	return run.frames[Math.min(run.frameIndex, run.frames.length - 1)] ?? null;
}

function composeHeaderRows(width: number, logoLines: readonly string[]): string[] {
	const safeWidth = Math.max(1, width);
	const logoWidth = Math.max(...logoLines.map((line) => safeVisibleWidth(line)));
	if (safeWidth <= logoWidth) {
		// Too narrow to centre: emit the logo, truncated to fit.
		return logoLines.map((line) => safeTruncateToWidth(line, safeWidth, "…"));
	}
	// Centre the logo block horizontally. Each line is padded to the shared logo
	// width, so the animated frames (already full width) and the static lines
	// (varying widths) stay aligned to the same block.
	const leftPad = " ".repeat(Math.floor((safeWidth - logoWidth) / 2));
	return logoLines
		.map((styledLine) => {
			const rightPad = " ".repeat(Math.max(0, logoWidth - safeVisibleWidth(styledLine)));
			return `${leftPad}${styledLine}${rightPad}`;
		});
}

/**
 * Live theme sources for startup helpers.
 *
 * `themeProvider` is the authoritative one (the extension's own session UI theme, published
 * from `session_start`); `activeTheme` is what the header factory hands us. The resource row
 * needs a source that is current whenever its text is rebuilt — see `setStartupActiveTheme`.
 */
let themeProvider: (() => ThemeLike | undefined) | undefined;

/** Rebuilds the resource row's text with the current theme (its Text content is baked in). */
let refreshResourceRowText: (() => void) | undefined;

export function setStartupThemeProvider(provider: (() => ThemeLike | undefined) | undefined): void {
	themeProvider = provider;
	if (!provider) {
		refreshResourceRowText = undefined;
		activeTheme = undefined;
	}
}

/** Theme to paint startup UI with, most authoritative source first. */
function currentStartupTheme(mode?: { theme?: unknown }): ThemeLike {
	return themeProvider?.() ?? (mode?.theme as ThemeLike | undefined) ?? activeTheme ?? FALLBACK_THEME;
}

/**
 * Publish the current theme for startup-UI helpers that run outside the header factory
 * (e.g. the resource row, which renders while the header may not have been created yet).
 *
 * Also rebuilds the resource row's text: `ExpandableText` extends pi's `Text`, which stores
 * the string it was constructed with, so a theme that arrives after the row was created has
 * to refresh that text explicitly — resolving the theme inside the renderer alone is not
 * enough, because the renderer is only consulted on construction or on expand/collapse.
 */
export function setStartupActiveTheme(theme: ThemeLike | undefined): void {
	activeTheme = theme;
	refreshResourceRowText?.();
}

export function setCompactStartupHeader(ui: ExtensionUIContext, cwd: string): void {
	if (isQuietStartup(cwd)) return;
	ui.setHeader((_tui, theme) => {
		const headerTheme = theme as ThemeLike;
		activeTheme = headerTheme;
		return {
			invalidate() {},
			render(width: number): string[] {
				maybeStartLogoAnimation(_tui, headerTheme, width);
				const animated = currentLogoAnimationLines();
				const logoLines = animated ?? styledLogoLines(headerTheme);
				return composeHeaderRows(width, logoLines);
			},
		};
	});
}

export function suppressStartupModelScopeLog(): void {
	installPatch(console, "log", "startup-ui.console.log", (originalLog) =>
		function suppressedConsoleLog(this: unknown, ...args: unknown[]) {
			const first = typeof args[0] === "string" ? args[0] : "";
			if (first.includes("Model scope:") && first.includes("Ctrl+P to cycle")) return;
			originalLog.apply(this, args);
		},
	);
}

/**
 * Rebuild pi's diagnostic `sourceInfos` map. `formatDiagnostics` uses it to
 * print the `(user)` / package scope label next to each conflict path.
 */
function buildDiagnosticSourceInfos(mode: any, themesResult: any): Map<string, unknown> {
	const sourceInfos = new Map<string, unknown>();
	try {
		const extensionsResult = mode?.session?.resourceLoader?.getExtensions?.();
		for (const extension of extensionsResult?.extensions ?? []) {
			if (!extension?.hidden && extension?.sourceInfo) sourceInfos.set(extension.path, extension.sourceInfo);
		}
		for (const skill of mode?.session?.resourceLoader?.getSkills?.()?.skills ?? []) {
			if (skill?.sourceInfo) sourceInfos.set(skill.filePath, skill.sourceInfo);
		}
		for (const prompt of mode?.session?.resourceLoader?.getPrompts?.()?.prompts ?? []) {
			if (prompt?.sourceInfo) sourceInfos.set(prompt.filePath, prompt.sourceInfo);
		}
		for (const loadedTheme of themesResult?.themes ?? []) {
			if (loadedTheme?.sourcePath && loadedTheme?.sourceInfo) sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
		}
	} catch {
		// Best effort: the report still renders without scope labels.
	}
	return sourceInfos;
}

/**
 * Assemble the same extension diagnostics pi prints under `[Extension issues]`:
 * load errors, command conflicts (extension + built-in) and shortcut conflicts.
 */
function collectExtensionDiagnostics(mode: any): unknown[] {
	const diagnostics: unknown[] = [];
	try {
		for (const error of mode?.session?.resourceLoader?.getExtensions?.()?.errors ?? []) {
			diagnostics.push({ type: "error", message: error.error, path: error.path });
		}
		const runner = mode?.session?.extensionRunner;
		if (typeof runner?.getCommandDiagnostics === "function") diagnostics.push(...(runner.getCommandDiagnostics() ?? []));
		if (typeof mode?.getBuiltInCommandConflictDiagnostics === "function") {
			diagnostics.push(...(mode.getBuiltInCommandConflictDiagnostics(runner) ?? []));
		}
		if (typeof runner?.getShortcutDiagnostics === "function") diagnostics.push(...(runner.getShortcutDiagnostics() ?? []));
	} catch {
		// Best effort: a partial report is better than none.
	}
	return diagnostics;
}

/** Swap the status `Text` pi just added for a horizontally centred one. */
function centerLatestStatus(mode: any, message: string): void {
	const children = mode?.chatContainer?.children;
	if (!Array.isArray(children)) return;
	const index = children.indexOf(mode.lastStatusText);
	if (index < 0) return;
	const centered = new CenteredStatusText(currentStartupTheme(mode).fg("dim", message), 1, 0);
	children[index] = centered;
	mode.lastStatusText = centered;
	try {
		mode.ui?.requestRender?.();
	} catch {
		// Best effort.
	}
}

/** System-prompt, append-prompt and context-file rows for the startup panel. */
function collectSystemContextItems(
	host: any,
	sources: {
		systemPrompt: unknown;
		appendSystemPrompts: string[];
		contextFiles: any[];
		systemPromptPath: string | undefined;
		appendSystemPromptPath: string | undefined;
	},
): SystemContextItem[] {
	const items: SystemContextItem[] = [];
	if (typeof sources.systemPrompt === "string") {
		const words = countWords(sources.systemPrompt);
		const lines = countLines(sources.systemPrompt);
		if (words > 0 && lines > 0) {
			items.push({
				priority: 10,
				kind: "system",
				path: sources.systemPromptPath ? host.formatContextPath(sources.systemPromptPath) : "custom system prompt",
				words,
				lines,
			});
		}
	}
	sources.appendSystemPrompts.forEach((content: string, index: number) => {
		const words = countWords(content);
		const lines = countLines(content);
		if (words <= 0 || lines <= 0) return;
		items.push({
			priority: 20 + index,
			kind: "append",
			path: sources.appendSystemPromptPath && index === 0 ? host.formatContextPath(sources.appendSystemPromptPath) : `append system prompt ${index + 1}`,
			words,
			lines,
		});
	});
	sources.contextFiles.forEach((file: any, index: number) => {
		const content = file.content ?? "";
		const words = countWords(content);
		const lines = countLines(content);
		if (words <= 0 || lines <= 0) return;
		items.push({
			priority: 100 + index,
			kind: "context",
			path: host.formatContextPath(file.path),
			words,
			lines,
		});
	});
	return items;
}

/** The startup Resources row chips. */
function buildResourceRows(
	host: any,
	parts: {
		systemContextItems: SystemContextItem[];
		scopedModels: any[];
		availableTools: AvailableTool[];
		skills: any[];
		templates: any[];
		extensions: any[];
		themes: any[];
	},
): ResourceRow[] {
	return [
		{ label: "system", items: parts.systemContextItems.filter((item) => item.kind === "system").map((item) => item.path) },
		{ label: "append", items: parts.systemContextItems.filter((item) => item.kind === "append").map((item) => item.path) },
		{ label: "context", items: parts.systemContextItems.filter((item) => item.kind === "context").map((item) => item.path) },
		{ label: "models", items: parts.scopedModels.map((scoped: any) => `${scoped.model.provider}/${scoped.model.id}`) },
		{ label: "tools", items: parts.availableTools.map((tool) => tool.name) },
		{ label: "skills", items: parts.skills.map((skill: any) => skill.name) },
		{ label: "prompts", items: parts.templates.map((template: any) => `/${template.name}`) },
		{ label: "extensions", items: host.getCompactExtensionLabels(parts.extensions) },
		{ label: "themes", items: parts.themes.map((loadedTheme: any) => loadedTheme.name ?? host.getCompactPathLabel(loadedTheme.sourcePath, loadedTheme.sourceInfo)) },
	].filter((row) => row.items.length > 0);
}

/** One collapsed notice per non-empty diagnostic group, each preceded by a blank line. */
function addDiagnosticNotices(
	host: any,
	groups: Array<{ title: string; diagnostics: unknown[] }>,
	sourceInfos: Map<string, unknown>,
	mode: { theme?: unknown },
): void {
	const requestRender = (): void => {
		try {
			host.ui?.requestRender?.();
		} catch {
			// Best effort.
		}
	};
	for (const group of groups) {
		host.loadedResourcesContainer.addChild(new Spacer(1));
		host.loadedResourcesContainer.addChild(new CollapsibleDiagnostics(
			() => currentStartupTheme(mode),
			group.title,
			typeof host.formatDiagnostics === "function" ? host.formatDiagnostics(group.diagnostics, sourceInfos) : "",
			requestRender,
		));
	}
}

export function installStartupUiPatch(InteractiveModeComponent: any): void {
	installPatch(
		InteractiveModeComponent?.prototype,
		"showLoadedResources",
		"startup-ui.showLoadedResources",
		(original) =>
		function showSleekLoadedResources(this: any, options?: { force?: boolean; showDiagnosticsWhenQuiet?: boolean; extensions?: Array<{ path: string; sourceInfo?: unknown }> }) {
		if (this.options?.verbose || !this.loadedResourcesContainer) return original.call(this, options);
		refreshResourceRowText = undefined;
		const showListing = options?.force || this.options?.verbose || !this.settingsManager?.getQuietStartup?.();
		if (!showListing) {
			return original.call(this, options);
		}

		this.loadedResourcesContainer.clear();
		const skillsResult = this.session.resourceLoader.getSkills();
		const skills = skillsResult.skills;
		const templates = this.session.promptTemplates ?? [];
		const themesResult = this.session.resourceLoader.getThemes();
		const themes = themesResult.themes.filter((loadedTheme: any) => loadedTheme.sourcePath);

		// Every diagnostic banner pi would print (skills / prompts / extension
		// issues / themes), rendered by us as collapsed notices instead. Skipped in
		// --verbose, where pi expands the whole startup listing anyway.
		const diagnosticSourceInfos = buildDiagnosticSourceInfos(this, themesResult);
		const diagnosticGroups: Array<{ title: string; diagnostics: unknown[] }> = this.options?.verbose
			? []
			: [
				{ title: "Skill conflicts", diagnostics: Array.isArray(skillsResult.diagnostics) ? skillsResult.diagnostics : [] },
				{ title: "Prompt conflicts", diagnostics: this.session.resourceLoader.getPrompts?.()?.diagnostics ?? [] },
				{ title: "Extension issues", diagnostics: collectExtensionDiagnostics(this) },
				{ title: "Theme conflicts", diagnostics: Array.isArray(themesResult.diagnostics) ? themesResult.diagnostics : [] },
			].filter((group) => group.diagnostics.length > 0);
		const extensions = options?.force && options?.extensions
			? options.extensions
			: this.session.resourceLoader.getExtensions().extensions.map((extension: any) => ({
				path: extension.path,
				sourceInfo: extension.sourceInfo,
			}));
		const contextFiles = this.session.resourceLoader.getAgentsFiles().agentsFiles;
		const scopedModels = this.session.scopedModels ?? [];
		const availableTools = getAvailableTools(this.session);
		const cwd = typeof this.sessionManager?.getCwd === "function" ? this.sessionManager.getCwd() : process.cwd();
		const agentDir = getAgentDir();
		const systemPrompt = this.session.resourceLoader.getSystemPrompt?.();
		const appendSystemPrompts = this.session.resourceLoader.getAppendSystemPrompt?.() ?? [];
		const systemPromptPath = discoverPromptFile(cwd, agentDir, "SYSTEM.md");
		const appendSystemPromptPath = discoverPromptFile(cwd, agentDir, "APPEND_SYSTEM.md");
		const systemContextItems = collectSystemContextItems(this, {
			systemPrompt,
			appendSystemPrompts,
			contextFiles,
			systemPromptPath,
			appendSystemPromptPath,
		});

		const rows = buildResourceRows(this, { systemContextItems, scopedModels, availableTools, skills, templates, extensions, themes });

		const mode = this as { theme?: unknown };
		if (rows.length > 0 || diagnosticGroups.length > 0) {
			this.loadedResourcesContainer.addChild(new Spacer(1));
			if (rows.length > 0) {
				// `ExpandableText` bakes its text at construction (it extends pi's `Text`), so the
				// renderer below runs at construction and on expand/collapse only. Resolve the theme
				// from the live sources, and let `setStartupActiveTheme` re-run this text once the
				// real theme is known — otherwise the row keeps whatever theme startup happened to
				// have (the colourless fallback) until a resume/reload rebuilds the whole mode.
				const getExpanded = () => typeof this.getStartupExpansionState === "function"
					? this.getStartupExpansionState()
					: Boolean(this.options?.verbose);
				const expanded = getExpanded();
				const collapsedText = () => renderResourceTable(currentStartupTheme(mode), rows, systemContextItems, availableTools, false);
				const expandedText = () => renderResourceTable(currentStartupTheme(mode), rows, systemContextItems, availableTools, true);
				const resourceRow = new ExpandableText(collapsedText, expandedText, expanded);
				// Only the newest row matters: session replacement discards the old
				// chat container, so chaining prior refreshes would retain every
				// previous session's row (and its captured data) for the process
				// lifetime.
				refreshResourceRowText = () => {
					resourceRow.setExpanded(getExpanded());
				};
				this.loadedResourcesContainer.addChild(resourceRow);
			}
			// Extra blank line between the Resources row and the diagnostics block.
			if (rows.length > 0 && diagnosticGroups.length > 0) {
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}
			// One collapsed notice per non-empty diagnostic group, each preceded by a
			// blank line so they read as separate blocks under the Resources row.
			addDiagnosticNotices(this, diagnosticGroups, diagnosticSourceInfos, mode);
			this.loadedResourcesContainer.addChild(new Spacer(1));
		}
		return undefined;
		},
	);

	// Centre the `/reload` confirmation status line (pi renders it left-aligned).
	installPatch(
		InteractiveModeComponent?.prototype,
		"showStatus",
		"startup-ui.showStatus",
		(original) =>
			function showSleekStatus(this: any, message?: unknown) {
				const result = original.call(this, message);
				if (typeof message === "string" && message.startsWith("Reloaded keybindings")) {
					centerLatestStatus(this, message);
				}
				return result;
			},
	);
}
