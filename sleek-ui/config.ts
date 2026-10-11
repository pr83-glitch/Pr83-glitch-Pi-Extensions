/**
 * sleek-ui config.
 *
 * Sleek's settings, stored under `~/.pi/agent/sleek.json` with `sleek-`
 * prefixed keys so they never collide with pi-zazz's `zazz-*` settings.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

import { resolveThinkingStyleId, type ThinkingStyleId } from "./tool-tags/thinking-styles.js";
import { resolveLogoAnimationStyleId, type LogoAnimationStyleId } from "./tool-tags/logo-animation-styles.js";

/**
 * Small enum-setting helper: a label table plus a `resolve` that coerces any
 * stored value to a known id. `fallback` is a thunk so it can read `DEFAULTS`
 * even though the tables are declared above it.
 */
function enumSetting<T extends string>(labels: Record<T, string>, fallback: () => T) {
	return {
		resolve: (value: unknown): T =>
			typeof value === "string" && Object.hasOwn(labels, value) ? (value as T) : fallback(),
		label: (value: T): string => labels[value],
	};
}

/** How the startup logo is coloured. */
export type LogoColorMode = "default" | "accent";
const LOGO_COLOR_MODE = enumSetting<LogoColorMode>(
	{ default: "Default", accent: "Accent" },
	() => DEFAULTS.logoColorMode,
);
export const resolveLogoColorModeId = LOGO_COLOR_MODE.resolve;
export const logoColorModeLabel = LOGO_COLOR_MODE.label;

/** How the user's own messages are drawn in the transcript. */
export type UserMessageStyle = "bar" | "box" | "plain";
const USER_MESSAGE_STYLE = enumSetting<UserMessageStyle>(
	{ bar: "Bar", box: "Box", plain: "Plain" },
	() => DEFAULTS.userMessageStyle,
);
export const resolveUserMessageStyleId = USER_MESSAGE_STYLE.resolve;
export const userMessageStyleLabel = USER_MESSAGE_STYLE.label;

/** How agent prose is drawn in the transcript. */
export type AgentMessageStyle = "bar" | "box" | "plain";
const AGENT_MESSAGE_STYLE = enumSetting<AgentMessageStyle>(
	{ bar: "Bar", box: "Box", plain: "Plain" },
	() => DEFAULTS.agentMessageStyle,
);
export const resolveAgentMessageStyleId = AGENT_MESSAGE_STYLE.resolve;
export const agentMessageStyleLabel = AGENT_MESSAGE_STYLE.label;

/** Tool-block spacing and background treatment. */
export type DensityMode = "default" | "compact";
const DENSITY_MODE = enumSetting<DensityMode>(
	{ default: "Extended", compact: "Sleek" },
	() => DEFAULTS.density,
);
export const resolveDensityModeId = DENSITY_MODE.resolve;
export const densityModeLabel = DENSITY_MODE.label;

/** Which footer the bottom status bar shows. */
export type StatusBarMode = "sleek" | "bar" | "minimal" | "default";

/** Built-in sections that can be shown or hidden in the sidebar. */
export type SidePanelItemId = "tasks" | "subagents" | "context" | "cacheHit" | "blackhole" | "directory" | "branch" | "diff";

const SIDE_PANEL_ITEM_LABELS: Record<SidePanelItemId, string> = {
	tasks: "Tasks",
	subagents: "Subagents",
	context: "Context usage",
	cacheHit: "Cache-hit percentage",
	blackhole: "Blackhole status",
	directory: "Project directory",
	branch: "Git branch",
	diff: "Git diff count",
};

export const SIDE_PANEL_ITEM_IDS = Object.keys(SIDE_PANEL_ITEM_LABELS) as readonly SidePanelItemId[];

export function sidePanelItemLabel(id: SidePanelItemId): string {
	return SIDE_PANEL_ITEM_LABELS[id];
}

function defaultSidePanelItems(): Record<SidePanelItemId, boolean> {
	return Object.fromEntries(SIDE_PANEL_ITEM_IDS.map((id) => [id, true])) as Record<SidePanelItemId, boolean>;
}

function normalizeSidePanelItems(value: unknown): Record<SidePanelItemId, boolean> {
	const raw = isRecord(value) ? value : {};
	const defaults = defaultSidePanelItems();
	return Object.fromEntries(SIDE_PANEL_ITEM_IDS.map((id) => [id, booleanOrDefault(raw[id], defaults[id])])) as Record<SidePanelItemId, boolean>;
}

/** Built-in values that can be shown and positioned in either status row. */
export type StatusBarItemId =
	| "directory"
	| "model"
	| "thinking"
	| "peak"
	| "inputTokens"
	| "outputTokens"
	| "cacheRead"
	| "cacheWrite"
	| "cacheHit"
	| "contextTokens"
	| "contextPercent"
	| "cost"
	| "workMode"
	| "git"
	| "gitChanges"
	| "extensions"
	| "sessionName"
	| "provider"
	| "routedModel"
	| "autoCompact";

export type StatusBarSlot = "off" | "bar1-left" | "bar1-right" | "bar2-left" | "bar2-right";
export interface StatusBarItemConfig {
	enabled: boolean;
	slot: StatusBarSlot;
	/** Keep the item when the rendered bar becomes width-constrained. */
	compact: boolean;
}
export type StatusBarLayout = Record<StatusBarItemId, StatusBarItemConfig>;

const STATUS_BAR_ITEM_LABELS: Record<StatusBarItemId, string> = {
	directory: "Directory",
	model: "Model",
	thinking: "Thinking level",
	peak: "DeepSeek peak status",
	inputTokens: "Input tokens",
	outputTokens: "Output tokens",
	cacheRead: "Cache-read tokens",
	cacheWrite: "Cache-write tokens",
	cacheHit: "Cache-hit percentage",
	contextTokens: "Context usage number",
	contextPercent: "Context usage percentage",
	cost: "Session cost",
	workMode: "Plan/build/yolo mode",
	git: "Git branch",
	gitChanges: "Git changes",
	extensions: "Extension statuses",
	sessionName: "Session name",
	provider: "Provider",
	routedModel: "Routed model",
	autoCompact: "Auto-compact indicator",
};

export const STATUS_BAR_ITEM_IDS = Object.keys(STATUS_BAR_ITEM_LABELS) as readonly StatusBarItemId[];

const STATUS_BAR_SLOT = enumSetting<StatusBarSlot>(
	{
		off: "Disabled",
		"bar1-left": "Status bar 1 · Left",
		"bar1-right": "Status bar 1 · Right",
		"bar2-left": "Status bar 2 · Left",
		"bar2-right": "Status bar 2 · Right",
	},
	() => "off",
);

export function statusBarItemLabel(id: StatusBarItemId): string {
	return STATUS_BAR_ITEM_LABELS[id];
}

export const statusBarSlotLabel = STATUS_BAR_SLOT.label;
export const resolveStatusBarSlotId = STATUS_BAR_SLOT.resolve;

function defaultStatusBarLayout(): StatusBarLayout {
	const left1: StatusBarItemId[] = ["directory", "model", "thinking", "peak"];
	const right1: StatusBarItemId[] = ["inputTokens", "outputTokens", "cacheRead", "cacheWrite", "cacheHit", "contextTokens", "contextPercent", "cost", "workMode"];
	const left2: StatusBarItemId[] = ["git", "gitChanges"];
	const right2: StatusBarItemId[] = ["extensions"];
	const layout = {} as StatusBarLayout;
	for (const id of STATUS_BAR_ITEM_IDS) {
		const slot = left1.includes(id) ? "bar1-left" : right1.includes(id) ? "bar1-right" : left2.includes(id) ? "bar2-left" : right2.includes(id) ? "bar2-right" : "off";
		layout[id] = { enabled: slot !== "off", slot, compact: slot !== "off" };
	}
	return layout;
}

export function resolveStatusBarLayout(value: unknown): StatusBarLayout {
	const raw = isRecord(value) ? value : {};
	const defaults = defaultStatusBarLayout();
	const layout = {} as StatusBarLayout;
	const legacyContext = isRecord(raw.context) ? raw.context : undefined;
	for (const id of STATUS_BAR_ITEM_IDS) {
		const stored = isRecord(raw[id]) ? raw[id] : (legacyContext && (id === "contextTokens" || id === "contextPercent") ? legacyContext : undefined);
		const item = stored ?? {};
		const slot = resolveStatusBarSlotId(item.slot);
		layout[id] = {
			enabled: typeof item.enabled === "boolean" ? item.enabled && slot !== "off" : defaults[id].enabled,
			slot: typeof item.enabled === "boolean" ? slot : defaults[id].slot,
			compact: typeof item.compact === "boolean" ? item.compact : defaults[id].compact,
		};
	}
	return layout;
}

export function isDefaultStatusBarLayout(layout: StatusBarLayout): boolean {
	const defaults = defaultStatusBarLayout();
	return STATUS_BAR_ITEM_IDS.every((id) => layout[id].enabled === defaults[id].enabled && layout[id].slot === defaults[id].slot && layout[id].compact === defaults[id].compact);
}

const STATUS_BAR_MODE = enumSetting<StatusBarMode>(
	{ sleek: "Sleek", bar: "Bar", minimal: "Minimal", default: "Default" },
	() => DEFAULTS.statusBar,
);

/** Coerce a stored value to a known status-bar mode, falling back to the default. */
export function resolveStatusBarModeId(value: unknown): StatusBarMode {
	// `gemini` was the pre-rename id for the Sleek bar, `blocks` for the Bar style.
	if (value === "gemini") return "sleek";
	if (value === "blocks") return "bar";
	return STATUS_BAR_MODE.resolve(value);
}

export const statusBarModeLabel = STATUS_BAR_MODE.label;

/** When a finished-response notification fires. */
export type NotificationMethod = "unfocused-timer" | "unfocused" | "always";

const NOTIFICATION_METHOD = enumSetting<NotificationMethod>(
	{ "unfocused-timer": "Unfocused + Timer", unfocused: "Unfocused only", always: "Always on" },
	() => DEFAULTS.notificationMethod,
);
export const resolveNotificationMethodId = NOTIFICATION_METHOD.resolve;
export const notificationMethodLabel = NOTIFICATION_METHOD.label;

/** Bundled fallback chime, used until the user picks a file in the Notifications menu. */
export const DEFAULT_NOTIFICATION_SOUND = "/usr/share/sounds/freedesktop/stereo/complete.oga";

/** Default minimum turn length (seconds) for a focused-terminal response alert. */
const DEFAULT_NOTIFICATION_TIMER_SECONDS = 20;
/** Extensions whose UI prompts should not trigger notification alerts. */
const DEFAULT_NOTIFICATION_BLACKLIST: string[] = ["pi-edit-message"];

export interface SleekConfig {
	density: DensityMode;
	thinkingStyle: ThinkingStyleId;
	userMessageStyle: UserMessageStyle;
	agentMessageStyle: AgentMessageStyle;
	/** Bottom status bar: the Sleek bar, pi's built-in footer, or nothing. */
	statusBar: StatusBarMode;
	/** Show the status bar's bottom row (git branch + edits, extension statuses). */
	bottomBar: boolean;
	/** Show the 30%-width right-side information panel. */
	sidePanel: boolean;
	/** Which sections are shown in the side panel. */
	sidePanelItems: Record<SidePanelItemId, boolean>;
	/** Visibility and row/side placement for status-bar items. */
	statusBarLayout: StatusBarLayout;
	logoAnimationStyle: LogoAnimationStyleId;
	/** Colour treatment for the startup logo pixels. */
	logoColorMode: LogoColorMode;
	/** Play a sound + desktop notification when Pi finishes or is waiting on the user. */
	notifications: boolean;
	/** Audio file played by the notification alert (absolute path). */
	notificationSound: string;
	/** When a finished response alerts (prompts always alert). */
	notificationMethod: NotificationMethod;
	/** Minimum turn length in seconds for an alert while focused (method "unfocused-timer"). */
	notificationTimerSeconds: number;
	/** Extension ids whose prompts are ignored by the notification system. */
	notificationBlacklist: string[];
	/** Apply the active theme's page background to the terminal (OSC 11 + ANSI frame). */
	useThemeBackground: boolean;
	/**
	 * Force the theme background even on hosts that ignore OSC 11 (Windows /
	 * Windows Terminal / WSL). File-only: no menu row, read silently.
	 */
	forceOSC11: boolean;
}

const DEFAULTS: SleekConfig = {
	density: "compact",
	thinkingStyle: "default",
	userMessageStyle: "bar",
	agentMessageStyle: "plain",
	statusBar: "default",
	bottomBar: true,
	sidePanel: true,
	sidePanelItems: defaultSidePanelItems(),
	statusBarLayout: defaultStatusBarLayout(),
	logoAnimationStyle: "materialize",
	logoColorMode: "default",
	notifications: true,
	notificationSound: DEFAULT_NOTIFICATION_SOUND,
	notificationMethod: "unfocused-timer",
	notificationTimerSeconds: DEFAULT_NOTIFICATION_TIMER_SECONDS,
	notificationBlacklist: DEFAULT_NOTIFICATION_BLACKLIST,
	useThemeBackground: true,
	forceOSC11: false,
};

/** Every setting is `sleek-<key>`, except the timer's shorter legacy key. */
const CONFIG_KEYS = Object.fromEntries(
	(Object.keys(DEFAULTS) as Array<keyof SleekConfig>).map((key) => [
		key,
		key === "notificationTimerSeconds" ? "sleek-notificationTimer" : `sleek-${key}`,
	]),
) as Record<keyof SleekConfig, string>;

const CONFIG_PATH = join(homedir(), ".pi", "agent", "sleek.json");
const STAT_INTERVAL_MS = 1000;

let cached: SleekConfig = { ...DEFAULTS };
let cachedMtimeMs = -1;
let lastStatAt = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function stringOrDefault(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function nonNegativeNumberOrDefault(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function stringArrayOrDefault(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return [...fallback];
	const result = value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
	return [...new Set(result)];
}

function defaultRawConfig(): Record<string, unknown> {
	return Object.fromEntries(Object.keys(DEFAULTS).map((key) => [
		CONFIG_KEYS[key as keyof SleekConfig],
		DEFAULTS[key as keyof SleekConfig],
	]));
}

function writeJsonAtomic(path: string, data: unknown): boolean {
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
		renameSync(tmp, path);
		return true;
	} catch {
		try {
			rmSync(tmp, { force: true });
		} catch {
			// Best effort cleanup.
		}
		return false;
	}
}

/** Preserve an unparseable config before overwriting it, so it stays recoverable. */
function backupMalformedConfig(path: string): boolean {
	try {
		copyFileSync(path, `${path}.corrupt-${Date.now()}`);
		return true;
	} catch {
		return false;
	}
}

function normalizeConfig(raw: unknown): SleekConfig {
	if (!isRecord(raw)) return { ...DEFAULTS };
	return {
		density: resolveDensityModeId(raw[CONFIG_KEYS.density]),
		thinkingStyle: resolveThinkingStyleId(raw[CONFIG_KEYS.thinkingStyle]),
		userMessageStyle: resolveUserMessageStyleId(raw[CONFIG_KEYS.userMessageStyle]),
		agentMessageStyle: resolveAgentMessageStyleId(raw[CONFIG_KEYS.agentMessageStyle]),
		statusBar: resolveStatusBarModeId(raw[CONFIG_KEYS.statusBar]),
		bottomBar: booleanOrDefault(raw[CONFIG_KEYS.bottomBar], DEFAULTS.bottomBar),
		sidePanel: booleanOrDefault(raw[CONFIG_KEYS.sidePanel], DEFAULTS.sidePanel),
		sidePanelItems: normalizeSidePanelItems(raw[CONFIG_KEYS.sidePanelItems]),
		statusBarLayout: resolveStatusBarLayout(raw[CONFIG_KEYS.statusBarLayout]),
		logoAnimationStyle: resolveLogoAnimationStyleId(raw[CONFIG_KEYS.logoAnimationStyle]),
		logoColorMode: resolveLogoColorModeId(raw[CONFIG_KEYS.logoColorMode]),
		notifications: booleanOrDefault(raw[CONFIG_KEYS.notifications], DEFAULTS.notifications),
		notificationSound: stringOrDefault(raw[CONFIG_KEYS.notificationSound], DEFAULTS.notificationSound),
		notificationMethod: resolveNotificationMethodId(raw[CONFIG_KEYS.notificationMethod]),
		notificationTimerSeconds: nonNegativeNumberOrDefault(
			raw[CONFIG_KEYS.notificationTimerSeconds],
			DEFAULTS.notificationTimerSeconds,
		),
		notificationBlacklist: stringArrayOrDefault(raw[CONFIG_KEYS.notificationBlacklist], DEFAULTS.notificationBlacklist),
		useThemeBackground: booleanOrDefault(raw[CONFIG_KEYS.useThemeBackground], DEFAULTS.useThemeBackground),
		forceOSC11: booleanOrDefault(raw[CONFIG_KEYS.forceOSC11], DEFAULTS.forceOSC11),
	};
}

export function loadConfig(): SleekConfig {
	const now = Date.now();
	if (now - lastStatAt < STAT_INTERVAL_MS) return cached;
	lastStatAt = now;

	let mtimeMs = -1;
	try {
		mtimeMs = statSync(CONFIG_PATH).mtimeMs;
	} catch {
		cached = { ...DEFAULTS };
		cachedMtimeMs = -1;
		return cached;
	}

	if (mtimeMs === cachedMtimeMs) return cached;
	cachedMtimeMs = mtimeMs;
	try {
		const raw: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		cached = normalizeConfig(raw);
	} catch {
		cached = { ...DEFAULTS };
	}
	return cached;
}

/** Save a partial config (stored under `sleek-` keys) and refresh the cache. */
export function saveConfig(patch: Partial<SleekConfig>): boolean {
	let raw: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		if (!isRecord(parsed)) {
			if (!backupMalformedConfig(CONFIG_PATH)) return false;
			raw = defaultRawConfig();
		} else {
			raw = parsed;
		}
	} catch {
		if (existsSync(CONFIG_PATH) && !backupMalformedConfig(CONFIG_PATH)) return false;
		raw = defaultRawConfig();
	}
	for (const key of Object.keys(patch) as Array<keyof SleekConfig>) {
		raw[CONFIG_KEYS[key]] = patch[key];
	}
	if (!writeJsonAtomic(CONFIG_PATH, raw)) return false;
	cached = normalizeConfig(raw);
	try {
		cachedMtimeMs = statSync(CONFIG_PATH).mtimeMs;
	} catch {
		cachedMtimeMs = -1;
	}
	lastStatAt = Date.now();
	return true;
}
