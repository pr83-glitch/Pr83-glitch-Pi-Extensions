import { basename } from "node:path";
import { HStack, VStack, ScrollView, compositeTuiLine, stripTerminalSequences, visibleWidth, wrapTextWithAnsi, type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { installPatch, uninstallPatch } from "./core/patch-registry.js";
import { copyChrome } from "./core/copy-selection.js";
import { loadConfig } from "./config.js";
import { thinkingStyleFrames, thinkingStyleFrameIntervalMs } from "./tool-tags/thinking-styles.js";
import { getGitStatus, type GitStatus } from "./git-status.js";
import { themeBackgroundAnsi, wrapAnsiBackground } from "./theme/ansi.js";
import { themeVarPainter } from "./theme/theme-extras.js";
import { isTodoTool } from "./tool-tags/labels.js";
import { bindSubagentActivity, getSubagentActivities } from "./subagent-activity.js";
import { BRANCH_GLYPH, DOT, FOLDER_GLYPH, cacheHitPercent, formatCompactTokens, meterBar, slimStatusText } from "./status-shared.js";

type SidePanelModel = { id: string; provider?: string };
type SidePanelContext = {
	sessionId?: string;
	cwd?: string;
	getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	getTokenUsage?: () => { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;
	getEditorText?: () => string;
};

type TodoTask = {
	id: number;
	subject: string;
	status: "pending" | "in_progress" | "completed" | "deleted";
	activeForm?: string;
	blockedBy?: number[];
};

type SubagentRow = {
	id: string;
	agentId?: string;
	prompt?: string;
	tools?: string[];
	name: string;
	model: string;
	task: string;
	status: "working" | "done" | "failed";
};
type PanelTheme = { fg(color: string, text: string): string; bg(color: string, text: string): string; strikethrough?(text: string): string };
type Renderer = TUI & { setLayoutRoot?(root: Component | undefined): void; layoutRoot?: Component };
type LayoutHost = { renderer: Renderer; fullscreenLayoutRoot: Component; themeController?: { applyFromSettings?: () => void } };

const PLAIN_THEME: PanelTheme = { fg: (_color, text) => text, bg: (_color, text) => text };
// Pi's native layout protocol is required to retain scroll, search and hit-test metadata.
const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const LEGACY_LAYOUT = Symbol.for("pi-sleek.side-panel.layout");

function agentFailed(result: any): boolean {
	const details = result?.details ?? result;
	return Boolean(result?.isError || details?.isError || details?.error)
		|| ["error", "failed"].includes(details?.status)
		|| (typeof details?.exitCode === "number" && details.exitCode !== 0 && details.exitCode !== -1);
}

function normalizeTaskStatus(value: unknown): TodoTask["status"] | undefined {
	if (value === "in-progress") return "in_progress";
	if (value === "pending" || value === "in_progress" || value === "completed" || value === "deleted") return value;
	return undefined;
}

function todoTasksFromDetails(value: unknown): TodoTask[] | undefined {
	if (!value || typeof value !== "object") return undefined;
	const source = value as { tasks?: unknown; todos?: unknown };
	const entries = Array.isArray(source.tasks) ? source.tasks : source.todos;
	if (!Array.isArray(entries)) return undefined;
	const tasks: TodoTask[] = [];
	for (const [index, value] of entries.entries()) {
		if (!value || typeof value !== "object") continue;
		const task = value as Record<string, unknown>;
		const status = normalizeTaskStatus(task.status);
		const subjectValue = task.subject ?? task.content ?? task.text ?? task.title ?? task.step;
		const subject = typeof subjectValue === "string" ? subjectValue : undefined;
		if (typeof subject !== "string" || !status) continue;
		tasks.push({
			// New manage_todo_list items intentionally have no id; numbering is their array order.
			id: typeof task.id === "number" ? task.id : index + 1,
			subject,
			status,
			...(typeof task.activeForm === "string" ? { activeForm: task.activeForm } : {}),
			blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.filter((id): id is number => typeof id === "number") : [],
		});
	}
	return tasks.filter((task) => task.status !== "deleted").sort((a, b) => rank(a.status) - rank(b.status));
}

function panelTheme(getTheme: () => unknown): PanelTheme {
	const candidate = getTheme() as PanelTheme | undefined;
	return typeof candidate?.fg === "function" && typeof candidate?.bg === "function" ? candidate : PLAIN_THEME;
}

class SidePanelComponent implements Component {
	private moreRow: number | undefined;
	private moreWidth = 0;
	private spinnerFrames: string[] = [];

	constructor(private readonly state: SidePanelController, private readonly getTheme: () => unknown, private readonly region: "all" | "header" | "body" | "footer" = "all") {}

	render(width: number): string[] {
		this.state.ensureGitInfo();
		const theme = panelTheme(this.getTheme);
		const items = loadConfig().sidePanelItems;
		const contentWidth = Math.max(1, width - 2);
		const lines: string[] = [];
		const add = (text: string, color = "muted") => {
			for (const line of wrapTextWithAnsi(theme.fg(color, text), contentWidth)) lines.push(` ${line}`);
		};
		this.moreRow = undefined;
		this.renderHeader(theme, items, contentWidth, lines);
		const [tasksStart, tasksEnd] = this.renderTodos(theme, items, contentWidth, lines, add);

		const [agentsStart, agentsEnd] = this.renderAgents(theme, items, contentWidth, lines, tasksStart);
		this.renderFooter(theme, items, contentWidth, lines, add);
		// Fullscreen docks header/footer outside the body ScrollView; regular mode keeps
		// natural content height. Only Todos and Agents receive a background.
		const taskBackground = themeBackgroundAnsi(theme, "selectedBg");
		return lines.map((line, index) => {
			const padded = compositeTuiLine("", line, 0, width, width);
			if ((tasksStart >= 0 && index >= tasksStart && index < tasksEnd)
				|| (agentsStart >= 0 && index >= agentsStart && index < agentsEnd)) {
				return taskBackground ? wrapAnsiBackground(padded, taskBackground) : theme.bg("toolSuccessBg", padded);
			}
			return padded;
		});
	}

	/** Project/branch/diff header, followed by a blank row when anything is shown. */
	private renderHeader(
		theme: any,
		items: ReturnType<typeof loadConfig>["sidePanelItems"],
		contentWidth: number,
		lines: string[],
	): void {
		if (this.region !== "all" && this.region !== "header") return;
		const showProject = items.directory && this.state.projectDirectory;
		const showBranch = items.branch && this.state.gitInfo?.branch;
		const showDiff = items.diff && this.state.gitInfo && (this.state.gitInfo.insertions > 0 || this.state.gitInfo.deletions > 0);
		if (!showProject && !showBranch && !showDiff) return;
		if (showProject) {
			for (const line of wrapTextWithAnsi(`${theme.fg("warning", FOLDER_GLYPH)} ${theme.fg("text", this.state.projectDirectory)}`, contentWidth)) {
				lines.push(` ${line}`);
			}
		}
		if (showBranch || showDiff) {
			const branch = showBranch ? `${theme.fg("muted", BRANCH_GLYPH)} ${theme.fg("muted", this.state.gitInfo!.branch)}` : "";
			const diff = showDiff ? `${theme.fg("success", `+${this.state.gitInfo!.insertions}`)} ${theme.fg("error", `-${this.state.gitInfo!.deletions}`)}` : "";
			const metadata = [branch, diff].filter(Boolean).join(` ${DOT} `);
			for (const line of wrapTextWithAnsi(metadata, contentWidth)) lines.push(` ${line}`);
		}
		lines.push("");
	}

	/** Todo list; returns the `[start, end)` line range used for its background. */
	private renderTodos(
		theme: any,
		items: ReturnType<typeof loadConfig>["sidePanelItems"],
		contentWidth: number,
		lines: string[],
		add: (text: string, color?: string) => void,
	): [number, number] {
		const tasks = this.state.todoTasks;
		if ((this.region !== "all" && this.region !== "body") || !items.tasks || tasks.length === 0) return [-1, -1];
		const start = lines.length;
		lines.push("");
		const active = this.state.working && tasks[0]?.status === "in_progress";
		const complete = this.state.completedTodos === tasks.length;
		const glyph = complete ? "\u{EBB5}" : "\u{EBB4}"; // Nerd Font: circle / circle-filled.
		const variable = active ? "blue" : "yellow";
		const paint = complete ? null : themeVarPainter(theme, variable);
		const marker = complete ? theme.fg("dim", glyph)
			: paint ? paint(glyph)
				: theme.fg(active ? "mdLink" : "warning", glyph);
		const heading = `${marker} ${theme.fg(tasks[0]?.status === "in_progress" ? "accent" : "dim", `Todos (${this.state.completedTodos}/${tasks.length})`)}`;
		lines.push(` ${heading}`);
		lines.push("");
		const visible = this.state.tasksExpanded ? tasks : tasks.slice(0, 10);
		const hasIncompleteTasks = visible.some((item) => item.status !== "completed");
		let previousTaskWasCompleted = false;
		for (const task of visible) {
			if (task.status === "completed" && !previousTaskWasCompleted && hasIncompleteTasks) {
				lines.push(copyChrome(` ${theme.fg("borderMuted", "─".repeat(contentWidth))}`, contentWidth + 2));
			}

			let taskMarker = task.status === "completed" ? theme.fg("success", "✓") : theme.fg(task.status === "in_progress" ? "warning" : "dim", task.status === "in_progress" ? "◐" : "○");
			if (task.status === "in_progress" && this.state.working) {
				// Pi's existing working-indicator ticks repaint this frame; no second animation timer.
				taskMarker = this.animatedMarker(theme);
			}
			const prefix = `${taskMarker} ${theme.fg("dim", `${task.id}.`)} `;
			const prefixWidth = visibleWidth(prefix);
			let subject = theme.fg(task.status === "in_progress" ? "accent" : task.status === "completed" ? "muted" : "text", stripTerminalSequences(task.subject).replace(/\s+/g, " "));
			if (task.status === "completed") subject = theme.strikethrough?.(subject) ?? `\x1b[9m${subject}\x1b[29m`;
			const blockedBy = Array.isArray(task.blockedBy) ? task.blockedBy.filter((id) => typeof id === "number") : [];
			const continuation = " ".repeat(prefixWidth);
			for (const [row, line] of wrapTextWithAnsi(subject, Math.max(1, contentWidth - prefixWidth)).entries()) {
				lines.push(` ${row === 0 ? prefix : continuation}${line}`);
			}
			if (task.status === "in_progress" && typeof task.activeForm === "string") {
				for (const line of wrapTextWithAnsi(theme.fg("muted", `  ${stripTerminalSequences(task.activeForm).replace(/\s+/g, " ")}`), contentWidth)) lines.push(` ${line}`);
			}
			if (blockedBy.length) {
				for (const line of wrapTextWithAnsi(theme.fg("dim", `  ⛓ ${blockedBy.map((id) => `#${id}`).join(",")}`), contentWidth)) lines.push(` ${line}`);
			}
			previousTaskWasCompleted = task.status === "completed";
		}
		if (tasks.length > 10) {
			const label = this.state.tasksExpanded ? "Show fewer" : `+${tasks.length - 10} more`;
			this.moreRow = lines.length;
			this.moreWidth = visibleWidth(label);
			add(label, "accent");
		}
		lines.push("");
		return [start, lines.length];
	}

	/** Subagent list; returns the `[start, end)` range used for its background. */
	private renderAgents(
		theme: any,
		items: ReturnType<typeof loadConfig>["sidePanelItems"],
		contentWidth: number,
		lines: string[],
		tasksStart: number,
	): [number, number] {
		const subagents = this.state.subagents;
		if ((this.region !== "all" && this.region !== "body") || !items.subagents || subagents.length === 0) return [-1, -1];
		if (tasksStart >= 0) lines.push("");
		const start = lines.length;
		lines.push("");
		lines.push(` ${theme.fg("accent", "Agents")}`);
		lines.push("");
		for (const subagent of subagents) {
			const marker = subagent.status === "failed" ? theme.fg("error", "✗")
				: subagent.status === "done" ? theme.fg("success", "✓") : this.animatedMarker(theme);
			const name = theme.fg(subagent.status === "failed" ? "error" : subagent.status === "done" ? "muted" : "accent", subagent.name);
			for (const line of wrapTextWithAnsi(`${marker} ${name}`, contentWidth)) lines.push(` ${line}`);
			for (const line of wrapTextWithAnsi(theme.fg("text", `  ${subagent.task}`), Math.max(1, contentWidth - 2))) lines.push(` ${line}`);
			if (subagent.status === "working") {
				const toolNames = subagent.tools?.map((name) => stripTerminalSequences(name).replace(/\s+/g, " "));
				for (const line of wrapTextWithAnsi(theme.fg("muted", `  ↳ ${toolNames?.length ? toolNames.join(", ") : "thinking…"}`), Math.max(1, contentWidth - 2))) lines.push(` ${line}`);
			} else {
				const statusText = subagent.status === "failed" ? "↳ failed" : "↳ done";
				for (const line of wrapTextWithAnsi(theme.fg(subagent.status === "failed" ? "error" : "success", `  ${statusText}`), Math.max(1, contentWidth - 2))) lines.push(` ${line}`);
			}
			for (const line of wrapTextWithAnsi(theme.fg("dim", `  ${subagent.model}`), Math.max(1, contentWidth - 2))) lines.push(` ${line}`);
		}
		lines.push("");
		return [start, lines.length];
	}

	/** Context, cache-hit and Blackhole footer rows. */
	private renderFooter(
		theme: any,
		items: ReturnType<typeof loadConfig>["sidePanelItems"],
		contentWidth: number,
		lines: string[],
		add: (text: string, color?: string) => void,
	): void {
		if ((this.region !== "all" && this.region !== "footer") || (!items.context && !items.cacheHit && !items.blackhole)) return;
		const addRightAligned = (left: string, right: string, color?: string) => {
			const painted = color === undefined ? right : theme.fg(color, right);
			const gap = Math.max(1, contentWidth - visibleWidth(left) - visibleWidth(painted));
			add(`${left}${" ".repeat(gap)}${painted}`);
		};
		// One blank row of top padding above the footer, matching the padded
		// Todos/Agents blocks. The fullscreen footer is its own region, so it has
		// no preceding row to lean on; in regular mode the body already ends blank.
		let footerPadded = false;
		const ensureFooterPadding = () => {
			if (footerPadded) return;
			footerPadded = true;
			if (lines.length === 0 || lines.at(-1) !== "") lines.push("");
		};
		const usage = items.context ? this.state.contextInfo.getContextUsage?.() : undefined;
		const tokenUsage = this.state.contextInfo.getTokenUsage?.();
		const hasUsage = usage && (usage.percent != null || usage.tokens != null || usage.contextWindow > 0);
		const hasCacheUsage = tokenUsage && tokenUsage.cacheRead > 0;
		if (hasUsage) {
			const percent = usage?.percent == null ? "?" : `${Math.round(usage.percent)}%`;
			const percentColor = usage?.percent != null && usage.percent >= 85 ? "warning" : "accent";
			ensureFooterPadding();
			// Tokens, separator and percent share one right-aligned row: `Context  85k/1.0M · 8%`.
			const tokens = `${formatCompactTokens(usage?.tokens, "?")}/${formatCompactTokens(usage?.contextWindow, "?")}`;
			addRightAligned(theme.fg("muted", "Context"), `${theme.fg("dim", tokens)}${theme.fg("dim", ` ${DOT} `)}${theme.fg(percentColor, percent)}`);
			const meterWidth = Math.max(8, contentWidth);
			const ratio = usage?.percent == null ? 0 : usage.percent / 100;
			add(meterBar(meterWidth, ratio, percentColor, (color, text) => theme.fg(color, text)), "dim");
			if (hasCacheUsage || this.state.blackholeStatus) lines.push("");
		}
		if (tokenUsage && items.cacheHit && tokenUsage.cacheRead > 0) {
			const hit = cacheHitPercent(tokenUsage);
			if (hit !== null) {
				ensureFooterPadding();
				addRightAligned(theme.fg("muted", "Cache hit"), `${Math.round(hit)}%`, "dim");
			}
		}
		if (items.blackhole && this.state.blackholeStatus) {
			ensureFooterPadding();
			if (lines.length && lines.at(-1) !== "") lines.push("");
			add("Blackhole", "muted");
			// The formatter supplies the single space between each label and meter.
			const status = this.state.blackholeStatus.replace(/[ \t]*▕/g, "▕");
			const meters = [...status.matchAll(/▕[^▕▏]*▏/g)];
			const labelsWidth = visibleWidth(status.replace(/▕[^▕▏]*▏/g, " "));
			const meterWidth = meters.length ? Math.max(1, Math.floor((contentWidth - labelsWidth) / meters.length)) : Infinity;
			add(slimStatusText(status, (color, text) => theme.fg(color, text), meterWidth), "dim");
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.button !== "left") return;
		if (event.y !== this.moreRow || event.x < 1 || event.x >= 1 + this.moreWidth) return;
		if (event.type === "click") {
			this.state.setTasksExpanded(!this.state.tasksExpanded);
			return { handled: true, render: true };
		}
		if (event.type === "press" || event.type === "release") return { handled: true, render: false };
		return undefined;
	}

	private animatedMarker(theme: PanelTheme): string {
		if (!this.spinnerFrames.length) this.spinnerFrames = thinkingStyleFrames("claude", theme, "working", "accent");
		const period = Math.max(1, this.spinnerFrames.length * 2 - 2);
		const step = Math.floor(Date.now() / thinkingStyleFrameIntervalMs("claude")) % period;
		return this.spinnerFrames[step < this.spinnerFrames.length ? step : period - step] ?? theme.fg("accent", "·");
	}

	invalidate(): void { this.spinnerFrames = []; }
}

function rank(status: TodoTask["status"]): number {
	return status === "in_progress" ? 0 : status === "pending" ? 1 : 2;
}

function panelWidth(width: number, enabled: boolean): number {
	if (!enabled || width < 100) return 0;
	// Keep the panel readable without letting it consume a third of a wide chat.
	return Math.min(42, Math.max(32, Math.floor(width * 0.30)));
}

/** A native HStack, not an opaque render wrapper: Pi can still find its ScrollView and dock. */
class FullscreenSidePanel extends HStack {
	constructor(
		root: Component,
		panel: Component,
		private readonly renderer: Renderer,
		private readonly controller: SidePanelController,
		getTheme: () => unknown,
	) {
		const divider: Component = {
			render: () => Array(renderer.terminal.rows).fill(copyChrome(panelTheme(getTheme).fg("border", "│"), 1)),
			invalidate() {},
			handleMouse: (event) => event.button === "left" && (event.type === "press" || event.type === "click")
				? { handled: true, render: false } : undefined,
		};
		super([
			{ component: root, basis: 0, grow: 1 },
			{ component: new HStack([
				{ component: divider, basis: 1, grow: 0, shrink: 0 },
				{ component: new VStack([
					{ component: new SidePanelComponent(controller, getTheme, "header"), basis: "auto", grow: 0, shrink: 1 },
					{ component: new ScrollView(panel, { overscroll: "contain", scrollbar: "hidden" }), basis: 0, grow: 1, shrink: 0, minSize: 1 },
					{ component: new SidePanelComponent(controller, getTheme, "footer"), basis: "auto", grow: 0, shrink: 1 },
				]), basis: 0, grow: 1 },
			]), basis: 0, grow: 0, shrink: 0,
				visible: ({ width }) => panelWidth(width, controller.visible) > 0 },
		]);
	}

	private size(width: number): void {
		// Exact 70/30 sizing; native weighted growth is not an exact percentage allocator.
		this.entries[1].basis = panelWidth(width, this.controller.visible);
	}

	[LAYOUT_NODE](): unknown {
		this.size(this.renderer.terminal.columns);
		return (HStack.prototype as any)[LAYOUT_NODE].call(this);
	}

	override render(width: number): string[] {
		this.size(width);
		return super.render(width);
	}
}

/** Regular mode retains Pi's original children, scrollback, cursor and document height. */
function renderRegularPanel(renderer: Renderer, original: TUI["render"], panel: Component, getTheme: () => unknown, enabled: boolean, width: number, getEditorText?: () => string): string[] {
	const rightWidth = panelWidth(width, enabled);
	if (rightWidth === 0) return original.call(renderer, width);
	const leftWidth = width - rightWidth;
	const lines = original.call(renderer, leftWidth);
	const rightLines = panel.render(rightWidth - 1);
	const divider = panelTheme(getTheme).fg("border", "│");
	// Anchor to the visible tail, without adding rows beneath the input/footer.
	const top = Math.max(0, lines.length - renderer.terminal.rows);
	const output = lines.slice();
	// The regular renderer's screen-copy path reads these rows verbatim. Do not
	// append the sidebar divider to the editor area, otherwise multiline input
	// copies the split bar as part of the selected text.
	const editorText = getEditorText?.() ?? "";
	const editorLines = editorText.split("\n").map((line) => line.trim()).filter(Boolean);
	let editorStart = lines.length;
	const firstEditorLine = editorLines[0];
	if (firstEditorLine) {
		for (let index = lines.length - 1; index >= 0; index--) {
			const plain = stripTerminalSequences(lines[index] ?? "");
			if (plain.includes(firstEditorLine)) {
				editorStart = index;
				break;
			}
		}
	}
	for (let row = top; row < Math.min(lines.length, editorStart); row++) {
		const right = compositeTuiLine(divider, rightLines[row - top] ?? "", 1, rightWidth - 1, rightWidth);
		output[row] = compositeTuiLine(lines[row], right, leftWidth, rightWidth, width);
	}
	return output;
}

/** Unwrap the previous faulty version when updating with /reload instead of restarting. */
function repairLegacyLayout(host: LayoutHost): void {
	const legacy = host.fullscreenLayoutRoot as Component & { [LEGACY_LAYOUT]?: boolean; baseRoot?: Component };
	if (legacy?.[LEGACY_LAYOUT] && legacy.baseRoot) host.fullscreenLayoutRoot = legacy.baseRoot;
	const child = host.renderer.children.length === 1 ? host.renderer.children[0] as Component & {
		[LEGACY_LAYOUT]?: boolean; baseComponents?: Component[];
	} : undefined;
	if (child?.[LEGACY_LAYOUT] && child.baseComponents) {
		host.renderer.children.splice(0, 1, ...child.baseComponents);
	}
}

export class SidePanelController {
	private context: SidePanelContext = {};
	private unbindActivity: (() => void) | undefined;
	private renderer: Renderer | undefined;
	private uninstall: (() => void) | undefined;
	private todoTaskList: TodoTask[] = [];
	private completedTaskCount = 0;
	private subagentRows: SubagentRow[] = [];
	private model = "";
	private blackholeStatusValue = "";
	private enabled = false;
	private taskInProgress = false;
	private expanded = false;
	private projectDirectoryValue = "";
	private gitInfoValue: GitStatus | undefined;
	private refreshGitInfo = (): void => {
		if (!this.enabled) return;
		this.ensureGitInfo();
		this.renderer?.requestRender();
	};

	bind(context: SidePanelContext, visible: boolean): void {
		this.unbindActivity?.();
		this.unbindActivity = context.sessionId ? bindSubagentActivity(context.sessionId, () => this.syncSubagentActivity()) : undefined;
		this.reset();
		this.context = context;
		this.enabled = visible;
		this.projectDirectoryValue = context.cwd ? basename(context.cwd) : "";
		this.ensureGitInfo();
		this.renderer?.requestRender();
	}

	install(host: LayoutHost, getTheme: () => unknown): void {
		this.uninstall?.();
		this.uninstall = undefined;
		repairLegacyLayout(host);
		const renderer = host.renderer;
		if (!renderer?.terminal || typeof renderer.render !== "function") return;
		this.renderer = renderer;
		const panel = new SidePanelComponent(this, getTheme, renderer.mode === "fullscreen" ? "body" : "all");
		if (renderer.mode === "fullscreen") {
			// Do not alter host.fullscreenLayoutRoot: Pi reuses it during renderer switches.
			const base = host.fullscreenLayoutRoot;
			if (!base || typeof renderer.setLayoutRoot !== "function" || typeof (HStack.prototype as any)[LAYOUT_NODE] !== "function") return;
			const root = new FullscreenSidePanel(base, panel, renderer, this, getTheme);
			renderer.setLayoutRoot(root);
			// ScrollView selections are already pane-local. Screen selections stay
			// in their STARTING pane, even when a drag crosses the divider.
			const selectionRenderer = renderer as Renderer & {
				selectionAnchor?: { col: number; scrollView?: unknown };
				getSelectionColumns?: (...args: any[]) => { start: number; end: number };
				getSelectionPoint?: (...args: any[]) => { col: number; scrollView?: unknown };
			};
			const originalColumns = selectionRenderer.getSelectionColumns;
			const wrappedColumns = (line: string, row: number, selection: any, minColumn = 0, maxColumn = visibleWidth(line)) => {
				const rightWidth = panelWidth(renderer.terminal.columns, this.enabled);
				const leftWidth = renderer.terminal.columns - rightWidth;
				if (rightWidth && !selection.start.scrollView && !selection.end.scrollView) {
					const anchor = selectionRenderer.selectionAnchor?.col ?? selection.start.col;
					if (anchor < leftWidth) maxColumn = Math.min(maxColumn, leftWidth);
					else minColumn = Math.max(minColumn, leftWidth + 1);
				}
				return originalColumns!.call(renderer, line, row, selection, minColumn, maxColumn);
			};
			if (originalColumns) installPatch(selectionRenderer, "getSelectionColumns", "side-panel.selection", () => wrappedColumns);
			const controllerVisible = () => this.enabled;
			installPatch(selectionRenderer, "getSelectionPoint", "pi-sleek.side-panel.selection-point", (original) =>
				function (this: unknown, event: { button: number; release?: boolean }, ...args: unknown[]) {
					const point = original.call(this, event, ...args);
					const rightWidth = panelWidth(renderer.terminal.columns, controllerVisible());
					const anchor = selectionRenderer.selectionAnchor;
					if (rightWidth && anchor && !anchor.scrollView && !point.scrollView && (event.release || (event.button & 32) !== 0)) {
						const leftWidth = renderer.terminal.columns - rightWidth;
						point.col = anchor.col < leftWidth ? Math.min(point.col, leftWidth - 1) : Math.max(point.col, leftWidth + 1);
					}
					return point;
				});
			this.uninstall = () => {
				uninstallPatch(selectionRenderer, "getSelectionColumns", "side-panel.selection");
				uninstallPatch(selectionRenderer, "getSelectionPoint", "pi-sleek.side-panel.selection-point");
				if (renderer.layoutRoot === root) renderer.setLayoutRoot?.(base);
			};
		} else {
			installPatch(renderer, "render", "side-panel.regular", (original) =>
				(width: number) => renderRegularPanel(renderer, original, panel, getTheme, this.enabled, width, () => this.context.getEditorText?.() ?? ""));
			this.uninstall = () => uninstallPatch(renderer, "render", "side-panel.regular");
		}
		renderer.requestRender();
	}

	setVisible(visible: boolean): void {
		this.enabled = visible;
		if (visible) this.ensureGitInfo();
		this.renderer?.invalidate();
		this.renderer?.requestRender();
	}

	get visible(): boolean { return this.enabled; }
	get shown(): boolean { return this.uninstall !== undefined && panelWidth(this.renderer?.terminal.columns ?? 0, this.enabled) > 0; }
	get tasksExpanded(): boolean { return this.expanded; }
	setTasksExpanded(expanded: boolean): void { this.expanded = expanded; this.renderer?.requestRender(); }

	setModel(model: SidePanelModel | undefined): void {
		this.model = model?.id ?? "";
		this.renderer?.requestRender();
	}

	setTodoDetails(details: unknown): void {
		const tasks = todoTasksFromDetails(details);
		if (tasks === undefined) return;
		this.todoTaskList = tasks;
		this.completedTaskCount = tasks.filter((task) => task.status === "completed").length;
		this.renderer?.requestRender();
	}

	setSubagentsFromBranch(branch: Iterable<unknown>): void {
		this.subagentRows = [];
		for (const entry of branch) {
			if (!entry || typeof entry !== "object") continue;
			const saved = entry as { type?: string; message?: any };
			const message = saved.type === "custom_message" ? entry : saved.message;
			if (!message || typeof message !== "object") continue;
			const value = message as any;
			if (value.role === "assistant" && Array.isArray(value.content)) {
				for (const call of value.content) {
					if (call?.type === "toolCall" && ["Agent", "subagent"].includes(call.name) && typeof call.id === "string") {
						this.startSubagents(call.id, call.arguments, "inherited");
					}
				}
			}
			if (value.role === "toolResult" && typeof value.toolCallId === "string") {
				if (value.toolName === "Agent") this.finishAgentTool(value.toolCallId, value, value.isError);
				if (value.toolName === "subagent") this.finishSubagents(value.toolCallId, value, value.isError);
			}
			this.handleSubagentMessage(message);
		}
		this.syncSubagentActivity();
	}

	setTodoTasksFromBranch(branch: Iterable<unknown>): void {
		this.todoTaskList = [];
		for (const entry of branch) {
			if (!entry || typeof entry !== "object") continue;
			const e = entry as {
				type?: string;
				customType?: string;
				data?: unknown;
				message?: { role?: string; toolName?: string; details?: unknown };
			};
			let tasks: TodoTask[] | undefined;
			if (e.type === "custom" && e.customType === "todos.state") tasks = todoTasksFromDetails(e.data);
			if (e.type === "message" && e.message?.role === "toolResult"
				&& isTodoTool(e.message.toolName ?? "")) {
				tasks = todoTasksFromDetails(e.message.details);
			}
			if (tasks !== undefined) this.todoTaskList = tasks;
		}
		this.completedTaskCount = this.todoTaskList.filter((task) => task.status === "completed").length;
		this.renderer?.requestRender();
	}

	startAgent(): void { this.taskInProgress = true; this.renderer?.requestRender(); }

	startSubagents(toolCallId: string, args: unknown, inheritedModel: string): void {
		const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
		const requested: Array<{ name: string; task: string; model?: string; prompt?: string }> = [];
		const add = (value: unknown) => {
			if (!value || typeof value !== "object") return;
			const item = value as Record<string, unknown>;
			if (typeof item.agent !== "string" && typeof item.prompt !== "string") return;
			requested.push({ name: typeof item.agent === "string" ? item.agent : "general-purpose", task: typeof item.task === "string" ? item.task : typeof item.description === "string" ? item.description : typeof item.prompt === "string" ? item.prompt : "working", model: typeof item.model === "string" ? item.model : undefined, prompt: typeof item.prompt === "string" ? item.prompt : typeof item.task === "string" ? item.task : undefined });
		};
		add(input);
		for (const key of ["tasks", "chain"]) if (Array.isArray(input[key])) for (const item of input[key] as unknown[]) add(item);
		if (!requested.length) return;
		this.subagentRows = [
			...this.subagentRows.filter((row) => row.status === "working" && !row.id.startsWith(`${toolCallId}:`)),
			...requested.map((agent, index): SubagentRow => ({ id: `${toolCallId}:${index}`, name: agent.name, model: agent.model ?? (inheritedModel || "inherited"), task: agent.task, prompt: agent.prompt, status: "working" })),
		];
		this.renderer?.requestRender();
	}

	updateSubagents(toolCallId: string, partial: unknown): void {
		const details = partial && typeof partial === "object" ? (partial as { details?: unknown }).details : undefined;
		const results = details && typeof details === "object" ? (details as { results?: unknown }).results : undefined;
		if (!Array.isArray(results)) return;
		for (const result of results) {
			if (!result || typeof result !== "object") continue;
			const item = result as Record<string, unknown>;
			const row = this.subagentRows.find((candidate) => candidate.id.startsWith(`${toolCallId}:`) && candidate.name === item.agent);
			if (!row) continue;
			if (typeof item.model === "string") row.model = item.model;
			if (typeof item.task === "string") row.task = item.task;
			if (agentFailed(item)) row.status = "failed";
			else if (typeof item.exitCode === "number" && item.exitCode !== -1 && row.status !== "failed") row.status = "done";
		}
		this.renderer?.requestRender();
	}

	finishSubagents(toolCallId: string, result: unknown, isError = false): void {
		const details = result && typeof result === "object" ? (result as { details?: unknown }).details : undefined;
		this.updateSubagents(toolCallId, { details });
		for (const row of this.subagentRows) {
			if (!row.id.startsWith(`${toolCallId}:`)) continue;
			if (isError || agentFailed(result)) row.status = "failed";
			else if (row.status !== "failed") row.status = "done";
		}
		this.renderer?.requestRender();
	}
	finishAgentTool(toolCallId: string, result: unknown, isError = false): void {
		const details = result && typeof result === "object" ? (result as { details?: Record<string, unknown> }).details : undefined;
		for (const row of this.subagentRows) {
			if (!row.id.startsWith(`${toolCallId}:`)) continue;
			if (typeof details?.agentId === "string") row.agentId = details.agentId;
			if (typeof details?.modelId === "string") row.model = details.modelId;
			if (typeof details?.description === "string") row.task = details.description;
			if (isError || agentFailed(result)) row.status = "failed";
			else if (row.status !== "failed") row.status = details?.status === "running" || details?.status === "queued" ? "working" : "done";
		}
		this.renderer?.requestRender();
	}

	handleSubagentMessage(message: unknown): void {
		if (!message || typeof message !== "object") return;
		const custom = message as { customType?: string; content?: unknown; details?: Record<string, unknown> };
		if (custom.customType !== "subagent-result") return;
		// pi-subagents-lite puts the short agent id in the notification text,
		// not its details. Match that id to distinguish concurrent same-type agents.
		const id = typeof custom.content === "string" ? custom.content.match(/^\[Subagent "[^"]+" (\S+) /)?.[1] : undefined;
		const row = id ? this.subagentRows.find((candidate) => candidate.agentId?.startsWith(id)) : undefined;
		if (!row) return;
		if (agentFailed(custom) || /\s(?:error|failed)\]/.test(typeof custom.content === "string" ? custom.content.split("\n")[0] : "")) row.status = "failed";
		else if (row.status !== "failed") row.status = "done";
		if (typeof custom.details?.modelId === "string") row.model = custom.details.modelId;
		this.renderer?.requestRender();
	}

	setBlackholeStatus(text: unknown): void {
		this.blackholeStatusValue = typeof text === "string" ? text.trim() : "";
		this.renderer?.requestRender();
	}
	finishAgent(): void { this.taskInProgress = false; this.renderer?.requestRender(); }
	get todoTasks(): readonly TodoTask[] { return this.todoTaskList; }
	get completedTodos(): number { return this.completedTaskCount; }
	private syncSubagentActivity(): void {
		for (const row of this.subagentRows) row.tools = [];
		for (const child of getSubagentActivities()) {
			const row = this.subagentRows.find((candidate) => candidate.id === child.parentRowId || candidate.agentId?.startsWith(child.agentId))
				?? (!child.settled ? this.subagentRows.find((candidate) => candidate.status === "working" && !candidate.agentId && candidate.prompt === child.prompt) : undefined);
			if (!row) continue;
			child.parentRowId ??= row.id;
			row.agentId ??= child.agentId;
			row.model = child.model || row.model;
			if (child.settled && row.status !== "failed") row.status = "done";
			row.tools = row.status === "working" ? [...new Set(child.tools.values())] : [];
		}
		this.renderer?.requestRender();
	}
	get subagents(): readonly SubagentRow[] { return this.subagentRows; }
	get working(): boolean { return this.taskInProgress; }
	get modelName(): string { return this.model; }
	get blackholeStatus(): string { return this.blackholeStatusValue; }
	get contextInfo(): SidePanelContext { return this.context; }
	get projectDirectory(): string { return this.projectDirectoryValue; }
	get gitInfo(): GitStatus | undefined { return this.gitInfoValue; }

	ensureGitInfo(): void {
		const cwd = this.context.cwd;
		if (!cwd || !this.enabled || (this.renderer && !panelWidth(this.renderer.terminal.columns, true))) return;
		this.gitInfoValue = getGitStatus(cwd, this.refreshGitInfo);
	}

	/** Clear all per-session state (shared by `bind` and `dispose`). */
	private reset(): void {
		this.context = {};
		this.todoTaskList = [];
		this.completedTaskCount = 0;
		this.subagentRows = [];
		this.enabled = false;
		this.taskInProgress = false;
		this.expanded = false;
		this.projectDirectoryValue = "";
		this.gitInfoValue = undefined;
		this.model = "";
		this.blackholeStatusValue = "";
	}

	dispose(): void {
		this.unbindActivity?.();
		this.unbindActivity = undefined;
		this.uninstall?.();
		this.uninstall = undefined;
		this.renderer = undefined;
		this.reset();
	}
}

export function installSidePanelLayout(InteractiveModeClass: unknown, controller: SidePanelController, getTheme: () => unknown, onMount?: (host: LayoutHost) => void): void {
	const prototype = (InteractiveModeClass as { prototype?: unknown } | undefined)?.prototype;
	// Preserve Todo/subagent widgets and their lifecycle; only hide duplicate dock
	// rendering while the sidebar is actually visible (not merely enabled).
	installPatch(prototype, "renderWidgetContainer", "pi-sleek.side-panel.todos", (original) =>
		function (this: unknown, container: unknown, widgets: Map<string, Component>, ...args: unknown[]): unknown {
			if (widgets.has("pi-sleek.lifecycle-bind")) {
				const host = this as LayoutHost & { showLoadedResources?: (options: unknown) => void };
				controller.install(host, getTheme);
				onMount?.(host);
				host.showLoadedResources?.({ force: false, showDiagnosticsWhenQuiet: true });
			}
			const display = new Map(widgets);
			for (const key of ["rpiv-todos", "todo-list", "todos", "agents"]) {
				const widget = widgets.get(key);
				if (!widget) continue;
				display.set(key, {
					render: (width) => controller.shown ? [] : widget.render(width),
					invalidate: () => widget.invalidate(),
					handleInput: (data) => { if (!controller.shown) widget.handleInput?.(data); },
					handleMouse: (event) => controller.shown ? undefined : widget.handleMouse?.(event),
				});
			}
			return original.call(this, container, display, ...args);
		},
	);
	installPatch(prototype, "mountInteractiveTui", "pi-sleek.side-panel.mount", (original) =>
		function (this: LayoutHost, nextUi: Renderer, components: Component[], ...args: unknown[]): unknown {
			const result = original.call(this, nextUi, components, ...args);
			const host = { renderer: nextUi, fullscreenLayoutRoot: this.fullscreenLayoutRoot };
			controller.install(host, getTheme);
			onMount?.(host);
			return result;
		},
	);
	// Mount runs before startup extensions bind, and is NOT called on /reload/new/resume.
	// Sleek sets its editor on every bind, so this also replaces stale layout closures.
	installPatch(prototype, "setCustomEditorComponent", "pi-sleek.side-panel.bind", (original) =>
		function (this: LayoutHost, ...args: unknown[]): unknown {
			const result = original.apply(this, args);
			if (args[0]) { controller.install(this, getTheme); onMount?.(this); }
			return result;
		},
	);
}
