import { truncateToWidth as tuiTruncateToWidth, visibleWidth as tuiVisibleWidth } from "@earendil-works/pi-tui";

const TRUNCATE_ELLIPSIS = "…";
const ANSI_RESET = "\x1b[0m";
const SGR_PREFIX_PATTERN = /^(?:\x1b\[[0-9;]*m)+/;
const SGR_SUFFIX_PATTERN = /(?:\x1b\[[0-9;]*m)+$/;

type SimpleSgrWrappedText = {
	prefix: string;
	body: string;
	suffix: string;
};

type FastTextKind = "ascii" | "sgrAscii" | "simple" | "sgrSimple";

type FastTextWidth = {
	visibleWidth: number;
	kind: FastTextKind;
};

type FastTruncateResult = {
	text: string;
	visibleWidth: number;
};

function isPrintableAsciiCode(code: number): boolean {
	return code >= 0x20 && code <= 0x7e;
}

function isSimpleWidthOneCode(code: number): boolean {
	return isPrintableAsciiCode(code);
}

function matchSimpleSgrWrappedText(text: string): SimpleSgrWrappedText | null {
	const prefixMatch = SGR_PREFIX_PATTERN.exec(text);
	const suffixMatch = SGR_SUFFIX_PATTERN.exec(text);
	if (!prefixMatch || !suffixMatch) return null;
	const prefix = prefixMatch[0];
	const suffix = suffixMatch[0];
	const bodyStart = prefix.length;
	const bodyEnd = suffixMatch.index;
	if (bodyEnd < bodyStart) return null;

	const body = text.slice(bodyStart, bodyEnd);
	const bodyWidth = knownVisibleWidth(body);
	if (!bodyWidth || bodyWidth.kind === "sgrAscii" || bodyWidth.kind === "sgrSimple") return null;
	return { prefix, body, suffix };
}

function readSgrSequenceEnd(text: string, offset: number): number {
	if (text.charCodeAt(offset) !== 0x1b || text[offset + 1] !== "[") return -1;
	let cursor = offset + 2;
	while (cursor < text.length) {
		const code = text.charCodeAt(cursor);
		if (code === 0x6d) return cursor + 1; // m
		if (code !== 0x3b && (code < 0x30 || code > 0x39)) return -1; // ; or 0-9
		cursor++;
	}
	return -1;
}

function knownVisibleWidth(text: string): FastTextWidth | null {
	let width = 0;
	let sawSgr = false;
	let sawSimpleGlyph = false;
	for (let i = 0; i < text.length;) {
		const sgrEnd = readSgrSequenceEnd(text, i);
		if (sgrEnd > i) {
			sawSgr = true;
			i = sgrEnd;
			continue;
		}
		const code = text.charCodeAt(i);
		if (!isSimpleWidthOneCode(code)) return null;
		if (!isPrintableAsciiCode(code)) sawSimpleGlyph = true;
		width++;
		i++;
	}
	if (sawSgr) return { visibleWidth: width, kind: sawSimpleGlyph ? "sgrSimple" : "sgrAscii" };
	return { visibleWidth: width, kind: sawSimpleGlyph ? "simple" : "ascii" };
}

function knownEllipsisWidth(text: string): number | null {
	if (text === TRUNCATE_ELLIPSIS) return 1;
	return knownVisibleWidth(text)?.visibleWidth ?? null;
}

function truncatePrintableAscii(text: string, width: number, ellipsis = TRUNCATE_ELLIPSIS): { text: string; visibleWidth: number } {
	if (width <= 0) return { text: "", visibleWidth: 0 };
	if (text.length <= width) return { text, visibleWidth: text.length };
	const ellipsisWidth = knownEllipsisWidth(ellipsis);
	if (ellipsisWidth === null) return { text: text.slice(0, width), visibleWidth: width };
	if (ellipsisWidth >= width) {
		if (ellipsis === TRUNCATE_ELLIPSIS) return { text: TRUNCATE_ELLIPSIS, visibleWidth: 1 };
		return { text: ellipsis.slice(0, width), visibleWidth: Math.min(width, ellipsis.length) };
	}
	const targetWidth = Math.max(0, width - ellipsisWidth);
	return { text: `${text.slice(0, targetWidth)}${ellipsis}`, visibleWidth: targetWidth + ellipsisWidth };
}

function truncateSgrAscii(text: string, width: number, ellipsis: string, visibleWidth: number): { text: string; visibleWidth: number } | null {
	if (visibleWidth <= width) return { text, visibleWidth };
	const ellipsisWidth = knownEllipsisWidth(ellipsis);
	if (ellipsisWidth === null) return null;
	if (ellipsisWidth >= width) return truncatePrintableAscii(ellipsis, width, "");

	const targetWidth = Math.max(0, width - ellipsisWidth);
	let keptWidth = 0;
	let output = "";
	for (let i = 0; i < text.length && keptWidth < targetWidth;) {
		const sgrEnd = readSgrSequenceEnd(text, i);
		if (sgrEnd > i) {
			output += text.slice(i, sgrEnd);
			i = sgrEnd;
			continue;
		}
		const code = text.charCodeAt(i);
		if (!isSimpleWidthOneCode(code)) return null;
		output += text[i] ?? "";
		keptWidth++;
		i++;
	}
	return { text: `${output}${ANSI_RESET}${ellipsis}${ANSI_RESET}`, visibleWidth: keptWidth + ellipsisWidth };
}

function fastTruncateText(text: string, width: number, ellipsis = TRUNCATE_ELLIPSIS): FastTruncateResult | null {
	const knownWidth = knownVisibleWidth(text);
	if (!knownWidth) return null;
	if (knownWidth.kind === "ascii" || knownWidth.kind === "simple") return truncatePrintableAscii(text, width, ellipsis);

	const simple = matchSimpleSgrWrappedText(text);
	if (simple) {
		const truncated = truncatePrintableAscii(simple.body, width, ellipsis);
		return { text: `${simple.prefix}${truncated.text}${simple.suffix}`, visibleWidth: truncated.visibleWidth };
	}

	const truncated = truncateSgrAscii(text, width, ellipsis, knownWidth.visibleWidth);
	return truncated;
}

export function safeVisibleWidth(text: string): number {
	const fastWidth = knownVisibleWidth(text);
	if (fastWidth) return fastWidth.visibleWidth;
	return tuiVisibleWidth(text);
}

export function safeTruncateToWidth(text: string, maxWidth: number, ellipsis = "...", pad = false): string {
	const width = Math.floor(maxWidth);
	if (!Number.isFinite(width) || width <= 0) return "";
	if (text.length === 0) return pad ? " ".repeat(width) : "";

	const truncated = fastTruncateText(text, width, ellipsis);
	if (truncated) {
		return pad ? `${truncated.text}${" ".repeat(Math.max(0, width - truncated.visibleWidth))}` : truncated.text;
	}

	return tuiTruncateToWidth(text, maxWidth, ellipsis, pad);
}

