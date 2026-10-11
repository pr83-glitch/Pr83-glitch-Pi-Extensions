/**
 * Read-block presentation.
 *
 * Resolves the read tool presentation without registering an executor; the renderer
 * matches the rest of the sleek tool blocks: an accent `Read` label and muted
 * path/line-range text. pi's result renderer is kept, so expanding still shows
 * the file contents.
 */
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readRange, toolLabel } from "./labels.js";
import { pathLabel } from "./shared.js";
import { animatedToolCall } from "./text-shimmer.js";
import { codeBlock, languageFromPath, resultContent } from "./code-block.js";

export function registerReadTool(pi: ExtensionAPI): void {
	pi.registerToolRenderer((toolName, next) => {
		const base = next();
		if (toolName !== "read") return base;
		return {
			...base,
			renderCall(args: any, theme: any, context: any) {
				return animatedToolCall(theme, context, (detail) => {
					const label = toolLabel("read", theme);
					const path = pathLabel(theme, args);
					const range = theme.fg("muted", readRange(args));
					return new Text(`${label} ${detail(path + range)}`, 0, 0);
				});
			},
			renderResult(result: any, options: any, theme: any, context: any) {
				if (!options.expanded) return base?.renderResult?.(result, options, theme, context) ?? new Text("", 0, 0);
				const content = resultContent(result);
				return content ? codeBlock(content, theme, languageFromPath(context?.args?.file_path ?? context?.args?.path), Number(context?.args?.offset ?? 1))
					: base?.renderResult?.(result, options, theme, context) ?? new Text("", 0, 0);
			},
		};
	});
}
