import {
	getActiveThinkingStyleId,
	thinkingStyleFrameIntervalMs,
	thinkingStyleFrames,
	thinkingStyleText,
} from "./thinking-styles.js";

type WorkingLoaderState = "working" | "thinking" | "answering" | "running";

interface WorkingLoaderTheme {
	fg?(color: string, text: string): string;
}

interface WorkingLoaderUi {
	theme?: WorkingLoaderTheme;
	setWorkingMessage(message?: string): void;
	setWorkingIndicator(options?: { frames?: string[]; intervalMs?: number }): void;
}

export interface WorkingLoaderController {
	configure(): void;
	start(state?: WorkingLoaderState): void;
	setState(state: WorkingLoaderState): void;
	stop(): void;
	dispose(): void;
}

const WORKING_MESSAGE_INTERVAL_MS = 400;
/** `.trim()` copies the growing message text on every delta; this only tests for ink. */
const NON_WHITESPACE_PATTERN = /\S/u;

function hasNonWhitespace(text: string): boolean {
	return NON_WHITESPACE_PATTERN.test(text);
}

export function workingStateForAssistantMessage(message: unknown): WorkingLoaderState {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "thinking";
	let hasAnswerText = false;
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const part = item as { type?: unknown; text?: unknown };
		if (part.type === "toolCall") return "running";
		if (part.type === "text" && typeof part.text === "string" && hasNonWhitespace(part.text)) hasAnswerText = true;
	}
	return hasAnswerText ? "answering" : "thinking";
}

export function createWorkingLoaderController(ui: WorkingLoaderUi): WorkingLoaderController {
	let state: WorkingLoaderState = "working";
	let step = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	// The themed styles return the same verb for every timer tick, so skip the
	// redundant setWorkingMessage call (the spinner has its own animation).
	let lastRenderedMessage: string | undefined;

	const render = () => {
		const text = thinkingStyleText(getActiveThinkingStyleId(), state, step, ui.theme);
		if (text === lastRenderedMessage) return;
		lastRenderedMessage = text;
		ui.setWorkingMessage(text);
	};

	const clearTimer = () => {
		if (!timer) return;
		clearInterval(timer);
		timer = undefined;
	};

	// The indicator frames are recoloured per state (tools run orange) and the
	// label-driven styles need a faster text tick than the default.
	const applyIndicator = () => {
		ui.setWorkingIndicator({
			frames: thinkingStyleFrames(getActiveThinkingStyleId(), ui.theme, state),
			intervalMs: thinkingStyleFrameIntervalMs(getActiveThinkingStyleId(), state),
		});
	};

	const armTimer = () => {
		clearTimer();
		timer = setInterval(() => {
			step += 1;
			render();
		}, WORKING_MESSAGE_INTERVAL_MS);
		timer.unref?.();
	};

	const setState = (nextState: WorkingLoaderState) => {
		if (state === nextState) return;
		const styleId = getActiveThinkingStyleId();
		state = nextState;
		// Retain the themed verb phase, but refresh tint and speed for every
		// state transition. Pi's public setWorkingIndicator API restarts the
		// spinner; it exposes no phase-preserving update option.
		if (styleId === "default") step = 0;
		applyIndicator();
		render();
		if (timer) armTimer();
	};

	const start = (nextState: WorkingLoaderState = "working") => {
		clearTimer();
		state = nextState;
		step = 0;
		applyIndicator();
		render();
		armTimer();
	};

	const stop = () => {
		clearTimer();
		state = "working";
		step = 0;
	};

	return {
		configure() {
			applyIndicator();
			if (timer) armTimer();
			render();
		},
		start,
		setState,
		stop,
		dispose() {
			clearTimer();
		},
	};
}
