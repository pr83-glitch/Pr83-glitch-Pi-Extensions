/**
 * Small process helpers shared by the notification modules.
 *
 * Alerting must never block the render loop or throw into a session handler, so
 * every helper here is best-effort: a missing binary or a spawn failure simply
 * does nothing.
 */
import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { delimiter, join } from "path";

/** Resolve a command through PATH so `notify-send`/`pw-play` work without a shell. */
export function findExecutable(command: string): string | undefined {
	if (command.includes("/")) return existsSync(command) ? command : undefined;
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir === "") continue;
		const candidate = join(dir, command);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** Fire-and-forget detached process; alerts must never block or surface errors. */
export function spawnDetached(command: string, args: readonly string[]): void {
	try {
		const child = spawn(command, [...args], { detached: true, stdio: "ignore" });
		child.on("error", () => {
			// Missing binary / no permission — nothing to do.
		});
		child.unref();
	} catch {
		// Best effort.
	}
}

/** Run a helper process and capture its stdout (used by the sound file picker). */
export function runCapture(
	command: string,
	args: readonly string[],
	signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string }> {
	return new Promise((resolve) => {
		if (signal?.aborted) { resolve({ code: null, stdout: "" }); return; }
		let child: ChildProcess;
		try {
			child = spawn(command, [...args], { stdio: ["ignore", "pipe", "ignore"] });
		} catch {
			resolve({ code: null, stdout: "" });
			return;
		}
		let stdout = "";
		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
		});
		const finish = (code: number | null): void => {
			signal?.removeEventListener("abort", abort);
			resolve({ code, stdout });
		};
		const abort = (): void => {
			child.kill();
			finish(null);
		};
		signal?.addEventListener("abort", abort, { once: true });
		child.on("error", () => finish(null));
		child.on("close", finish);
		if (signal?.aborted) abort();
	});
}
