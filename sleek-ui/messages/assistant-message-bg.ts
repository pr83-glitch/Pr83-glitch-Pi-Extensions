/**
 * Agent-message background.
 *
 * pi renders each assistant message as a `Container` whose text blocks are bare
 * `Markdown` children ("Assistant text messages with no background") while
 * thinking blocks are wrapped in a `MouseRegion` and tool calls live in separate
 * components. To style only the agent's prose, this patch wraps each text
 * `Markdown` child in a live style component just before the component renders —
 * thinking and tool blocks are never matched. The style follows
 * `sleek-agentMessageStyle` and offers bar, box and plain variants.
 *
 * Wrapping happens in `render` (not `updateContent`) so components that already
 * exist get picked up on the next frame: after a `/reload` or on a theme change.
 * Wrapped blocks are recognised on later frames, so the response footer is
 * (re)placed even when the component painted before its stats were seeded. A
 * `Text` footer is kept as a plain sibling just below the last block, outside the
 * tint. `updateContent` discards the wrappers by clearing the content tree, so
 * freshly built text blocks are re-wrapped on their next render.
 *
 * The tint uses the active theme's resolved `selectedBg` surface. This uses
 * `theme.getBgAnsi("selectedBg")`, so it works for hex themes and ANSI-palette
 * themes like `Terminal`; the style component reads the theme on every render,
 * so a theme switch takes effect on the next frame.
 *
 * Stateless apart from the reused footer `Text` (held on the component instance)
 * and installed through `core/patch-registry.ts`, so it is rebuilt on every bind
 * and unwound on shutdown.
 */
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

import { installPatch } from "../core/patch-registry.js";
import { copyChrome, copyMetadata } from "../core/copy-selection.js";
import { loadConfig } from "../config.js";
import { safeVisibleWidth } from "../render-budget.js";
import { themeBackgroundAnsi, wrapAnsiBackground } from "../theme/ansi.js";
import { BAR_GLYPH, BLOCK_MIN_WIDTH, BOX_SIDE_GLYPH, blockBoxFrame } from "./block-style.js";
import { buildResponseFooterLine } from "./response-footer.js";


export function installAssistantMessageBackground(getTheme: () => any): void {
	installPatch(
		(AssistantMessageComponent as { prototype: unknown }).prototype,
		"render",
		"pi-sleek.assistant-message-bg.render",
		(base: (this: any, width: number) => string[]) =>
			function patchedAssistantRender(this: any, width: number): string[] {
				decorateAssistantContent(this, getTheme, width);
				return base.call(this, width);
			},
	);
}

/** Marker on a text block we wrapped, and on the detached footer sibling + its state. */
const AGENT_BLOCK_FLAG = "__sleekAgentBlock";
const FOOTER_STATE = "__sleekResponseFooter";

/**
 * Wrap every raw text `Markdown` child in an `AgentStyleBlock`, then place the
 * response footer as a plain sibling just below the last block (outside the
 * tint). Re-evaluated on every render: an already-wrapped block is recognised,
 * so a component that painted before the stats were seeded still gains its
 * footer on the next frame.
 */
function decorateAssistantContent(component: any, getTheme: () => any, width: number): void {
	const children = component?.contentContainer?.children;
	if (!Array.isArray(children) || children.length === 0) return;
	const outputPad = Number(component?.outputPad) || 0;
	let lastTextIndex = -1;
	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		if (isMarkdownComponent(child)) {
			const block = new AgentStyleBlock(child, getTheme, outputPad);
			children[i] = block;
			lastTextIndex = i;
		} else if (child?.[AGENT_BLOCK_FLAG]) {
			lastTextIndex = i;
		}
	}
	// Only the LAST text run carries the metrics footer, so a message split by a
	// thinking block does not print it twice.
	updateResponseFooter(component, children, lastTextIndex, getTheme, width, outputPad);
}

/**
 * Keep the muted metrics footer a plain sibling right after the last agent text
 * block — one blank line below the tinted surface — so it sits outside the tint.
 * The container/`Text` pair is reused and only repositioned/updated when needed.
 */
function updateResponseFooter(
	component: any,
	children: any[],
	lastTextIndex: number,
	getTheme: () => any,
	width: number,
	outputPad: number,
): void {
	const state = (component[FOOTER_STATE] ??= { block: undefined as any, text: undefined as any });
	const block = state.block as any;
	const existingIndex = block ? children.indexOf(block) : -1;

	// The footer spans the same content width as the block's text; the Markdown
	// `outputPad` inset is the only outer padding.
	const sidePad = Math.max(Math.max(0, 1 - outputPad), outputPad);
	const innerWidth = Math.max(1, width - sidePad * 2);

	let line: string | undefined;
	if (lastTextIndex >= 0 && width > 0) {
		const theme = getTheme();
		if (theme) line = buildResponseFooterLine(theme, component?.lastMessage, innerWidth);
	}

	if (!line) {
		if (existingIndex !== -1) children.splice(existingIndex, 1);
		return;
	}

	if (!block) {
		state.block = new ResponseFooterBlock();
		state.text = new Text("", sidePad, 0);
		// One blank line between the agent block and the metrics row.
		state.block.addChild(new Spacer(1));
		state.block.addChild(state.text);
	}
	const footer = state.block;
	if (state.text.text !== line) state.text.setText(line);

	const targetIndex = Math.min(lastTextIndex + 1, children.length);
	if (existingIndex !== targetIndex) {
		if (existingIndex !== -1) children.splice(existingIndex, 1);
		children.splice(Math.min(targetIndex, children.length), 0, footer);
	}
}

class ResponseFooterBlock extends Container {
	override render(width: number): string[] {
		return super.render(width).map((line) => copyChrome(line, width));
	}
}

class AgentStyleBlock {
	[AGENT_BLOCK_FLAG] = true;

	constructor(private readonly child: any, private readonly getTheme: () => any, private readonly padding: number) {}

	render(width: number): string[] {
		const style = loadConfig().agentMessageStyle;
		const lines = style === "bar" ? this.renderBar(width)
			: style === "box" ? this.renderBox(width) : this.renderPlain(width);
		const boxed = style === "box" && width >= BLOCK_MIN_WIDTH;
		const rail = style === "bar" && width >= BLOCK_MIN_WIDTH;
		const left = (boxed ? 2 : rail ? 1 : 0) + Math.max(0, this.padding);
		const right = boxed ? 2 : rail ? 1 : 0;
		return lines.map((line, index) => boxed && (index === 0 || index === lines.length - 1)
			? copyChrome(line, width)
			: copyMetadata(line, { width, exclude: [[0, left], [width - right, width]] }));
	}

	invalidate(): void {
		this.child.invalidate?.();
	}

	private renderPlain(width: number): string[] {
		const theme = this.getTheme();
		const lines = this.child.render(width).map((line: string) => paintAgentLine(line, width, "", "", "", "", theme));
		const blank = paintAgentLine("", width, "", "", "", "", theme);
		return [blank, ...lines, blank];
	}

	private renderBar(width: number): string[] {
		if (width < BLOCK_MIN_WIDTH) return this.renderPlain(width);
		const contentWidth = width - 2;
		const theme = this.getTheme();
		const rail = typeof theme?.fg === "function" ? theme.fg("accent", BAR_GLYPH) : BAR_GLYPH;
		return this.child.render(contentWidth).map((line: string) => paintAgentLine(line, width, rail, BAR_GLYPH, "", " ", theme));
	}

	private renderBox(width: number): string[] {
		if (width < BLOCK_MIN_WIDTH) return this.renderPlain(width);
		const contentWidth = width - 4;
		const theme = this.getTheme();
		const border = (text: string): string => typeof theme?.fg === "function" ? theme.fg("border", text) : text;
		const lines = this.child.render(contentWidth).map((line: string) =>
			paintAgentLine(line, width, border(`${BOX_SIDE_GLYPH} `), `${BOX_SIDE_GLYPH} `, border(` ${BOX_SIDE_GLYPH}`), ` ${BOX_SIDE_GLYPH}`, theme, false));
		const [top, bottom] = blockBoxFrame(width, border);
		return [top, ...lines, bottom];
	}
}

function paintAgentLine(
	line: string,
	width: number,
	prefix: string,
	prefixPlain: string,
	suffix: string,
	suffixPlain: string,
	theme: any,
	background = true,
): string {
	const visible = safeVisibleWidth(line) + safeVisibleWidth(prefixPlain) + safeVisibleWidth(suffixPlain);
	const fill = " ".repeat(Math.max(0, width - visible));
	const rendered = `${prefix}${line}${fill}${suffix}`;
	return background ? assistantBackground(rendered, theme) : rendered;
}

/**
 * `instanceof` can miss when the host resolves a second copy of pi-tui, so fall
 * back to the (unminified) constructor name.
 */
function isMarkdownComponent(component: any): boolean {
	return component instanceof Markdown || component?.constructor?.name === "Markdown";
}

/** Paint a line on the theme's `selectedBg` surface; `""` leaves it plain. */
function assistantBackground(content: string, theme: any): string {
	if (!content) return content;
	// `selectedBg` is pi's semantic mapping to the theme's `bgSubtle` var.
	const ansi = themeBackgroundAnsi(theme, "selectedBg");
	return ansi ? wrapAnsiBackground(content, ansi) : content;
}
