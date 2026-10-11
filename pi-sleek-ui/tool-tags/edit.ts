/**
 * Split-diff rendering for the edit tool.
 *
 * pi's built-in edit renderer prints a unified diff inside a self-rendered
 * tool block. This keeps the same self-rendered shape, swaps in the
 * side-by-side `SplitDiffComponent`, and applies the same standard tool
 * background used by task updates, shell commands and read blocks.
 *
 * Registered during the load phase: pi rebuilds the tool set before
 * `session_start` on `/reload`, so registering from the session handler would be
 * too late and the built-in renderer would return.
 */
import {
	getLanguageFromPath,
	type ExtensionAPI,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component } from "@earendil-works/pi-tui";

import {
	SplitDiffComponent,
	buildSplitRows,
	countDiffStats,
	extractEditedPath,
	firstText,
	renderDiffMeter,
} from "../split-diff.js";
import { stripAnsi } from "../theme/ansi.js";
import { toolLabel } from "./labels.js";
import { pathLabel, resultText } from "./shared.js";
import { animatedToolCall } from "./text-shimmer.js";

const MAX_HIGHLIGHT_DIFF_CHARS = 12000;
const MAX_HIGHLIGHT_DIFF_ROWS = 120;
const COLLAPSED_MAX_ROWS = 36;

type ToolBackground = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

export function registerEditTool(pi: ExtensionAPI): void {
	pi.registerToolRenderer((toolName, next) => {
		const base = next();
		if (toolName !== "edit") return base;
		return {
			...base,
			renderShell: "self",
			renderCall(args, theme, context) {
				return animatedToolCall(theme, context, (detail) => {
					const path = pathLabel(theme, args);
					const background: ToolBackground = context?.isError ? "toolErrorBg" : "toolPendingBg";
					return toolSurface(
						theme,
						new Text(`${toolLabel("edit", theme)} ${detail(path)}`, 0, 0),
						background,
						"call",
					);
				});
			},
			renderResult(result: any, options: ToolRenderResultOptions, theme: any, context: any) {
				const isError = context?.isError || result.isError;
				const background: ToolBackground = options.isPartial
					? "toolPendingBg"
					: isError
						? "toolErrorBg"
						: "toolSuccessBg";

				if (options.isPartial) {
					return toolSurface(
						theme,
						new Text(`${theme.fg("dim", "↳")} ${theme.fg("muted", "Applying edit...")}`, 0, 0),
						background,
					);
				}
				if (isError) {
					return toolSurface(
						theme,
						new Text(theme.fg("error", stripAnsi(textOutput(result)).trim() || "Error"), 0, 0),
						background,
					);
				}

				const details = result.details as { diff?: string; path?: string } | undefined;
				const diff = details?.diff;
				if (!diff) {
					const output = stripAnsi(textOutput(result)).trim();
					return toolSurface(
						theme,
						new Text(theme.fg("dim", `↳ ${output || "Edit applied"}`), 0, 0),
						background,
					);
				}

				const rows = buildSplitRows(diff);
				const message = firstText(result.content as Array<{ type: string; text?: string }>);
				const args = context.args as { path?: string; file_path?: string } | undefined;
				const argPath = args?.path ?? args?.file_path;
				const sourcePath = details?.path ?? (typeof argPath === "string" && argPath ? argPath : undefined) ?? extractEditedPath(message);
				const language = sourcePath ? getLanguageFromPath(sourcePath) : undefined;
				const shouldHighlight =
					Boolean(language) && diff.length <= MAX_HIGHLIGHT_DIFF_CHARS && rows.length <= MAX_HIGHLIGHT_DIFF_ROWS;
				const split = new SplitDiffComponent(
					theme,
					rows,
					options.expanded ? Infinity : COLLAPSED_MAX_ROWS,
					shouldHighlight ? language : undefined,
				);

				const { additions, removals } = countDiffStats(diff);
				const meter = renderDiffMeter(theme, additions, removals);
				const summary =
					`${theme.fg("dim", "↳")} ${theme.fg("muted", "diff")}` +
					` ${theme.fg("toolDiffAdded", `+${additions}`)}` +
					` ${theme.fg("toolDiffRemoved", `-${removals}`)}` +
					(meter ? ` ${meter}` : "");

				const resultComponent: Component = {
					render(width: number): string[] {
						const safeWidth = Math.max(1, width);
						return [...new Text(summary, 0, 0).render(safeWidth), ...split.render(safeWidth)];
					},
					invalidate(): void {
						split.invalidate();
					},
				};
				return toolSurface(theme, resultComponent, background);
			},
		};
	});
}

function toolSurface(
	theme: any,
	child: Component,
	background: ToolBackground,
	variant: "call" | "result" = "result",
): Box {
	const paddingY = variant === "call" ? 1 : 0;
	const paddingBottom = variant === "call" ? 0 : 1;
	const box = new Box(1, paddingY, (content: string) => theme.bg(background, content));
	if (paddingBottom > 0) {
		box.addChild({
			render(width: number): string[] {
				return [...child.render(width), ...Array.from({ length: paddingBottom }, () => "")];
			},
			invalidate(): void {
				child.invalidate();
			},
		});
	} else {
		box.addChild(child);
	}
	return box;
}

function textOutput(result: { content?: Array<{ type: string; text?: string }> } | undefined): string {
	return resultText(result).replace(/\r/g, "");
}
