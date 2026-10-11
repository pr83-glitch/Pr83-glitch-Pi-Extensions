/**
 * sleek-ui — a minimal, stripped-down sibling of pi-zazz.
 *
 * Bundled features: companion themes, thinking-style animations, the home/intro
 * screen fragment (logo, version, hints, ready, resources), the `/sleek` floating
 * settings menu, the startup logo animation, user/agent message styles, the tool
 * Density (Extended/Sleek) renderer, a compact-thinking collapse, the side panel,
 * the configurable status bar, work-mode borders, the theme page background and
 * desktop notifications.
 *
 * Live copy (what Pi loads): ~/.pi/agent/extensions/sleek-ui/
 * Repo mirror:               <repo>/sleek-ui/
 */
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { AgentSession, InteractiveMode } from "@earendil-works/pi-coding-agent";

import { installPatch, restorePatchedMethods } from "./core/patch-registry.js";
import { installCopySelection } from "./core/copy-selection.js";
import { PlaceholderEditor } from "./editor/placeholder-editor.js";
import { registerCompanionThemes } from "./theme/companion-themes.js";
import { setFullTheme, themeName } from "./theme/theme-extras.js";
import { createPaletteTintController } from "./theme/palette-tint.js";
import { createPageBackgroundController, type PageBackgroundTerminal } from "./theme/page-background-controller.js";
import { setFrameBackgroundEnabled } from "./theme/frame-background.js";
import { resetGitStatus } from "./git-status.js";
import { installRenderFrameBackground, uninstallRenderFrameBackground } from "./performance/render-frame-background.js";
import { installAssistantMessageBackground } from "./messages/assistant-message-bg.js";
import { installFollowUpMessageBackground } from "./messages/follow-up-message-bg.js";
import { clearImagePreviewCache, installImagePreview } from "./messages/image-preview.js";
import { installUserMessageStyle } from "./messages/user-message-style.js";
import { responseStatsClock, seedResponseStatsFromEntries } from "./messages/response-stats.js";
import { registerBashTool } from "./tool-tags/bash.js";
import { isTodoTool } from "./tool-tags/labels.js";
import { registerEditTool } from "./tool-tags/edit.js";
import { registerReadTool } from "./tool-tags/read.js";
import { registerWriteTool } from "./tool-tags/write.js";
import { installWorkingTimer } from "./tool-tags/working-timer.js";
import { installCompactThinking, installToolDensity, stopToolAnimationTicker } from "./tool-tags/density.js";
import { addUsageFromMessage, getStatusBarUsage, minimalStatusBarSample, installStatusBar, installWorkModeBorderTrigger, applyWorkModeBorderColor, resetStatusBarUsage, seedStatusBarUsage, stopStatusBarTimers } from "./status-bar.js";
import { DOT } from "./status-shared.js";
import { installSidePanelLayout, SidePanelController } from "./side-panel.js";
import { bindChildActivity, startChildActivity, updateChildActivity, finishChildActivity } from "./subagent-activity.js";
import {
	beginLogoAnimationSession,
	buildLogoPreviewFrames,
	installStartupUiPatch,
	setCompactStartupHeader,
	setStartupActiveTheme,
	setStartupThemeProvider,
	stopLogoAnimation,
	suppressStartupModelScopeLog,
} from "./startup-ui.js";
import { type MenuRow } from "./menu/popup.js";
import { createThemeMenuComponent } from "./menu/theme-picker.js";
import { openOptionPicker, type PickerOption, type SettingOptionHelp } from "./menu/option-picker.js";
import { createMenu, openOverlay } from "./menu/overlay.js";
import { openNotificationsMenu } from "./menu/notifications-menu.js";
import { menuPrimaryHint, type MenuTheme } from "./menu/frame.js";
import {
	createWorkingLoaderController,
	workingStateForAssistantMessage,
} from "./tool-tags/loader-accent.js";
import {
	resolveThinkingStyleId,
	setActiveThinkingStyleId,
	thinkingStyleFrameIntervalMs,
	thinkingStyleFrames,
	thinkingStyleLabel,
} from "./tool-tags/thinking-styles.js";
import {
	logoAnimationStyleLabel,
	resolveLogoAnimationStyleId,
	setActiveLogoAnimationStyleId,
} from "./tool-tags/logo-animation-styles.js";
import {
	agentMessageStyleLabel,
	densityModeLabel,
	resolveDensityModeId,
	loadConfig,
	logoColorModeLabel,
	resolveAgentMessageStyleId,
	resolveLogoColorModeId,
	resolveStatusBarModeId,
	resolveUserMessageStyleId,
	SIDE_PANEL_ITEM_IDS,
	sidePanelItemLabel,
	saveConfig,
	statusBarItemLabel,
	statusBarModeLabel,
	statusBarSlotLabel,
	STATUS_BAR_ITEM_IDS,
	userMessageStyleLabel,
	type SleekConfig,
	type StatusBarItemId,
	type StatusBarSlot,
} from "./config.js";
import {
	consumeBlacklistedPrompt,
	isActivePromptSourceBlacklisted,
	isNotificationSourceBlacklisted,
	markPromptSource,
	withNotificationPromptSource,
	maybeAlert,
	noteAssistantMessage,
	resetAlertState,
} from "./notify/alerts.js";
import { installFocusTracking, onTerminalFocusChange, uninstallFocusTracking } from "./notify/focus.js";

type WorkingLoaderController = ReturnType<typeof createWorkingLoaderController>;

/** Muted hint shown in the input box for an empty session. */
const INPUT_PLACEHOLDER = 'Ask anything…  "Build a Pi extension"';

/** Force-rescanning the theme directories is throttled so a theme reapply burst is cheap. */
const FORCE_THEME_SCAN_INTERVAL_MS = 1000;
let lastForcedThemeScanAt = 0;

let ownedEditorFactory: ReturnType<ExtensionUIContext["getEditorComponent"]>;
let currentSessionUi: ExtensionUIContext | undefined;
let workingLoaderController: WorkingLoaderController | undefined;
/** OSC 11 page-background controller; the terminal is captured from the concrete renderer. */
const pageBackground = createPageBackgroundController();
const paletteTint = createPaletteTintController();
let pageBackgroundTerminal: PageBackgroundTerminal | undefined;
/**
 * True while the theme picker is live-previewing a highlighted theme. The
 * preview recolours the ANSI cells fine, but rewriting the terminal's *default*
 * background (OSC 11) to a previewed dark theme leaves terminals that paint the
 * prompt row from that default (e.g. Zed) showing a dark user-message block until
 * a full redraw. Hold the page background at the real theme's colour and resync
 * once the picker settles.
 */
let themePreviewActive = false;
/** Main-session repaint hook, captured from the mounted renderer. */
let requestSessionRender: (() => void) | undefined;
let scheduledRender: ReturnType<typeof setTimeout> | undefined;
/** Terminal-focus subscription that re-reads the palette when focus returns. */
let unsubscribeTerminalFocus: (() => void) | undefined;
const sidePanel = new SidePanelController();

function installNotificationCommandSourcePatch(): void {
	installPatch(AgentSession.prototype as any, "_tryExecuteExtensionCommand", "pi-sleek.notifications.command-source", (original) =>
		async function patchedTryExecuteExtensionCommand(this: any, text: string): Promise<boolean> {
			const spaceIndex = text.indexOf(" ");
			const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
			const command = this._extensionRunner?.getCommand?.(commandName);
			const sourceInfo = command?.sourceInfo;
			const source = [sourceInfo?.source, sourceInfo?.path].filter((value): value is string => typeof value === "string").join("|");
			return source === "" ? original.call(this, text) : withNotificationPromptSource(source, () => original.call(this, text));
		},
	);
}
const runningToolCalls = new Set<string>();
/** True once the session has any input; the input placeholder only shows before then. */
let sessionHasMessages = false;
/** Suppress the response alert when the completed agent run was user-aborted. */
let suppressNextResponseNotification = false;

/**
 * Push the active theme to the pieces that latched it at construction: the
 * thinking-style frames (computed from theme vars) and the startup resource row
 * (its `Text` content is baked in, so it must be rebuilt explicitly).
 */
function syncTheme(force = false): void {
	if (force) {
		const now = Date.now();
		if (lastForcedThemeScanAt > 0 && now - lastForcedThemeScanAt < FORCE_THEME_SCAN_INTERVAL_MS) {
			force = false;
		} else {
			lastForcedThemeScanAt = now;
		}
	}
	const theme = currentSessionUi?.theme;
	if (theme) {
		setFullTheme(theme, force);
		paletteTint.configure(theme);
	}
	setStartupActiveTheme(theme);
	workingLoaderController?.configure();
	// Keep the terminal page background aligned with the (possibly new) theme.
	// Suppressed during theme-picker preview: OSC 11 must not follow a previewed
	// theme (see `themePreviewActive`); the picker resyncs once it settles.
	if (!themePreviewActive) {
		applyPageBackground(theme);
	}
}

/** Align the terminal page background and ANSI frame tint with the current config. */
function applyPageBackground(theme: any): void {
	const config = loadConfig();
	setFrameBackgroundEnabled(config.useThemeBackground);
	pageBackground.sync(theme, pageBackgroundTerminal, {
		enabled: config.useThemeBackground,
		forceOsc11: config.forceOSC11,
	});
}

/** Seed the sidebar and the stats clocks from a session branch. */
function applyBranch(branch: readonly any[]): void {
	sidePanel.setTodoTasksFromBranch(branch);
	sidePanel.setSubagentsFromBranch(branch);
	try {
		seedResponseStatsFromEntries(branch);
		seedStatusBarUsage(branch);
	} catch {
		// Best effort: keep live tracking active if branch metadata is incomplete.
	}
}

/** Reapply our theme-derived UI whenever pi re-applies the theme (settings switch, auto dark/light). */
function installThemeSyncPatch(InteractiveModeClass: unknown): void {
	installPatch(
		(InteractiveModeClass as { prototype?: unknown } | undefined)?.prototype,
		"updateEditorBorderColor",
		"sleek.theme-sync.updateEditorBorderColor",
		(original) =>
			function (this: unknown, ...args: unknown[]) {
				syncTheme(true);
				const result = original.apply(this, args);
				// pi set the border from the thinking level; retint it for build/yolo.
				applyWorkModeBorderColor(this, () => currentSessionUi?.theme);
				return result;
			},
	);
}

/** The theme picker; also reachable from the `/sleek` menu's Theme row. */
async function openThemePicker(ctx: { ui: any }): Promise<void> {
	const ui = ctx.ui;
	const themes = ui.getAllThemes() as { name: string; path?: string }[];
	if (themes.length === 0) {
		ui.notify("No themes available", "info");
		return;
	}
	const currentName = themeName(ui.theme);
	// Preview applies theme instances (no settings write); the persisted setting
	// still holds the original, which is restored on cancel.
	const original = currentName !== "" ? ui.getTheme(currentName) : undefined;
	// Keep the terminal default background on the real theme while browsing, so a
	// previewed dark theme cannot leave the prompt row painted dark (see
	// `themePreviewActive`). Resync to whatever theme the picker leaves active.
	themePreviewActive = true;
	try {
		await openOverlay(ui, (
			(tui: any, theme: any, done: (result: string | undefined) => void) =>
				createThemeMenuComponent({ tui, theme, host: ui, currentName, original, done })
		));
	} finally {
		themePreviewActive = false;
		syncTheme(true);
	}
}

/**
 * Menu model: each entry reads its current value from the config and knows how
 * to apply the next one, open its own submenu or picker, or toggle in place;
 * the popup itself (`menu/popup.ts`) is the shared extension-manager chrome.
 */
type SleekSettingsGroup = "Appearance" | "Animation" | "Status bar" | "Side panel" | "Notifications";

const SETTINGS_GROUP_ORDER: readonly SleekSettingsGroup[] = ["Appearance", "Animation", "Status bar", "Side panel", "Notifications"];

interface SettingsEntry {
	name: string;
	group: SleekSettingsGroup;
	title: string;
	/** One-line summary, used for search matching. */
	summary: string;
	description: string;
	kind: "theme" | "picker" | "toggle" | "submenu";
	options?: readonly SettingOptionHelp[];
	/** Optional static sample shown in the picker's right-hand preview column. */
	sample?: (id: string, theme: any) => string | undefined;
	/** Optional always-on animated preview for the picker. */
	preview?: (id: string, theme: any) => { frames: string[][]; intervalMs: number } | undefined;
	/** How the picker shows the animation: a right pane (default) or the selected row's sample cell. */
	previewMode?: "pane" | "sample";
	/** Picker/theme/submenu current value; submenus without one read as "configure". */
	read?: (config: SleekConfig) => string;
	/** Picker value label; submenus default to "Configure…". */
	labelForValue?: (value: string) => string;
	apply?: (value: string) => boolean | void;
	/** Submenu opener; a picker entry leaves this unset and uses the option picker. */
	open?: (ctx: { ui: any; cwd?: string }) => Promise<void>;
	/** Toggles only: the boolean state, kept out of the on/off string plumbing. */
	get?: (config: SleekConfig) => boolean;
	set?: (value: boolean) => boolean | void;
	/** Toggles only: value labels; defaults to Enabled/Disabled. */
	toggleLabels?: (enabled: boolean) => string;
}

/** An entry's current value as the on/off/configure string the menu model uses. */
function entryValue(entry: SettingsEntry, config: SleekConfig): string {
	if (entry.kind === "toggle") return entry.get?.(config) ? "on" : "off";
	return entry.read?.(config) ?? "configure";
}

/** Display label for an entry's value. */
function entryLabel(entry: SettingsEntry, value: string): string {
	if (entry.kind === "toggle") return entry.toggleLabels?.(value === "on") ?? (value === "on" ? "Enabled" : "Disabled");
	return entry.labelForValue?.(value) ?? "Configure…";
}

const THINKING_STYLE_OPTIONS: readonly SettingOptionHelp[] = [
	{ id: "claude", section: "1 block animations", text: "Claude Code-style stars in the theme's orange, with Claude's verb list." },
	{ id: "default", section: "1 block animations", text: "pi's own braille spinner with the state label and animated dots." },
	{ id: "moon", section: "1 block animations", text: "Large glyph-stepped moon phases that cycle through a lunar month (Nerd Font)." },
	{ id: "orbit", section: "1 block animations", text: "A one-cell arc rotates, accelerates into a slash sequence and sparks before recovering." },
	{ id: "ripple", section: "1 block animations", text: "A one-cell ring expands into a brief burst, then settles with a soft fade." },
	{ id: "shimmer", section: "1 block animations", text: "A one-cell glint builds into a sharp flare, then fades through a lingering afterglow." },
	{ id: "fireflies", section: "10 block animations", text: "Three glowing • lights drift and flicker across the row." },
	{ id: "meteor", section: "10 block animations", text: "A bright ● streaks across with a star-dust tail (Nerd Font)." },
];

const USER_MESSAGE_STYLE_OPTIONS: readonly SettingOptionHelp[] = [
	{ id: "bar", text: "A half-block accent rail on the left (the edit diff marker), with a one-column right margin." },
	{ id: "plain", text: "Full-width tinted background, with no marker or margin." },
	{ id: "box", text: "A thin border drawn around the tinted block." },
];

const AGENT_MESSAGE_STYLE_OPTIONS: readonly SettingOptionHelp[] = [
	{ id: "bar", text: "A half-block accent rail on the left, with a one-column right margin." },
	{ id: "plain", text: "Full-width tinted background, with no marker or margin." },
	{ id: "box", text: "A thin border around agent prose, without a background." },
];

const STATUS_BAR_OPTIONS: readonly SettingOptionHelp[] = [
	{ id: "default", text: "Pi's built-in two-line footer (directory/branch + usage stats/context)." },
	{ id: "sleek", text: "A two-line Sleek bar: directory, model and colour-coded thinking level left; I/O/R/CH tokens, context, cost and mode right, with compact filtering when the width is tight." },
	{ id: "bar", text: "A pi-zazz nvim statusline: a full-width bar on the tool-block surface with coloured boxes on the first and last visible items, a coloured thinking-level label beside the model and muted context metrics, plus a git + extension row." },
	{ id: "minimal", text: "A one-line icon-first footer inspired by pi-footer: individual colored statuses separated by ·, with the configured left/right groups and compact visibility flags." },
];

/** One-line ANSI sample for the status-bar picker. */
function statusBarSample(id: string, theme: MenuTheme): string {
	switch (resolveStatusBarModeId(id)) {
		case "default":
			return theme.fg("muted", "~/proj (main)  ↑109 ↓282  26.1%");
		case "sleek":
			return [
				`${theme.fg("warning", "\u{EA83}")} ${theme.fg("muted", "proj")}`,
				`${theme.fg("muted", "gpt-5")}`,
				`${theme.fg("dim", "I")} ${theme.fg("muted", "109")}`,
				`${theme.fg("dim", "O")} ${theme.fg("muted", "282")}`,
				`${theme.fg("dim", "R")} ${theme.fg("muted", "800")}`,
			].join(` ${DOT} `);
		case "minimal":
			return minimalStatusBarSample(theme);
		case "bar":
		default:
			return [
				theme.inverse(theme.fg("accent", " HIGH ")),
				theme.fg("muted", "gpt-5"),
				theme.fg("muted", "90k/128k"),
				theme.inverse(theme.fg("accent", " proj ")),
			].join("  ");
	}
}

const STATUS_BAR_SLOT_OPTIONS: readonly StatusBarSlot[] = ["off", "bar1-left", "bar1-right", "bar2-left", "bar2-right"];

function statusBarItemRows(): MenuRow[] {
	const layout = loadConfig().statusBarLayout;
	return STATUS_BAR_ITEM_IDS.map((id) => {
		const item = layout[id];
		const value = statusBarSlotLabel(item.enabled ? item.slot : "off");
		return {
			id,
			label: statusBarItemLabel(id),
			value,
			meta: item.compact ? "☑ compact" : "☐ compact",
			state: item.enabled ? "on" : "off",
			search: `${id} ${statusBarItemLabel(id)} ${value} enable disable compact left right row status bar`,
		};
	});
}

async function openStatusBarItemPicker(ctx: { ui: any }, id: StatusBarItemId): Promise<void> {
	const layout = loadConfig().statusBarLayout;
	const item = layout[id];
	const options: PickerOption[] = STATUS_BAR_SLOT_OPTIONS.map((slot) => ({
		id: slot,
		label: statusBarSlotLabel(slot),
		description: slot === "off"
			? "Hide this item in every status-bar mode."
			: `Show this item on ${statusBarSlotLabel(slot).toLowerCase()}.`,
	}));
	await openOptionPicker(ctx.ui, {
		title: `${statusBarItemLabel(id)} · placement`,
		listTitle: statusBarItemLabel(id),
		options,
		currentId: item.enabled ? item.slot : "off",
		onSelect: (slotId) => {
			const slot = slotId as StatusBarSlot;
			const next = { ...layout, [id]: { ...item, enabled: slot !== "off", slot } };
			if (!saveConfig({ statusBarLayout: next })) return false;
			requestSessionRender?.();
			return true;
		},
	});
}

async function openStatusBarItemsMenu(ctx: { ui: any }): Promise<void> {
	const ui = ctx.ui;
	for (;;) {
		const outcome = await openOverlay(ui, (
			(tui: any, theme: any, done: (result: string | undefined) => void) =>
				createMenu(tui, theme, {
					title: `Status bar items · ${STATUS_BAR_ITEM_IDS.length}`,
					columnTitles: { label: "ITEM", status: "PLACEMENT", description: "COMPACT" },
					searchHint: "Type to filter status items...",
					rows: () => statusBarItemRows(),
					primaryHint: menuPrimaryHint(theme, { extra: [["space", "compact"]] }),
					onActivate: (row) => done(row.id),
					onToggle: (row, popup) => {
						const id = row.id as StatusBarItemId;
						const current = loadConfig().statusBarLayout[id];
						if (!saveConfig({ statusBarLayout: { ...loadConfig().statusBarLayout, [id]: { ...current, compact: !current.compact } } })) {
							ui.notify("Could not save status bar layout", "error");
							return;
						}
						popup.refresh();
						requestSessionRender?.();
					},
					onClose: () => done(undefined),
				})
		));
		if (outcome === undefined) return;
		await openStatusBarItemPicker(ctx, outcome as StatusBarItemId);
	}
}

function sidePanelItemRows(): MenuRow[] {
	const items = loadConfig().sidePanelItems;
	return SIDE_PANEL_ITEM_IDS.map((id) => ({
		id,
		label: sidePanelItemLabel(id),
		value: items[id] ? "Shown" : "Hidden",
		state: items[id] ? "on" : "off",
		search: `${id} ${sidePanelItemLabel(id)} show hide`,
	}));
}

/** Toggle one side-panel section, then refresh the open menu and the session. */
function toggleSidePanelItem(ui: any, row: MenuRow, popup: { refresh: () => void }): void {
	const id = row.id as (typeof SIDE_PANEL_ITEM_IDS)[number];
	const items = loadConfig().sidePanelItems;
	if (!saveConfig({ sidePanelItems: { ...items, [id]: !items[id] } })) {
		ui.notify("Could not save side panel settings", "error");
		return;
	}
	sidePanel.setVisible(loadConfig().sidePanel);
	popup.refresh();
	requestSessionRender?.();
}

async function openSidePanelItemsMenu(ctx: { ui: any }): Promise<void> {
	const ui = ctx.ui;
	await openOverlay(ui, (
		(tui: any, theme: any, done: (result: string | undefined) => void) =>
			createMenu(tui, theme, {
				title: `Side panel items · ${SIDE_PANEL_ITEM_IDS.length}`,
				columnTitles: { label: "ITEM", status: "VISIBILITY", description: "" },
				searchHint: "Type to filter panel items...",
				rows: () => sidePanelItemRows(),
				primaryHint: menuPrimaryHint(theme, { extra: [["space", "toggle"]] }),
				onActivate: (row, popup) => toggleSidePanelItem(ui, row, popup),
				onToggle: (row, popup) => toggleSidePanelItem(ui, row, popup),
				onClose: () => done(undefined),
			})
	));
}

/** One-line ANSI sample for the user-message-style picker. */
function userMessageStyleSample(id: string, theme: MenuTheme): string {
	const message = theme.fg("muted", "message");
	switch (resolveUserMessageStyleId(id)) {
		case "bar":
			return `${theme.fg("accent", "\u{258C}")} ${message}`;
		case "box":
			return `${theme.fg("border", "│")} ${message} ${theme.fg("border", "│")}`;
		case "plain":
		default:
			return message;
	}
}

const LOGO_ANIMATION_OPTIONS: readonly SettingOptionHelp[] = [
	{ id: "static", text: "No animation — the logo appears immediately." },
	{ id: "materialize", text: "Cells pop in random order, hold, flicker twice and settle into the solid logo." },
	{ id: "reveal", text: "Fills bottom-to-top like a glass, with a wavy surface." },
	{ id: "wipe", text: "Whole-row wipe from top to bottom that accelerates, flickers, then settles." },
];

const LOGO_COLOR_MODE_OPTIONS: readonly SettingOptionHelp[] = [
	{ id: "default", text: "Use the active theme's red, blue, and yellow semantic colors." },
	{ id: "accent", text: "Paint every logo pixel with the active theme's accent color." },
];

function logoColorModeSample(id: string, theme: MenuTheme): string {
	if (resolveLogoColorModeId(id) === "accent") return theme.fg("accent", "██████");
	return [theme.fg("error", "██"), theme.fg("mdLink", "██"), theme.fg("warning", "██")].join("");
}

/** Persist a picker value and repaint the session; extras run only on success. */
function applySetting(patch: Partial<SleekConfig>, after?: () => void): boolean {
	if (!saveConfig(patch)) return false;
	after?.();
	requestSessionRender?.();
	return true;
}

const settingsMenu: readonly SettingsEntry[] = [
	{
		name: "theme",
		group: "Appearance",
		title: "Themes",
		summary: "Browse every available theme",
		description:
			"Browse every available theme — pi's built-ins plus the bundled Sleek companion themes — with a live palette preview. Enter applies and persists; Escape restores the previous theme.",
		kind: "theme",
		read: () => activeThemeName() || "pick…",
		labelForValue: (value) => value || "pick…",
		open: (ctx) => openThemePicker(ctx),
	},
	{
		name: "density",
		group: "Appearance",
		title: "Density",
		summary: "Tool-block backgrounds and spacing",
		description: "Extended keeps the full tool-block appearance. Sleek shows every collapsed tool as one background-free summary row, with right-aligned hints/statuses, and starts thinking collapsed but clickable during and after generation. Expanded tools use the same full code-block appearance in either style.",
		kind: "picker",
		options: [
			{ id: "default", text: "Extended tool backgrounds and top/bottom padding" },
			{ id: "compact", text: "Sleek one-line tool summaries; thinking starts collapsed and can be expanded at any time" },
		],
		read: (config) => config.density,
		labelForValue: (value) => densityModeLabel(resolveDensityModeId(value)),
		apply: (value) => applySetting({ density: resolveDensityModeId(value) }),
	},
	{
		name: "notifications",
		group: "Notifications",
		title: "Notifications",
		summary: "Alert sound when Pi finishes or needs input",
		description:
			"Play a sound and show a desktop notification when Pi finishes a response or needs input. Finished-response alerts follow the configured method: unfocused only, unfocused or longer than the configured timer, or always. Prompts alert whenever notifications are enabled, except for blacklisted sources and Sleek's own menus.",
		kind: "submenu",
		read: (config) => (config.notifications ? "on" : "off"),
		labelForValue: (value) => (value === "on" ? "Enabled" : "Disabled"),
		open: (ctx) => openNotificationsMenu(ctx),
	},
	{
		name: "userMessageStyle",
		group: "Appearance",
		title: "User message style",
		summary: "How your own messages are drawn",
		description:
			"Choose how your messages appear in the transcript. Every style keeps the accent-tinted background from the bundled themes; they differ in the marker and insets drawn around it. Enter applies and persists; Escape keeps the current style.",
		kind: "picker",
		options: USER_MESSAGE_STYLE_OPTIONS,
		sample: (id, theme) => userMessageStyleSample(id, theme),
		read: (config) => config.userMessageStyle,
		labelForValue: (value) => userMessageStyleLabel(resolveUserMessageStyleId(value)),
		apply: (value) => applySetting({ userMessageStyle: resolveUserMessageStyleId(value) }),
	},
	{
		name: "agentMessageStyle",
		group: "Appearance",
		title: "Agent message style",
		summary: "How agent replies are drawn",
		description:
			"Choose how agent prose appears in the transcript. Choose Bar, Plain or Box, matching the User message style choices. Box uses a border without a background. Enter applies and persists; Escape keeps the current style.",
		kind: "picker",
		options: AGENT_MESSAGE_STYLE_OPTIONS,
		sample: (id, theme) => userMessageStyleSample(id, theme),
		read: (config) => config.agentMessageStyle,
		labelForValue: (value) => agentMessageStyleLabel(resolveAgentMessageStyleId(value)),
		apply: (value) => applySetting({ agentMessageStyle: resolveAgentMessageStyleId(value) }),
	},
	{
		name: "thinkingStyle",
		group: "Animation",
		title: "Thinking style",
		summary: "Animation while thinking",
		description:
			"Choose the animation and label shown while the model is thinking or running tools. Running tools tint the animation in the theme's orange. Enter applies and persists; Escape keeps the current style.",
		kind: "picker",
		options: THINKING_STYLE_OPTIONS,
		// One representative frame per style as a static sample for the picker: the
		// busiest frame (so travelling styles do not land on an empty gap), and
		// among equal-ink frames the middle one (single-glyph spinners).
			sample: (id, theme) => {
			const frames = thinkingStyleFrames(resolveThinkingStyleId(id), theme, "working");
			if (frames.length === 0) return undefined;
			const inks = frames.map((frame) => (frame.replace(/\x1b\[[0-9;]*m/g, "").match(/\S/gu) ?? []).length);
			const maxInk = Math.max(...inks);
			const candidates = maxInk > 0 ? frames.filter((_, index) => inks[index] === maxInk) : frames;
			return candidates[Math.floor(candidates.length / 2)] ?? frames[0];
		},
		// Always-on animation for the highlighted row's SAMPLE cell.
		preview: (id, theme) => {
			const style = resolveThinkingStyleId(id);
			const frames = thinkingStyleFrames(style, theme, "working");
			if (frames.length === 0) return undefined;
			return { frames: frames.map((frame) => [frame]), intervalMs: thinkingStyleFrameIntervalMs(style, "working") };
		},
		previewMode: "sample",
		read: (config) => resolveThinkingStyleId(config.thinkingStyle),
		labelForValue: (value) => thinkingStyleLabel(resolveThinkingStyleId(value)),
		apply: (value) => {
			const style = resolveThinkingStyleId(value);
			return applySetting({ thinkingStyle: style }, () => {
				setActiveThinkingStyleId(style);
				workingLoaderController?.configure();
			});
		},
	},
	{
		name: "logoAnimationStyle",
		group: "Animation",
		title: "Pi logo animation",
		summary: "Startup logo animation",
		description:
			"Choose the animation played over the Pi logo (~1 second) on a real startup, on /new and when /reload is run on an empty session. It never plays on /resume or /fork. Enter applies and persists; Escape keeps the current animation.",
		kind: "picker",
		options: LOGO_ANIMATION_OPTIONS,
		// Ctrl+P preview: the animation frames for the highlighted style.
		preview: (id, theme) => {
			const style = resolveLogoAnimationStyleId(id);
			if (style === "static") return undefined;
			const built = buildLogoPreviewFrames(style, theme);
			return built ? { frames: built.frames, intervalMs: built.intervalMs } : undefined;
		},
		read: (config) => resolveLogoAnimationStyleId(config.logoAnimationStyle),
		labelForValue: (value) => logoAnimationStyleLabel(resolveLogoAnimationStyleId(value)),
		apply: (value) => {
			const style = resolveLogoAnimationStyleId(value);
			return applySetting({ logoAnimationStyle: style }, () => setActiveLogoAnimationStyleId(style));
		},
	},
	{
		name: "logoColorMode",
		group: "Animation",
		title: "Logo color mode",
		summary: "Colours used by the Pi logo",
		description:
			"Choose the logo colours. Default uses the active theme's red, blue, and yellow semantic colors; Accent paints the entire logo with the theme accent. Enter applies and persists; Escape keeps the current mode.",
		kind: "picker",
		options: LOGO_COLOR_MODE_OPTIONS,
		sample: (id, theme) => logoColorModeSample(id, theme),
		read: (config) => config.logoColorMode,
		labelForValue: (value) => logoColorModeLabel(resolveLogoColorModeId(value)),
		apply: (value) => applySetting({ logoColorMode: resolveLogoColorModeId(value) }),
	},
	{
		name: "useThemeBackground",
		group: "Appearance",
		title: "Theme background",
		summary: "Paint the active theme's background",
		description:
			"Fill the terminal's page background and the chat frame with the active theme's background colour, so the theme covers the whole window instead of only the text cells. Turn this off to fall back to the terminal's own background — which is what you want when terminal transparency is enabled.",
		kind: "toggle",
		get: (config) => config.useThemeBackground,
			set: (enabled) => applySetting({ useThemeBackground: enabled }, () => syncTheme(true)),
	},
	{
		name: "statusBar",
		group: "Status bar",
		title: "Status bar",
		summary: "Bottom footer style",
		description:
			"Choose the bottom status bar. 'Sleek' is a pi-zazz-style two-line bar: the directory, model and colour-coded thinking level on the left of line one, with the I/O/R/CH tokens, context meter, cost and plan/build/yolo badge right-aligned; the git branch sits on the left of line two with the remaining extension statuses on the right. 'Bar' is pi-zazz's nvim statusline: a full-width bar on the bash/edit tool-block surface with coloured boxes on the first and last visible items of each row, the model and a coloured thinking-level label, and muted cost/context metrics, with the git branch and extension statuses on a second row. 'Minimal' is a one-line icon-first style with individually colored statuses separated by dots. Build mode tints the input-box divider lines in the theme's purple (blue fallback), yolo orange. 'Default' keeps pi's built-in footer until its item layout is customized. Use 'Status bar items' to move or hide items, and press Space there to toggle whether an item survives compact-width filtering. Enter applies and persists; Escape keeps the current choice.",
		kind: "picker",
		options: STATUS_BAR_OPTIONS,
		sample: (id, theme) => statusBarSample(id, theme),
		read: (config) => resolveStatusBarModeId(config.statusBar),
		labelForValue: (value) => statusBarModeLabel(resolveStatusBarModeId(value)),
		apply: (value) => applySetting({ statusBar: resolveStatusBarModeId(value) }),
	},
	{
		name: "statusBarItems",
		group: "Status bar",
		title: "Status bar items",
		summary: "Enable and position individual status items",
		description:
			"Choose which status items are visible and place each one on Status bar 1 or 2, on the left or right. The layout applies to Sleek, Bar and customized Default mode. The Bottom bar toggle still controls whether row 2 is shown.",
		kind: "submenu",
		open: (ctx) => openStatusBarItemsMenu(ctx),
	},
	{
		name: "sidePanel",
		group: "Side panel",
		title: "Side panel",
		summary: "Tasks and session details on the right",
		description:
			"Show a right-side panel sized to roughly 30% of the terminal, clamped to 32–42 columns. It can show tasks, subagents with their models, project/git details, context usage, cache hit and Blackhole status. Press Ctrl+\\ to toggle it, or turn it off here for the full transcript width. Below 100 columns it hides automatically.",
		kind: "toggle",
		get: (config) => config.sidePanel,
		set: (enabled) => applySetting({ sidePanel: enabled }, () => sidePanel.setVisible(enabled)),
	},
	{
		name: "sidePanelExpandedTasks",
		group: "Side panel",
		title: "Expand sidebar tasks",
		summary: "Show all todos instead of the first 10",
		description: "The sidebar shows up to 10 tasks by default. Click +N more in fullscreen mode to show all tasks, or use this toggle in either UI mode. Expanded fullscreen lists scroll independently with the mouse wheel.",
		kind: "toggle",
		get: () => sidePanel.tasksExpanded,
		set: (enabled) => sidePanel.setTasksExpanded(enabled),
		toggleLabels: (enabled) => (enabled ? "All tasks" : "10 tasks"),
	},
	{
		name: "sidePanelItems",
		group: "Side panel",
		title: "Side panel items",
		summary: "Choose which side-panel sections are shown",
		description:
			"Show or hide individual sections in the right-side panel: directory, branch, diff, tasks, subagents, context usage, cache hit and Blackhole status. Models appear within subagent entries, not as a separate main-model section. Enter or Space toggles an item; the panel updates immediately.",
		kind: "submenu",
		open: (ctx) => openSidePanelItemsMenu(ctx),
	},
	{
		name: "bottomBar",
		group: "Status bar",
		title: "Bottom bar",
		summary: "Git branch, edits and extension statuses",
		description:
			"Show the status bar's bottom row — the git branch with its +added/-removed edit counts and the remaining extension statuses (e.g. pi-blackhole's O/P/X meters). Turn it off to keep only the main bar.",
		kind: "toggle",
		get: (config) => config.bottomBar,
		set: (enabled) => applySetting({ bottomBar: enabled }),
	},
];

function toMenuRows(): MenuRow[] {
	const config = loadConfig();
	return [...settingsMenu]
		.sort((a, b) => SETTINGS_GROUP_ORDER.indexOf(a.group) - SETTINGS_GROUP_ORDER.indexOf(b.group))
		.map((entry) => {
			const value = entryValue(entry, config);
			return {
				id: entry.name,
				label: entry.title,
				section: entry.group,
				value: entryLabel(entry, value),
				state: entry.kind === "toggle" ? (value === "on" ? "on" : "off") : "info",
				search: [entry.name, entry.title, entry.summary, entry.description, value].join(" "),
			};
		});
}

/** Display name of the theme currently applied to this session, or "". */
function activeThemeName(): string {
	const active = currentSessionUi?.theme as { definition?: { name?: unknown }; name?: unknown } | undefined;
	if (typeof active?.definition?.name === "string") return active.definition.name;
	return typeof active?.name === "string" ? active.name : "";
}

/** Dedicated picker for a select-style setting (thinking style, logo animation, message styles). */
async function openSettingsPicker(ctx: { ui: any }, entry: SettingsEntry): Promise<void> {
	if ((entry.options ?? []).length === 0) return;
	const options: PickerOption[] = (entry.options ?? []).map((option) => ({
		id: option.id,
		label: entryLabel(entry, option.id),
		description: option.text,
		section: option.section,
	}));
	await openOptionPicker(ctx.ui, {
		title: `${entry.title} · ${options.length}`,
		listTitle: entry.title,
		options,
		currentId: entryValue(entry, loadConfig()),
		onSelect: (id) => entry.apply?.(id),
		preview: entry.preview,
		previewMode: entry.previewMode,
		sample: entry.sample,
	});
}

export default function (pi: ExtensionAPI): void {
	// Load-phase registration: pi awaits extension factories before building the
	// session's theme/tool sets, so bundled themes must be wired before session_start.
	// The InteractiveMode class is required here, not at session_start: Pi applies
	// the settings theme inside init(), which runs before session_start, so the
	// transient "Failed to load theme" banner for bundled themes must be silenced
	// and the theme re-applied after resource discovery from the load phase.
	registerCompanionThemes(pi, InteractiveMode);
	registerEditTool(pi);
	registerBashTool(pi);
	registerReadTool(pi);
	registerWriteTool(pi);

	pi.registerShortcut("ctrl+\\", {
		description: "Toggle Sleek side panel",
		handler: (ctx) => {
			if (ctx.mode !== "tui") return;
			const enabled = !loadConfig().sidePanel;
			if (!saveConfig({ sidePanel: enabled })) {
				ctx.ui.notify("Could not save the side panel setting.", "error");
				return;
			}
			sidePanel.setVisible(enabled);
		},
	});

	pi.registerCommand("sleek", {
		description: "Open the Sleek menu",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			// Entering a row opens its own submenu or picker; once it settles we come
			// straight back to the settings menu.
			for (;;) {
				const outcome = await openOverlay<string | undefined>(ctx.ui, (
					(tui: any, theme: any, done: (result: string | undefined) => void) => {
						const primaryHint = menuPrimaryHint(theme);
						return createMenu(tui, theme, {
							title: `Sleek settings · ${settingsMenu.length}`,
							searchHint: "Type to filter settings...",
							rows: () => toMenuRows(),
							primaryHint,
							onActivate: (row, popup) => {
								const entry = settingsMenu.find((candidate) => candidate.name === row.id);
								if (!entry) return;
								// Toggles apply in place and keep the popup open so the row flips live.
								if (entry.kind === "toggle") {
									const enabled = entry.get?.(loadConfig()) ?? false;
									if (entry.set?.(!enabled) === false) {
										ctx.ui.notify(`Could not save ${entry.title}`, "error");
									}
									popup.refresh();
									return;
								}
								done(entry.name);
							},
							onClose: () => done(undefined),
						});
					}
				));
				if (outcome === undefined) return;
				const entry = settingsMenu.find((candidate) => candidate.name === outcome);
				if (!entry) return;
				if (entry.open) await entry.open(ctx as { ui: any; cwd?: string });
				else await openSettingsPicker(ctx as { ui: any }, entry);
			}
		},
	});

	// --- Thinking-style animation lifecycle -----------------------------------
	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.mode !== "tui") {
			startChildActivity(ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionName(), event.prompt, ctx.model?.id ?? "");
			return;
		}
		sessionHasMessages = true;
		workingLoaderController?.setState("working");
	});

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		sessionHasMessages = true;
		suppressNextResponseNotification = false;
		runningToolCalls.clear();
		sidePanel.startAgent();
		responseStatsClock.beginTurn();
		workingLoaderController?.start("working");
	});

	// User input marks the session as no longer empty, so the placeholder
	// disappears for good once the first message is sent.
	pi.on("input", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		sessionHasMessages = true;
	});

	pi.on("model_select", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		sidePanel.setModel(event.model);
	});

	pi.on("message_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		sidePanel.handleSubagentMessage(event.message);
		responseStatsClock.handleMessageStart(event.message);
		if (event.message.role === "assistant" && runningToolCalls.size === 0) {
			workingLoaderController?.setState(workingStateForAssistantMessage(event.message));
		}
	});

	pi.on("message_update", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		responseStatsClock.handleMessageUpdate(event.message);
		if (event.message.role === "assistant" && runningToolCalls.size === 0) {
			workingLoaderController?.setState(workingStateForAssistantMessage(event.message));
		}
	});

	// Stop the per-turn clock and repaint so the streamed component picks up its
	// response footer with the now-final stats.
	pi.on("message_end", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		responseStatsClock.handleMessageEnd(event.message);
		addUsageFromMessage(event.message);
		if (event.message.role === "assistant") {
			// Keep the latest reply text for the response notification highlight.
			noteAssistantMessage(event.message);
			requestSessionRender?.();
		}
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (ctx.mode !== "tui") {
			updateChildActivity(ctx.sessionManager.getSessionId(), event.toolCallId, event.toolName, true);
			return;
		}
		runningToolCalls.add(event.toolCallId);
		if (event.toolName === "subagent" || event.toolName === "Agent") sidePanel.startSubagents(event.toolCallId, event.args, sidePanel.modelName);
		workingLoaderController?.setState("running");
	});

	pi.on("tool_execution_update", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (event.toolName === "subagent") sidePanel.updateSubagents(event.toolCallId, event.partialResult);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (ctx.mode !== "tui") {
			updateChildActivity(ctx.sessionManager.getSessionId(), event.toolCallId, event.toolName, false);
			return;
		}
		if (event.toolName === "subagent") sidePanel.finishSubagents(event.toolCallId, event.result, event.isError);
		if (event.toolName === "Agent") sidePanel.finishAgentTool(event.toolCallId, event.result, event.isError);
		runningToolCalls.delete(event.toolCallId);
	});

	pi.on("tool_result", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (isTodoTool(event.toolName) && !event.isError) sidePanel.setTodoDetails(event.details);
	});

	pi.on("agent_end", (event, ctx) => {
		if (ctx.mode !== "tui") {
			// A run can retry or continue after agent_end; only settled is final.
			finishChildActivity(ctx.sessionManager.getSessionId(), false);
			return;
		}
		runningToolCalls.clear();
		sidePanel.finishAgent();
		suppressNextResponseNotification = Array.isArray(event.messages)
			&& event.messages.some((message) => message.role === "assistant" && message.stopReason === "aborted");
		workingLoaderController?.stop();
	});

	// Notifications. A finished response follows the configured method rule and
	// quotes the latest reply; prompts always alert. Dedicated events give the
	// prompt its category *before* the generic `ui_prompt_start` fires (and is
	// deduped): `pi-permit:ask` for permission prompts and the ask_user_question
	// tool's documented `rpiv:ask-user:prompt` event for questions.
	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode !== "tui") {
			finishChildActivity(ctx.sessionManager.getSessionId());
			return;
		}
		if (suppressNextResponseNotification) {
			suppressNextResponseNotification = false;
			return;
		}
		maybeAlert("response");
	});

	pi.on("ui_prompt_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (isActivePromptSourceBlacklisted() || consumeBlacklistedPrompt()) return;
		maybeAlert("prompt", typeof event.title === "string" ? event.title : undefined);
	});

	// Extensions can identify their own UI prompt immediately before opening it;
	// this lets users blacklist prompt sources that do not expose a title.
	pi.events.on("pi-extension:prompt", (data) => {
		const source = (data as { source?: unknown } | undefined)?.source;
		if (typeof source === "string") markPromptSource(source);
	});

	pi.events.on("pi-permit:ask", (data) => {
		const title = (data as { title?: unknown } | undefined)?.title;
		maybeAlert("permission", typeof title === "string" ? title : undefined);
	});

	pi.events.on("rpiv:ask-user:prompt", (data) => {
		const source = "@juicesharp/rpiv-ask-user-question";
		if (isNotificationSourceBlacklisted(source)) {
			markPromptSource(source);
			return;
		}
		const questions = (data as { questions?: unknown } | undefined)?.questions;
		const first = Array.isArray(questions) ? (questions[0] as { question?: unknown } | undefined) : undefined;
		maybeAlert("question", typeof first?.question === "string" ? first.question : undefined);
	});

	// Task snapshots follow the active branch, including a /tree navigation.
	pi.on("session_tree", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		applyBranch(ctx.sessionManager.getBranch());
	});

	pi.on("session_compact", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// Compaction usage is persisted outside message_end. Refresh at this
		// lifecycle boundary, never by scanning the transcript on each frame.
		seedStatusBarUsage(ctx.sessionManager.getBranch());
		requestSessionRender?.();
	});

	// --- Session lifecycle ----------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		// In-process subagents load this module too; their headless sessions must
		// never rebind or reset the shared parent TUI, clocks, or sidebar.
		if (ctx.mode !== "tui") { bindChildActivity(ctx.sessionManager.getSessionId()); return; }
		const sessionReason =
			typeof _event === "object" && _event !== null && "reason" in _event && typeof (_event as { reason?: unknown }).reason === "string"
				? (_event as { reason: string }).reason
				: undefined;
		// A fresh session still has metadata entries (model/thinking-level change),
		// so count only real conversation entries, not the branch length.
		const branch = ctx.sessionManager.getBranch();
		sessionHasMessages = branch.some((entry) => entry.type === "message");
		// Repaint once after the seed: pi renders the transcript before emitting
		// session_start, so already-built components only gain their footers on a
		// later frame (the editor factory below installs the repaint hook).
		let reapplySettingsTheme: (() => void) | undefined;
		if (scheduledRender) clearTimeout(scheduledRender);
		scheduledRender = setTimeout(() => {
			scheduledRender = undefined;
			// Pi publishes discovered companion themes after session_start returns.
			reapplySettingsTheme?.();
			requestSessionRender?.();
		}, 0);
		// Play the logo animation on a real startup, on /new, and on /reload while
		// the session is still empty (never on /resume or /fork).
		const playLogoAnimation =
			sessionReason === "startup" ||
			sessionReason === "new" ||
			(sessionReason === "reload" && !sessionHasMessages);
		beginLogoAnimationSession(playLogoAnimation);

		const ui = ctx.ui;
		currentSessionUi = ui;
		sidePanel.bind({ sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, getContextUsage: () => ctx.getContextUsage(), getTokenUsage: getStatusBarUsage, getEditorText: () => ctx.ui.getEditorText() }, loadConfig().sidePanel);
		sidePanel.setModel(ctx.model);
		applyBranch(branch);
		paletteTint.bindUi(ui);
		const config = loadConfig();
		setActiveThinkingStyleId(config.thinkingStyle);

		setActiveLogoAnimationStyleId(config.logoAnimationStyle);

		let boundRenderer: TUI | undefined;
		const bindRenderer = (tui: TUI): void => {
			installCopySelection(tui);
			if (tui === boundRenderer) return;
			boundRenderer = tui;
			const uiTheme = (currentSessionUi?.theme ?? ctx.ui.theme) as any;
			pageBackgroundTerminal = (tui as any).terminal as PageBackgroundTerminal;
			requestSessionRender = () => {
				try {
					(tui as any).requestRender?.();
				} catch {
					// Best effort.
				}
			};
			const sleekTui = tui as TUI;
			paletteTint.bindTerminal(
				sleekTui.terminal as PageBackgroundTerminal,
				// Palette-derived backgrounds change after the terminal query returns.
				// Invalidate cached message components before repainting, otherwise an
				// already-rendered user message keeps its old background until scroll/click.
				() => {
					sleekTui.invalidate?.();
					requestSessionRender?.();
				},
				// Query the terminal's reported background and ANSI palette so the
				// Terminal theme can derive its dark-mode surfaces from real colours.
				typeof sleekTui.queryTerminalColors === "function"
					? (options) => sleekTui.queryTerminalColors(options)
					: undefined,
				{
					// Terminals that support it push OSC 997 colour-scheme reports…
					onColorSchemeChange: typeof sleekTui.onTerminalColorSchemeChange === "function"
						? (listener) => sleekTui.onTerminalColorSchemeChange((scheme) => { if (scheme === "dark" || scheme === "light") listener(scheme); })
						: undefined,
					// …and mode 2031 makes them start doing so when pi has not.
					enableColorSchemeNotifications: typeof sleekTui.setTerminalColorSchemeNotifications === "function"
						? () => sleekTui.setTerminalColorSchemeNotifications(true)
						: undefined,
				},
			);
			// Re-read the terminal palette when focus changes: terminals do not push a
			// notification when their theme changes, and a theme is usually switched
			// while the terminal is in the background.
			unsubscribeTerminalFocus?.();
			unsubscribeTerminalFocus = onTerminalFocusChange((isFocused) => {
				paletteTint.notifyTerminalFocus(isFocused);
			});
			installRenderFrameBackground(sleekTui, uiTheme);
			// Observe terminal focus so a finished response can alert while away.
			installFocusTracking(tui as any);
			applyPageBackground(uiTheme);
			sleekTui.invalidate();
			sleekTui.requestRender();
		};
		suppressStartupModelScopeLog();
		installStartupUiPatch(InteractiveMode);
		installThemeSyncPatch(InteractiveMode);
		installWorkingTimer(InteractiveMode);
		installToolDensity(() => currentSessionUi?.theme, () => requestSessionRender?.());
		installNotificationCommandSourcePatch();
		installStatusBar(() => currentSessionUi?.theme, () => requestSessionRender?.());
		installSidePanelLayout(InteractiveMode, sidePanel, () => currentSessionUi?.theme, (host) => {
			if (host.themeController) reapplySettingsTheme = () => host.themeController?.applyFromSettings?.();
			bindRenderer(host.renderer);
		});
		installWorkModeBorderTrigger(InteractiveMode, (key, text) => {
			if (key === "blackhole") sidePanel.setBlackholeStatus(text);
		});
		installUserMessageStyle(() => currentSessionUi?.theme);
		installAssistantMessageBackground(() => currentSessionUi?.theme);
		installCompactThinking(() => currentSessionUi?.theme, () => requestSessionRender?.());
		installFollowUpMessageBackground(() => currentSessionUi?.theme);
		installImagePreview(() => currentSessionUi?.theme);

		// Give the startup UI a live theme source: the header bakes its text at
		// construction, so it needs the current theme AND a later refresh.
		setStartupThemeProvider(() => currentSessionUi?.theme);
		setCompactStartupHeader(ui, ctx.cwd);
		// A zero-line widget invokes the current host's existing layout hook,
		// including quiet startup and when another extension owns the editor.
		try { ui.setWidget("pi-sleek.lifecycle-bind", []); }
		finally { ui.setWidget("pi-sleek.lifecycle-bind", undefined); }

		workingLoaderController?.dispose();
		workingLoaderController = createWorkingLoaderController(ui);
		workingLoaderController.configure();
		syncTheme(true);

		// Input placeholder: muted hint, only while the session has no messages and
		// the editor is empty. Reinstalled on every session bind with fresh state.
		// The editor factory is the first point where the TUI (and its terminal) is
		// available, so the page background and ANSI frame painting are wired here.
		const existingEditor = ui.getEditorComponent();
		if (existingEditor && existingEditor !== ownedEditorFactory) {
			ui.notify("Sleek placeholder disabled: another extension owns the editor.", "warning");
		} else {
			ownedEditorFactory = (tui, editorTheme, keybindings) => new PlaceholderEditor(tui, editorTheme, keybindings, {
				placeholder: () => (currentSessionUi?.theme ?? ctx.ui.theme).fg("muted", INPUT_PLACEHOLDER),
				enabled: () => !sessionHasMessages,
			});
			ui.setEditorComponent(ownedEditorFactory);
		}
	});

	pi.on("session_shutdown", (event, ctx) => {
		if (ctx.mode !== "tui") {
			finishChildActivity(ctx.sessionManager.getSessionId());
			return;
		}
		if (scheduledRender) clearTimeout(scheduledRender);
		scheduledRender = undefined;
		paletteTint.dispose();
		unsubscribeTerminalFocus?.();
		unsubscribeTerminalFocus = undefined;
		// Only reset the terminal page background (OSC 111) when the process is
		// really exiting. Session replacements (resume/new/fork/reload) are
		// immediately followed by a session_start that re-applies the theme's page
		// background; resetting in between paints the resumed UI on the terminal's
		// default background.
		const reason =
			typeof event === "object" && event !== null && "reason" in event
				? (event as { reason?: unknown }).reason
				: undefined;
		if (reason === "quit") pageBackground.reset(pageBackgroundTerminal);
		// Unwind the instance-level frame-background patch before the module is
		// re-imported, or `/reload` would keep the previous closure (and its stale
		// theme/enabled flag) alive and nest a new wrapper inside it.
		uninstallRenderFrameBackground();
		uninstallFocusTracking();
		resetAlertState();
		// Unwind every prototype patch so the next session bind rebuilds it from the
		// pristine host methods (and a /reload picks up fresh module code).
		restorePatchedMethods();
		stopLogoAnimation();
		responseStatsClock.reset();
		clearImagePreviewCache();
		resetStatusBarUsage();
		resetGitStatus();
		stopStatusBarTimers();
		stopToolAnimationTicker();
		workingLoaderController?.dispose();
		workingLoaderController = undefined;
		sidePanel.dispose();
		runningToolCalls.clear();
		sessionHasMessages = false;
		currentSessionUi = undefined;
		pageBackgroundTerminal = undefined;
		requestSessionRender = undefined;
		setStartupThemeProvider(undefined);
		try {
			if (ownedEditorFactory && ctx.ui.getEditorComponent() === ownedEditorFactory) ctx.ui.setEditorComponent(undefined);
			ownedEditorFactory = undefined;
		} catch {
			// Best effort: shutdown happens during session replacement.
		}
	});
}
