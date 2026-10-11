/**
 * Queued follow-up messages above the editor.
 *
 * pi renders them as dim `Follow-up: …` rows. This patch paints each row with the
 * theme's `userMessageBg` so a queued follow-up reads as a tinted block with
 * one padded row above and below, without changing anything else about the
 * pending-messages area.
 *
 * `InteractiveMode.updatePendingMessagesDisplay` rebuilds the container on every
 * change, so the wrappers are rebuilt each time; stateless and installed through
 * `core/patch-registry.ts`.
 */
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Box } from "@earendil-works/pi-tui";

import { installPatch } from "../core/patch-registry.js";
import { stripAnsi } from "../theme/ansi.js";

const FOLLOW_UP_PREFIX = "Follow-up: ";

export function installFollowUpMessageBackground(getTheme: () => any): void {
	installPatch(
		(InteractiveMode as { prototype: unknown }).prototype,
		"updatePendingMessagesDisplay",
		"pi-sleek.follow-up-message-bg.updatePendingMessagesDisplay",
		(base: (this: any, ...args: any[]) => unknown) =>
			function patchedPendingMessagesDisplay(this: any, ...args: any[]): unknown {
				const result = base.apply(this, args);
				const children = this.pendingMessagesContainer?.children;
				if (!Array.isArray(children)) return result;

				for (let i = 0; i < children.length; i++) {
					const child = children[i];
					if (typeof child?.text !== "string" || !stripAnsi(child.text).startsWith(FOLLOW_UP_PREFIX)) continue;
					// Resolve the theme per render so a theme switch repaints queued rows
					// without waiting for the pending queue to change.
					const box = new Box(0, 1, (content: string) => {
						try {
							return getTheme()?.bg("userMessageBg", content) ?? content;
						} catch {
							return content;
						}
					});
					box.addChild(child);
					children[i] = box;
				}
				return result;
			},
	);
}
