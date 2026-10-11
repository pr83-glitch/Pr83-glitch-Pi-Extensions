import { execFile } from "node:child_process";

export type GitStatus = { branch: string; insertions: number; deletions: number };

const CACHE_MS = 5000;
const TIMEOUT_MS = 1000;
let cached: (GitStatus & { cwd: string; fetchedAt: number }) | undefined;
let inFlight = false;
let generation = 0;
let activeCwd: string | undefined;
const updateListeners = new Set<() => void>();

function parseShortstat(text: string, word: "insertion" | "deletion"): number {
	return Number(text.match(new RegExp(`([0-9]+) ${word}`))?.[1] ?? 0);
}

/** Run one git command; resolves `undefined` when git fails (no repo, timeout). */
function runGit(cwd: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		try {
			execFile("git", args, { cwd, timeout: TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
				resolve(error ? undefined : stdout);
			});
		} catch {
			resolve(undefined);
		}
	});
}

async function refresh(cwd: string): Promise<void> {
	if (inFlight) return;
	inFlight = true;
	const serial = generation;
	try {
		const [branch, unstaged, staged] = await Promise.all([
			runGit(cwd, ["branch", "--show-current"]),
			runGit(cwd, ["diff", "--shortstat"]),
			runGit(cwd, ["diff", "--cached", "--shortstat"]),
		]);
		if (serial !== generation) return;
		cached = {
			cwd,
			// Empty branch means "not a git repo"; a successful but empty branch is a detached HEAD.
			branch: branch === undefined ? "" : branch.trim() || "detached",
			insertions: parseShortstat(unstaged ?? "", "insertion") + parseShortstat(staged ?? "", "insertion"),
			deletions: parseShortstat(unstaged ?? "", "deletion") + parseShortstat(staged ?? "", "deletion"),
			fetchedAt: Date.now(),
		};
	} finally {
		if (serial !== generation) return;
		inFlight = false;
		const listeners = [...updateListeners];
		updateListeners.clear();
		for (const listener of listeners) {
			try { listener(); } catch { /* Best effort. */ }
		}
	}
}

/** Cached, non-blocking Git details shared by the footer and side panel. */
export function getGitStatus(cwd: string, onUpdate?: () => void): GitStatus | undefined {
	if (!cwd) return undefined;
	if (activeCwd !== cwd) {
		resetGitStatus();
		activeCwd = cwd;
	}
	if (!cached || cached.cwd !== cwd || Date.now() - cached.fetchedAt >= CACHE_MS) {
		if (onUpdate) updateListeners.add(onUpdate);
		if (!inFlight) void refresh(cwd);
	}
	return cached?.cwd === cwd ? { branch: cached.branch, insertions: cached.insertions, deletions: cached.deletions } : undefined;
}

export function resetGitStatus(): void {
	generation++;
	inFlight = false;
	activeCwd = undefined;
	cached = undefined;
	updateListeners.clear();
}
