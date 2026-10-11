/**
 * Shared plumbing for the `/sleek` popups.
 *
 * Every menu is a `MenuPopup` drawn in a centred `ctx.ui.custom` overlay, and
 * every one of them mutes Sleek's notification alerts while it is open
 * (`withSleekUi`) and derives its row budget and repaint hook from the overlay's
 * tui. `createMenu` and `openOverlay` centralise that so a call site only
 * describes its own rows and overlay width.
 */
import type { Component } from "@earendil-works/pi-tui";

import { withSleekUi } from "../notify/alerts.js";
import type { MenuTheme } from "./frame.js";
import { MenuPopup, type MenuPopupOptions } from "./popup.js";

/** Overlay width for the standard settings menus. */
const MENU_OVERLAY_WIDTH = "92%";

/** A `MenuPopup`'s options minus the two hooks derived from the overlay's tui. */
export type SleekMenuOptions = Omit<MenuPopupOptions, "terminalRows" | "requestRender">;

/** Build a `MenuPopup` wired to the overlay's tui (terminal rows + repaint). */
export function createMenu(tui: any, theme: MenuTheme, options: SleekMenuOptions): MenuPopup {
	return new MenuPopup(theme, {
		...options,
		terminalRows: () => tui?.terminal?.rows ?? 40,
		requestRender: () => tui?.requestRender?.(),
	});
}

/**
 * Open a component in the standard centred Sleek overlay with alerts muted for
 * the duration of the interaction. Resolves with whatever the component's
 * `done` callback receives (or `undefined` when it closes with Escape).
 */
export function openOverlay<T = undefined>(
	ui: any,
	factory: (tui: any, theme: any, done: (result: T | undefined) => void) => Component,
): Promise<T | undefined> {
	return withSleekUi(ui.custom(
		(tui: any, theme: any, _keybindings: unknown, done: (result: T | undefined) => void) => factory(tui, theme, done),
		{ overlay: true, overlayOptions: { anchor: "center", width: MENU_OVERLAY_WIDTH, maxHeight: "85%" } },
	));
}
