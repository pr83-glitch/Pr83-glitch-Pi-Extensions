import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { installPatch } from "./patch-registry.js";

type Range = [number, number];
type CopyMetadata = { exclude?: Range[]; omit?: boolean; columns?: Range[]; width: number };
type PositionedMetadata = CopyMetadata & { offset: number };
type Point = { row: number; col: number; scrollView?: unknown };
type Bounds = { start: Point; end: Point };
type Rect = { x: number; y: number; width: number; height: number };
type LayoutBox = {
	rect: Rect; clip: Rect; children: LayoutBox[]; lines?: readonly string[]; lineOffset?: number;
};
type SelectionRenderer = {
	mode?: string;
	selectionAnchor?: Point;
	currentLayout?: { root: LayoutBox; lines?: readonly string[] };
	hasOverlay?: () => boolean;
	getSelectionBounds?: () => Bounds | undefined;
	getSelectionSourceLine?: (point: Point) => string;
	getSelectionColumns?: (line: string, row: number, bounds: Bounds) => { start: number; end: number };
	getActiveSelectionText?: () => string | undefined;
};

// APC is the same zero-width, terminal-ignored carrier Pi uses for its cursor
// marker. Unlike OSC it cannot change titles, clipboard, colors or prompt zones.
// Read annotations BEFORE slicing: terminal-cell slicing need not retain them.
const PREFIX = "\x1b_pi-sleek:copy;";
const END = "\x1b\\";
const ZONES = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

export function copyMetadata(line: string, metadata: CopyMetadata): string {
	const zones = line.match(ZONES)?.[0] ?? "";
	return `${zones}${PREFIX}${JSON.stringify(metadata)}${END}${line.slice(zones.length)}`;
}

export function copyChrome(line: string, width: number): string {
	return copyMetadata(line, { width, omit: true, exclude: [[0, width]] });
}

function validRanges(value: unknown): value is Range[] {
	return Array.isArray(value) && value.length <= 16 && value.every((range) =>
		Array.isArray(range) && range.length === 2 && range.every((n) => Number.isSafeInteger(n) && n >= 0) && range[1] >= range[0]);
}

function annotations(line: string, origin = 0): PositionedMetadata[] {
	const found: PositionedMetadata[] = [];
	let index = line.indexOf(PREFIX);
	while (index !== -1) {
		const end = line.indexOf(END, index + PREFIX.length);
		if (end === -1) break;
		if (end - index < 1024) {
			try {
				const data = JSON.parse(line.slice(index + PREFIX.length, end)) as CopyMetadata;
				if (data && Number.isSafeInteger(data.width) && data.width >= 0
					&& (data.exclude === undefined || validRanges(data.exclude))
					&& (data.columns === undefined || (validRanges(data.columns) && data.columns.length === 2))) {
					found.push({ ...data, offset: origin + visibleWidth(line.slice(0, index)) });
				}
			} catch { /* Untrusted/malformed annotations never alter copied content. */ }
		}
		index = line.indexOf(PREFIX, end + END.length);
	}
	return found;
}

/** Subtract only renderer-owned chrome; never trim indentation or match glyphs. */
export function copySelectedLine(line: string, start: number, end: number, anchorColumn: number,
	metadata = annotations(line)): string | undefined {
	const exclude: Range[] = [];
	let omit = false;
	for (const data of metadata) {
		if (end <= data.offset || start >= data.offset + data.width) continue;
		omit ||= data.omit === true;
		for (const [a, b] of data.exclude ?? []) exclude.push([data.offset + a, data.offset + b]);
		if (data.columns) {
			const [left, right] = data.columns;
			const chosen = anchorColumn - data.offset >= left![1] ? right! : left!;
			exclude.push([data.offset, data.offset + chosen[0]], [data.offset + chosen[1], data.offset + data.width]);
		}
	}
	exclude.sort((a, b) => a[0] - b[0]);
	let cursor = start;
	let text = "";
	const take = (a: number, b: number) => stripTerminalSequences(sliceByColumn(line, a, Math.max(0, b - a), true));
	for (const [a, b] of exclude) {
		if (b <= cursor || a >= end) continue;
		if (a > cursor) text += take(cursor, Math.min(a, end));
		cursor = Math.max(cursor, Math.min(b, end));
	}
	if (cursor < end) text += take(cursor, end);
	text = text.trimEnd();
	return omit && text.length === 0 ? undefined : text;
}

// Screen composition may discard APCs. Recover their provenance from the
// native frame's ORIGINAL leaf lines, translating/clipping to screen cells.
// No string-keyed registry, stale cache entries, or per-frame transcript walk.
function screenAnnotations(root: LayoutBox, bounds: Bounds): Map<number, PositionedMetadata[]> {
	const rows = new Map<number, PositionedMetadata[]>();
	const visit = (box: LayoutBox) => {
		const top = Math.max(box.rect.y, box.clip.y, bounds.start.row);
		const bottom = Math.min(box.rect.y + box.rect.height, box.clip.y + box.clip.height, bounds.end.row + 1);
		if (bottom <= top || box.clip.width <= 0) return;
		if (box.lines) {
			for (let row = top; row < bottom; row++) {
				const line = box.lines[row - box.rect.y + (box.lineOffset ?? 0)] ?? "";
				const data = annotations(line, box.rect.x);
				if (!data.length) continue;
				const clipped = data.map((entry) => ({
					...entry,
					exclude: entry.exclude?.map(([a, b]): Range => [
						Math.max(a, box.clip.x - entry.offset),
						Math.min(b, box.clip.x + box.clip.width - entry.offset),
					]).filter(([a, b]) => b > a),
				}));
				rows.set(row, [...(rows.get(row) ?? []), ...clipped]);
			}
		}
		for (const child of box.children) visit(child);
	};
	visit(root);
	return rows;
}

export function installCopySelection(renderer: unknown): void {
	const host = renderer as SelectionRenderer | undefined;
	if (host?.mode !== "fullscreen" || typeof host.getSelectionBounds !== "function"
		|| typeof host.getSelectionSourceLine !== "function" || typeof host.getSelectionColumns !== "function") return;
	installPatch(host, "getActiveSelectionText", "pi-sleek.copy-selection", (base) =>
		function (this: SelectionRenderer): string | undefined {
			const bounds = this.getSelectionBounds!();
			// Preserve native validation (including detached ScrollViews). A copy
			// getter has no clipboard side effects; reuse its result on fallback.
			const nativeText = base.call(this) as string | undefined;
			if (!bounds || nativeText === undefined) return nativeText;
			// Overlays own their screen text, not the underlying frame's metadata.
			if (!bounds.start.scrollView && this.hasOverlay?.()) return nativeText;
			const screen = !bounds.start.scrollView && this.currentLayout
				? screenAnnotations(this.currentLayout.root, bounds) : undefined;
			const output: string[] = [];
			let annotated = false;
			for (let row = bounds.start.row; row <= bounds.end.row; row++) {
				const line = this.getSelectionSourceLine!({ ...bounds.start, row });
				const frameLine = this.currentLayout?.lines?.[row];
				const overwritten = screen && frameLine !== undefined
					&& stripTerminalSequences(line) !== stripTerminalSequences(frameLine);
				// Flash/search/overlay painting happens after the base layout. When
				// visible cells differ, do not apply underlying provenance to them.
				const data = overwritten ? [] : screen ? screen.get(row) ?? [] : annotations(line);
				annotated ||= data.length > 0;
				const { start, end } = this.getSelectionColumns!(line, row, bounds);
				const text = copySelectedLine(line, start, end, this.selectionAnchor?.col ?? bounds.start.col, data);
				if (text !== undefined) output.push(text);
			}
			if (!annotated) return nativeText;
			return output.join("\n") || undefined;
		});
}
