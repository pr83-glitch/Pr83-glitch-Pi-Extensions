// Split-diff renderer — side-by-side diff view with syntax highlighting and inline emphasis.
// Ported from pi-zazz (itself adapted from nielpattin/dotfiles diff-renderer.ts).

import type { Theme } from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import { bgHexAnsi, keepAnsiBackgroundAcrossResets, parseAnsiColorCode, stripAnsi } from "./theme/ansi.js";
import { blendRgb, rgbToHex, type Rgb } from "./theme/color.js";
import { safeTruncateToWidth, safeVisibleWidth } from "./render-budget.js";
import { copyChrome, copyMetadata } from "./core/copy-selection.js";

// ── Types ──────────────────────────────────────────────────────────

type DiffLine = {
	prefix: "+" | "-" | " ";
	line: string;
	lineNumber: string;
};

type SplitDiffRow = {
	kind: "context" | "changed" | "added" | "removed";
	left?: DiffLine;
	right?: DiffLine;
};

type CellLineKind = "add" | "remove" | "context";

type DiffSpan = { start: number; end: number };

type DiffPalette = {
	addRowBgAnsi: string;
	removeRowBgAnsi: string;
	addEmphasisBgAnsi: string;
	removeEmphasisBgAnsi: string;
};

// ── Constants ──────────────────────────────────────────────────────

const BG_ANSI_PATTERN = /\x1b\[(?:4\d|10\d|48;5;\d{1,3}|48;2;\d{1,3};\d{1,3};\d{1,3}|49)m/g;

const ADD_ROW_BACKGROUND_MIX_RATIO = 0.24;
const REMOVE_ROW_BACKGROUND_MIX_RATIO = 0.12;
const ADD_INLINE_EMPHASIS_MIX_RATIO = 0.44;
const REMOVE_INLINE_EMPHASIS_MIX_RATIO = 0.26;

// ── Diff background palette ───────────────────────────────────────

function rgbToBgAnsi(theme: Theme, color: Rgb): string {
	return bgHexAnsi(theme, rgbToHex(color));
}

function resolveDiffPalette(theme: Theme): DiffPalette {
	const baseBg =
		parseAnsiColorCode(theme.getBgAnsi("toolSuccessBg")) ?? parseAnsiColorCode(theme.getBgAnsi("toolPendingBg")) ?? { r: 32, g: 35, b: 42 };
	const addFg = parseAnsiColorCode(theme.getFgAnsi("toolDiffAdded")) ?? { r: 88, g: 173, b: 88 };
	const removeFg = parseAnsiColorCode(theme.getFgAnsi("toolDiffRemoved")) ?? { r: 196, g: 98, b: 98 };

	const addRowBg = blendRgb(baseBg, addFg, ADD_ROW_BACKGROUND_MIX_RATIO);
	const removeRowBg = blendRgb(baseBg, removeFg, REMOVE_ROW_BACKGROUND_MIX_RATIO);
	const addEmphasisBg = blendRgb(baseBg, addFg, ADD_INLINE_EMPHASIS_MIX_RATIO);
	const removeEmphasisBg = blendRgb(baseBg, removeFg, REMOVE_INLINE_EMPHASIS_MIX_RATIO);

	return {
		addRowBgAnsi: rgbToBgAnsi(theme, addRowBg),
		removeRowBgAnsi: rgbToBgAnsi(theme, removeRowBg),
		addEmphasisBgAnsi: rgbToBgAnsi(theme, addEmphasisBg),
		removeEmphasisBgAnsi: rgbToBgAnsi(theme, removeEmphasisBg),
	};
}

// ── ANSI background helpers ────────────────────────────────────────

function applyBackgroundToVisibleRange(
	ansiText: string,
	start: number,
	end: number,
	backgroundAnsi: string,
	restoreBackgroundAnsi: string,
): string {
	if (!ansiText || start >= end || end <= 0) return ansiText;

	let output = "";
	let visibleIndex = 0;
	let index = 0;
	let inRange = false;

	while (index < ansiText.length) {
		if (ansiText[index] === "\x1b") {
			const sequenceEnd = ansiText.indexOf("m", index);
			if (sequenceEnd !== -1) {
				output += ansiText.slice(index, sequenceEnd + 1);
				index = sequenceEnd + 1;
				continue;
			}
		}

		if (visibleIndex === start && !inRange) {
			output += backgroundAnsi;
			inRange = true;
		}
		if (visibleIndex === end && inRange) {
			output += restoreBackgroundAnsi;
			inRange = false;
		}

		output += ansiText[index] ?? "";
		visibleIndex++;
		index++;
	}

	if (inRange) output += restoreBackgroundAnsi;
	return output;
}

// ── Text utilities ─────────────────────────────────────────────────

function sanitizeSingleLineText(value: string): string {
	return value.replace(/\r/g, "").replace(/\n/g, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function stripInlineBreaksPreserveAnsi(value: string): string {
	return value.replace(/\r/g, "").replace(/\n/g, "");
}

function fitToWidth(value: string, width: number): string {
	const safeWidth = Math.max(1, width);
	return padRenderedLineWidth(safeTruncateToWidth(value, safeWidth), safeWidth);
}

function padRenderedLineWidth(line: string, width: number): string {
	const safeWidth = Math.max(1, width);
	const current = safeVisibleWidth(stripAnsi(line));
	if (current >= safeWidth) return line;
	return line + " ".repeat(safeWidth - current);
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function wrapPlainText(text: string, width: number, maxLines = Infinity): string[] {
	const safeWidth = Math.max(1, width);
	const lines: string[] = [];
	let current = "";
	let cells = 0;
	// Segment lazily: collapsed diffs never allocate a whole long line's graphemes.
	for (const { segment } of graphemeSegmenter.segment(text)) {
		const size = safeVisibleWidth(segment);
		if (cells + size > safeWidth && current) {
			lines.push(current);
			if (lines.length >= maxLines) return lines;
			current = "";
			cells = 0;
		}
		current += segment;
		cells += size;
	}
	if (lines.length < maxLines) lines.push(current);
	return lines;
}

// ── Diff parsing ───────────────────────────────────────────────────

function parseLineNumber(value: string): number | undefined {
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) return undefined;
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function makeDiffLine(prefix: "+" | "-" | " ", lineNumber: string | number | undefined, line: string): DiffLine {
	return {
		prefix,
		lineNumber: lineNumber === undefined ? "" : String(lineNumber),
		line,
	};
}

function parseDiffLine(rawLine: string): DiffLine | undefined {
	const match = rawLine.match(/^([+\- ])\s?(.*)$/);
	if (!match) return undefined;
	const [, prefix, rest = ""] = match;
	if (prefix !== "+" && prefix !== "-" && prefix !== " ") return undefined;

	const gutterMatch = rest.match(/^(\d+)\s(.*)$/);
	const lineNumber = gutterMatch?.[1] ?? "";
	const line = gutterMatch?.[2] ?? rest;
	const cleanLineNumber = sanitizeSingleLineText(lineNumber);
	const cleanLine = sanitizeSingleLineText(line).replace(/\t/g, "    ");
	return { prefix, lineNumber: cleanLineNumber, line: cleanLine };
}

function computeInlineDiffSpans(leftLine: string, rightLine: string): { left: DiffSpan[]; right: DiffSpan[] } {
	if (leftLine === rightLine) return { left: [], right: [] };
	if (leftLine.length + rightLine.length > 24000) return { left: [{ start: 0, end: leftLine.length }], right: [{ start: 0, end: rightLine.length }] };
	const left = Array.from(graphemeSegmenter.segment(leftLine));
	const right = Array.from(graphemeSegmenter.segment(rightLine));
	let prefix = 0;
	while (prefix < Math.min(left.length, right.length) && left[prefix]!.segment === right[prefix]!.segment) prefix++;
	let li = left.length;
	let ri = right.length;
	while (li > prefix && ri > prefix && left[li - 1]!.segment === right[ri - 1]!.segment) { li--; ri--; }
	const start = left[prefix]?.index ?? leftLine.length;
	const leftEnd = left[li]?.index ?? leftLine.length;
	const rightEnd = right[ri]?.index ?? rightLine.length;
	const leftSpan = leftEnd > start ? [{ start, end: leftEnd }] : [];
	const rightSpan = rightEnd > start ? [{ start, end: rightEnd }] : [];
	return { left: leftSpan, right: rightSpan };
}

// ── Exported helpers ───────────────────────────────────────────────

export function buildSplitRows(diff: string): SplitDiffRow[] {
	const rows: SplitDiffRow[] = [];
	let pendingLeft: DiffLine[] = [];
	let pendingRight: DiffLine[] = [];
	let oldCursor: number | undefined;
	let newCursor: number | undefined;

	const flushPending = () => {
		const count = Math.max(pendingLeft.length, pendingRight.length);
		for (let index = 0; index < count; index++) {
			const left = pendingLeft[index];
			const right = pendingRight[index];
			if (left && right) rows.push({ kind: "changed", left, right });
			else if (left) rows.push({ kind: "removed", left });
			else if (right) rows.push({ kind: "added", right });
		}
		pendingLeft = [];
		pendingRight = [];
	};

	for (const rawLine of diff.split("\n")) {
		const parsed = parseDiffLine(rawLine);
		if (!parsed) continue;

		const parsedNum = parseLineNumber(parsed.lineNumber);
		if (parsed.prefix === "-") {
			const oldNum = parsedNum ?? oldCursor;
			if (oldNum !== undefined) oldCursor = oldNum + 1;
			pendingLeft.push(makeDiffLine("-", oldNum, parsed.line));
			continue;
		}
		if (parsed.prefix === "+") {
			const newNum = parsedNum ?? newCursor;
			if (newNum !== undefined) newCursor = newNum + 1;
			pendingRight.push(makeDiffLine("+", newNum, parsed.line));
			continue;
		}

		flushPending();

		const oldNum = parsedNum ?? oldCursor;
		const newNum = newCursor ?? oldNum;
		if (oldNum !== undefined) oldCursor = oldNum + 1;
		if (newNum !== undefined) newCursor = newNum + 1;

		rows.push({
			kind: "context",
			left: makeDiffLine(" ", oldNum, parsed.line),
			right: makeDiffLine(" ", newNum, parsed.line),
		});
	}

	flushPending();
	return rows;
}

export function countDiffStats(diff: string): { additions: number; removals: number } {
	let additions = 0;
	let removals = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) additions += 1;
		if (line.startsWith("-")) removals += 1;
	}
	return { additions, removals };
}

export function renderDiffMeter(theme: Theme, additions: number, removals: number, width = 20): string {
	const total = additions + removals;
	if (total <= 0) return "";

	const addBlocks = Math.round((additions / total) * width);
	const removeBlocks = Math.max(0, width - addBlocks);
	const addBar = addBlocks > 0 ? theme.fg("toolDiffAdded", "━".repeat(addBlocks)) : "";
	const removeBar = removeBlocks > 0 ? theme.fg("toolDiffRemoved", "━".repeat(removeBlocks)) : "";
	return `${theme.fg("dim", "[")}${addBar}${removeBar}${theme.fg("dim", "]")}`;
}

export function extractEditedPath(message: string): string | undefined {
	const m = message.match(/Successfully replaced (?:text|\d+ block\(s\)|lines L\d+-\d+) in (.+)\.$/);
	return m?.[1];
}

export function firstText(content: Array<{ type: string; text?: string }>): string {
	for (const part of content) {
		if (part.type === "text" && typeof part.text === "string") {
			return part.text;
		}
	}
	return "";
}

// ── SplitDiffComponent ─────────────────────────────────────────────

export class SplitDiffComponent implements Component {
	private cacheWidth?: number;
	private cacheLines?: string[];
	private readonly lineNumberWidth: number;
	private readonly highlightCache = new Map<string, string>();
	private readonly inlineHighlights = new WeakMap<DiffLine, DiffSpan[]>();
	private readonly palette: DiffPalette;
	private readonly containerBgAnsi: string;

	constructor(
		private readonly theme: Theme,
		private readonly rows: SplitDiffRow[],
		private readonly maxRows: number,
		private readonly language?: string,
	) {
		let maxDigits = 3;
		for (const row of rows) {
			const leftDigits = row.left?.lineNumber.trim().length ?? 0;
			const rightDigits = row.right?.lineNumber.trim().length ?? 0;
			maxDigits = Math.max(maxDigits, leftDigits, rightDigits);

			if (row.kind === "changed" && row.left && row.right) {
				const spans = computeInlineDiffSpans(row.left.line, row.right.line);
				if (spans.left.length > 0) this.inlineHighlights.set(row.left, spans.left);
				if (spans.right.length > 0) this.inlineHighlights.set(row.right, spans.right);
			}
		}
		this.lineNumberWidth = maxDigits;
		this.palette = resolveDiffPalette(theme);
		this.containerBgAnsi = theme.getBgAnsi("toolSuccessBg");
	}

	private getCellLineKind(kind: SplitDiffRow["kind"], side: "left" | "right"): CellLineKind {
		if (kind === "changed") return side === "left" ? "remove" : "add";
		if (kind === "removed" && side === "left") return "remove";
		if (kind === "added" && side === "right") return "add";
		return "context";
	}

	private getVisualLineKind(kind: SplitDiffRow["kind"], side: "left" | "right", line?: DiffLine): CellLineKind {
		const base = this.getCellLineKind(kind, side);
		if ((kind === "added" || kind === "removed") && (line?.line ?? "") === "") {
			return "context";
		}
		return base;
	}

	private getNumberColor(lineKind: CellLineKind): "toolDiffRemoved" | "toolDiffAdded" | "dim" {
		if (lineKind === "remove") return "toolDiffRemoved";
		if (lineKind === "add") return "toolDiffAdded";
		return "dim";
	}

	private getRowBackground(lineKind: CellLineKind): string | undefined {
		if (lineKind === "add") return this.palette.addRowBgAnsi;
		if (lineKind === "remove") return this.palette.removeRowBgAnsi;
		return undefined;
	}

	private getEmphasisBackground(lineKind: CellLineKind): string | undefined {
		if (lineKind === "add") return this.palette.addEmphasisBgAnsi;
		if (lineKind === "remove") return this.palette.removeEmphasisBgAnsi;
		return undefined;
	}

	private blankCell(kind: SplitDiffRow["kind"], side: "left" | "right", columnWidth: number): string {
		const lineKind = this.getCellLineKind(kind, side);
		const markerChar = lineKind === "add" || lineKind === "remove" ? "▌" : " ";
		const markerColor = lineKind === "add" ? "toolDiffAdded" : lineKind === "remove" ? "toolDiffRemoved" : "borderMuted";
		const marker = this.theme.fg(markerColor, markerChar);
		const lineNumber = this.theme.fg("dim", " ".repeat(this.lineNumberWidth));
		const divider = "  ";
		const prefix = `${marker} ${lineNumber}${divider}`;
		const prefixPlain = `${markerChar} ${" ".repeat(this.lineNumberWidth)}  `;
		const tailWidth = Math.max(0, columnWidth - safeVisibleWidth(prefixPlain));
		let rendered = prefix + " ".repeat(tailWidth);

		const bg = this.getRowBackground(lineKind);
		if (!bg) return fitToWidth(rendered, columnWidth);
		rendered = `${bg}${keepAnsiBackgroundAcrossResets(rendered, bg)}${this.containerBgAnsi}`;
		return fitToWidth(rendered, columnWidth);
	}

	private syntaxHighlight(line: string): string {
		if (!this.language) return stripInlineBreaksPreserveAnsi(line);
		const safeLine = sanitizeSingleLineText(line);
		const key = `${this.language}\n${safeLine}`;
		const cached = this.highlightCache.get(key);
		if (cached) return cached;

		let highlighted = safeLine;
		try {
			highlighted = highlightCode(safeLine, this.language)[0] ?? safeLine;
			highlighted = stripInlineBreaksPreserveAnsi(highlighted).replace(BG_ANSI_PATTERN, "");
		} catch {
			highlighted = safeLine;
		}
		this.highlightCache.set(key, highlighted);
		return highlighted;
	}

	private formatCellLines(
		kind: SplitDiffRow["kind"],
		side: "left" | "right",
		line: DiffLine | undefined,
		columnWidth: number,
		maxLines = Infinity,
	): string[] {
		if (!line) return [this.blankCell(kind, side, columnWidth)];

		const lineKind = this.getVisualLineKind(kind, side, line);
		const markerChar = lineKind === "add" || lineKind === "remove" ? "▌" : " ";
		const markerColor = lineKind === "add" ? "toolDiffAdded" : lineKind === "remove" ? "toolDiffRemoved" : "borderMuted";
		const lineNumber = line.lineNumber.trim().padStart(this.lineNumberWidth, " ");

		const firstPrefixAnsi =
			this.theme.fg(markerColor, markerChar) +
			" " +
			this.theme.fg(this.getNumberColor(lineKind), lineNumber) +
			this.theme.fg("borderMuted", "  ");
		const firstPrefixPlain = `${markerChar} ${lineNumber}  `;

		const contPrefixAnsi =
			this.theme.fg(markerColor, markerChar) +
			" " +
			this.theme.fg("dim", " ".repeat(this.lineNumberWidth)) +
			"  ";
		const contPrefixPlain = `${markerChar} ${" ".repeat(this.lineNumberWidth)}  `;

		const codeWidth = Math.max(1, columnWidth - safeVisibleWidth(firstPrefixPlain));
		const rowBg = this.getRowBackground(lineKind);
		const emphasisBg = this.getEmphasisBackground(lineKind);

		const plainSegments = wrapPlainText(line.line, codeWidth, maxLines);
		const lines: string[] = [];
		const spans = this.inlineHighlights.get(line) ?? [];

		let consumed = 0;
		for (let i = 0; i < plainSegments.length; i++) {
			const prefixAnsi = i === 0 ? firstPrefixAnsi : contPrefixAnsi;
			const prefixPlain = i === 0 ? firstPrefixPlain : contPrefixPlain;
			const plainSegment = plainSegments[i] ?? "";
			let segment = this.syntaxHighlight(plainSegment);

			if (spans.length > 0 && emphasisBg) {
				const segmentStart = consumed;
				for (let si = spans.length - 1; si >= 0; si--) {
					const span = spans[si];
					if (!span) continue;
					const localStart = Math.max(0, span.start - segmentStart);
					const localEnd = Math.min(plainSegment.length, span.end - segmentStart);
					if (localEnd > localStart) {
						segment = applyBackgroundToVisibleRange(
							segment,
							localStart,
							localEnd,
							emphasisBg,
							rowBg ?? this.containerBgAnsi,
						);
					}
				}
			}

			segment = fitToWidth(segment, codeWidth);
			let rendered = prefixAnsi + segment;

			// Defensive pad if prefix widths diverge because of unicode widths
			const expectedWidth = safeVisibleWidth(prefixPlain) + codeWidth;
			const currentWidth = safeVisibleWidth(stripAnsi(rendered));
			if (currentWidth < expectedWidth) {
				rendered += " ".repeat(expectedWidth - currentWidth);
			}

			if (rowBg) {
				rendered = `${rowBg}${keepAnsiBackgroundAcrossResets(rendered, rowBg)}${this.containerBgAnsi}`;
			}
			lines.push(fitToWidth(rendered, columnWidth));
			consumed += plainSegment.length;
		}

		return lines;
	}

	render(width: number): string[] {
		if (this.cacheWidth === width && this.cacheLines) return this.cacheLines;
		const safeWidth = Math.max(1, width);
		if (Math.floor((safeWidth - 1) / 2) < this.lineNumberWidth + 4 + 1) {
			const lines: string[] = [];
			for (const row of this.rows.slice(0, this.maxRows)) {
				const removed = () => this.theme.fg("toolDiffRemoved", `− ${row.left?.line ?? ""}`);
				const added = () => this.theme.fg("toolDiffAdded", `+ ${row.right?.line ?? ""}`);
				const content = row.kind === "context" ? this.theme.fg("muted", row.left?.line ?? "")
					: row.kind === "removed" ? removed()
						: row.kind === "added" ? added()
							: `${removed()} ${this.theme.fg("dim", "→")} ${added()}`;
				const removedWidth = safeVisibleWidth(`− ${row.left?.line ?? ""}`);
				const exclude: [number, number][] = row.kind === "context" ? []
					: row.kind === "changed" ? [[0, 2], [removedWidth + 3, removedWidth + 5]] : [[0, 2]];
				lines.push(copyMetadata(safeTruncateToWidth(content, safeWidth, "…"), { width: safeWidth, exclude }));
			}
			if (this.rows.length > this.maxRows) {
				lines.push(copyChrome(safeTruncateToWidth(this.theme.fg("muted", "… more diff (expand to view)"), safeWidth, "…"), safeWidth));
			}
			this.cacheWidth = width;
			this.cacheLines = lines;
			return lines;
		}
		const columnSeparator = " ";
		const separatorWidth = safeVisibleWidth(columnSeparator);
		const leftWidth = Math.max(1, Math.floor((safeWidth - separatorWidth) / 2));
		const rightWidth = Math.max(1, safeWidth - separatorWidth - leftWidth);

		const lines: string[] = [];
		let hasMore = false;

		for (const row of this.rows) {
			if (lines.length >= this.maxRows) { hasMore = true; break; }
			const remaining = this.maxRows - lines.length;
			// One bounded lookahead line distinguishes an exactly-full preview from
			// a truncated row without wrapping the entire remaining source.
			const leftCellLines = this.formatCellLines(row.kind, "left", row.left, leftWidth, remaining + 1);
			const rightCellLines = this.formatCellLines(row.kind, "right", row.right, rightWidth, remaining + 1);
			const rowHeight = Math.max(leftCellLines.length, rightCellLines.length);
			if (rowHeight > remaining) hasMore = true;

			for (let i = 0; i < Math.min(rowHeight, remaining); i++) {
				const leftFallbackKind: SplitDiffRow["kind"] = row.kind === "changed" ? "context" : row.kind;
				const rightFallbackKind: SplitDiffRow["kind"] = row.kind === "changed" ? "context" : row.kind;
				const leftCell = leftCellLines[i] ?? this.blankCell(leftFallbackKind, "left", leftWidth);
				const rightCell = rightCellLines[i] ?? this.blankCell(rightFallbackKind, "right", rightWidth);
				const joined = fitToWidth(leftCell + columnSeparator + rightCell, safeWidth);
				const gutter = this.lineNumberWidth + 4;
				lines.push(copyMetadata(joined, {
					width: safeWidth,
					columns: [[gutter, leftWidth], [leftWidth + separatorWidth + gutter, safeWidth]],
				}));
			}
		}

		if (hasMore) {
			lines.push(copyChrome(safeTruncateToWidth(this.theme.fg("muted", "… more diff (expand to view)"), safeWidth, "…"), safeWidth));
		}

		this.cacheWidth = width;
		this.cacheLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cacheWidth = undefined;
		this.cacheLines = undefined;
		this.highlightCache.clear();
	}
}
