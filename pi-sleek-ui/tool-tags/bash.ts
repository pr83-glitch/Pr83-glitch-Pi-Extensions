/**
 * Collapsed bash command display.
 *
 * pi's shell renderer prints the whole command, which for a long `&&` chain or a
 * heredoc wraps over many lines and pushes the output down. This keeps pi's
 * result rendering (output preview, truncation notices, elapsed timer) and only
 * replaces the call row: the command is shown on a single truncated line with a
 * `ctrl+o to expand` hint. The command remains collapsed; Ctrl+O or a left
 * click expands only pi's output preview below it.
 *
 * Only a renderer resolver is registered; Pi and other extensions retain execution.
 */
import { highlightCode, keyText, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component } from "@earendil-works/pi-tui";

import { safeTruncateToWidth, safeVisibleWidth } from "../render-budget.js";
import { toolLabel } from "./labels.js";
import { shimmerToolDetail } from "./text-shimmer.js";

export function registerBashTool(pi: ExtensionAPI): void {
	pi.registerToolRenderer((toolName, next) => {
		const base = next();
		if (toolName !== "bash") return base;
		return {
			...base,
			renderCall(args: any, theme: any, context: any) {
				// Preserve pi's elapsed-timer bookkeeping: the result renderer reads it.
				const state = context?.state;
				if (state && context.executionStarted && state.startedAt === undefined) {
					state.startedAt = Date.now();
					state.endedAt = undefined;
				}
				// Keep the command collapsed even when pi's shared expansion state opens
				// the result output below it.
				return new BashCommandComponent(args, theme, context?.state ?? {}, Boolean(context?.expanded));
			},
		};
	});
}

class BashCommandComponent implements Component {
	constructor(
		private readonly args: any,
		private readonly theme: any,
		private readonly state: any,
		private readonly expanded: boolean,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const command = typeof this.args?.command === "string" ? this.args.command : "";
		const timeout = this.args?.timeout;
		const suffix = timeout && this.expanded ? this.theme.fg("muted", ` (timeout ${timeout}s)`) : "";
		const label = toolLabel("bash", this.theme);
		const labelPlain = "Bash ";
		const commandStyle = (text: string) => shimmerToolDetail(this.theme.fg("muted", text), this.theme, this.state);
		const prompt = "$ ";

		if (!this.expanded) {
			const count = this.state.compactOutputLines;
			const more = typeof count === "number" ? `${count} more ${count === 1 ? "line" : "lines"}, ` : "";
			const hint = this.theme.fg("muted", ` (${more}${keyText("app.tools.expand")} to expand)`);
			const budget = Math.max(0, width - safeVisibleWidth("Bash $ ") - safeVisibleWidth(hint));
			const preview = safeTruncateToWidth(command.split("\n")[0] || "...", budget, "…");
			return [safeTruncateToWidth(`${label} ${commandStyle(prompt + preview)}${hint}`, Math.max(1, width), "")];
		}

		if (!command) return [safeTruncateToWidth(`${label} ${commandStyle(`${prompt}...`)}${suffix}`, Math.max(1, width), "")];

		const firstLine = command.split("\n")[0] ?? "";
		let highlighted = firstLine;
		try {
			highlighted = highlightCode(firstLine, "bash")[0] ?? firstLine;
		} catch {
			// Keep the command readable when the syntax highlighter rejects input.
		}
		const plainCommandPrefix = `${labelPlain}${prompt}`;
		if (!command.includes("\n") && safeVisibleWidth(plainCommandPrefix + firstLine) + safeVisibleWidth(suffix) <= width) {
			return [`${label} ${this.theme.fg("muted", prompt)}${highlighted}${suffix}`];
		}

		const hint = this.theme.fg("text", ` … (${keyText("app.tools.expand")} to collapse output)`);
		const budget = Math.max(0, width - safeVisibleWidth(plainCommandPrefix) - safeVisibleWidth(hint) - safeVisibleWidth(suffix));
		const truncated = safeTruncateToWidth(highlighted, budget, "…");
		return [safeTruncateToWidth(`${label} ${this.theme.fg("muted", prompt)}${truncated}${hint}${suffix}`, Math.max(1, width), "")];
	}
}
