/**
 * Image preview block — an extra card drawn just below a user message that
 * carries an image.
 *
 * pi's own `UserMessageComponent` renders text only: image content blocks are
 * dropped from the transcript, and a pasted clipboard image arrives as a temp
 * file *path* inside the message text (`/tmp/pi-clipboard-<uuid>.png`), which
 * the transcript shows as a bare line. This module collects both kinds of image
 * reference from a user message and adds one preview block per image in the
 * main window, directly below the message:
 *
 *   Image pi-clipboard-0851....png · /tmp                              1800 × 1140
 *
 *   <inline terminal image>
 *
 *                            View · 󰇚 Save to Downloads
 *
 * The card sits on the edit tool's block background. When the terminal cannot
 * display the image, the card collapses to a single, untinted line:
 *
 *   Image pi-clipboard-....png · /tmp  1800 × 1140  Inline preview unavailable   View · 󰇚 Save to Downloads
 *
 * `View` opens the file with the platform viewer, `Save to Downloads` copies it
 * into `~/Downloads` without clobbering an existing file. The block only renders
 * the inline preview when the terminal announces image support
 * (`getCapabilities().images`). Mouse clicks only fire in fullscreen mode, which
 * is the mode Sleek targets.
 *
 * The block is injected by patching `InteractiveMode.prototype.addMessageToChat`
 * — the single choke point pi uses for both live (`message_start`) and history
 * (`renderSessionItems`) user messages — and honours pi's own `showImages`
 * setting instead of adding a second switch. Stateless apart from a small
 * base64 cache, and installed through `core/patch-registry.ts`, so it is rebuilt
 * on every bind and unwound on shutdown.
 */
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Box, getCapabilities, getImageDimensions, Image as TerminalImage, Spacer, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";

import { installPatch } from "../core/patch-registry.js";
import { safeTruncateToWidth, safeVisibleWidth } from "../render-budget.js";

/** Actions offered on the footer row. */
type PreviewAction = "view" | "save";

/** One image discovered in a user message. */
type PreviewImage = {
	/** Absolute on-disk path when the image came from (or was found by) a path. */
	path?: string;
	/** Base64 payload for an attached image block with no path. */
	data?: string;
	mimeType?: string;
	name: string;
	/** Directory, or `"Clipboard"` when the image has no known location. */
	location: string;
};

const MIME_BY_EXTENSION: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};
/** Matches absolute, `~/`-rooted and `./`-rooted paths with an image extension. */
const IMAGE_PATH_RE = /(?:~\/|\.{1,2}\/|\/|[A-Za-z]:[\\/])[^\s"'`()<>[\]{}]+?\.(?:png|jpe?g|webp|gif)\b/gi;
/** At most this many images per message, so one paste cannot flood the transcript. */
const MAX_IMAGES = 4;
const VIEW_LABEL = "View";
const SAVE_LABEL = "\u{F01DA} Save to Downloads";
/** Middle dot between the two actions. */
const ACTION_SEPARATOR = "\u00B7";
/** Leading label, tinted with the theme's blue (`mdLink`) like the tool labels. */
const IMAGE_LABEL = "Image";
/** Nerd Font image icon (U+F0976) shown before the label. */
const IMAGE_ICON = "\u{F0976}";
/** Middle dot separating the image name from its location. */
const DOT = "\u00B7";
/** Surface the card is painted on — the same block background as the edit tool. */
const BLOCK_BACKGROUND = "toolSuccessBg";

/** Base64 payloads for path-backed images, keyed by path (bounded, cleared on shutdown). */
const base64Cache = new Map<string, { base64: string; mimeType: string; mtimeMs: number }>();
const MAX_CACHE_ENTRIES = 16;

export function clearImagePreviewCache(): void {
	base64Cache.clear();
}

function isPreviewAction(value: string): value is PreviewAction {
	return value === "view" || value === "save";
}
function extensionOf(filePath: string): string {
	return extname(filePath).toLowerCase();
}

function mimeTypeFor(filePath: string): string {
	return MIME_BY_EXTENSION[extensionOf(filePath)] ?? "image/png";
}

/** Expand a `~/` prefix and resolve a path found in message text against `cwd`. */
function resolveCandidate(raw: string, cwd: string): string | undefined {
	let candidate = raw;
	if (candidate.startsWith("~/")) candidate = join(homedir(), candidate.slice(2));
	if (!isAbsolute(candidate)) candidate = resolve(cwd, candidate);
	try {
		return statSync(candidate).isFile() ? candidate : undefined;
	} catch {
		return undefined;
	}
}

/** Every text block of a user message, joined the way pi renders it. */
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text?: string } => Boolean(block) && typeof block === "object")
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}

/** Image file paths mentioned in a user message, in first-seen order. */
function pathsInText(text: string, cwd: string): string[] {
	if (!text) return [];
	const found: string[] = [];
	const seen = new Set<string>();
	for (const match of text.matchAll(IMAGE_PATH_RE)) {
		const raw = match[0] ?? "";
		const filePath = resolveCandidate(raw, cwd);
		if (!filePath || seen.has(filePath)) continue;
		seen.add(filePath);
		found.push(filePath);
		if (found.length >= MAX_IMAGES) break;
	}
	return found;
}

/** Attached image blocks that carry no usable path (labeled `Clipboard`). */
function attachedImages(content: unknown): PreviewImage[] {
	if (!Array.isArray(content)) return [];
	const images: PreviewImage[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const candidate = block as { type?: unknown; data?: unknown; mimeType?: unknown };
		if (candidate.type !== "image" || typeof candidate.data !== "string" || !candidate.data) continue;
		images.push({
			data: candidate.data,
			mimeType: typeof candidate.mimeType === "string" ? candidate.mimeType : undefined,
			name: "Clipboard",
			location: "Clipboard",
		});
		if (images.length >= MAX_IMAGES) break;
	}
	return images;
}

/** Collect the preview images carried by a user message (exported for tests). */
export function collectPreviewImages(message: { role?: unknown; content?: unknown }, cwd: string): PreviewImage[] {
	if (message.role !== "user") return [];
	const images: PreviewImage[] = [];
	for (const filePath of pathsInText(messageText(message.content), cwd)) {
		images.push({ path: filePath, name: basename(filePath), location: dirname(filePath) });
	}
	for (const image of attachedImages(message.content)) {
		if (images.length >= MAX_IMAGES) break;
		images.push(image);
	}
	return images;
}

/** Base64 + mime for a path-backed image, cached by path and mtime. */
function readImageData(image: PreviewImage): { base64: string; mimeType: string } | undefined {
	if (image.data) return { base64: image.data, mimeType: image.mimeType ?? "image/png" };
	if (!image.path) return undefined;
	let mtimeMs = 0;
	try {
		mtimeMs = statSync(image.path).mtimeMs;
	} catch {
		return undefined;
	}
	const cached = base64Cache.get(image.path);
	if (cached && cached.mtimeMs === mtimeMs) return cached;
	try {
		const entry = { base64: readFileSync(image.path).toString("base64"), mimeType: mimeTypeFor(image.path), mtimeMs };
		base64Cache.delete(image.path);
		base64Cache.set(image.path, entry);
		if (base64Cache.size > MAX_CACHE_ENTRIES) base64Cache.delete(base64Cache.keys().next().value as string);
		return entry;
	} catch {
		return undefined;
	}
}

/** Materialize a path for a data-only image so it can be viewed/saved. */
function ensureTempFile(image: PreviewImage): string | undefined {
	if (image.path) return image.path;
	if (!image.data) return undefined;
	const extension = Object.entries(MIME_BY_EXTENSION).find(([, mime]) => mime === image.mimeType)?.[0] ?? ".png";
	const filePath = join(tmpdir(), `pi-clipboard-${randomUUID()}${extension}`);
	try {
		writeFileSync(filePath, Buffer.from(image.data, "base64"));
		image.path = filePath;
		return filePath;
	} catch {
		return undefined;
	}
}

/** `~/Downloads/<name>`, appending ` (n)` rather than overwriting. */
function downloadTarget(name: string): string {
	const directory = join(homedir(), "Downloads");
	mkdirSync(directory, { recursive: true });
	const extension = extname(name);
	const stem = extension ? name.slice(0, -extension.length) : name;
	let target = join(directory, name);
	for (let index = 1; index < 1000 && existsSync(target); index += 1) {
		target = join(directory, `${stem} (${index})${extension}`);
	}
	return target;
}

/** Open a file with the platform's default handler, detached from pi. */
function openInViewer(filePath: string): void {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", filePath] : [filePath];
	try {
		spawn(command, args, { detached: true, stdio: "ignore" }).unref();
	} catch {
		// The caller surfaces a failure notification; a missing opener must not crash a render.
	}
}

type PreviewHost = {
	requestRender: () => void;
	status: (message: string) => void;
	error: (message: string) => void;
};

type ActionHit = { action: PreviewAction; start: number; end: number };

/** Left/right aligned row, clamped to `width`. */
function padSides(left: string, right: string, width: number): string {
	const rightWidth = right ? safeVisibleWidth(right) : 0;
	if (!right) return safeTruncateToWidth(left, width, "…", false);
	const leftWidth = safeVisibleWidth(left);
	if (leftWidth + rightWidth + 2 > width) return safeTruncateToWidth(left, width, "…", false);
	return `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
}

/**
 * The preview block. Renders the header, the inline image and the action row,
 * and hit-tests the action row columns on click.
 */
export class ImagePreviewComponent implements Component {
	private readonly image: PreviewImage;
	private readonly getTheme: () => any;
	private readonly host: PreviewHost;
	private readonly dimensions: { widthPx: number; heightPx: number } | undefined;
	private terminalImage: TerminalImage | undefined;
	private actionHits: ActionHit[] = [];
	private actionRow = -1;

	constructor(image: PreviewImage, getTheme: () => any, host: PreviewHost, maxWidthCells: number) {
		this.image = image;
		this.getTheme = getTheme;
		this.host = host;
		const data = readImageData(image);
		this.dimensions = data ? getImageDimensions(data.base64, data.mimeType) ?? undefined : undefined;
		this.terminalImage = data
			? new TerminalImage(
					data.base64,
					data.mimeType,
					{ fallbackColor: (text: string) => this.theme()?.fg("muted", text) ?? text },
					{ maxWidthCells, filename: image.name },
					this.dimensions,
				)
			: undefined;
	}

	private theme(): any {
		try {
			return this.getTheme();
		} catch {
			return undefined;
		}
	}

	private renderImage(width: number): string[] {
		return this.terminalImage ? this.terminalImage.render(width) : [];
	}

	private paint(color: string, text: string): string {
		const theme = this.theme();
		try {
			return typeof theme?.fg === "function" ? theme.fg(color, text) : text;
		} catch {
			return text;
		}
	}

	private bold(text: string): string {
		const theme = this.theme();
		try {
			return typeof theme?.bold === "function" ? theme.bold(text) : text;
		} catch {
			return text;
		}
	}

	/** True when this terminal can draw the inline preview right now. */
	previewAvailable(): boolean {
		return Boolean(getCapabilities().images) && Boolean(this.terminalImage);
	}

	/** `Image <name> · <location>`, the blue label first. */
	private header(): string {
		return `${this.paint("mdLink", `${IMAGE_ICON} ${IMAGE_LABEL}`)} ${this.bold(this.image.name)} ${this.paint("muted", DOT)} ${this.paint("muted", this.image.location || "Clipboard")}`;
	}

	private dimensionsText(): string {
		return this.dimensions ? `${this.dimensions.widthPx} × ${this.dimensions.heightPx}` : "";
	}

	private actionSegments(): { plain: string; styled: string; action?: PreviewAction }[] {
		return [
			{ plain: VIEW_LABEL, styled: this.paint("accent", VIEW_LABEL), action: "view" },
			{ plain: ` ${ACTION_SEPARATOR} `, styled: ` ${this.paint("muted", ACTION_SEPARATOR)} ` },
			{ plain: SAVE_LABEL, styled: this.paint("muted", SAVE_LABEL), action: "save" },
		];
	}

	/** Lay the action labels out from `offset` and remember their column ranges for click routing. */
	private placeActions(offset: number): { line: string; width: number; hits: ActionHit[] } {
		const hits: ActionHit[] = [];
		let line = "";
		let column = offset;
		for (const segment of this.actionSegments()) {
			if (segment.action) hits.push({ action: segment.action, start: column, end: column + safeVisibleWidth(segment.plain) - 1 });
			line += segment.styled;
			column += safeVisibleWidth(segment.plain);
		}
		return { line, width: column - offset, hits };
	}

	render(width: number): string[] {
		const usable = Math.max(1, Math.floor(width));
		const lines: string[] = [];
		const dimensions = this.dimensionsText();
		const supportsImages = this.previewAvailable();

		// No image to draw: everything — header, resolution, hint, actions — fits on
		// one line, with the actions right-aligned.
		if (!supportsImages) {
			const hint = this.paint("muted", getCapabilities().images ? "Preview unavailable for this image" : "Inline preview unavailable");
			const head = [this.header(), dimensions ? this.paint("muted", dimensions) : ""].filter(Boolean).join(" ");
			const offset = Math.max(0, usable - this.actionWidth());
			const actions = this.placeActions(offset);
			// Keep the hint (and the actions) visible; only the header gives way.
			const room = offset - 1;
			const headBudget = room - safeVisibleWidth(hint) - 1;
			const leftText = headBudget > 0
				? `${safeTruncateToWidth(head, headBudget, "…", false)} ${hint}`
				: safeTruncateToWidth(hint, Math.max(0, room), "…", false);
			const gap = " ".repeat(Math.max(0, usable - safeVisibleWidth(leftText) - actions.width));
			this.actionHits = actions.hits;
			this.actionRow = 0;
			lines.push(safeTruncateToWidth(`${leftText}${gap}${actions.line}`, usable, "…", false));
			return lines;
		}

		// Blank rows give the card top/bottom padding on the tinted surface.
		lines.push("");
		lines.push(padSides(this.header(), this.paint("muted", dimensions), usable));
		lines.push("");
		lines.push(...this.renderImage(usable));
		lines.push("");
		const offset = Math.max(0, usable - this.actionWidth());
		const actions = this.placeActions(offset);
		this.actionHits = actions.hits;
		this.actionRow = lines.length;
		lines.push(safeTruncateToWidth(`${offset > 0 ? " ".repeat(offset) : ""}${actions.line}`, usable, "…", false));
		lines.push("");
		return lines;
	}

	private actionWidth(): number {
		return this.actionSegments().reduce((total, segment) => total + safeVisibleWidth(segment.plain), 0);
	}

	handleMouse(event: TuiMouseEvent): { handled: boolean } | undefined {
		if (event.type !== "click" || event.button !== "left" || event.y !== this.actionRow) return undefined;
		const hit = this.actionHits.find((candidate) => event.x >= candidate.start && event.x <= candidate.end);
		if (!hit || !isPreviewAction(hit.action)) return undefined;
		void this.run(hit.action);
		return { handled: true };
	}

	private async run(action: PreviewAction): Promise<void> {
		try {
			if (action === "view") {
				const filePath = ensureTempFile(this.image);
				if (!filePath) {
					this.host.error("Image file is no longer available.");
					return;
				}
				openInViewer(filePath);
				this.host.status(`Opened ${basename(filePath)}`);
				return;
			}
			const source = ensureTempFile(this.image);
			if (!source) {
				this.host.error("Image file is no longer available.");
				return;
			}
			const target = downloadTarget(this.image.path ? basename(this.image.path) : this.image.name);
			copyFileSync(source, target);
			this.host.status(`Saved to ${target}`);
		} catch (error) {
			this.host.error(`Image action failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.host.requestRender();
		}
	}

	invalidate(): void {
		this.terminalImage?.invalidate();
	}
}

/** Wrap the card in the edit tool's block surface (1-column side padding, full-width background). */
export function createPreviewBlock(image: PreviewImage, getTheme: () => any, host: PreviewHost, maxWidthCells: number): Component {
	const preview = new ImagePreviewComponent(image, getTheme, host, maxWidthCells);
	// Untinted, like a plain tool line, when there is no preview to frame.
	const box = new Box(1, 0, (content: string) => {
		if (!preview.previewAvailable()) return content;
		try {
			return getTheme()?.bg(BLOCK_BACKGROUND, content) ?? content;
		} catch {
			return content;
		}
	});
	box.addChild(preview);
	return box;
}

/** Add one preview block below a user message that carries images. */
export function installImagePreview(getTheme: () => any): void {
	installPatch(
		(InteractiveMode as { prototype: unknown }).prototype,
		"addMessageToChat",
		"pi-sleek.image-preview.addMessageToChat",
		(base: (this: any, ...args: any[]) => unknown) =>
			function patchedAddMessageToChat(this: any, message: any, options: any): unknown {
				const result = base.call(this, message, options);
				try {
					if (message?.role !== "user") return result;
					if (this.settingsManager?.getShowImages?.() === false) return result;
					const images = collectPreviewImages(message, this.sessionManager?.getCwd?.() ?? process.cwd());
					if (images.length === 0 || !Array.isArray(this.chatContainer?.children)) return result;
					const maxWidthCells = this.settingsManager?.getImageWidthCells?.() ?? 60;
					const host: PreviewHost = {
						requestRender: () => this.ui?.requestRender?.(),
						status: (text: string) => this.showStatus?.(text),
						error: (text: string) => this.showError?.(text),
					};
					for (const image of images) {
						this.chatContainer.addChild(new Spacer(1));
						this.chatContainer.addChild(createPreviewBlock(image, getTheme, host, maxWidthCells));
					}
				} catch {
					// A malformed message must never break the transcript; skip the block.
				}
				return result;
			},
	);
}
