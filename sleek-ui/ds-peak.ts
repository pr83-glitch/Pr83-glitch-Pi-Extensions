/**
 * DeepSeek peak / off-peak pricing windows (UTC).
 *
 * DeepSeek changes this scheme from time to time, so the schedule lives in one
 * small table here. Current V4-era schedule (community-sourced — re-verify at
 * https://api-docs.deepseek.com/quick_start/pricing when it changes):
 *
 *   Peak      Mon–Fri 01:00–04:00 and 06:00–10:00 UTC
 *   Off-peak  everything else, including all weekend
 *
 * All comparisons are done in UTC wall-clock time, so the result matches the
 * user's local moment without any timezone database or DST handling.
 */

type DsPeakState = "peak" | "offpeak";

type DsPeakInfo = {
	state: DsPeakState;
	/** Milliseconds until the next peak↔off-peak switch. */
	nextTransitionMs: number;
};

/** Peak windows as [startMinutes, endMinutes) in UTC minutes-of-day. */
const PEAK_WINDOWS_UTC: ReadonlyArray<{ startMinutes: number; endMinutes: number }> = [
	{ startMinutes: 1 * 60, endMinutes: 4 * 60 },
	{ startMinutes: 6 * 60, endMinutes: 10 * 60 },
];

/** Times (UTC minutes-of-day) at which the state can possibly change. */
const CANDIDATE_BOUNDARY_MINUTES = [0, ...PEAK_WINDOWS_UTC.flatMap((window) => [window.startMinutes, window.endMinutes])];
const LOOKAHEAD_DAYS = 8;
const DAY_MS = 86_400_000;

function isWeekdayUtc(date: Date): boolean {
	const day = date.getUTCDay();
	return day >= 1 && day <= 5;
}

function minutesOfDayUtc(date: Date): number {
	return date.getUTCHours() * 60 + date.getUTCMinutes();
}

/** Whether `now` falls inside a DeepSeek peak window. */
function getDsPeakState(now: Date = new Date()): DsPeakState {
	if (!isWeekdayUtc(now)) return "offpeak";
	const minutes = minutesOfDayUtc(now);
	for (const window of PEAK_WINDOWS_UTC) {
		if (minutes >= window.startMinutes && minutes < window.endMinutes) return "peak";
	}
	return "offpeak";
}

/** Milliseconds until the next state change (bounded by the 8-day lookahead). */
function getNextDsPeakTransitionMs(now: Date = new Date()): number {
	const current = getDsPeakState(now);
	const nowMs = now.getTime();
	const midnightUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

	for (let dayOffset = 0; dayOffset <= LOOKAHEAD_DAYS; dayOffset++) {
		for (const minutes of CANDIDATE_BOUNDARY_MINUTES) {
			const candidateMs = midnightUtc + dayOffset * DAY_MS + minutes * 60_000;
			if (candidateMs <= nowMs) continue;
			if (getDsPeakState(new Date(candidateMs)) !== current) {
				return candidateMs - nowMs;
			}
		}
	}
	return LOOKAHEAD_DAYS * DAY_MS;
}

// The state and the countdown only change on minute boundaries, so memoize per
// minute: callers can hit this from every render without recomputing.
let cachedMinute = -1;
let cachedInfo: DsPeakInfo | null = null;

export function getDsPeakInfo(now: Date = new Date()): DsPeakInfo {
	const minute = Math.floor(now.getTime() / 60_000);
	if (cachedInfo && cachedMinute === minute) return cachedInfo;
	const info: DsPeakInfo = {
		state: getDsPeakState(now),
		nextTransitionMs: getNextDsPeakTransitionMs(now),
	};
	cachedMinute = minute;
	cachedInfo = info;
	return info;
}

/** Compact countdown: `47m`, `1h 12m`, `2h`. */
export function formatDsPeakCountdown(ms: number): string {
	const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
	if (totalMinutes < 60) return `${totalMinutes}m`;
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}
