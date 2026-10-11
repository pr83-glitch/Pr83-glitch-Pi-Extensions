/**
 * The notification alert: a desktop notification plus a sound.
 *
 * Rules (from the Notifications menu):
 *   - a finished response follows the notification method — unfocused only,
 *     unfocused or turn longer than the timer, or always — and quotes the
 *     latest reply as a highlight;
 *   - a prompt (question, permission, any `ctx.ui` dialog) always alerts and
 *     names its category.
 *
 * The alert never blocks and never throws into a session handler.
 */
import { existsSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join } from "path";

import { DEFAULT_NOTIFICATION_SOUND, loadConfig } from "../config.js";
import { responseStatsClock } from "../messages/response-stats.js";
import { findExecutable, spawnDetached } from "./exec.js";
import { isTerminalFocused } from "./focus.js";

export type AlertReason = "response" | "permission" | "question" | "prompt";

/** Collapse alerts that would otherwise land back to back (prompt + settle). */
const ALERT_DEDUPE_MS = 1_200;
/** Longest response highlight carried in the notification body. */
const RESPONSE_HIGHLIGHT_MAX_CHARS = 140;
const NOTIFICATION_APP = "pi";

/**
 * Audio backends tried in order. `>=` any of these is enough on a normal Linux
 * desktop; `canberra-gtk-play` is the freedesktop fallback.
 */
type AudioPlayer = { command: string; args: (file: string) => string[] };

const AUDIO_PLAYERS: ReadonlyArray<AudioPlayer> = [
	{ command: "pw-play", args: (file) => [file] },
	{ command: "paplay", args: (file) => [file] },
	{ command: "canberra-gtk-play", args: (file) => [`--file=${file}`] },
];

let sleekUiDepth = 0;
let lastAlertAt = 0;
let blacklistedPromptUntil = 0;
let activePromptSource: string | undefined;
/** Text of the latest assistant reply, shown as the response highlight. */
let lastAssistantText = "";
let resolvedPlayer: AudioPlayer | null | undefined;
let resolvedNotifySend: string | null | undefined;

/**
 * Mark a Sleek overlay as open for the life of `run`. Pi emits
 * `ui_prompt_start` for every `ctx.ui.custom` call, including our own menu, so
 * those must not alert. The depth is raised synchronously (before the queued
 * `ui_prompt_start` microtask runs) and lowered when the overlay settles.
 */
export function withSleekUi<T>(run: Promise<T>): Promise<T> {
	sleekUiDepth += 1;
	return run.finally(() => {
		sleekUiDepth = Math.max(0, sleekUiDepth - 1);
	});
}

function resolvePlayer(): AudioPlayer | null {
	if (resolvedPlayer !== undefined) return resolvedPlayer;
	resolvedPlayer = null;
	for (const player of AUDIO_PLAYERS) {
		if (findExecutable(player.command)) {
			resolvedPlayer = player;
			break;
		}
	}
	return resolvedPlayer;
}

/**
 * Remember the latest assistant reply so a response alert can show a short
 * highlight. Tool-only turns carry no text and leave the previous highlight in
 * place, so the alert always quotes something the user can recognise.
 */
export function noteAssistantMessage(message: unknown): void {
	const text = extractAssistantText(message);
	if (text !== "") lastAssistantText = text;
}

function extractAssistantText(message: unknown): string {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join(" ");
}

/** Collapse whitespace and clip a reply into a one-line notification highlight. */
function responseHighlight(): string {
	const collapsed = lastAssistantText.replace(/\s+/gu, " ").trim();
	if (collapsed === "") return "";
	if (collapsed.length <= RESPONSE_HIGHLIGHT_MAX_CHARS) return collapsed;
	return `${collapsed.slice(0, RESPONSE_HIGHLIGHT_MAX_CHARS - 1).trimEnd()}…`;
}

/** Build the notification body: a headline plus an optional detail line. */
function notificationBody(reason: AlertReason, detail?: string): string {
	if (reason === "response") {
		const highlight = responseHighlight();
		return highlight === "" ? "Response ready" : `Response ready\n${highlight}`;
	}
	const extra = detail?.trim() ?? "";
	if (reason === "prompt") return extra === "" ? "Pi needs your input" : extra;
	const headline = reason === "permission" ? "Agent is asking for permission" : "Agent is asking a question";
	return extra === "" ? headline : `${headline}\n${extra}`;
}

/** Whether an extension's prompt alerts are disabled in the notification settings. */
export function isNotificationSourceBlacklisted(source: string): boolean {
	const normalized = source.trim();
	if (normalized === "") return false;
	const candidates = new Set<string>();
	for (const part of normalized.split("|")) {
		const value = part.trim();
		if (value === "") continue;
		candidates.add(value);
		candidates.add(value.replace(/\.(?:ts|js|mjs|cjs)$/u, ""));
		candidates.add(value.replace(/^npm:/u, ""));
		const packageMatch = value.match(/(?:node_modules\/|^npm:)((?:@[^/]+\/)?[^/:/]+)(?:\/|$)/u);
		if (packageMatch?.[1]) candidates.add(packageMatch[1]);
		const extensionMatch = value.match(/(?:^|\/)extensions\/([^/]+)(?:\/|$)/u);
		if (extensionMatch?.[1]) candidates.add(extensionMatch[1].replace(/\.(?:ts|js|mjs|cjs)$/u, ""));
	}
	return loadConfig().notificationBlacklist.some((blocked) => candidates.has(blocked));
}

/** Keep the command's extension identity through all nested UI prompts. */
export function withNotificationPromptSource<T>(source: string, run: () => Promise<T>): Promise<T> {
	const previous = activePromptSource;
	activePromptSource = source;
	return run().finally(() => {
		activePromptSource = previous;
	});
}

/** Mark the next prompt as belonging to an extension that may be blacklisted. */
export function markPromptSource(source: string): void {
	if (isNotificationSourceBlacklisted(source)) blacklistedPromptUntil = Date.now() + 5_000;
}

/** True while a command from a blacklisted extension owns the UI prompt. */
export function isActivePromptSourceBlacklisted(): boolean {
	return activePromptSource !== undefined && isNotificationSourceBlacklisted(activePromptSource);
}

/** Consume a prompt-source marker before the generic ui_prompt_start alert. */
export function consumeBlacklistedPrompt(): boolean {
	if (Date.now() > blacklistedPromptUntil) {
		blacklistedPromptUntil = 0;
		return false;
	}
	blacklistedPromptUntil = 0;
	return true;
}

/** Session shutdown / reload: forget per-session alert state. */
export function resetAlertState(): void {
	lastAssistantText = "";
	lastAlertAt = 0;
	sleekUiDepth = 0;
	blacklistedPromptUntil = 0;
	activePromptSource = undefined;
}

/** Expand `~`, and make a relative path relative to home (paths come from the user). */
function resolveSoundPath(file: string): string {
	const trimmed = file.trim();
	if (trimmed === "") return DEFAULT_NOTIFICATION_SOUND;
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
	return isAbsolute(trimmed) ? trimmed : join(homedir(), trimmed);
}

/** Play a sound file without blocking. */
export function playNotificationSound(file: string): void {
	const player = resolvePlayer();
	if (!player) return;
	const path = resolveSoundPath(file);
	if (!existsSync(path)) return;
	spawnDetached(player.command, player.args(path));
}

function notifySend(): string | null {
	if (resolvedNotifySend !== undefined) return resolvedNotifySend;
	resolvedNotifySend = findExecutable("notify-send") ?? null;
	return resolvedNotifySend;
}

/** Show a desktop notification without blocking. */
function sendDesktopNotification(title: string, body: string): void {
	const command = notifySend();
	if (!command) return;
	spawnDetached(command, ["-a", NOTIFICATION_APP, "-u", "normal", title, body]);
}

/**
 * Fire an alert when the rule allows it. `detail` is a prompt title, question
 * text or permission reason when Pi knows one.
 *
 * A finished response is gated by the configured notification method (focus
 * and/or the turn timer); prompts (question, permission, generic) always alert.
 */
export function maybeAlert(reason: AlertReason, detail?: string): void {
	const config = loadConfig();
	if (!config.notifications) return;
	// Our own /sleek overlays emit `ui_prompt_start` too — never alert for them.
	if (sleekUiDepth > 0) return;

	if (reason === "response") {
		const method = config.notificationMethod;
		if (method === "unfocused") {
			if (isTerminalFocused()) return;
		} else if (method === "unfocused-timer") {
			const elapsedMs = responseStatsClock.getTurnElapsedMs() ?? 0;
			if (isTerminalFocused() && elapsedMs <= config.notificationTimerSeconds * 1000) return;
		}
	}

	const now = Date.now();
	if (now - lastAlertAt < ALERT_DEDUPE_MS) return;
	lastAlertAt = now;

	sendDesktopNotification(NOTIFICATION_APP, notificationBody(reason, detail));
	playNotificationSound(config.notificationSound);
}
