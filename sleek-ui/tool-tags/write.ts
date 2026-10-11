/**
 * Write-block presentation.
 *
 * Resolves the write tool presentation without registering an executor; the renderer
 * matches the rest of the sleek tool blocks: an accent `Write` label, a muted
 * path and a muted preview of the content. pi's result renderer is kept.
 */
import { keyText, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { toolLabel } from "./labels.js";
import { pathLabel } from "./shared.js";
import { animatedToolCall } from "./text-shimmer.js";
import { codeBlock, languageFromPath } from "./code-block.js";

const COLLAPSED_MAX_LINES = 1;

export function registerWriteTool(pi: ExtensionAPI): void {
	pi.registerToolRenderer((toolName, next) => {
		const base = next();
		if (toolName !== "write") return base;
		let expandedKey = "";
		let expandedPreview: Text | undefined;
		return {
			...base,
			renderCall(args: any, theme: any, context: any) {
				const call = new Container();
				call.addChild(animatedToolCall(theme, context, (detail) =>
					new Text(`${toolLabel("write", theme)} ${detail(pathLabel(theme, args))}`, 0, 0),
				));
				const content: string = typeof args?.content === "string" ? args.content : "";
				if (content) {
					// The preview is static: retain its Text wrapping cache across shimmer ticks.
					const lines = content.replace(/\r\n?/g, "\n").replace(/\t/g, "   ").split("\n");
					while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
					if (context?.expanded) {
						const language = languageFromPath(args?.file_path ?? args?.path);
						const key = `${content}\n${language ?? ""}`;
						if (expandedKey !== key || !expandedPreview) {
							expandedKey = key;
							expandedPreview = codeBlock(content, theme, language);
						}
						call.addChild(expandedPreview);
						return call;
					}
					const shown = lines.slice(0, COLLAPSED_MAX_LINES);
					let preview = shown.map((line) => theme.fg("muted", line)).join("\n");
					const remaining = lines.length - shown.length;
					if (remaining > 0) {
						preview += `\n${theme.fg("muted", `... (${remaining} more lines,`)} ${theme.fg("muted", keyText("app.tools.expand"))} ${theme.fg("muted", "to expand)")}`;
					}
					call.addChild(new Spacer(1));
					call.addChild(preview ? new Text(preview, 0, 0) : new Spacer(1));
				}
				return call;
			},
		};
	});
}
