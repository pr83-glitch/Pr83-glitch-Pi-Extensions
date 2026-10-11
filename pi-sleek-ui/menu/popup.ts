/**
 * Reusable extension-manager style popup: search bar, optional filter line,
 * hint line, a scrollable list with a right-aligned value column, and an
 * inspector detail band.
 *
 * Mirrors `@vanillagreen/pi-extension-manager`'s manager UI so the `/sleek`
 * menus look and key like pi's `/extensions` browser. Rows are rebuilt on every
 * render (`rows()`), so a toggle is reflected immediately without reopening
 * the popup.
 *
 * Rows may carry a `value`, which is rendered as a right-aligned column in the
 * list pane (the `/sleek` menu uses it for each setting's current state/value).
 *
 * Keys: type to search, `backspace`/`ctrl+u`, `↑`/`↓` (wraps at both ends),
 * Page Up/Down and Home/End scroll without wrapping; fullscreen mouse wheel navigates.
 * `alt+<filter.key>` cycles a filter, `enter` activates, `esc`/`ctrl+c` closes.
 */
import { Input, matchesKey, truncateToWidth, visibleWidth, type KeyId, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

import {
	menuPad,
	menuSelectedLine,
	menuStateToken,
	menuWrapLine,
	type MenuTheme,
} from "./frame.js";

const PREFERRED_LIST_ROWS = 18;

export type MenuRowState = "on" | "off" | "info";

export interface MenuRow {
	id: string;
	/** Primary label shown in the left pane. */
	label: string;
	/** Muted trailing tag (appearance, scope, kind…). */
	meta?: string;
	/**
	 * Current state/value, rendered as a right-aligned column in the list pane.
	 * Only shown when at least one visible row has one.
	 */
	value?: string;
	state?: MenuRowState;
	/** Dimmed and non-activatable (e.g. a setting that does not apply to the current mode). */
	disabled?: boolean;
	/** Pre-styled marker replacing the default state token (e.g. a radio glyph). */
	marker?: string;
	/** Optional visual section label; section rows are inserted before matching settings. */
	section?: string;
	/** Text the search box matches; defaults to `label meta`. */
	search?: string;
}

export interface MenuFilter {
	id: string;
	label: string;
	/** Cycle key: `alt+<key>`. */
	key: string;
	values: readonly string[];
	matches: (row: MenuRow, value: string) => boolean;
}

/** Centre a block of rendered lines within `width`, using one shared left pad. */
function centerBlock(lines: string[], width: number): string[] {
	const trimmed = lines.map((line) => line.replace(/ +$/u, ""));
	const blockWidth = Math.max(0, ...trimmed.map((line) => visibleWidth(line)));
	const pad = Math.max(0, Math.floor((Math.max(1, width) - blockWidth) / 2));
	if (pad === 0) return trimmed;
	const prefix = " ".repeat(pad);
	return trimmed.map((line) => `${prefix}${line}`);
}

export interface MenuPopupOptions {
	/** Frame title, written into the top rule. */
	title: string;
	/** Inline-only: column header labels (defaults SETTING / STATUS / DESCRIPTION). */
	columnTitles?: { label?: string; status?: string; description?: string };
	/** Inline-only: search placeholder shown while the query is empty. */
	searchHint?: string;
	/**
	 * Optional always-on animation: `"pane"` renders a right-hand preview pane
	 * (Pi logo picker); `"sample"` animates the selected row's sample cell
	 * instead (Thinking style picker).
	 */
	preview?: {
		mode?: "pane" | "sample";
		framesFor(row: MenuRow | undefined, theme: MenuTheme): { frames: string[][]; intervalMs: number } | undefined;
	};
	/** Rows, rebuilt on every render so live values update in place. */
	rows: () => MenuRow[];
	filters?: MenuFilter[];
	primaryHint: string;
	onActivate: (row: MenuRow, popup: MenuPopup) => void;
	/** Optional quick toggle bound to the space key for checkbox-style rows. */
	onToggle?: (row: MenuRow, popup: MenuPopup) => void;
	onSelectionChange?: (row: MenuRow | undefined, popup: MenuPopup) => void;
	onClose: () => void;
	onDispose?: () => void;
	/** Row selected when the popup opens (defaults to the first row). */
	initialId?: string;
	terminalRows: () => number;
	requestRender: () => void;
}

export class MenuPopup {
	private readonly searchInput = new Input();
	private get search(): string { return this.searchInput.getValue(); }
	private disposed = false;
	private selected = 0;
	private scroll = 0;
	private viewportRows = 1;
	private readonly filterValues: Record<string, string> = {};
	// Always-on split preview state (used by the Pi logo animation picker).
	private previewFrames: string[][] | undefined;
	private previewIndex = 0;
	private previewTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly theme: MenuTheme,
		private readonly options: MenuPopupOptions,
	) {
		for (const filter of options.filters ?? []) {
			this.filterValues[filter.id] = filter.values[0] ?? "all";
		}
		if (options.initialId !== undefined) {
			const index = options.rows().findIndex((row) => row.id === options.initialId);
			if (index >= 0) this.selected = index;
		}
		if (options.preview) this.syncPreview();
	}

	/** Repaint in place (used after an activation changed the underlying data). */
	refresh(): void {
		if (this.disposed) return;
		this.options.requestRender();
	}

	/** Clear the preview timer; pi calls this when the overlay closes. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.options.onDispose?.();
		if (this.previewTimer) {
			clearInterval(this.previewTimer);
			this.previewTimer = undefined;
		}
	}

	/** (Re)build the always-on split preview for the current selection. */
	private syncPreview(): void {
		if (!this.options.preview) return;
		const built = this.options.preview.framesFor(this.filteredRows()[this.selected], this.theme);
		this.previewFrames = built?.frames;
		this.previewIndex = 0;
		if (this.previewTimer) {
			clearInterval(this.previewTimer);
			this.previewTimer = undefined;
		}
		if (built && built.frames.length > 1) {
			const timer = setInterval(() => {
				this.previewIndex = (this.previewIndex + 1) % built.frames.length;
				this.options.requestRender();
			}, Math.max(16, built.intervalMs));
			timer.unref?.();
			this.previewTimer = timer;
		}
	}

	private currentPreviewLines(): string[] | undefined {
		if (!this.previewFrames || this.previewFrames.length === 0) return undefined;
		return this.previewFrames[this.previewIndex % this.previewFrames.length];
	}

	private filteredRows(): MenuRow[] {
		const rows = this.options.rows();
		const query = this.search.trim().toLowerCase();
		return rows.filter((row) => {
			if (query !== "") {
				const haystack = (row.search ?? `${row.label} ${row.meta ?? ""}`).toLowerCase();
				if (!haystack.includes(query)) return false;
			}
			for (const filter of this.options.filters ?? []) {
				const value = this.filterValues[filter.id] ?? filter.values[0] ?? "all";
				if (!filter.matches(row, value)) return false;
			}
			return true;
		});
	}

	private syncSelection(rowCount: number): void {
		this.selected = Math.max(0, Math.min(this.selected, Math.max(0, rowCount - 1)));
	}

	private buildListRows(rows: MenuRow[]): Array<{ row: MenuRow; index: number } | { section: string }> {
		const visible: Array<{ row: MenuRow; index: number } | { section: string }> = [];
		let currentSection: string | undefined;
		for (let index = 0; index < rows.length; index++) {
			const row = rows[index]!;
			const needsSection = row.section !== undefined && row.section !== currentSection;
			if (needsSection) {
				visible.push({ section: row.section! });
				currentSection = row.section;
			}
			visible.push({ row, index });
		}
		return visible;
	}

	private sectionHeader(theme: MenuTheme, label: string, width: number): string {
		const prefix = `── ${label.toUpperCase()} `;
		const line = `${prefix}${"─".repeat(Math.max(0, width - visibleWidth(prefix)))}`;
		return theme.fg("dim", truncateToWidth(line, width, ""));
	}

	private notifySelectionChange(): void {
		this.options.onSelectionChange?.(this.filteredRows()[this.selected], this);
	}

	private renderFilterLine(theme: MenuTheme): string {
		const filters = this.options.filters ?? [];
		if (filters.length === 0) return "";
		const parts = filters.map((filter) => {
			const value = this.filterValues[filter.id] ?? filter.values[0] ?? "all";
			const shown = value === "all"
				? theme.fg("dim", value)
				: theme.fg("accent", value);
			return `${theme.fg("muted", `${filter.label}:`)} ${shown}`;
		});
		const keys = filters
			.map((filter) => `${theme.fg("warning", `alt+${filter.key}`)} ${theme.fg("dim", filter.label)}`)
			.join(theme.fg("dim", " · "));
		return `${theme.fg("muted", "filters:")} ${parts.join("  ")}   ${keys}`;
	}

	/**
	 * Single-table layout: one line per row (`SETTING │ STATUS │ DESCRIPTION`,
	 * separators are plain gaps) with the selected row filled.
	 */
	render(width: number): string[] {
		const theme = this.theme;
		const safeWidth = Math.max(1, width);
		const innerWidth = Math.max(1, safeWidth - 2);
		const bodyWidth = Math.max(1, innerWidth - 2);
		const allRows = this.options.rows();
		const rows = this.filteredRows();
		const border = (text: string): string => theme.fg("accent", text);

		const titles = {
			label: this.options.columnTitles?.label ?? "SETTING",
			status: this.options.columnTitles?.status ?? "STATUS",
			description: this.options.columnTitles?.description ?? "DESCRIPTION",
		};
		const hasStatus = allRows.some((row) => (row.value ?? "").length > 0);
		const hasDescription = allRows.some((row) => (row.meta ?? "").length > 0);

		// Always-on animation: a right preview pane (Pi logo) or the selected row's
		// sample cell (Thinking style). Only the pane needs the horizontal split.
		const sampleMode = this.options.preview?.mode === "sample";
		const frameLines = this.options.preview && !sampleMode ? this.currentPreviewLines() : undefined;
		const split = Boolean(this.options.preview) && !sampleMode && bodyWidth >= 62;
		const previewW = split ? Math.max(20, Math.min(42, Math.floor(bodyWidth * 0.4))) : 0;
		const paneW = split ? Math.max(16, bodyWidth - previewW - 3) : bodyWidth;

		const hints = menuWrapLine(this.options.primaryHint, bodyWidth);
		const filterLines = (this.options.filters ?? []).length > 0
			? menuWrapLine(this.renderFilterLine(theme), bodyWidth)
			: [];
		const terminalRows = Math.max(1, Math.floor(this.options.terminalRows() * 0.85));
		// top border, title, filter line, rule, header, rule, bottom border, hints
		const fixedRows = 6 + hints.length + filterLines.length;
		this.syncSelection(rows.length);
		const list = this.buildListRows(rows);
		const availableListRows = Math.max(1, Math.min(PREFERRED_LIST_ROWS, terminalRows - fixedRows));
		// Reserve an indicator row only for overflowing lists, without taking the last item row.
		const indicatorRow = list.length > availableListRows && availableListRows > 1;
		const listRows = Math.max(1, availableListRows - (indicatorRow ? 1 : 0));
		this.viewportRows = listRows;
		const selectedLine = list.findIndex((entry) => "row" in entry && entry.index === this.selected);
		if (selectedLine < this.scroll) this.scroll = Math.max(0, selectedLine);
		if (selectedLine >= this.scroll + listRows) this.scroll = selectedLine - listRows + 1;
		this.scroll = Math.max(0, Math.min(this.scroll, list.length - listRows));
		const visibleRows = list.slice(this.scroll, this.scroll + listRows);
		const overflowing = list.length > listRows;
		const listW = Math.max(1, paneW - (overflowing ? 2 : 0));

		// --- left pane: the option list ---
		const gap = "  ";
		const desiredStatusW = Math.max(titles.status.length, ...allRows.map((row) => visibleWidth(row.value ?? "")));
		const descriptionReserve = hasDescription ? gap.length + 8 : 0;
		const labelW = Math.max(1, Math.min(28,
			Math.max(titles.label.length, ...allRows.map((row) => (row.marker ? 3 : 2) + visibleWidth(row.label))),
			listW - descriptionReserve - (hasStatus ? gap.length + Math.min(8, desiredStatusW) : 0),
		));
		const statusW = Math.max(0, Math.min(desiredStatusW, listW - labelW - gap.length - descriptionReserve));
		const usedWidth = labelW + (hasStatus ? gap.length + statusW : 0);
		const descriptionW = Math.max(0, listW - usedWidth - (hasDescription ? gap.length : 0));

		const left: string[] = [];
		const header = [theme.fg("muted", menuPad(titles.label, labelW))];
		if (hasStatus) header.push(theme.fg("muted", menuPad(titles.status, statusW)));
		if (hasDescription) header.push(theme.fg("muted", titles.description));
		left.push(header.join(gap));
		if (rows.length === 0) {
			left.push(theme.fg("dim", "No matching items."));
		} else {
			for (const entry of visibleRows) {
				if ("section" in entry) {
					left.push(this.sectionHeader(theme, entry.section, listW));
					continue;
				}
				const { row, index } = entry;
				const isSelected = index === this.selected;
				const marker = row.marker ?? menuStateToken(theme, row.state);
				const name = row.disabled
					? theme.fg("dim", row.label)
					: isSelected
						? theme.fg("text", row.label)
						: theme.fg("muted", row.label);
				// Picker rows carry a wide radio glyph, so give it an extra gap.
				const setting = row.marker ? `${marker}  ${name}` : `${marker} ${name}`;
				const cells = [menuPad(setting, labelW)];
				if (hasStatus) cells.push(theme.fg(row.disabled ? "dim" : isSelected ? "text" : "accent", menuPad(row.value ?? "", statusW)));
				if (hasDescription) {
					const sample = isSelected && sampleMode
						? this.currentPreviewLines()?.[0] ?? row.meta ?? ""
						: row.meta ?? "";
					cells.push(theme.fg(isSelected ? "text" : "dim", truncateToWidth(sample, descriptionW, "…")));
				}
				const line = cells.join(gap);
				left.push(isSelected ? menuSelectedLine(theme, line, listW) : line);
			}
		}
		if (overflowing) {
			const thumbHeight = Math.max(1, Math.floor(listRows * listRows / list.length));
			const thumbTop = Math.round(this.scroll / (list.length - listRows) * (listRows - thumbHeight));
			for (let i = 1; i < left.length; i++) {
				const thumb = i - 1 >= thumbTop && i - 1 < thumbTop + thumbHeight;
				left[i] = `${menuPad(left[i]!, listW)} ${theme.fg(thumb ? "accent" : "borderMuted", thumb ? "┃" : "│")}`;
			}
		}

		// --- right pane: the animated preview ---
		const right: string[] = [];
		if (split) {
			right.push(theme.fg("muted", "PREVIEW"));
			right.push("");
			if (frameLines) {
				right.push(...centerBlock(frameLines.map((line) => truncateToWidth(line, previewW, "…")), previewW));
			} else {
				right.push(theme.fg("dim", "no preview"));
			}
		}

		const body: string[] = [];
		// Title + search hint.
		const title = theme.bold(theme.fg("accent", this.options.title));
		const searchHint = this.options.searchHint ?? "Type to filter…";
		const search = this.search.length > 0 ? `⌕ ${this.search}` : `⌕ ${searchHint}`;
		const searchStyled = theme.fg(this.search.length > 0 ? "text" : "dim", search);
		const titleGap = Math.max(1, bodyWidth - visibleWidth(title) - visibleWidth(searchStyled));
		body.push(`${title}${" ".repeat(titleGap)}${searchStyled}`);
		body.push(...filterLines);
		body.push(theme.fg("dim", "─".repeat(bodyWidth)));

		if (split) {
			const height = Math.max(left.length, right.length);
			for (let i = 0; i < height; i += 1) {
				if (i > listRows) break;
				body.push(`${menuPad(left[i] ?? "", paneW)} ${theme.fg("dim", "│")} ${menuPad(right[i] ?? "", previewW)}`);
			}
		} else {
			body.push(...left);
		}

		if (indicatorRow) {
			const remaining = list.slice(this.scroll + listRows).filter((entry) => "row" in entry).length;
			// U+EA9A: Nerd Font downward indicator, written as an escape for readable diffs.
			const label = truncateToWidth(` \u{EA9A} ${remaining} more ${remaining === 1 ? "item" : "items"} `, bodyWidth, "…");
			const padding = " ".repeat(Math.max(0, Math.floor((bodyWidth - visibleWidth(label)) / 2)));
			body.push(remaining > 0 ? `${padding}${theme.bg("toolSuccessBg", theme.fg("dim", label))}` : "");
		}
		body.push(theme.fg("dim", "─".repeat(bodyWidth)));
		for (const line of hints) body.push(line);

		const out: string[] = [border(`┌${"─".repeat(innerWidth)}┐`)];
		for (const line of body.slice(0, Math.max(0, terminalRows - 2))) {
			out.push(`${border("│")} ${menuPad(line, bodyWidth)} ${border("│")}`);
		}
		out.push(border(`└${"─".repeat(innerWidth)}┘`));
		return out.slice(0, terminalRows).map((line) => truncateToWidth(line, safeWidth, ""));
	}

	invalidate(): void {
		// Nothing cached: every render rebuilds rows and panes.
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" || !event.wheelDelta) return undefined;
		this.moveSelection(event.wheelDelta);
		return { handled: true, render: true };
	}

	private moveSelection(delta: number): void {
		this.selected = Math.max(0, Math.min(this.selected + delta, this.filteredRows().length - 1));
		if (this.options.preview) this.syncPreview();
		this.notifySelectionChange();
		this.options.requestRender();
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.dispose();
			this.options.onClose();
			return;
		}
		for (const filter of this.options.filters ?? []) {
			if (!matchesKey(data, `alt+${filter.key}` as KeyId)) continue;
			const current = this.filterValues[filter.id] ?? filter.values[0] ?? "";
			const index = Math.max(0, filter.values.indexOf(current));
			this.filterValues[filter.id] = filter.values[(index + 1) % Math.max(1, filter.values.length)] ?? current;
			this.selected = 0;
			this.scroll = 0;
			if (this.options.preview) this.syncPreview();
			this.notifySelectionChange();
			this.options.requestRender();
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "down")) {
			// Wrap around: Down on the last row jumps to the first, Up on the first
			// jumps to the last, so a short list never needs a trip back through it.
			const rowCount = this.filteredRows().length;
			if (rowCount > 0) {
				const delta = matchesKey(data, "up") ? -1 : 1;
				this.selected = (this.selected + delta + rowCount) % rowCount;
			}
		} else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
			this.moveSelection((matchesKey(data, "pageUp") ? -1 : 1) * this.viewportRows);
			return;
		} else if (matchesKey(data, "home") || matchesKey(data, "end")) {
			this.moveSelection(matchesKey(data, "home") ? -this.selected : this.filteredRows().length);
			return;
		} else if (data === " " && this.options.onToggle) {
			const row = this.filteredRows()[this.selected];
			if (row && !row.disabled) this.options.onToggle(row, this);
			return;
		} else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			const row = this.filteredRows()[this.selected];
			if (row && !row.disabled) this.options.onActivate(row, this);
			return;
		} else {
			const before = this.search;
			if (matchesKey(data, "ctrl+u")) this.searchInput.setValue("");
			else this.searchInput.handleInput(data);
			if (this.search === before) return;
			this.selected = 0;
			this.scroll = 0;
		}
		if (this.options.preview) this.syncPreview();
		this.notifySelectionChange();
		this.options.requestRender();
	}
}
