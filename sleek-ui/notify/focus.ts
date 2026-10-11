/**
 * Terminal focus tracking for the notification alert.
 *
 * Supporting terminals report focus changes after DECSET 1004; the sequences
 * are `CSI I` (focus in) and `CSI O` (focus out). In fullscreen mode pi-tui
 * already enables reporting, but its own viewport listener consumes the
 * sequences before any extension input listener sees them, so we observe them
 * at the TUI's input entry point (`handleTerminalInput`) instead. In regular
 * mode no listener consumes them, so the wrapper strips them out of the stream
 * to keep them out of the editor.
 *
 * Reload safety: the TUI handed to extensions is a stable Proxy that survives
 * `/reload`, so the wrapper is rebuilt from the base method on every bind and
 * unwound from `session_shutdown` (model: `performance/render-frame-background.ts`).
 */
import { clearTuiMethodWrapper, getOriginalTuiMethod, rememberTuiMethodWrapper } from "../performance/tui-proxy-original.js";

const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";
const PATCHED = Symbol.for("pi-sleek.focus.patched");

type InputHandler = (data: string) => unknown;

interface FocusPatch {
	base: InputHandler;
	wrapper: InputHandler;
}

interface FocusTui {
	handleTerminalInput?: InputHandler;
	handleViewportInput?: unknown;
	terminal?: { write?: (data: string) => unknown };
	[PATCHED]?: FocusPatch;
}

/** Assume focused until the terminal says otherwise, so short turns stay quiet. */
let focused = true;

const focusListeners = new Set<(focused: boolean) => void>();

/**
 * Observe focus changes (used to re-read the terminal palette when a theme was
 * switched while the terminal was in the background). Returns an unsubscribe.
 */
export function onTerminalFocusChange(listener: (focused: boolean) => void): () => void {
	focusListeners.add(listener);
	return () => focusListeners.delete(listener);
}

function setFocused(next: boolean): void {
	if (next === focused) return;
	focused = next;
	for (const listener of focusListeners) {
		try {
			listener(next);
		} catch {
			// A listener must never break the input path.
		}
	}
}

let installed: { tui: FocusTui; base: InputHandler; wrapper: InputHandler; ownFocusReporting: boolean } | undefined;

/** True when the terminal has not reported losing focus (or cannot report it). */
export function isTerminalFocused(): boolean {
	return focused;
}

/** Observe (fullscreen) or own (regular mode) DECSET 1004 focus reporting. */
export function installFocusTracking(tui: unknown): void {
	const target = tui as FocusTui | undefined;
	if (!target || typeof target.handleTerminalInput !== "function") return;

	// Rebuild from scratch on every bind so a `/reload` never nests wrappers.
	uninstallFocusTracking();

	// Fullscreen pi-tui owns the focus sequences (and uses them to drop a
	// selection on blur), so leave them in the stream and only record them.
	const altScreen = typeof target.handleViewportInput === "function";

	const existing = target[PATCHED];
	const base: InputHandler =
		existing && typeof existing.base === "function"
			? existing.base
			: (getOriginalTuiMethod(target, "handleTerminalInput") as InputHandler);

	const wrapper: InputHandler = function (this: unknown, data: string): unknown {
		if (typeof data === "string" && (data.includes(FOCUS_IN) || data.includes(FOCUS_OUT))) {
			for (const match of data.matchAll(/\x1b\[(I|O)/g)) setFocused(match[1] === "I");
			if (!altScreen) {
				const stripped = data.split(FOCUS_IN).join("").split(FOCUS_OUT).join("");
				if (stripped.length === 0) return undefined;
				return base.call(this, stripped);
			}
		}
		return base.call(this, data);
	};

	const patch: FocusPatch = { base, wrapper };
	target[PATCHED] = patch;
	target.handleTerminalInput = wrapper;
	rememberTuiMethodWrapper(target, "handleTerminalInput", wrapper);

	// pi-tui only enables focus reporting in fullscreen; enable it ourselves in
	// regular mode (writing it in fullscreen is an idempotent no-op).
	try {
		target.terminal?.write?.(ENABLE_FOCUS_REPORTING);
	} catch {
		// Best effort: a write failure must not break the editor factory.
	}

	installed = { tui: target, base, wrapper, ownFocusReporting: !altScreen };
}

/** Restore the base input handler; called from `session_shutdown`. */
export function uninstallFocusTracking(): void {
	const state = installed;
	if (!state) return;
	installed = undefined;
	try {
		// Another extension may have wrapped the same method after us. Never
		// restore over that wrapper or erase its chain entry.
		if (state.ownFocusReporting) state.tui.terminal?.write?.(DISABLE_FOCUS_REPORTING);
		if (state.tui.handleTerminalInput === state.wrapper) {
			state.tui.handleTerminalInput = state.base;
			state.tui[PATCHED] = undefined;
			clearTuiMethodWrapper(state.tui, "handleTerminalInput", state.wrapper);
		}
	} catch {
		// Best effort: shutdown must never throw.
	}
	focused = true;
}
