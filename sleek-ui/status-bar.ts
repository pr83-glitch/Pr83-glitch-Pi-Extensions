/**
 * Status bar — the Sleek-style footer, ported from pi-zazz's `gemini` user zone.
 *
 * pi's own footer is two dim lines (cwd/branch, usage stats/context) plus any
 * extension statuses. This module replaces it, per `sleek-statusBar`, with:
 *   - `default` — pi's own footer until its item layout is customized;
 *   - `sleek`   — the configurable two-row Sleek layout;
 *   - `bar`     — the configurable pi-zazz nvim-style layout on the bash/edit
 *                 tool-block surface;
 *   - `minimal` — a one-line icon/status layout with dot separators and compact filtering.
 *
 * Installed by patching `FooterComponent.prototype.render` because the footer
 * owns the data the bar needs (`session.state.model`, `session.getContextUsage()`
 * and `footerData.getGitBranch()`), and the mode/layout are read per render so
 * `/sleek` changes apply live. `/sleek` → Status bar items controls visibility
 * and placement across both rows and sides; the default footer is left untouched
 * until its layout is customized. Token usage is accumulated from `message_end`
 * events and seeded on `session_start`, so the render path never scans entries.
 */

import { basename } from "path";

import { FooterComponent } from "@earendil-works/pi-coding-agent";

import { installPatch } from "./core/patch-registry.js";
import { copyChrome } from "./core/copy-selection.js";
import {
	isDefaultStatusBarLayout,
	loadConfig,
	resolveStatusBarModeId,
	type StatusBarItemConfig,
	type StatusBarItemId,
	type StatusBarLayout,
} from "./config.js";
import { formatDsPeakCountdown, getDsPeakInfo } from "./ds-peak.js";
import { getGitStatus } from "./git-status.js";
import { safeTruncateToWidth, safeVisibleWidth } from "./render-budget.js";
import { stripAnsi, themeBackgroundAnsi, wrapAnsiBackground } from "./theme/ansi.js";
import { isHexColor } from "./theme/color.js";
import { getThemeVarAnsi, getThemeVarBackground, themeVarPainter } from "./theme/theme-extras.js";
import { BRANCH_GLYPH, DOT, FOLDER_GLYPH, cacheHitPercent, formatCompactTokens, meterBar, slimStatusText } from "./status-shared.js";
/** Cells in the context bar — thin `━` runs, matching the pi-blackhole meters. */
const CONTEXT_BAR_CELLS = 8;
/** Theme blue for the context bar's filled run. */
const CONTEXT_BAR_COLOR = "mdLink";

type Part = { plain: string; rendered: string; boxed?: { plain: string; rendered: string }; withWorkMode?: Part };
/** An extension status set via `ctx.ui.setStatus`. */
type StatusEntry = { key: string; text: string };
type StatusBarUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number };
/** pi-permit's work modes: the input-box border colour follows them. */
type WorkMode = "plan" | "build" | "yolo";

/** The plan/build/yolo mode badge values pi-permit renders. */
const WORK_MODE_VALUES = new Set(["plan", "build", "yolo"]);

const EMPTY_USAGE: StatusBarUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
let usage: StatusBarUsage = { ...EMPTY_USAGE };

function finiteOr0(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** `theme.fg`, or the identity when the theme is missing (footer render can outrun the theme). */
function safeFg(theme: any): (color: string, text: string) => string {
	return typeof theme?.fg === "function"
		? (color: string, text: string) => theme.fg(color, text)
		: (_color: string, text: string) => text;
}

/** Add one usage record into the running totals. */
function addUsage(u: any): void {
	usage.input += finiteOr0(u?.input);
	usage.output += finiteOr0(u?.output);
	usage.cacheRead += finiteOr0(u?.cacheRead);
	usage.cacheWrite += finiteOr0(u?.cacheWrite);
	usage.costUsd += finiteOr0(u?.cost?.total);
}

/** Accumulate a finished message's usage into the bar's running totals. */
export function addUsageFromMessage(message: any): void {
	if (!message || (message.role !== "assistant" && message.role !== "toolResult") || !message.usage) return;
	addUsage(message.usage);
}

/** Rebuild the running totals from session entries (session_start / resume). */
export function seedStatusBarUsage(entries: readonly any[]): void {
	usage = { ...EMPTY_USAGE };
	if (!Array.isArray(entries)) return;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		if (entry.type === "message") addUsageFromMessage(entry.message);
		else if ((entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary")) addUsage(entry.usage);
	}
}

/** Return a snapshot for other Sleek surfaces, such as the side panel. */
export function getStatusBarUsage(): StatusBarUsage {
	return { ...usage };
}

/** Drop the running totals (session_shutdown). */
export function resetStatusBarUsage(): void {
	usage = { ...EMPTY_USAGE };
}

/** Install the footer patch; `getTheme` resolves the live theme at render time. */
export function installStatusBar(getTheme: () => any, requestRender?: () => void): void {
	installPatch(
		(FooterComponent as { prototype?: unknown }).prototype,
		"render",
		"pi-sleek.status-bar.render",
		(base: (this: any, width: number) => string[]) =>
			function patchedStatusBarRender(this: any, width: number): string[] {
				const config = loadConfig();
				const mode = resolveStatusBarModeId(config.statusBar);
				let lines: string[];
				if (mode === "default" && isDefaultStatusBarLayout(config.statusBarLayout)) {
					stopStatusBarTimers();
					lines = base.call(this, width);
				} else {
					try {
						// A customized Default uses Sleek's compact item renderer.
						lines = renderStatusBar(mode === "bar" || mode === "minimal" ? mode : "sleek", this, width, getTheme(), requestRender);
					} catch {
						// Never let the status bar take down the footer.
						lines = base.call(this, width);
					}
				}
				return lines.map((line) => copyChrome(line, width));
			},
	);
}

/**
 * The DeepSeek peak/off-peak countdown only changes on minute boundaries and
 * pi does not repaint an idle TUI, so one unref'd tick keeps it live.
 */
let peakTimer: ReturnType<typeof setInterval> | undefined;

function startPeakTimer(requestRender?: () => void): void {
	if (peakTimer || typeof requestRender !== "function") return;
	peakTimer = setInterval(() => {
		try {
			requestRender();
		} catch {
			// Best effort.
		}
	}, 60_000);
	peakTimer.unref?.();
}

/** Clear the peak timer (session_shutdown). */
export function stopStatusBarTimers(): void {
	if (!peakTimer) return;
	clearInterval(peakTimer);
	peakTimer = undefined;
}

function sanitizeLine(text: unknown): string {
	return String(text ?? "").replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim();
}

function readExtensionStatuses(footer: any): StatusEntry[] {
	try {
		const statuses = footer?.footerData?.getExtensionStatuses?.();
		if (!statuses || typeof statuses.entries !== "function") return [];
		return Array.from(statuses.entries() as Iterable<[unknown, unknown]>)
			.sort(([a], [b]) => String(a).localeCompare(String(b)))
			.map(([key, text]) => ({ key: String(key), text: sanitizeLine(text) }))
			.filter((entry) => entry.text.length > 0);
	} catch {
		return [];
	}
}

function isWorkModeStatus(entry: StatusEntry): boolean {
	return workModeFromText(entry.text) !== null || entry.key === "pi-permit-mode";
}

/** The work-mode status entry, preferring pi-permit's own key over a bare plan/build/yolo label. */
function findWorkModeStatus(statuses: StatusEntry[]): StatusEntry | undefined {
	return statuses.find((entry) => entry.key === "pi-permit-mode" && isWorkModeStatus(entry))
		?? statuses.find(isWorkModeStatus);
}

/** The `plan`/`build`/`yolo` value behind a status label, ANSI stripped. */
function workModeFromText(text: unknown): WorkMode | null {
	const plain = stripAnsi(String(text ?? "")).trim().toLowerCase();
	return WORK_MODE_VALUES.has(plain) ? (plain as WorkMode) : null;
}

/** First work-mode status found: pi-permit's own key wins, then any plan/build/yolo label. */
function workModeFromStatuses(statuses: unknown): WorkMode | null {
	if (!statuses || typeof (statuses as { entries?: unknown }).entries !== "function") return null;
	let fallback: WorkMode | null = null;
	for (const [key, text] of statuses as Iterable<[unknown, unknown]>) {
		const mode = workModeFromText(text);
		if (!mode) continue;
		if (key === "pi-permit-mode") return mode;
		fallback ??= mode;
	}
	return fallback;
}

/** Pad (or truncate) a rendered line to exactly `width` visible columns. */
function fitLine(rendered: string, width: number): string {
	const visible = safeVisibleWidth(rendered);
	if (visible > width) return safeTruncateToWidth(rendered, width, "…");
	return rendered + " ".repeat(Math.max(0, width - visible));
}

/** Left cluster, right cluster right-aligned; truncates the right when it cannot fit. */
function splitRow(left: string, right: string, leftPlain: string, rightPlain: string, width: number): string {
	const leftWidth = safeVisibleWidth(leftPlain);
	const rightWidth = safeVisibleWidth(rightPlain);
	if (leftWidth === 0 && rightWidth === 0) return "";
	if (leftWidth === 0) return " ".repeat(Math.max(0, width - rightWidth)) + safeTruncateToWidth(right, width, "…");
	if (rightWidth === 0) return safeTruncateToWidth(left, width, "…");
	if (leftWidth + rightWidth + 1 <= width) return left + " ".repeat(width - leftWidth - rightWidth) + right;
	const available = width - leftWidth - 1;
	if (available <= 0) return safeTruncateToWidth(left, width, "…");
	const truncatedPlain = safeTruncateToWidth(rightPlain, available, "…");
	const truncated = safeTruncateToWidth(right, available, "…");
	const truncatedWidth = safeVisibleWidth(truncatedPlain);
	return left + " ".repeat(Math.max(1, width - leftWidth - truncatedWidth)) + truncated;
}

/** Render the configured footer in the Sleek, Bar or Minimal style. */
function renderStatusBar(
	style: "sleek" | "bar" | "minimal",
	footer: any,
	width: number,
	theme: any,
	requestRender?: () => void,
): string[] {
	if (typeof width !== "number" || width <= 0) return [];
	const config = loadConfig();
	const layout = style === "minimal" ? minimalLayout(config.statusBarLayout, config.bottomBar) : config.statusBarLayout;
	const parts = buildStatusBarParts(footer, theme, requestRender, style, config.statusBarLayout, config.bottomBar);
	const rendered = renderConfiguredRows(
		layout,
		style === "minimal" ? minimalizeParts(parts, theme) : parts,
		width,
		style === "minimal"
			? { singleLine: true, bottomBar: config.bottomBar }
			: { bottomBar: config.bottomBar, boxEdges: style === "bar" },
	);
	if (style !== "bar") return rendered;
	const bgAnsi = barBackgroundAnsi(theme);
	return bgAnsi ? rendered.map((line) => wrapAnsiBackground(line, bgAnsi)) : rendered;
}

/** Minimal-style icons use Nerd Font escapes with plain-text fallbacks where practical. */
const MINIMAL_ICONS: Partial<Record<StatusBarItemId, string>> = {
	thinking: "\u{EE9C}", // U+EE9C
	contextTokens: "\u{F451}", // U+F451
	contextPercent: "\u{F451}", // U+F451
	cost: "\u{F155}", // fa-dollar-sign
	model: "\u{EE0D}", // U+EE0D
};

function minimalThinkingPainter(theme: any, level: string): (text: string) => string {
	const key = level.trim().toLowerCase();
	if (key === "medium") return minimalColorPainter(theme, "blue", "mdLink");
	if (key === "high") return minimalColorPainter(theme, "yellow", "warning");
	if (key === "xhigh" || key === "max") return minimalColorPainter(theme, "red", "error");
	if (key === "low" || key === "minimal") return minimalColorPainter(theme, "green", "success");
	const muted = safeFg(theme);
	return (text: string) => muted("muted", text);
}

function minimalColorPainter(theme: any, variable: string, fallback: string): (text: string) => string {
	const paint = safeFg(theme);
	return themeVarPainter(theme, variable) ?? ((text: string) => paint(fallback, text));
}

function minimalizeParts(parts: Partial<Record<StatusBarItemId, Part>>, theme: any): Partial<Record<StatusBarItemId, Part>> {
	const fg = safeFg(theme);
	const result: Partial<Record<StatusBarItemId, Part>> = {};
	const solidPainters: Partial<Record<StatusBarItemId, (text: string) => string>> = {
		directory: minimalColorPainter(theme, "yellow", "warning"),
		git: minimalColorPainter(theme, "purple", "mdLink"),
		contextTokens: (text) => fg("muted", text),
		contextPercent: (text) => fg("accent", text),
		cost: minimalColorPainter(theme, "green", "success"),
		model: minimalColorPainter(theme, "blue", "mdLink"),
	};
	for (const [id, part] of Object.entries(parts) as Array<[StatusBarItemId, Part | undefined]>) {
		if (!part) continue;
		// Git/directory parts carry their own identity glyphs and have no MINIMAL_ICONS entry.
		const icon = MINIMAL_ICONS[id];
		const painter = id === "thinking" ? minimalThinkingPainter(theme, part.plain) : solidPainters[id];
		const body = painter ? painter(part.plain) : part.rendered;
		result[id] = icon
			? { plain: `${icon} ${part.plain}`, rendered: `${painter ? painter(icon) : fg("muted", icon)} ${body}` }
			: { ...part, plain: part.plain, rendered: body };
	}
	return result;
}

/** Static picker data, styled with the same icons and painters as the live bar. */
export function minimalStatusBarSample(theme: any): string {
	const fg = (color: string, text: string): string => theme.fg(color, text);
	const parts = minimalizeParts({
		thinking: { plain: "low", rendered: "" },
		contextTokens: { plain: "27k/128k", rendered: "" },
		git: branchPart(fg, { footerData: { getGitBranch: () => "main" } })!,
		cost: { plain: "1.415", rendered: "" },
		model: { plain: "gpt-5.5", rendered: "" },
	}, theme);
	return joinParts(Object.values(parts) as Part[]).rendered;
}

const itemVisible = (item: StatusBarItemConfig, styleBottomBar: boolean): boolean =>
	item.enabled && item.slot !== "off" && (styleBottomBar || item.slot.startsWith("bar1-"));

function minimalLayout(layout: StatusBarLayout, bottomBar: boolean): StatusBarLayout {
	const result = {} as StatusBarLayout;
	for (const id of Object.keys(layout) as StatusBarItemId[]) {
		const item = layout[id];
		const compactSlot = item.slot === "bar2-left" ? "bar1-left" : item.slot === "bar2-right" ? "bar1-right" : item.slot;
		result[id] = { ...item, enabled: itemVisible(item, bottomBar), slot: compactSlot };
	}
	return result;
}

function slotParts(): Record<"bar1-left" | "bar1-right" | "bar2-left" | "bar2-right", Part[]> {
	return { "bar1-left": [], "bar1-right": [], "bar2-left": [], "bar2-right": [] };
}

function extensionStatusesPart(
	statuses: StatusEntry[],
	modeStatus: StatusEntry | undefined,
	showMode: boolean,
	fg: (color: string, text: string) => string,
): Part | null {
	const entries = showMode ? statuses.filter((entry) => entry !== modeStatus) : statuses;
	if (entries.length === 0) return null;
	return {
		plain: entries.map((entry) => stripAnsi(slimStatusText(entry.text, fg))).join(` ${DOT} `),
		rendered: entries.map((entry) => slimStatusText(entry.text, fg)).join(` ${DOT} `),
	};
}

function buildStatusBarParts(
	footer: any,
	theme: any,
	requestRender: (() => void) | undefined,
	style: "sleek" | "bar" | "minimal",
	configuredLayout: StatusBarLayout,
	bottomBar: boolean,
): Partial<Record<StatusBarItemId, Part>> {
	const fg = safeFg(theme);
	const session = footer?.session;
	const state = session?.state;
	const model = state?.model;
	const peakItem = configuredLayout.peak;
	const peakVisible = itemVisible(peakItem, bottomBar);
	if (peakVisible && isDeepSeekModel(model)) startPeakTimer(requestRender);
	else stopStatusBarTimers();
	const cwd = readCwd(session);
	const statuses = readExtensionStatuses(footer);
	const modeStatus = findWorkModeStatus(statuses);
	const mode = workModeFromText(modeStatus?.text);
	const modelId = typeof model?.id === "string" ? model.id : "";
	const level = typeof state?.thinkingLevel === "string" && model?.reasoning ? state.thinkingLevel : "";
	const project = cwd ? basename(cwd) : "";
	const parts: Partial<Record<StatusBarItemId, Part>> = {};

	if (project) {
		parts.directory = { plain: `${FOLDER_GLYPH} ${project}`, rendered: `${fg("warning", FOLDER_GLYPH)} ${fg("muted", project)}` };
	}
	if (modelId) parts.model = { plain: modelId, rendered: fg("muted", modelId) };
	if (level) {
		parts.thinking = style === "bar"
			? levelLabel(theme, level)
			: { plain: level, rendered: fg(thinkingLevelColor(level), level) };
	}
	const peak = dsPeakBadge(fg, model);
	if (peak) parts.peak = peak;
	if (usage.input > 0) parts.inputTokens = labelValue(fg, "I", formatCompactTokens(usage.input));
	if (usage.output > 0) parts.outputTokens = labelValue(fg, "O", formatCompactTokens(usage.output));
	if (usage.cacheRead > 0) parts.cacheRead = labelValue(fg, "R", formatCompactTokens(usage.cacheRead));
	if (usage.cacheWrite > 0) parts.cacheWrite = labelValue(fg, "W", formatCompactTokens(usage.cacheWrite));
	const hit = cacheHitPart(fg);
	if (hit) parts.cacheHit = hit;
	const context = contextUsageParts(fg, session, style);
	if (context.tokens) parts.contextTokens = context.tokens;
	if (context.percent) parts.contextPercent = context.percent;
	const cost = style === "bar"
		? (usage.costUsd > 0 ? costBullet(theme, usage.costUsd) : null)
		: costBadge(fg, style !== "minimal");
	if (cost) parts.cost = cost;
	if (modeStatus) {
		const modeText = stripAnsi(modeStatus.text).trim().toLowerCase();
		const modeLabel = `${workModeIcon(mode)}${modeText ? ` ${modeText}` : ""}`;
		const modePaint = modePainter(theme, mode, level || "off");
		const label = style === "bar" ? modeLabel.toUpperCase() : modeLabel;
		parts.workMode = { plain: label, rendered: modePaint ? modePaint(label) : modeStatus.text };
	}
	const git = branchPart(fg, footer);
	if (git) parts.git = git;
	const gitItem = configuredLayout.gitChanges;
	const gitVisible = itemVisible(gitItem, bottomBar);
	const gitChanges = gitVisible ? gitChangesPart(fg, cwd, requestRender) : null;
	if (gitChanges) parts.gitChanges = gitChanges;
	const extensions = extensionStatusesPart(statuses, modeStatus, itemVisible(configuredLayout.workMode, bottomBar), fg);
	if (extensions) parts.extensions = { ...extensions, withWorkMode: extensionStatusesPart(statuses, modeStatus, false, fg) ?? undefined };

	fillMetaParts(parts, footer, session, model, fg);
	if (style === "bar") boxBarParts(parts, theme, mode, level, fg);
	return parts;
}

/** Session name, provider, routed model and auto-compact indicator. */
function fillMetaParts(
	parts: Partial<Record<StatusBarItemId, Part>>,
	footer: any,
	session: any,
	model: any,
	fg: (color: string, text: string) => string,
): void {
	const sessionName = session?.sessionManager?.getSessionName?.();
	if (typeof sessionName === "string" && sessionName.trim()) parts.sessionName = { plain: sessionName.trim(), rendered: fg("muted", sessionName.trim()) };
	if (typeof model?.provider === "string" && model.provider) parts.provider = { plain: model.provider, rendered: fg("dim", model.provider) };
	const routed = session?.routedModel?.model;
	if (routed?.id) {
		const routedText = `→ ${routed.id}`;
		parts.routedModel = { plain: routedText, rendered: fg("muted", routedText) };
	}
	if (footer?.autoCompactEnabled) parts.autoCompact = { plain: "auto", rendered: fg("dim", "auto") };
}

/** Bar style: give every part a reverse-video `boxed` variant. */
function boxBarParts(
	parts: Partial<Record<StatusBarItemId, Part>>,
	theme: any,
	mode: WorkMode | null,
	level: string,
	fg: (color: string, text: string) => string,
): void {
	for (const id of Object.keys(parts) as StatusBarItemId[]) {
		const part = parts[id]!;
		const paint = (id === "workMode" ? modePainter(theme, mode, level || "off")
			: id === "thinking" ? nvimLevelPainter(theme, level)
				: themeVarPainter(theme, id === "directory" || id === "model" ? "cyan" : "accent"))
			?? ((text: string) => fg("accent", text));
		part.boxed = reverseBlock(theme, paint, part.plain);
	}
}

type StatusBarBuckets = ReturnType<typeof slotParts>;

function buildStatusBarBuckets(
	layout: StatusBarLayout,
	parts: Partial<Record<StatusBarItemId, Part>>,
	compactOnly: boolean,
	showSecondRow: boolean,
	boxEdges = false,
): StatusBarBuckets {
	const buckets = slotParts();
	for (const id of Object.keys(layout) as StatusBarItemId[]) {
		const item: StatusBarItemConfig = layout[id];
		let part = parts[id];
		const modeVisible = itemVisible(layout.workMode, showSecondRow) && (!compactOnly || layout.workMode.compact);
		if (id === "extensions" && !modeVisible && part?.withWorkMode) part = part.withWorkMode;
		if (!item.enabled || item.slot === "off" || !part || !(item.slot in buckets)) continue;
		if (compactOnly && !item.compact) continue;
		if (!showSecondRow && item.slot.startsWith("bar2-")) continue;
		buckets[item.slot as keyof StatusBarBuckets].push(part);
	}
	if (boxEdges) {
		for (const row of ["bar1", "bar2"] as const) {
			const left = buckets[`${row}-left`];
			const right = buckets[`${row}-right`];
			const first = left.length ? left : right;
			const last = right.length ? right : left;
			if (first.length) first[0] = first[0]!.boxed ?? first[0]!;
			if (last.length) last[last.length - 1] = last.at(-1)!.boxed ?? last.at(-1)!;
		}
	}
	return buckets;
}

function configuredRowsFromBuckets(buckets: StatusBarBuckets, width: number, showSecondRow: boolean): string[] {
	const join = (items: Part[]): Part => joinParts(items);
	const row1 = join(buckets["bar1-left"]);
	const row2 = showSecondRow ? join(buckets["bar2-left"]) : { plain: "", rendered: "" };
	const row1Right = join(buckets["bar1-right"]);
	const row2Right = showSecondRow ? join(buckets["bar2-right"]) : { plain: "", rendered: "" };
	const rendered1 = splitRow(row1.rendered, row1Right.rendered, row1.plain, row1Right.plain, width);
	const rendered2 = splitRow(row2.rendered, row2Right.rendered, row2.plain, row2Right.plain, width);
	const hasRow2 = Boolean(row2.plain || row2Right.plain);
	if (!row1.plain && !row1Right.plain && !hasRow2) return [" ".repeat(width)];
	return hasRow2
		? [fitLine(rendered1, width), fitLine(rendered2, width)]
		: [fitLine(rendered1, width)];
}

function configuredRowsFit(buckets: StatusBarBuckets, width: number, showSecondRow: boolean): boolean {
	const rowFits = (left: Part[], right: Part[]): boolean => {
		const leftWidth = safeVisibleWidth(joinParts(left).plain);
		const rightWidth = safeVisibleWidth(joinParts(right).plain);
		if (leftWidth === 0) return rightWidth <= width;
		if (rightWidth === 0) return leftWidth <= width;
		return leftWidth + rightWidth + 1 <= width;
	};
	return rowFits(buckets["bar1-left"], buckets["bar1-right"])
		&& (!showSecondRow || rowFits(buckets["bar2-left"], buckets["bar2-right"]));
}

function renderConfiguredRows(
	layout: StatusBarLayout,
	parts: Partial<Record<StatusBarItemId, Part>>,
	width: number,
	options: { singleLine?: boolean; bottomBar?: boolean; boxEdges?: boolean } = {},
): string[] {
	const showSecondRow = !options.singleLine && (options.bottomBar ?? loadConfig().bottomBar);
	const allBuckets = buildStatusBarBuckets(layout, parts, false, showSecondRow, options.boxEdges);
	const buckets = configuredRowsFit(allBuckets, width, showSecondRow)
		? allBuckets
		: buildStatusBarBuckets(layout, parts, true, showSecondRow, options.boxEdges);
	return configuredRowsFromBuckets(buckets, width, showSecondRow);
}

// ------------------------------------------------------------
// Bar style — a pi-zazz nvim statusline on the tool-block surface

/** Raw resolved value of a theme var (hex or ANSI escape), for equality checks. */
function themeVarValue(theme: any, varName: string): string {
	const hex = getThemeVarBackground(theme, varName);
	if (isHexColor(hex)) return hex.toLowerCase();
	return getThemeVarAnsi(theme, varName) || "";
}

/**
 * Painter for `varName`; when it resolves to the same colour as `aliasOf`, some
 * themes point two vars at one palette entry (rose-pine maps both `blue` and
 * `green` to `foam`), so `nextVar` is used to keep the two blocks distinct.
 */
function distinctThemeVarPainter(
	theme: any,
	varName: string,
	aliasOf: string,
	nextVar: string,
): ((text: string) => string) | null {
	const painter = themeVarPainter(theme, varName);
	const value = themeVarValue(theme, varName);
	if (painter && value && value !== themeVarValue(theme, aliasOf)) return painter;
	return themeVarPainter(theme, nextVar) ?? painter;
}

/** Vivid theme colour for a thinking level; null for `off`, which gets no box. */
function nvimLevelPainter(theme: any, level: string): ((text: string) => string) | null {
	const key = level.trim().toLowerCase();
	if (key === "off") return null;
	const varName = key === "minimal" || key === "low" ? "green"
		: key === "medium" ? "yellow"
			: key === "high" ? "blue"
				: key === "xhigh" || key === "max" ? "orange"
					: "";
	const painter = varName === "blue"
		? distinctThemeVarPainter(theme, "blue", "green", "purple")
		: varName ? themeVarPainter(theme, varName) : null;
	return painter ?? themeVarPainter(theme, "accent");
}

/** Match the input box border colours for the plan/build/yolo mode status. */
function modePainter(theme: any, mode: WorkMode | null, thinkingLevel = "off"): ((text: string) => string) | null {
	if (typeof theme?.fg !== "function") return null;
	if (mode === "plan") {
		if (typeof theme?.getThinkingBorderColor === "function") return theme.getThinkingBorderColor(thinkingLevel);
		return (text: string) => theme.fg("border", text);
	}
	if (mode === "build") return themeVarPainter(theme, "purple") ?? ((text: string) => theme.fg("mdLink", text));
	if (mode === "yolo") return themeVarPainter(theme, "yellow") ?? ((text: string) => theme.fg("warning", text));
	return (text: string) => theme.fg("accent", text);
}

/** Nerd Font icons for the work-mode status item. */
function workModeIcon(mode: WorkMode | null): string {
	if (mode === "build") return "\u{F140B}"; // U+F140B
	if (mode === "plan") return "\u{F05E3}"; // U+F05E3
	if (mode === "yolo") return "\u{F169E}"; // U+F169E
	return "";
}

/**
 * Reverse-video block (` text `): `paint`'s colour becomes the background, so the
 * label reads as a solid block — the nvim badge look. Dim text when there is no
 * paint (`off` thinking, unknown mode).
 */
function reverseBlock(theme: any, paint: ((text: string) => string) | null, text: string): { plain: string; rendered: string } {
	const body = ` ${text} `;
	return { plain: body, rendered: paint ? `\x1b[7m${paint(body)}\x1b[27m` : safeFg(theme)("dim", body) };
}

/**
 * The bar's background: the same surface pi paints bash and edit tool blocks on
 * (`toolSuccessBg`, the settled look), so the bar matches the transcript's tool
 * boxes instead of the accent tint.
 */
function barBackgroundAnsi(theme: any): string {
	return themeBackgroundAnsi(theme, "toolSuccessBg") || themeBackgroundAnsi(theme, "toolPendingBg");
}

/** Session cost in the Bar style, with the amount muted. */
function costBullet(theme: any, costUsd: number): { plain: string; rendered: string } {
	const amount = `$${costUsd.toFixed(3)}`;
	return { plain: amount, rendered: safeFg(theme)("muted", amount) };
}

/** Build independent context-number and context-percentage items. */
function contextUsageParts(
	fg: (color: string, text: string) => string,
	session: any,
	style: "sleek" | "bar" | "minimal",
): { tokens: Part | null; percent: Part | null } {
	let ctx: any;
	try {
		ctx = session?.getContextUsage?.();
	} catch {
		return { tokens: null, percent: null };
	}
	if (!ctx) return { tokens: null, percent: null };
	const window = typeof ctx.contextWindow === "number" && ctx.contextWindow > 0 ? ctx.contextWindow : 0;
	const tokens = typeof ctx.tokens === "number" && Number.isFinite(ctx.tokens) ? ctx.tokens : null;
	const used = tokens === null ? "?" : formatCompactTokens(tokens);
	const windowText = window > 0 ? formatCompactTokens(window) : "?";
	const tokensPart = tokens !== null || window > 0
		? style === "sleek" && tokens !== null && window > 0
			? (() => {
				const bar = contextBar(fg, tokens / window);
				return { plain: `${bar.plain} ${used}/${windowText}`, rendered: `${bar.rendered} ${fg("muted", `${used}/${windowText}`)}` };
			})()
			: { plain: `${used}/${windowText}`, rendered: fg("muted", `${used}/${windowText}`) }
		: null;
	const percentValue = typeof ctx.percent === "number" && Number.isFinite(ctx.percent) ? `${Math.round(ctx.percent)}%` : "";
	const percentPart = percentValue ? { plain: percentValue, rendered: fg("muted", percentValue) } : null;
	return { tokens: tokensPart, percent: percentPart };
}

/**
 * The thinking level as a coloured label (no background block); dim for themes
 * whose level var does not resolve.
 */
function levelLabel(theme: any, level: string): { plain: string; rendered: string } {
	const text = level.toUpperCase();
	const paint = nvimLevelPainter(theme, level);
	return { plain: text, rendered: paint ? paint(text) : safeFg(theme)("dim", text) };
}

function branchPart(fg: (color: string, text: string) => string, footer: any): Part | null {
	const branch = readBranch(footer);
	if (!branch) return null;
	const plain = `${BRANCH_GLYPH} ${branch}`;
	return { plain, rendered: `${fg("muted", BRANCH_GLYPH)} ${fg("muted", branch)}` };
}

function gitChangesPart(fg: (color: string, text: string) => string, cwd: string, requestRender?: () => void): Part | null {
	const status = getGitStatus(cwd, requestRender);
	if (!status || (status.insertions <= 0 && status.deletions <= 0)) return null;
	const plain = `(+${status.insertions},-${status.deletions})`;
	const rendered = `(${fg("success", `+${status.insertions}`)},${fg("error", `-${status.deletions}`)})`;
	return { plain, rendered };
}

function joinParts(parts: Part[]): Part {
	return {
		plain: parts.map((part) => part.plain).join(` ${DOT} `),
		rendered: parts.map((part) => part.rendered).join(` ${DOT} `),
	};
}

function labelValue(fg: (color: string, text: string) => string, label: string, value: string): Part {
	return { plain: `${label} ${value}`, rendered: `${fg("dim", label)} ${fg("muted", value)}` };
}

/** Cache-hit percentage, shown on its own so compact mode can keep it. */
function cacheHitPart(fg: (color: string, text: string) => string): Part | null {
	const hit = cacheHitPercent(usage);
	if (hit === null || usage.cacheRead <= 0) return null;
	return labelValue(fg, "CH", `${Math.round(hit)}%`);
}

/** DeepSeek peak/off-peak label, colour and countdown, or null for other models. */
function dsPeakState(model: any): { label: string; countdown: string; color: string } | null {
	if (!isDeepSeekModel(model)) return null;
	const info = getDsPeakInfo();
	const isPeak = info.state === "peak";
	return {
		label: isPeak ? "Peak" : "Off-Peak",
		countdown: formatDsPeakCountdown(info.nextTransitionMs),
		color: isPeak ? "warning" : "success",
	};
}

function dsPeakBadge(fg: (color: string, text: string) => string, model: any): Part | null {
	const state = dsPeakState(model);
	if (!state) return null;
	// Label and countdown stay together, joined by a space — no `·` divider.
	return {
		plain: `${state.label} ${state.countdown}`,
		rendered: `${fg(state.color, state.label)} ${fg("muted", state.countdown)}`,
	};
}

function isDeepSeekModel(model: any): boolean {
	if (!model) return false;
	const provider = String(model.provider ?? "").toLowerCase();
	const id = String(model.id ?? "").toLowerCase();
	return provider.includes("deepseek") || id.startsWith("deepseek");
}

/** Thinking level tint: off/unknown muted, low green, medium blue, high orange, max/xhigh red. */
function thinkingLevelColor(level: string): string {
	switch (level.trim().toLowerCase()) {
		case "minimal":
		case "low":
			return "success";
		case "medium":
			return "mdLink";
		case "high":
			return "warning";
		case "xhigh":
		case "max":
			return "error";
		default:
			return "muted";
	}
}

/** Thin theme-blue context bar, filled to `ratio`, remainder in `borderMuted`. */
function contextBar(fg: (color: string, text: string) => string, ratio: number): Part {
	return { plain: "━".repeat(CONTEXT_BAR_CELLS), rendered: meterBar(CONTEXT_BAR_CELLS, ratio, CONTEXT_BAR_COLOR, fg) };
}

function costBadge(fg: (color: string, text: string) => string, includeDollar = true): Part | null {
	if (!(usage.costUsd > 0)) return null;
	const text = `${includeDollar ? "$" : ""}${usage.costUsd.toFixed(3)}`;
	return { plain: text, rendered: fg("warning", text) };
}

function readCwd(session: any): string {
	try {
		return typeof session?.sessionManager?.getCwd === "function" ? String(session.sessionManager.getCwd() ?? "") : "";
	} catch {
		return "";
	}
}

function readBranch(footer: any): string {
	try {
		const branch = footer?.footerData?.getGitBranch?.();
		return typeof branch === "string" ? branch : "";
	} catch {
		return "";
	}
}

/**
 * Tint the input box's divider (border) lines by work mode: plan keeps pi's own
 * border colour, build uses theme purple (mdLink fallback) and yolo uses the theme yellow (warning fallback).
 * Called after pi sets the border colour, so it wins for build/yolo.
 */
export function applyWorkModeBorderColor(mode: any, getTheme: () => any): void {
	try {
		const editor = mode?.editor;
		if (!editor || mode?.isBashMode) return;
		const workMode = workModeFromStatuses(mode?.footerDataProvider?.getExtensionStatuses?.());
		if (workMode !== "build" && workMode !== "yolo") return;
		const theme = getTheme();
		if (!theme || typeof theme.fg !== "function") return;
		const buildBorder = themeVarPainter(theme, "purple") ?? ((text: string) => theme.fg("mdLink", text));
		const yoloBorder = themeVarPainter(theme, "yellow") ?? ((text: string) => theme.fg("warning", text));
		editor.borderColor = workMode === "build" ? buildBorder : yoloBorder;
	} catch {
		// Never let the tinting break the editor.
	}
}

/**
 * Re-tint on a mode switch: pi-permit changes its badge through
 * `ctx.ui.setStatus`, which does not otherwise touch the editor border.
 */
export function installWorkModeBorderTrigger(
	InteractiveModeClass: { prototype?: unknown } | undefined,
	onExtensionStatus?: (key: string, text: unknown) => void,
): void {
	installPatch(
		InteractiveModeClass?.prototype,
		"setExtensionStatus",
		"pi-sleek.status-bar.setExtensionStatus",
		(original) =>
			function (this: any, key: string, text: unknown) {
				const result = original.call(this, key, text);
				onExtensionStatus?.(key, text);
				if (key === "pi-permit-mode" || workModeFromText(text) !== null) {
					try {
						this.updateEditorBorderColor?.();
					} catch {
						// Best effort.
					}
				}
				return result;
			},
	);
}
