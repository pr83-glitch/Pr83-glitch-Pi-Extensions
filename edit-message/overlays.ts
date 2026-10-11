/**
 * Floating overlay UI for edit-message.
 *
 * Two boxed, mouse-aware popups rendered as pi overlays (the same technique the
 * pi-zazz `/zazz` menu uses):
 *
 * - `showMessageSelector` — pick a previous user message.
 * - `showActionMenu`      — pick what to do with it (edit / copy / summarize+fork).
 *
 * Notes that matter:
 * - `overlay: true` + `overlayOptions` keeps the popup floating over the chat
 *   instead of pushing the transcript around.
 * - `SelectList` already implements `handleMouse` (left press/click + wheel), so
 *   rows are mouse-selectable for free — but the TUI dispatches mouse events with
 *   coordinates local to OUR returned component, so we translate y by the one
 *   border line above the list before forwarding.
 * - SelectList wraps the whole selected row in `theme.selectedText`, so padding
 *   the text to the inner width there paints the full row background.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, SelectList, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type SelectItem, type TuiMouseEventResult } from "@earendil-works/pi-tui";

/** Actions the user can run on the selected message. */
export type Action = "edit" | "copy" | "summarize-fork";

/** One selectable previous user message. */
export interface PickerItem {
  id: string;
  text: string;
}

/** Which message was picked and what the user wants to do with it. */
export interface PickerResult {
  id: string;
  /** `"menu"` means "open the action popup for this message". */
  action: Action | "menu";
}

const HORIZONTAL = "━";
const OVERLAY_MIN_WIDTH = 72;
const OVERLAY_MAX_WIDTH = 120;
const OVERLAY_ROW_PADDING = 10; // heavy frame + zazz-style horizontal padding
const OVERLAY_LABEL_CAP = 64; // a long message must not inflate the popup
const MENU_PADDING_X = 2;

function innerWidth(width: number): number {
  return Math.max(1, width - 2 - MENU_PADDING_X * 2);
}

function border(theme: Theme, left: string, right: string, width: number): string {
  const fill = Math.max(0, width - 2);
  return theme.fg("accent", `${left}${HORIZONTAL.repeat(fill)}${right}`);
}

/** Top border with an inline label tab: `┏ label ━━━━┓`. */
function borderWithLabel(theme: Theme, label: string, width: number): string {
  const labelWidth = visibleWidth(label);
  if (labelWidth + 3 > width - 2) return border(theme, "┏", "┓", width);
  const dashes = HORIZONTAL.repeat(Math.max(1, width - 2 - labelWidth - 2));
  return `${theme.fg("accent", "┏ ")}${theme.fg("success", theme.bold(label))}${theme.fg("accent", ` ${dashes}┓`)}`;
}

/** One content line inside the box, padded to the full inner width. */
function boxedLine(theme: Theme, content: string, width: number): string {
  const contentWidth = innerWidth(width);
  const truncated = truncateToWidth(content, contentWidth, "…");
  const fill = " ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)));
  const pad = " ".repeat(MENU_PADDING_X);
  const edge = theme.fg("accent", "┃");
  return `${edge}${pad}${truncated}${fill}${pad}${edge}`;
}

/** Wrap a raw row in a background that spans the whole row. */
function highlightRow(theme: Theme, text: string, width: number): string {
  const fill = " ".repeat(Math.max(0, width - visibleWidth(text)));
  return theme.bg("selectedBg", text + fill);
}

/** Single-line preview of a message: collapse whitespace, trim, cap the length. */
function previewText(text: string, max = 200): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return truncateToWidth(normalized, max, "…");
}

/** Width the popup asks the overlay for: fits the rows, the title and the hint. */
function overlayWidth(items: SelectItem[], title: string, hint: string): number {
  const labelWidth = Math.min(
    items.reduce((max, item) => Math.max(max, visibleWidth(item.label)), 0),
    OVERLAY_LABEL_CAP,
  );
  const descWidth = items.reduce(
    (max, item) => Math.max(max, item.description ? visibleWidth(item.description) : 0),
    0,
  );
  const rowWidth = labelWidth + (descWidth > 0 ? descWidth + 6 : 0);
  const widest = Math.max(rowWidth, visibleWidth(title) + 4, visibleWidth(hint));
  return Math.min(OVERLAY_MAX_WIDTH, Math.max(OVERLAY_MIN_WIDTH, widest + OVERLAY_ROW_PADDING));
}

interface FloatingListOptions<T> {
  /** Label shown in the top border. */
  title: string;
  items: SelectItem[];
  /** Dim hint line rendered below the rows inside the box. */
  hint: string;
  /** Max rows visible before the list scrolls. */
  maxVisible: number;
  /** Index selected when the popup opens (defaults to the last row). */
  initialIndex?: number;
  /** Mapped from the chosen row; `undefined` cancels. */
  onSelect: (item: SelectItem) => T;
  /** Direct keys on the selected row. Return `undefined` to let the list handle the key. */
  onHotkey?: (data: string, item: SelectItem | undefined) => T | undefined;
}

/** Shared boxed `SelectList` overlay. Resolves to `undefined` on cancel. */
function showFloatingList<T>(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  options: FloatingListOptions<T>,
): Promise<T | undefined> {
  pi.events.emit("pi-extension:prompt", { source: "edit-message" });
  const width = overlayWidth(options.items, options.title, options.hint);
  // Reserve room for the description column on the right of the label column:
  // SelectList drops descriptions entirely when fewer than ~11 columns remain.
  const primaryMax = Math.max(20, Math.min(72, innerWidth(width) - 15));
  // Refreshed every render: the overlay may clamp our requested width.
  const state = { rowWidth: 0 };

  return ctx.ui.custom<T | undefined>((tui, theme, _kb, done) => {
    const listTheme = {
      selectedPrefix: (text: string) => text, // Required by host type; current SelectList styles the complete row.
      selectedText: (text: string) => highlightRow(theme, text, state.rowWidth),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("muted", text),
      noMatch: (text: string) => theme.fg("muted", text),
    };
    const layout = {
      minPrimaryColumnWidth: 20,
      maxPrimaryColumnWidth: primaryMax,
      // SelectList's default truncation drops the tail silently; keep an ellipsis
      // so a clipped message preview is obvious.
      truncatePrimary: ({ text, maxWidth }: { text: string; maxWidth: number }) => truncateToWidth(text, maxWidth, "…"),
    };
    let list = new SelectList(options.items, options.maxVisible, listTheme, layout);
    list.setSelectedIndex(options.initialIndex ?? Math.max(0, options.items.length - 1));
    const wire = () => {
      list.onSelect = (item: SelectItem) => done(options.onSelect(item));
      list.onCancel = () => done(undefined);
    };
    wire();
    let capacity = options.maxVisible;
    let primaryWidth = primaryMax;
    let renderedRows = options.items.length;
    let renderedWidth = width;
    let rowStart = 2;
    let rowInset = 1 + MENU_PADDING_X;

    const selectedItem = (): SelectItem | undefined => list.getSelectedItem() ?? undefined;

    const title = `${theme.fg("accent", theme.bold(options.title))} `;

    return {
      render: (renderWidth: number): string[] => {
        state.rowWidth = innerWidth(renderWidth);
        renderedWidth = renderWidth;
        // Rebuild with a public constructor rather than mutating private maxVisible.
        // Keep selection through resize, and reserve scroll info plus frame/hints.
        const height = Math.max(1, Math.floor(tui.terminal.rows * 0.85));
        let hintLines = wrapTextWithAnsi(options.hint, state.rowWidth);
        if (hintLines.length + 6 > height) hintLines = [truncateToWidth("↑/↓ · ↵ · esc", state.rowWidth, "")];
        const compact = height < 7;
        rowStart = compact ? 0 : 2;
        rowInset = compact ? 0 : 1 + MENU_PADDING_X;
        const visible = Math.max(1, Math.min(options.maxVisible, height - (compact ? 2 : hintLines.length + 5)));
        const nextPrimaryWidth = Math.max(1, Math.min(72, state.rowWidth - 15));
        if (visible !== capacity || nextPrimaryWidth !== primaryWidth) {
          const selected = list.getSelectedItem()?.value;
          list = new SelectList(options.items, visible, listTheme, {
            ...layout, maxPrimaryColumnWidth: nextPrimaryWidth,
          });
          list.setSelectedIndex(Math.max(0, options.items.findIndex((item) => item.value === selected)));
          capacity = visible;
          primaryWidth = nextPrimaryWidth;
          wire();
        }
        renderedRows = Math.min(visible, options.items.length);
        const rows = list.render(state.rowWidth);
        hintLines = hintLines.map((line) => theme.fg("dim", line));
        if (compact) {
          // Very short terminals cannot fit chrome + hints. Keep the selected
          // row and keyboard path visible instead of letting overlay clipping hide it.
          return [...rows, ...hintLines.slice(0, Math.max(0, height - rows.length))]
            .slice(0, height).map((line) => truncateToWidth(line, renderWidth, ""));
        }
        const blank = boxedLine(theme, "", renderWidth);
        return [
          borderWithLabel(theme, title, renderWidth),
          blank,
          ...rows.map((row) => boxedLine(theme, row, renderWidth)),
          blank,
          ...hintLines.map((line) => boxedLine(theme, line, renderWidth)),
          border(theme, "┗", "┛", renderWidth),
        ].map((line) => truncateToWidth(line, renderWidth, ""));
      },
      handleInput: (data: string): void => {
        const hotkey = options.onHotkey?.(data, selectedItem());
        if (hotkey !== undefined) {
          done(hotkey);
          return;
        }
        list.handleInput(data);
        tui.requestRender();
      },
      // Mouse coordinates are local to this component: line 0 is the top
      // border and line 1 the blank padding row, so the list starts at line 2.
      // SelectList bounds-checks the resulting index.
      handleMouse: (event): TuiMouseEventResult | undefined => {
        if (event.x < rowInset || event.x >= renderedWidth - rowInset || event.y < rowStart || event.y >= rowStart + renderedRows) return undefined;
        return list.handleMouse?.({ ...event, x: event.x - rowInset, y: event.y - rowStart });
      },
      invalidate: (): void => list.invalidate(),
    } satisfies Component;
  }, { overlay: true, overlayOptions: { width, maxHeight: "85%" } });
}

/**
 * Pick a previous user message. Hotkeys act directly (`e`/`c`/`ctrl+f`);
 * Enter (or a click) opens the action popup for the selected message.
 */
export function showMessageSelector(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  items: PickerItem[],
): Promise<PickerResult | undefined> {
  const rows: SelectItem[] = items.map((item, index) => ({
    value: item.id,
    label: previewText(item.text),
    description: `${index + 1}/${items.length}`,
  }));

  return showFloatingList<PickerResult>(pi, ctx, {
    title: "Select a previous user message",
    items: rows,
    maxVisible: 12,
    hint: "↑/↓ navigate · e edit · c copy · ctrl+f summarize+fork · ↵ menu · esc cancel",
    onSelect: (item) => ({ id: item.value, action: "menu" }),
    onHotkey: (data, item) => {
      if (!item) return undefined;
      if (matchesKey(data, "e") || matchesKey(data, "shift+e")) return { id: item.value, action: "edit" };
      if (matchesKey(data, "c") || matchesKey(data, "shift+c")) return { id: item.value, action: "copy" };
      if (matchesKey(data, "ctrl+f")) return { id: item.value, action: "summarize-fork" };
      return undefined;
    },
  });
}

/** Pick an action for the already-selected message. */
export function showActionMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<Action | undefined> {
  const rows: SelectItem[] = [
    { value: "edit", label: "Edit message and regenerate response", description: "revert here, keep the text" },
    { value: "copy", label: "Copy message to clipboard", description: "no session change" },
    { value: "summarize-fork", label: "Summarize and fork", description: "new session, then compact" },
  ];

  return showFloatingList<Action>(pi, ctx, {
    title: "Message action",
    items: rows,
    maxVisible: 5,
    initialIndex: 0,
    hint: "↑/↓ navigate · ↵ select · esc cancel",
    onSelect: (item) => item.value as Action,
  });
}
