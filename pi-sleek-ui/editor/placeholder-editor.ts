/**
 * Input-box placeholder.
 *
 * pi's editor has no placeholder: an empty input renders as a bare cursor line.
 * `PlaceholderEditor` extends pi's `CustomEditor` and, only while the buffer is
 * empty AND `enabled()` is true, paints a muted hint in place of the empty
 * content line. The hint is visual only — it is never written into the editor
 * buffer, so pressing Enter on an empty box does nothing.
 */
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

interface PlaceholderEditorOptions {
	/** Returns the already-styled placeholder text (e.g. `theme.fg("muted", …)`). */
	placeholder: () => string;
	/** True while the placeholder is eligible (e.g. the session has no messages yet). */
	enabled: () => boolean;
}

export class PlaceholderEditor extends CustomEditor {
	private readonly placeholderText: () => string;
	private readonly placeholderEnabled: () => boolean;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		options: PlaceholderEditorOptions,
	) {
		// `embedWorkingStatus` keeps the working/thinking indicator in the top
		// border, exactly like pi's default editor does.
		super(tui, theme, keybindings, { embedWorkingStatus: true });
		this.placeholderText = options.placeholder;
		this.placeholderEnabled = options.enabled;
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (!this.placeholderEnabled() || this.getText().length > 0) return lines;
		const text = this.placeholderText();
		// Empty input renders exactly three lines: top border, one content line,
		// bottom border (no autocomplete list is shown while the buffer is empty).
		if (text.length === 0 || lines.length < 3) return lines;
		const paddingX = Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)));
		const contentWidth = Math.max(1, width - paddingX * 2);
		const left = " ".repeat(paddingX);
		const shown = truncateToWidth(text, Math.max(0, contentWidth - 1), "…");
		const right = " ".repeat(Math.max(0, contentWidth - 1 - visibleWidth(shown)));
		// Keep both the IME hardware-cursor marker and the visual block cursor.
		const cursor = lines[1]?.includes(CURSOR_MARKER) ? CURSOR_MARKER : "";
		lines[1] = `${left}${cursor}\x1b[7m \x1b[27m${shown}${right}${left}`;
		// The cursor occupies one cell; pad the final row to the effective width.
		lines[1] = truncateToWidth(lines[1], width, "");
		return lines;
	}
}
