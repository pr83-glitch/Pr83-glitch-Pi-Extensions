/**
 * Generic option picker, rendered with the extension-manager style popup — the
 * same chrome as the theme picker. Used by `/sleek` for its select-style
 * settings (thinking style, logo animation, message styles, status bar and
 * placement) so each opens its own dedicated list instead of cycling in place.
 *
 * Rows are rebuilt on every render; the current value is marked, a `sample` or
 * `preview` may render a live preview, Enter applies + persists, Escape cancels.
 */
import { MenuPopup, type MenuRow } from "./popup.js";
import { menuOptionMarker, menuPrimaryHint, type MenuTheme } from "./frame.js";
import { createMenu, openOverlay } from "./overlay.js";

export interface PickerOption {
	id: string;
	label: string;
	description: string;
	/** Optional visual group heading. */
	section?: string;
}

/** One selectable value with its help text; the raw shape the option lists are written in. */
export interface SettingOptionHelp {
	id: string;
	text: string;
	section?: string;
}

export interface OptionPickerHost {
	notify(message: string, kind?: "info" | "warning" | "error"): void;
}

export interface OptionPickerArgs {
	tui: { terminal?: { rows?: number }; requestRender(): void };
	theme: MenuTheme;
	/** Notification sink for apply results. */
	host: OptionPickerHost;
	/** Frame title, written into the top rule. */
	title: string;
	/** Row label used in apply-result notifications. */
	listTitle: string;
	options: readonly PickerOption[];
	/** Id selected when the popup opens. */
	currentId: string;
	/** Apply + persist the chosen id; return false when the save failed. */
	onSelect: (id: string) => boolean | void;
	/** Always-on animated frames for a row id. */
	preview?: (id: string, theme: MenuTheme) => { frames: string[][]; intervalMs: number } | undefined;
	/** Optional ANSI-styled one-line sample for a row id. */
	sample?: (id: string, theme: MenuTheme) => string | undefined;
	/** How the animation is shown: a right pane (default) or the selected row's sample cell. */
	previewMode?: "pane" | "sample";
	done: (result: string | undefined) => void;
}

export function createOptionMenuComponent(args: OptionPickerArgs): MenuPopup {
	const rows = (): MenuRow[] =>
		args.options.map((option) => ({
			id: option.id,
			label: option.label,
			section: option.section,
			meta: args.sample?.(option.id, args.theme),
			state: option.id === args.currentId ? "on" : "info",
			marker: menuOptionMarker(args.theme, option.id === args.currentId),
			search: `${option.id} ${option.label} ${option.description} ${option.section ?? ""}`,
		}));

	return createMenu(args.tui, args.theme, {
		title: args.title,
		columnTitles: { label: "OPTION", description: "SAMPLE" },
		preview: args.preview
			? { mode: args.previewMode, framesFor: (row, theme) => (row ? args.preview?.(row.id, theme) : undefined) }
			: undefined,
		rows,
		initialId: args.currentId,
		primaryHint: menuPrimaryHint(args.theme, { close: "cancel" }),
		onActivate: (row) => {
			const applied = args.onSelect(row.id);
			args.host.notify(
				applied === false ? `Could not apply "${row.id}"` : `${args.listTitle}: ${row.label}`,
				applied === false ? "error" : "info",
			);
			args.done(row.id);
		},
		onClose: () => args.done(undefined),
	});
}

/** Open the option picker in the standard `/sleek` overlay and resolve on close. */
export function openOptionPicker(
	ui: any,
	args: Omit<OptionPickerArgs, "tui" | "theme" | "host" | "done"> & { host?: OptionPickerHost },
): Promise<string | undefined> {
	return openOverlay<string | undefined>(ui, (tui, theme, done) =>
		createOptionMenuComponent({ ...args, tui, theme, host: args.host ?? ui, done }));
}
