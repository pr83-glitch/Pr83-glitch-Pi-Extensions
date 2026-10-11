/**
 * Per-assistant-message stats for the response footer (the bar the boxed
 * response ends with, `↳ ◷ 12.4s | $0.0042 · 42.5 t/s`).
 *
 * Pi stores no per-message timing live, so it is clocked from the extension events
 * and kept in a WeakMap keyed by the message object (never written into the
 * session file). To make the footer survive a reload/resume, `seedResponseStatsFromEntries`
 * rebuilds the same stats from the persisted session entries (usage + entry/message
 * timestamps) at `session_start`; `getResponseStats` falls back to that seeded map.
 *
 * Two windows are measured:
 * - `totalMs` — from the turn's `agent_start` to this message's end. That is the
 *   number the footer shows on the left: it includes the request latency, the
 *   thinking phase and EVERY tool call (bash/todo/read/write) that ran before
 *   this message, so the turn's final response reports the whole turn.
 * - `generationMs` — first streamed delta to message end, the window the output
 *   tokens were actually produced in. Used for the tokens/s figure; counting the
 *   pre-first-token latency or tool waits would understate throughput.
 */

const statsByMessage = new WeakMap<object, ResponseStats>();

/**
 * Stats rebuilt from persisted session entries, keyed by `timestamp|responseId`.
 * A resumed session's messages are not the same objects the live clock saw (and the
 * WeakMap is empty), so identity cannot be used there; the key fields are persisted.
 */
const seededStatsByKey = new Map<string, ResponseStats>();

type ResponseStats = {
	totalMs: number;
	generationMs: number;
	costUsd: number | null;
	outputTokens: number;
};

/** No speed figure below this sample size — a 20 ms window is noise. */
const MIN_SPEED_SAMPLE_MS = 150;

class ResponseStatsClock {
	private turnStartMs: number | null = null;
	private messageStartMs: number | null = null;
	private firstDeltaMs: number | null = null;

	/** Turn boundary (`agent_start`): everything after this belongs to one reply. */
	beginTurn(): void {
		this.turnStartMs = Date.now();
		this.messageStartMs = null;
		this.firstDeltaMs = null;
	}

	handleMessageStart(message: any): void {
		if (message?.role !== "assistant") return;
		this.turnStartMs ??= Date.now();
		this.messageStartMs = Date.now();
		this.firstDeltaMs = null;
	}

	handleMessageUpdate(message: any): void {
		if (message?.role !== "assistant") return;
		this.firstDeltaMs ??= Date.now();
	}

	handleMessageEnd(message: any): void {
		if (message?.role !== "assistant") return;
		if (!message || typeof message !== "object") return;

		const endMs = Date.now();
		const messageStartMs = this.messageStartMs ?? endMs;
		const turnStartMs = this.turnStartMs ?? messageStartMs;
		const usage = message.usage;
		const cost = typeof usage?.cost?.total === "number" && Number.isFinite(usage.cost.total) ? usage.cost.total : null;
		const outputTokens = typeof usage?.output === "number" && Number.isFinite(usage.output) ? usage.output : 0;

		statsByMessage.set(message, {
			totalMs: Math.max(0, endMs - turnStartMs),
			generationMs: Math.max(0, endMs - (this.firstDeltaMs ?? messageStartMs)),
			costUsd: cost,
			outputTokens,
		});

		this.messageStartMs = null;
		this.firstDeltaMs = null;
	}

	/**
	 * Elapsed time of the current turn (from `agent_start`), or null when no turn
	 * is running. The working-indicator timer and the finished footer read the
	 * same anchor, so the number does not jump when a response completes.
	 */
	getTurnElapsedMs(): number | null {
		if (this.turnStartMs === null) return null;
		return Math.max(0, Date.now() - this.turnStartMs);
	}

	/** Session shutdown/reload: drop the turn anchor so a stale one is never reused. */
	reset(): void {
		this.turnStartMs = null;
		this.messageStartMs = null;
		this.firstDeltaMs = null;
	}
}

/** Process-wide singleton wired from index.ts; read by the response footer. */
export const responseStatsClock = new ResponseStatsClock();

/** Stats for a finished message: live clock first, then the resumed-session seed. */
export function getResponseStats(message: any): ResponseStats | undefined {
	if (!message || typeof message !== "object") return undefined;
	const live = statsByMessage.get(message);
	if (live) return live;
	const key = responseStatsKey(message);
	return key ? seededStatsByKey.get(key) : undefined;
}

/** `timestamp|responseId`; null when the message carries no persisted timestamp. */
function responseStatsKey(message: any): string | null {
	const timestamp = timestampMs(message?.timestamp);
	if (timestamp === null) return null;
	const responseId = typeof message?.responseId === "string" ? message.responseId : "";
	return `${timestamp}|${responseId}`;
}

function timestampMs(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

/**
 * Rebuild per-response stats for a resumed/reloaded session from its entries.
 *
 * Turn split mirrors the live clock: the most recent `user` message opens a turn, and
 * every assistant message in it reports `totalMs` from that turn start to its own end.
 * `generationMs` uses the assistant message's own `timestamp` (the live clock's
 * first-delta window is not persisted), so a resumed t/s is a slight under-estimate
 * (it includes the pre-first-token latency). Entries without timestamps are skipped.
 */
export function seedResponseStatsFromEntries(entries: readonly any[]): void {
	seededStatsByKey.clear();
	if (!Array.isArray(entries)) return;
	let turnStartMs: number | null = null;
	let previousEndMs: number | null = null;
	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (!message || typeof message !== "object") continue;
		const endMs = timestampMs(entry.timestamp) ?? timestampMs(message.timestamp);
		const startMs = timestampMs(message.timestamp) ?? previousEndMs;
		if (message.role === "user" && startMs !== null) turnStartMs = startMs;
		if (message.role === "assistant" && endMs !== null) {
			const key = responseStatsKey(message);
			if (key) {
				const usage = message.usage;
				const cost = typeof usage?.cost?.total === "number" && Number.isFinite(usage.cost.total) ? usage.cost.total : null;
				const outputTokens = typeof usage?.output === "number" && Number.isFinite(usage.output) ? usage.output : 0;
				const turnStart = turnStartMs ?? startMs ?? endMs;
				seededStatsByKey.set(key, {
					totalMs: Math.max(0, endMs - turnStart),
					generationMs: startMs !== null ? Math.max(0, endMs - startMs) : 0,
					costUsd: cost,
					outputTokens,
				});
			}
		}
		if (endMs !== null) previousEndMs = endMs;
	}
}

/** `12.4s`, switching to `1m 12.4s` once a turn passes a minute. */
export function formatResponseDuration(ms: number): string {
	// Round to the displayed precision first so the branch cannot disagree with
	// the printed value (`59.96s` must become `1m 0.0s`, not `60.0s`).
	const seconds = Math.round(ms / 100) / 10;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${(seconds - minutes * 60).toFixed(1)}s`;
}

/** Per-response costs are small: four decimals, trailing zeros trimmed, min two. */
export function formatResponseCost(usd: number): string {
	const fixed = usd.toFixed(4);
	const trimmed = fixed.replace(/(\.\d\d)0+$/, "$1");
	return `$${trimmed}`;
}

/** Output tokens per second over the generation window; null when not measurable. */
export function formatResponseTokensPerSecond(stats: ResponseStats): string | null {
	if (stats.outputTokens <= 0 || stats.generationMs < MIN_SPEED_SAMPLE_MS) return null;
	const rate = stats.outputTokens / (stats.generationMs / 1000);
	if (!Number.isFinite(rate) || rate <= 0) return null;
	const rounded = rate >= 100 ? Math.round(rate) : Math.round(rate * 10) / 10;
	return `${rounded} t/s`;
}
