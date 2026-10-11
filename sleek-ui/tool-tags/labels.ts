/** Tool identity stays the same across density and expansion states. */
import { themeVarPainter } from "../theme/theme-extras.js";

export function themeColor(theme: any, variable: string, fallback: string, text: string): string {
	const paint = themeVarPainter(theme, variable);
	return paint ? paint(text) : theme.fg(fallback, text);
}

export function isTodoTool(name: string): boolean {
	return ["todo", "todo_complete_all", "manage_todo_list"].includes(name);
}

export function isSkillsTool(name: string): boolean {
	return ["skill", "skills"].includes(name.toLowerCase());
}

/** Display name for a tool: `ToDo` for the todo tools, else the capitalized name. */
export function toolDisplayName(name: string): string {
	return isTodoTool(name) ? "ToDo" : isSkillsTool(name) ? "Skills" : name.charAt(0).toUpperCase() + name.slice(1);
}

/** ToDo's identity icon (U+F51B) tinted blue — not an execution-status icon. */
export function todoIcon(theme: any): string {
	return themeColor(theme, "blue", "mdLink", "\u{F51B}");
}

export function toolLabel(name: string, theme: any): string {
	const todo = isTodoTool(name);
	const label = toolDisplayName(name);
	const colors: Record<string, [string, string]> = {
		bash: ["orange", "warning"],
		read: ["blue", "mdLink"],
		write: ["green", "success"],
		edit: ["purple", "accent"],
		skill: ["cyan", "accent"],
		skills: ["cyan", "accent"],
	};
	const [variable, fallback] = colors[name.toLowerCase()] ?? ["warmMix", "toolTitle"];
	const painted = todo
		? themeColor(theme, "blue", "mdLink", theme.bold(label))
		: themeColor(theme, variable, fallback, theme.bold(label));
	// ToDo keeps its identity icon in front of the label.
	return todo ? `${todoIcon(theme)} ${painted}` : painted;
}

export function readRange(args: any): string {
	if (args?.offset == null && args?.limit == null) return "";
	const start = args.offset ?? 1;
	return `:${start}${args.limit != null ? `-${start + args.limit - 1}` : ""}`;
}
