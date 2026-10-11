/** Paint only concrete renderers, never Pi's dynamically forwarding TUI proxy. */
import { paintFrameBackgroundClears, paintFrameBackgroundLines, padFrameRows, resolveFrameBackgroundAnsi } from "../theme/frame-background.js";
import { installPatch, uninstallPatch } from "../core/patch-registry.js";

type TerminalLike = { columns?: number; rows?: number; write?: (data: string) => unknown };
type TuiLike = { applyLineResets?: (lines: string[]) => string[]; terminal?: TerminalLike };
let installed: { tui: TuiLike; terminal?: TerminalLike } | undefined;

export function uninstallRenderFrameBackground(): void {
	if (!installed) return;
	uninstallPatch(installed.tui, "applyLineResets", "frame-background.lines");
	uninstallPatch(installed.terminal, "write", "frame-background.write");
	installed = undefined;
}

export function installRenderFrameBackground(tui: TuiLike, theme: any): void {
	if (process.env.PI_SLEEK_RENDER_FRAME_BG === "0") return;
	if (!tui || typeof tui.applyLineResets !== "function") return;
	// The proxy returns fresh function identities. Refuse it rather than writing
	// an old renderer's methods into a newly mounted renderer on cleanup.
	if (tui.applyLineResets !== tui.applyLineResets) return;
	uninstallRenderFrameBackground();
	const terminal = tui.terminal;
	installPatch(terminal, "write", "frame-background.write", (original) =>
		function (this: TerminalLike, data: string) {
			const bg = resolveFrameBackgroundAnsi(theme);
			return original.call(this, bg ? paintFrameBackgroundClears(data, bg) : data);
		});
	installPatch(tui, "applyLineResets", "frame-background.lines", (original) =>
		function (this: TuiLike, lines: string[]) {
			const bg = resolveFrameBackgroundAnsi(theme);
			if (!bg) return original.call(this, lines);
			const rows = Math.max(0, Math.floor(this.terminal?.rows ?? 0));
			const columns = Math.max(0, Math.floor(this.terminal?.columns ?? 0));
			return paintFrameBackgroundLines(original.call(this, padFrameRows(lines, rows)), bg, columns);
		});
	installed = { tui, terminal };
}
