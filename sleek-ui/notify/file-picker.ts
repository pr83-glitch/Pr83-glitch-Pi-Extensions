/**
 * Native "choose a sound file" picker for the Notifications menu.
 *
 * Uses the desktop's own dialog (`zenity`, then `kdialog`) so the choice feels
 * native and the surrounding TUI does not need to grow a file browser. The
 * dialog is spawned as a child process and awaited, so the Pi TUI keeps
 * rendering while it is open.
 */
import { existsSync, statSync } from "fs";
import { dirname } from "path";

import { findExecutable, runCapture } from "./exec.js";

const AUDIO_FILTERS = ["*.oga", "*.ogg", "*.wav", "*.flac", "*.mp3", "*.opus", "*.m4a", "*.aac"];

/** True when one of the supported desktop dialogs is installed. */
export function hasFilePicker(): boolean {
	return findExecutable("zenity") !== undefined || findExecutable("kdialog") !== undefined;
}

/** Open the native picker and resolve the chosen path, or undefined on cancel. */
export async function pickNotificationSound(currentPath?: string, signal?: AbortSignal): Promise<string | undefined> {
	if (signal?.aborted) return undefined;
	const startDir = startDirectory(currentPath);
	const zenity = findExecutable("zenity");
	if (zenity) {
		const args = [
			"--file-selection",
			"--title=Choose notification sound",
			`--file-filter=Audio files | ${AUDIO_FILTERS.join(" ")}`,
			"--file-filter=All files | *",
		];
		if (startDir) args.push(`--filename=${startDir}/`);
		const { code, stdout } = await runCapture(zenity, args, signal);
		return !signal?.aborted && code === 0 ? nonEmpty(stdout) : undefined;
	}

	const kdialog = findExecutable("kdialog");
	if (kdialog) {
		const filter = `${AUDIO_FILTERS.join(" ")}|Audio files`;
		const { code, stdout } = await runCapture(kdialog, ["--getopenfilename", startDir ?? ".", filter], signal);
		return !signal?.aborted && code === 0 ? nonEmpty(stdout) : undefined;
	}

	return undefined;
}

function nonEmpty(value: string): string | undefined {
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

/** Best-effort starting directory: the current file's folder, else its parent. */
function startDirectory(currentPath?: string): string | undefined {
	const trimmed = currentPath?.trim();
	if (!trimmed) return undefined;
	try {
		if (existsSync(trimmed) && statSync(trimmed).isDirectory()) return trimmed;
		const dir = dirname(trimmed);
		return existsSync(dir) ? dir : undefined;
	} catch {
		return undefined;
	}
}
