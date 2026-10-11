import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const EXTENSIONS: Record<string, string> = {
	bash: "bash", sh: "bash", zsh: "bash", fish: "bash",
	js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
	json: "json", md: "markdown", py: "python", rb: "ruby", rs: "rust",
	go: "go", java: "java", c: "c", h: "c", cpp: "cpp", css: "css",
	html: "xml", xml: "xml", yaml: "yaml", yml: "yaml", toml: "ini",
};

export function languageFromPath(path: unknown): string | undefined {
	const extension = typeof path === "string" ? path.split(/[./\\]/).pop()?.toLowerCase() : undefined;
	return extension ? EXTENSIONS[extension] : undefined;
}

function resultText(result: any): string {
	if (typeof result === "string") return result;
	if (typeof result?.content === "string") return result.content;
	if (Array.isArray(result?.content)) {
		return result.content.filter((item: any) => item?.type === "text").map((item: any) => item.text ?? "").join("\n");
	}
	return "";
}

export function codeBlock(content: string, theme: any, language?: string, firstLine = 1): Text {
	const source = content.replace(/\r\n?/g, "\n").replace(/\t/g, "   ");
	let lines = source.split("\n");
	while (lines.length > 1 && lines.at(-1) === "") lines.pop();
	const highlighted = language ? (() => {
		try { return highlightCode(source, language); } catch { return lines; }
	})() : lines;
	const width = Math.max(1, String(firstLine + lines.length - 1).length);
	return new Text(highlighted.map((line, index) => `${theme.fg("dim", String(firstLine + index).padStart(width, " "))} ${line}`).join("\n"), 0, 0);
}

export function resultContent(result: any): string {
	return resultText(result);
}
