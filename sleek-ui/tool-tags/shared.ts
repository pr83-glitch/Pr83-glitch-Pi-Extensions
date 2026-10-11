/** Helpers shared by the tool renderers Sleek decorates. */

/** The call's file path, muted, or a dim `(unknown)` when the args carry none. */
export function pathLabel(theme: any, args: any): string {
	const raw = String(args?.file_path ?? args?.path ?? "");
	return raw ? theme.fg("muted", raw) : theme.fg("dim", "(unknown)");
}

/** Join a tool result's text blocks (the shape density/bash/edit read). */
export function resultText(result: any): string {
	const content = result?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block: any) => block?.type === "text")
		.map((block: any) => String(block.text ?? ""))
		.join("\n");
}
