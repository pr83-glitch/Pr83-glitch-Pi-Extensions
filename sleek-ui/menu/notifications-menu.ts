/**
 * The `/sleek` → Notifications submenu.
 *
 * A five-row settings list (enabled, method, timer, sound, prompt blacklist)
 * plus the overlays it opens on top of itself: the method picker, the seconds
 * prompt, the desktop sound picker and the extension blacklist. Split out of
 * `index.ts` because it is self-contained — it only needs the live `ui`, the
 * session cwd for extension discovery, the config and the notification helpers.
 */
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

import {
	loadConfig,
	notificationMethodLabel,
	resolveNotificationMethodId,
	saveConfig,
	type SleekConfig,
} from "../config.js";
import { playNotificationSound, withSleekUi } from "../notify/alerts.js";
import { hasFilePicker, pickNotificationSound } from "../notify/file-picker.js";
import { menuPrimaryHint, type MenuTheme } from "./frame.js";
import { openOptionPicker, type PickerOption, type SettingOptionHelp } from "./option-picker.js";
import { createMenu, openOverlay } from "./overlay.js";
import type { MenuRow } from "./popup.js";

/** Basename of the configured sound, for the Notifications row. */
function notificationSoundLabel(path: string): string {
	const trimmed = path.trim();
	if (trimmed === "") return "default";
	return trimmed.split("/").pop() ?? trimmed;
}

const NOTIFICATION_METHOD_OPTIONS: readonly SettingOptionHelp[] = [
	{
		id: "unfocused-timer",
		text: "Alert for a finished response when the terminal is unfocused, or when the turn ran longer than the timer. Prompts always alert. Recommended.",
	},
	{
		id: "unfocused",
		text: "Alert for a finished response only when the terminal is unfocused. The timer is not used.",
	},
	{
		id: "always",
		text: "Alert for every finished response, regardless of focus or turn length.",
	},
];

/** The timer only matters for the "Unfocused + Timer" method. */
function notificationTimerDisabled(config: SleekConfig): boolean {
	return config.notificationMethod !== "unfocused-timer";
}

/** One-line ANSI sample for the notification-method picker. */
function notificationMethodSample(id: string, theme: MenuTheme): string {
	switch (resolveNotificationMethodId(id)) {
		case "unfocused":
			return theme.fg("muted", "unfocused only");
		case "always":
			return theme.fg("success", "always");
		default:
			return `${theme.fg("muted", "unfocused")} ${theme.fg("dim", "or")} ${theme.fg("accent", `> ${loadConfig().notificationTimerSeconds}s`)}`;
	}
}

/**
 * Extension ids that can be blacklisted: everything discovered in the global and
 * project extension directories plus Pi's installed npm packages, unioned with
 * whatever the config already lists.
 */
export function notificationExtensionIds(cwd: string): string[] {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const directories = [join(agentDir, "extensions"), join(cwd, ".pi", "extensions")];
	const ids = new Set(loadConfig().notificationBlacklist);
	for (const directory of directories) {
		try {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				if (entry.name.startsWith(".")) continue;
				if (entry.isDirectory() || entry.isSymbolicLink()) ids.add(entry.name);
				else if (entry.isFile() && [".ts", ".js", ".mjs", ".cjs"].includes(extname(entry.name))) {
					ids.add(basename(entry.name, extname(entry.name)));
				}
			}
		} catch {
			// An extension directory may not exist for this scope.
		}
	}
	const nodeModules = join(agentDir, "npm", "node_modules");
	try {
		const packages = readdirSync(nodeModules, { withFileTypes: true }).flatMap((entry) => {
			if (entry.name.startsWith(".")) return [];
			const path = join(nodeModules, entry.name);
			return entry.name.startsWith("@") && entry.isDirectory()
				? readdirSync(path, { withFileTypes: true }).map((scoped) => join(path, scoped.name))
				: [path];
		});
		for (const path of packages) {
			try {
				const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
				if (typeof manifest.name === "string" && Array.isArray(manifest.pi?.extensions)) ids.add(manifest.name);
			} catch {
				// Not every installed npm package is a Pi extension.
			}
		}
	} catch {
		// The Pi npm package directory may not exist.
	}
	return [...ids].sort((a, b) => a.localeCompare(b));
}

function notificationRows(): MenuRow[] {
	const config = loadConfig();
	const timerDisabled = notificationTimerDisabled(config);
	return [
		{
			id: "enabled",
			label: "Notifications",
			value: config.notifications ? "Enabled" : "Disabled",
			state: config.notifications ? "on" : "off",
			search: "notifications enable disable alert sound",
		},
		{
			id: "method",
			label: "Notification method",
			value: notificationMethodLabel(config.notificationMethod),
			state: "info",
			search: `notification method focus unfocused always timer ${config.notificationMethod}`,
		},
		{
			id: "timer",
			label: "Notification timer",
			value: `${config.notificationTimerSeconds}s`,
			state: timerDisabled ? "off" : "info",
			disabled: timerDisabled,
			search: "notification timer seconds minimum turn duration",
		},
		{
			id: "sound",
			label: "Notification sound",
			value: notificationSoundLabel(config.notificationSound),
			state: "info",
			search: `notification sound file ${config.notificationSound}`,
		},
		{
			id: "blacklist",
			label: "Prompt blacklist",
			value: `${config.notificationBlacklist.length} ignored`,
			state: "info",
			search: "prompt blacklist extensions ignore suppress notifications",
		},
	];
}

/** Dedicated picker for the notification method (sits on top of the submenu). */
async function openNotificationMethodPicker(ctx: { ui: any }): Promise<void> {
	const options: PickerOption[] = NOTIFICATION_METHOD_OPTIONS.map((option) => ({
		id: option.id,
		label: notificationMethodLabel(resolveNotificationMethodId(option.id)),
		description: option.text,
	}));
	await openOptionPicker(ctx.ui, {
		title: `Notification method · ${options.length}`,
		listTitle: "Notification method",
		options,
		currentId: loadConfig().notificationMethod,
		onSelect: (id) => saveConfig({ notificationMethod: resolveNotificationMethodId(id) }),
		sample: (id, theme) => notificationMethodSample(id, theme),
	});
}

/** Prompt for the minimum turn length (seconds) used by the timer method. */
async function editNotificationTimer(ui: any): Promise<void> {
	const current = loadConfig().notificationTimerSeconds;
	const raw = await withSleekUi(ui.input("Notification timer (seconds)", String(current)));
	if (typeof raw !== "string") return;
	const parsed = Number(raw.trim());
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		ui.notify("Enter a whole number of seconds (0 or more)", "warning");
		return;
	}
	if (!saveConfig({ notificationTimerSeconds: parsed })) ui.notify("Could not save notification timer", "error");
}

/** Open the native picker, persist the choice and preview it. */
async function chooseNotificationSound(ui: {
	notify(message: string, kind?: "info" | "warning" | "error"): void;
}, signal: AbortSignal): Promise<boolean> {
	if (!hasFilePicker()) {
		ui.notify("No desktop file picker found (install zenity or kdialog)", "warning");
		return false;
	}
	const picked = await pickNotificationSound(loadConfig().notificationSound, signal);
	if (signal.aborted || !picked) return false;
	if (!saveConfig({ notificationSound: picked })) {
		ui.notify("Could not save notification sound", "error");
		return false;
	}
	playNotificationSound(picked);
	return true;
}

/** Toggle extension IDs whose prompts should not alert. */
async function openNotificationBlacklistPicker(ctx: { ui: any; cwd?: string }): Promise<void> {
	const ui = ctx.ui;
	const ids = notificationExtensionIds(ctx.cwd || process.cwd());
	await openOverlay(ui, (tui: any, theme: any, done: (result: string | undefined) => void) => {
		const rows = (): MenuRow[] => {
			const blocked = new Set(loadConfig().notificationBlacklist);
			return ids.map((id) => ({
				id,
				label: id,
				value: blocked.has(id) ? "Ignored" : "Alerts",
				state: blocked.has(id) ? "on" : "off",
				search: `${id} extension prompt blacklist ignore notification`,
			}));
		};
		return createMenu(tui, theme, {
			title: "Prompt blacklist",
			searchHint: "Type to filter extensions...",
			rows,
			primaryHint: menuPrimaryHint(theme),
			onActivate: (row, popup) => {
				const blocked = new Set(loadConfig().notificationBlacklist);
				if (blocked.has(row.id)) blocked.delete(row.id);
				else blocked.add(row.id);
				if (!saveConfig({ notificationBlacklist: [...blocked] })) {
					ui.notify("Could not save notification blacklist", "error");
					return;
				}
				popup.refresh();
			},
			onClose: () => done(undefined),
		});
	});
}

/** The Notifications submenu, opened from the `/sleek` menu's Notifications row. */
export async function openNotificationsMenu(ctx: { ui: any; cwd?: string }): Promise<void> {
	const ui = ctx.ui;
	// Method and timer need a second overlay (a picker / a text prompt), so the
	// submenu closes, the overlay opens, and the submenu reopens — like /sleek.
	for (;;) {
		const outcome = await openOverlay<string>(ui, (tui: any, theme: any, done: (result: string | undefined) => void) => {
			const lifetime = new AbortController();
			let picking = false;
			return createMenu(tui, theme, {
				title: "Notifications · 5",
				searchHint: "Type to filter settings...",
				rows: () => notificationRows(),
				primaryHint: menuPrimaryHint(theme),
				onActivate: (row, popup) => {
					if (row.id === "enabled") {
						if (!saveConfig({ notifications: !loadConfig().notifications })) {
							ui.notify("Could not save notification settings", "error");
							return;
						}
						popup.refresh();
						return;
					}
					if (row.id === "sound") {
						if (picking || lifetime.signal.aborted) return;
						picking = true;
						void chooseNotificationSound(ui, lifetime.signal).then((changed) => {
							if (changed && !lifetime.signal.aborted) popup.refresh();
						}).finally(() => { picking = false; });
						return;
					}
					lifetime.abort();
					done(row.id);
				},
				onDispose: () => lifetime.abort(),
				onClose: () => { lifetime.abort(); done(undefined); },
			});
		},
		);
		if (outcome === undefined) return;
		if (outcome === "method") await openNotificationMethodPicker(ctx);
		else if (outcome === "timer") await editNotificationTimer(ui);
		else if (outcome === "blacklist") await openNotificationBlacklistPicker(ctx);
	}
}
