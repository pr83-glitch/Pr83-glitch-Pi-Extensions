/** One-line collapsed tools; expanded tools delegate to their original renderer. */
import { AssistantMessageComponent, SkillInvocationMessageComponent, ToolExecutionComponent, keyText } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { installPatch } from "../core/patch-registry.js";
import { safeTruncateToWidth, safeVisibleWidth } from "../render-budget.js";
import { countDiffStats, renderDiffMeter } from "../split-diff.js";
import { stripAnsi } from "../theme/ansi.js";
import { isTodoTool, readRange, themeColor, todoIcon, toolDisplayName, toolLabel } from "./labels.js";
import { resultText } from "./shared.js";
import { SHIMMER_FRAME_MS, SHIMMER_LOOP_MS, SHIMMER_FADE_MS, TOOL_DETAIL_ANIMATION, canShimmer, shimmerOffsetChars, shimmerText, type ToolShimmerFrame } from "./text-shimmer.js";

type Summary = {
	name: string;
	detail: string;
	status: string;
	lines?: number;
	diff?: { additions: number; removals: number };
	todo: boolean;
};
const PLAIN_THEME = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function oneLine(value: unknown): string {
	return stripAnsi(typeof value === "string" ? value : "").replace(/[\r\n\t]+/g, " ").trim();
}

function summarize(tool: any): Summary {
	const args = tool.args ?? {};
	const result = tool.result;
	const details = result?.details;
	const name = String(tool.toolName);
	const error = result?.isError || details?.error;
	const status = error ? "error" : result && !tool.isPartial ? "completed" : tool.executionStarted ? "in progress" : "pending";
	const text = resultText(result);
	const lines = result ? details?.truncation?.totalLines ?? (text.trimEnd() ? text.trimEnd().split(/\r?\n/).length : 0) : undefined;
	const todo = isTodoTool(name);
	if (todo) {
		const tasks = details?.tasks ?? details?.todos ?? args.todoList ?? args.tasks ?? args.todos ?? [];
		const task = Array.isArray(tasks)
			? tasks.find((entry: any) => args.id !== undefined ? entry.id === args.id : args.subject ? entry.subject === args.subject : false)
				?? tasks.find((entry: any) => ["in_progress", "in-progress"].includes(entry.status))
				?? tasks.find((entry: any) => entry.status === "pending") ?? tasks.at(-1)
			: undefined;
		return {
			name: "todo", todo: true,
			detail: oneLine(args.subject ?? task?.subject ?? task?.title ?? task?.content ?? task?.text ?? (args.id !== undefined ? `#${args.id}` : args.action ?? "Tasks")),
			status: error ? "error" : oneLine(args.status ?? task?.status ?? (args.action === "create" ? "pending" : status)).replace(/[_-]/g, " "),
		};
	}
	const primary = args.command ?? args.file_path ?? args.path ?? args.query ?? args.url ?? args.description ?? args.prompt ?? args.message
		?? Object.values(args).find((value) => typeof value === "string");
	return {
		name, todo: false, status, lines,
		detail: oneLine(Array.isArray(primary) ? primary.join(", ") : primary) + (name === "read" ? readRange(args) : ""),
		...(name === "write" && typeof args.content === "string" ? { lines: args.content.trimEnd() ? args.content.trimEnd().split(/\r?\n/).length : 0 } : {}),
		...(name === "edit" && !error && typeof details?.diff === "string" ? { diff: countDiffStats(details.diff) } : {}),
	};
}

function renderSummary(summary: Summary, width: number, theme: any, frame: ToolShimmerFrame | null): string {
	const hint = `${keyText("app.tools.expand") || "ctrl+o"} to expand`;
	const color = summary.status === "error" ? "error" : summary.status === "completed" ? "success" : summary.status === "in progress" ? "warning" : "dim";
	const status = theme.fg(color, `● ${summary.status}`);
	const label = toolDisplayName(summary.name);
	const paintedLabel = toolLabel(summary.name, theme);
	// Nerd Font icons: ToDo U+F51B; done U+F0E1E, processing U+F0130, failed U+F0156.
	const icon = summary.todo ? todoIcon(theme)
		: summary.status === "error" ? themeColor(theme, "red", "error", "\u{F0156}")
		: summary.status === "completed" ? themeColor(theme, "green", "success", "\u{F0E1E}")
		: themeColor(theme, "orange", "warning", "\u{F0130}");
	const marker = summary.name === "bash" ? " $" : summary.todo ? " →" : "";
	const detail = `${theme.fg("muted", marker)}${summary.detail ? ` ${theme.fg("muted", summary.detail)}` : ""}`;
	const prefix = `${summary.todo ? "" : `${icon} `}${paintedLabel}`;
	let right = summary.todo ? status
		: summary.diff ? `${theme.fg("muted", "diff")} ${theme.fg("toolDiffAdded", `+${summary.diff.additions}`)} ${theme.fg("toolDiffRemoved", `-${summary.diff.removals}`)} ${renderDiffMeter(theme, summary.diff.additions, summary.diff.removals)}`
		: summary.name === "bash" && summary.lines !== undefined && summary.status === "completed"
			? theme.fg("muted", `(${summary.lines} earlier lines, ${hint})`)
			: theme.fg("muted", `${summary.lines !== undefined ? `${summary.lines} lines ` : ""}(${hint})`);
	// On narrow terminals retain a recognisable label and status rather than wrap.
	if (safeVisibleWidth(right) > width - 12) {
		right = summary.todo ? status : summary.diff ? `diff +${summary.diff.additions} -${summary.diff.removals}` : theme.fg("muted", `(${keyText("app.tools.expand") || "ctrl+o"})`);
	}
	right = safeTruncateToWidth(right, Math.max(0, width - Math.min(12, width)), "…");
	const rightWidth = safeVisibleWidth(right);
	const leftWidth = Math.max(0, width - rightWidth - (rightWidth ? 2 : 0));
	const suffix = summary.name === "edit" ? theme.fg("muted", ` … (${hint})`) : "";
	const suffixWidth = safeVisibleWidth(suffix);
	const appendSuffix = suffix && leftWidth > suffixWidth + safeVisibleWidth(label) + safeVisibleWidth(icon) + 3;
	const budget = appendSuffix ? leftWidth - suffixWidth : leftWidth || width;
	// Shimmer only visible detail cells, not an entire long command/prompt.
	const visibleDetail = frame === null ? detail : safeTruncateToWidth(detail, Math.max(0, budget - safeVisibleWidth(prefix)), "…");
	const description = prefix + (frame === null ? visibleDetail : shimmerText(visibleDetail, theme, frame.offset, frame.fade));
	const left = safeTruncateToWidth(description, budget, "…") + (appendSuffix ? suffix : "");
	return left + " ".repeat(Math.max(0, width - safeVisibleWidth(left) - rightWidth)) + right;
}

function restyleHeader(line: string, name: string, theme: any, width?: number): string {
	const displayName = toolDisplayName(name);
	const names = isTodoTool(name) ? [name, "todo", "ToDo"] : [name, displayName];
	const escaped = names.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	const token = new RegExp(`^((?:\\s|\\x1b\\[[0-9;]*m)*)(?:${escaped})(?=\\s|\\x1b|$)`);
	const styled = line.replace(token, (_match, prefix) => `${prefix}${toolLabel(name, theme)}`);
	return width === undefined ? styled : safeTruncateToWidth(styled, width, "…");
}

/** A tool is "processing" from execution start until a non-partial result lands. */
function isToolProcessing(tool: any): boolean {
	return Boolean(tool?.executionStarted) && (!tool.result || tool.isPartial === true);
}

const TOOL_ANIMATION_KEY = Symbol.for("pi-sleek.tool-shimmer.timer");
type AnimationHost = typeof globalThis & {
	[TOOL_ANIMATION_KEY]?: ReturnType<typeof setInterval>;
};
const animationHost = () => globalThis as AnimationHost;

// Weak state survives expiry so expanding/updating a finished block cannot replay it.
let animationStarts = new WeakMap<object, { start: number | null; ended?: number; frame?: ToolShimmerFrame; thinking?: boolean; visible?: boolean }>();
const activeTools = new Set<any>();

/** Stop the shared repaint tick and forget tracked tools (session shutdown/reload). */
export function stopToolAnimationTicker(): void {
	const host = animationHost();
	if (host[TOOL_ANIMATION_KEY]) clearInterval(host[TOOL_ANIMATION_KEY]);
	host[TOOL_ANIMATION_KEY] = undefined;
	activeTools.clear();
	animationStarts = new WeakMap();
}

function isAssistantThinking(component: any): boolean {
	return component.isStreaming === true && component.lastMessage?.content?.at(-1)?.type === "thinking";
}

function animationEligible(tool: any): boolean {
	const state = animationStarts.get(tool);
	if (state?.thinking) return state.visible === true;
	return (loadConfig().density === "compact" && !tool.expanded)
		|| ["bash", "read", "write", "edit"].includes(String(tool.toolName));
}

function toolAnimationFrame(tool: any, theme: any, visibleDetail = false): ToolShimmerFrame | null {
	const state = animationStarts.get(tool);
	if (!state || !animationEligible(tool) || !canShimmer(theme, state.thinking ? "thinkingText" : "muted")) return null;
	// Live calls may finish before their first paint. Empty streamed args consume no loop.
	if (state.start === null) {
		if (!visibleDetail || (state.thinking && !isAssistantThinking(tool))) return null;
		state.start = performance.now();
	}
	const now = performance.now();
	const minimumEnd = state.start + (state.thinking ? 0 : SHIMMER_LOOP_MS);
	const stopAt = Math.max(minimumEnd, state.ended ?? minimumEnd);
	const processing = state.thinking ? isAssistantThinking(tool) : isToolProcessing(tool);
	const settling = !processing && now >= stopAt;
	if (settling && now >= stopAt + SHIMMER_FADE_MS) return null;
	// Freeze the band during the fade; only its contrast settles into muted.
	const elapsed = Math.max(0, (settling ? stopAt : now) - state.start);
	const offset = shimmerOffsetChars(Math.floor(elapsed / SHIMMER_FRAME_MS) * SHIMMER_FRAME_MS);
	const fade = settling ? Math.floor((now - stopAt) / SHIMMER_FRAME_MS) * SHIMMER_FRAME_MS / SHIMMER_FADE_MS : 0;
	if (!state.frame || state.frame.offset !== offset || state.frame.fade !== fade) state.frame = { offset, fade };
	return state.frame;
}

/** Resume an existing window after density/expansion changes, never restart its phase. */
function syncToolAnimation(tool: any, getTheme: () => any, requestRender?: () => void): void {
	if (toolAnimationFrame(tool, getTheme()) === null) return;
	activeTools.add(tool);
	const host = animationHost();
	if (!host[TOOL_ANIMATION_KEY] && requestRender) {
		host[TOOL_ANIMATION_KEY] = setInterval(() => {
			for (const active of activeTools) {
				if (toolAnimationFrame(active, getTheme()) === null) activeTools.delete(active);
			}
			// Also paint the final static frame before retiring the interval.
			requestRender();
			if (activeTools.size === 0) {
				clearInterval(host[TOOL_ANIMATION_KEY]);
				host[TOOL_ANIMATION_KEY] = undefined;
			}
		}, SHIMMER_FRAME_MS);
		host[TOOL_ANIMATION_KEY]?.unref?.();
	}
}

export function installToolDensity(getTheme: () => any = () => undefined, requestRender?: () => void): void {
	stopToolAnimationTicker();
	const summaries = new WeakMap<object, { args: any; result: any; partial: boolean; started: boolean; summary: Summary; row?: { width: number; frame: ToolShimmerFrame | null; colors: unknown; text: string } }>();
	// Preserve external renderers/execution (notably rpiv-todo); restyle only a
	// leading tool-name token, never its body, action glyphs or result component.
	const decorateCall = (component: any, name: string, theme: any): any => {
		let header: { source: string; width: number; colors: unknown; text: string } | undefined;
		return {
			__sleekLabelBase: component,
			render(width: number) {
				const lines = [...component.render(width)];
				const index = lines.findIndex((line: string) => stripAnsi(line).trim());
				if (index >= 0) {
					const source = lines[index], colors = theme?.colors ?? theme?.sourcePath ?? theme?.definition ?? theme?.name;
					if (!header || header.source !== source || header.width !== width || header.colors !== colors) {
						header = { source, width, colors, text: restyleHeader(source, name, theme, width) };
					}
					lines[index] = header.text;
				}
				return lines;
			},
			invalidate: () => { header = undefined; component.invalidate?.(); },
			handleMouse: (event: any) => component.handleMouse?.(event),
		};
	};
	installPatch(ToolExecutionComponent.prototype, "getCallRenderer", "pi-sleek.tool-label.call", (original) =>
		function (this: any, ...args: any[]) {
			const renderer = original.apply(this, args);
			if (!renderer) return renderer;
			return (callArgs: any, theme: any, context: any, ...rest: any[]) => {
				const lastComponent = context.lastComponent?.__sleekLabelBase ?? context.lastComponent;
				context.state[TOOL_DETAIL_ANIMATION] = (detail?: string) => toolAnimationFrame(this, theme,
					Boolean(detail?.trim()) && Boolean(callArgs.command ?? callArgs.path ?? callArgs.file_path));
				return decorateCall(renderer(callArgs, theme, { ...context, lastComponent }, ...rest), String(this.toolName), theme);
			};
		},
	);
	installPatch(ToolExecutionComponent.prototype, "createCallFallback", "pi-sleek.tool-label.fallback", (original) =>
		function (this: any, ...args: any[]) {
			return decorateCall(original.apply(this, args), String(this.toolName), getTheme() ?? PLAIN_THEME);
		},
	);
	installPatch(ToolExecutionComponent.prototype, "formatToolExecution", "pi-sleek.tool-label.generic", (original) =>
		function (this: any, ...args: any[]) {
			const lines = original.apply(this, args).split("\n");
			lines[0] = restyleHeader(lines[0], String(this.toolName), getTheme() ?? PLAIN_THEME);
			return lines.join("\n");
		},
	);
	installPatch(ToolExecutionComponent.prototype, "updateDisplay", "pi-sleek.tool-density.summary-cache", (original) =>
		function (this: any, ...args: any[]) {
			summaries.delete(this);
			// Pi never marks replayed historical calls as executionStarted.
			if (isToolProcessing(this) && !animationStarts.has(this)) animationStarts.set(this, { start: null });
			const state = animationStarts.get(this);
			if (state) {
				if (isToolProcessing(this)) state.ended = undefined;
				else if (this.result && !this.isPartial && state.ended === undefined) state.ended = performance.now();
			}
			return original.apply(this, args);
		},
	);
	installPatch(ToolExecutionComponent.prototype, "render", "pi-sleek.tool-density.render", (original) =>
		function (this: any, width: number, ...args: any[]) {
			if ((!this.result || isToolProcessing(this)) && !animationStarts.has(this)) animationStarts.set(this, { start: null });
			if (loadConfig().density !== "compact" || this.expanded) {
				const lines = original.call(this, width, ...args);
				syncToolAnimation(this, getTheme, requestRender);
				return lines;
			}
			let cached = summaries.get(this);
			if (!cached || cached.args !== this.args || cached.result !== this.result || cached.partial !== this.isPartial || cached.started !== this.executionStarted) {
				cached = { args: this.args, result: this.result, partial: this.isPartial, started: this.executionStarted, summary: summarize(this) };
				summaries.set(this, cached);
			}
			const pad = Math.min(Math.max(0, this.outputPad ?? 1), Math.max(0, Math.floor((width - 1) / 2)));
			const innerWidth = Math.max(1, width - pad * 2), theme = getTheme() ?? PLAIN_THEME;
			const frame = toolAnimationFrame(this, theme, Boolean(cached.summary.detail)), colors = theme.colors ?? theme.sourcePath ?? theme.definition ?? theme.name;
			if (!cached.row || cached.row.width !== innerWidth || cached.row.frame !== frame || cached.row.colors !== colors) {
				cached.row = { width: innerWidth, frame, colors, text: renderSummary(cached.summary, innerWidth, theme, frame) };
			}
			const row = " ".repeat(pad) + cached.row.text + " ".repeat(pad);
			syncToolAnimation(this, getTheme, requestRender);
			return ["", row];
		},
	);
	installPatch(SkillInvocationMessageComponent.prototype, "render", "pi-sleek.tool-density.skill-render", (original) =>
		function (this: any, width: number, ...args: any[]) {
			const compact = loadConfig().density === "compact";
			if (compact) {
				// SkillInvocationMessageComponent is a Box; Sleek rows use the same
				// background-free, zero-padding treatment as other compact tools.
				this.setPaddingX?.(0);
				this.setBgFn?.(undefined);
				this.paddingY = 0;
			} else {
				this.setPaddingX?.(1);
				this.setBgFn?.((text: string) => getTheme()?.bg?.("customMessageBg", text) ?? text);
				this.paddingY = 1;
			}
			const lines = original.call(this, width, ...args);
			if (!compact || this.expanded) return lines;
			return lines.map((line: string) => line.replace("[skill]", "Skill"));
		},
	);
	installPatch(ToolExecutionComponent.prototype, "handleMouse", "pi-sleek.tool-density.mouse", (original) =>
		function (this: any, event: any, ...args: any[]) {
			if (loadConfig().density !== "compact" || this.expanded) return original.call(this, event, ...args);
			if (event.y !== 1 || event.type !== "click" || event.button !== "left") return undefined;
			this.setExpanded(true);
			this.ui.requestRender();
			return { handled: true };
		},
	);
}

// Nerd Font thinking icon, U+EE9C. Native Text/MouseRegion keep padding and clicks.
const THINKING_ICON = "\u{EE9C}";

function decorateThinkingLabels(component: any, getTheme: () => any, requestRender?: () => void): void {
	const regions = component.contentContainer?.children?.filter((child: any) => typeof child.onMouse === "function") ?? [];
	let state = animationStarts.get(component);
	if (isAssistantThinking(component)) {
		if (!state || state.ended !== undefined) {
			state = { start: null, thinking: true };
			animationStarts.set(component, state);
		}
	} else if (state && state.ended === undefined) state.ended = performance.now();
	if (state) state.visible = false;
	for (const region of regions) {
		const child = region.child;
		if (typeof child?.setText !== "function" || stripAnsi(child.text ?? "") !== component.hiddenThinkingLabel) continue;
		const current = region === regions.at(-1);
		if (current && state) state.visible = true;
		let previousFrame: ToolShimmerFrame | null | undefined;
		let previousColors: unknown;
		region.child = {
			render(width: number) {
				const theme = getTheme();
				const frame = current ? toolAnimationFrame(component, theme, true) : null;
				const colors = theme?.colors ?? theme?.sourcePath ?? theme?.definition ?? theme?.name;
				if (theme && (frame !== previousFrame || colors !== previousColors)) {
					const label = component.hiddenThinkingLabel;
					const styled = frame ? shimmerText(label, theme, frame.offset, frame.fade, "thinkingText") : theme.fg("thinkingText", label);
					const text = theme.italic?.(styled) ?? `\x1b[3m${styled}\x1b[23m`;
					if (child.text !== text) child.setText(text);
					previousFrame = frame;
					previousColors = colors;
				}
				if (current) syncToolAnimation(component, getTheme, requestRender);
				return child.render(width);
			},
			invalidate: () => { previousFrame = undefined; child.invalidate(); },
		};
	}
}

/** Start thinking collapsed in Compact; animate only the current collapsed label. */
export function installCompactThinking(getTheme: () => any = () => undefined, requestRender?: () => void): void {
	const renderedDensity = new WeakMap<object, string>();
	installPatch(AssistantMessageComponent.prototype, "updateContent", "pi-sleek.density.thinking-content", (original) =>
		function (this: any, ...args: any[]) {
			if (!this.hiddenThinkingLabel.startsWith(`${THINKING_ICON} `)) this.hiddenThinkingLabel = `${THINKING_ICON} ${this.hiddenThinkingLabel}`;
			const hidden = this.hideThinkingBlock;
			if (loadConfig().density === "compact") this.hideThinkingBlock = true;
			let result;
			try {
				result = original.apply(this, args);
			} finally {
				this.hideThinkingBlock = hidden;
			}
			decorateThinkingLabels(this, getTheme, requestRender);
			return result;
		},
	);
	installPatch(AssistantMessageComponent.prototype, "render", "pi-sleek.density.thinking-render", (original) =>
		function (this: any, ...args: any[]) {
			const density = loadConfig().density;
			if (renderedDensity.get(this) !== density) {
				renderedDensity.set(this, density);
				this.invalidate();
			}
			return original.apply(this, args);
		},
	);
}
