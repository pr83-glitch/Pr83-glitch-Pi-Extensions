/**
 * "Thinking style" registry: each style contributes the working-indicator
 * glyph frames (colored) and the status text used while an agent turn runs
 * (working / thinking / answering / running).
 *
 * Styles:
 * - "default" — the historic look: braille spinner in the theme accent and the
 *   state label (Working / Thinking / Answering / Cooking) with animated dots.
 * - "claude" — Claude Code inspired: ping-pong star glyph frames (· ✢ ✳ ✶ ✻ ✽)
 *   in the theme's orange (vars.orange, fallback #ff8700), and a verb sampled
 *   from Claude Code's SPINNER_VERBS list with "…". The shimmer sweep from the original CC
 *   spinner is deliberately NOT ported: it requires a 50 ms per-line repaint
 *   loop, which is not worth the render cost in pi's status row. Glyph frames
 * are driven by pi's own working-indicator timer (no extra timers).
 * - The other styles (`moon`, `meteor`, `fireflies`, `ripple`, `shimmer`,
 *   `orbit`) are each one entry in `THINKING_STYLES` below, together with the
 *   label, frame interval, frame builder and verb vocabulary.
 *
 * Verb list source: Claude Code `constants/spinnerVerbs.ts`. Structure of the
 * glyph set and ping-pong playback adapted from
 * https://github.com/Demo-0416/my-pi-extensions (better-claude-code-ui, MIT).
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { fgHex } from "../theme/ansi.js";
import { blendRgb, hexToRgb, normalizeHex, rgbToHex } from "../theme/color.js";
import { getThemeVarAnsi, getThemeVarBackground, themeVarPainter } from "../theme/theme-extras.js";

export type ThinkingStyleId =
	| "default"
	| "claude"
	| "moon"
	| "meteor"
	| "fireflies"
	| "ripple"
	| "shimmer"
	| "orbit";

type ThinkingStyleState = "working" | "thinking" | "answering" | "running";

interface ThinkingStyleTheme {
	fg?(color: string, text: string): string;
}

const DEFAULT_THINKING_STYLE_ID: ThinkingStyleId = "default";

/**
 * Ids merged into another style — same animation, new name. Kept as an alias so a config
 * written before the merge still selects the animation it was pointing at.
 */
const RENAMED_THINKING_STYLE_IDS: Record<string, ThinkingStyleId> = {
	"moon-bold": "moon",
};

const DEFAULT_MESSAGES: Record<ThinkingStyleState, string> = {
	working: "Working",
	thinking: "Thinking",
	answering: "Answering",
	running: "Cooking",
};

const FALLBACK_ORANGE_HEX = "#ff8700";

function isThinkingStyleId(value: unknown): value is ThinkingStyleId {
	return typeof value === "string" && Object.hasOwn(THINKING_STYLES, value);
}

export function resolveThinkingStyleId(value: unknown): ThinkingStyleId {
	if (typeof value === "string") {
		const renamed = RENAMED_THINKING_STYLE_IDS[value];
		if (renamed) return renamed;
	}
	return isThinkingStyleId(value) ? value : DEFAULT_THINKING_STYLE_ID;
}

export function thinkingStyleLabel(id: ThinkingStyleId): string {
	return styleDefinition(id).label;
}

// ---------------------------------------------------------------------------
// Live active style (refreshed on session_start, switched by the command so a
// change applies on the next loader tick without recreating the controller).
// ---------------------------------------------------------------------------

let activeThinkingStyleId: ThinkingStyleId = DEFAULT_THINKING_STYLE_ID;

export function getActiveThinkingStyleId(): ThinkingStyleId {
	return activeThinkingStyleId;
}

export function setActiveThinkingStyleId(id: ThinkingStyleId): void {
	activeThinkingStyleId = id;
}

// ---------------------------------------------------------------------------
// Glyph frames
// ---------------------------------------------------------------------------

const DEFAULT_SPINNER_FRAMES = ["⣷", "⣯", "⣟", "⡿", "⢿", "⣻", "⣽", "⣾"];
const DEFAULT_SPINNER_INTERVAL_MS = 80;

// Claude Code Spinner utils: Ghostty renders ✽ slightly offset → swap in *.
function claudeCharacters(): string[] {
	if (process.env.TERM === "xterm-ghostty") return ["·", "✢", "✳", "✶", "✻", "*"];
	return ["·", "✢", "✳", "✶", "✻", "✽"];
}

function themeFg(theme: ThinkingStyleTheme | undefined, color: string, text: string): string {
	if (!theme?.fg) return text;
	for (const fallbackColor of [color, "accent", "text"]) {
		try {
			return theme.fg(fallbackColor, text);
		} catch {}
	}
	return text;
}

// ---------------------------------------------------------------------------
// Wide (multi-cell) animations
//
// Every frame of a style must have the SAME visible width (or the status text
// jitters), and tracks use glyphs (─ ▁) instead of spaces so trailing padding
// is never trimmed. Frames are generated once at configure time.
// ---------------------------------------------------------------------------

/** Cell width shared by the travelling comet/firefly animations. */
const BAR_WIDTH = 10;
/** Resolve the theme's accent color as hex (for gradient shading). */

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

/** Theme var (e.g. `"orange"`) as `#rrggbb`, or `fallback` when the theme lacks it. */
function themeVarHex(theme: ThinkingStyleTheme | undefined, name: string, fallback = ""): string {
	try {
		return normalizeHex(getThemeVarBackground(theme ?? {}, name)) ?? fallback;
	} catch {
		return fallback;
	}
}

/**
 * Per-state tint: running tools light the indicator in the theme's orange, every
 * other state stays on the accent. `tintVar` overrides that (used by the
 * compaction/branch indicators).
 */
const STATE_TINT_VARS: Record<ThinkingStyleState, string> = {
	working: "accent",
	thinking: "accent",
	answering: "accent",
	running: "orange",
};

function stateAccentHex(
	theme: ThinkingStyleTheme | undefined,
	state: ThinkingStyleState,
	tintVar?: string,
): string | null {
	const accent = themeVarHex(theme, "accent") || null;
	const name = tintVar ?? STATE_TINT_VARS[state] ?? "accent";
	if (name === "accent") return accent;
	return themeVarHex(theme, name) || accent;
}

/** How far the dim end of a ramp drifts toward the secondary (orange) hue. */
const HUE_SHIFT = 0.35;

type Shade = (factor: number, glyph: string) => string;

/**
 * The one color ramp every style uses: `factor` (1 = brightest) scales the
 * luminance, while the dim end also drifts toward the theme's orange so a trail
 * shifts hue and not just brightness. Falls back to accent/muted/dim tokens.
 */
function makeShade(
	theme?: ThinkingStyleTheme,
	state: ThinkingStyleState = "working",
	tintVar?: string,
): Shade {
	const accent = stateAccentHex(theme, state, tintVar);
	const secondary = themeVarHex(theme, "orange", FALLBACK_ORANGE_HEX);
	return (factor, glyph) => {
		if (accent) {
			const ratio = clamp01(HUE_SHIFT * (1 - clamp01(factor)));
			const color = rgbToHex(blendRgb(hexToRgb(accent), hexToRgb(secondary), ratio));
			return fgHex(theme ?? {}, color, glyph);
		}
		const ansi = getThemeVarAnsi(theme ?? {}, tintVar ?? STATE_TINT_VARS[state]);
		if (ansi) return `${ansi}${factor < 0.7 ? "\x1b[2m" : ""}${glyph}\x1b[22m\x1b[39m`;
		const token = factor >= 0.9 ? "accent" : factor >= 0.4 ? "muted" : "dim";
		return themeFg(theme, token, glyph);
	};
}

/**
 * Nerd Font icons are one cell wide; anything the terminal would measure wider
 * (emoji, East-Asian-wide shapes) falls back instead of shifting the row.
 */
function safeGlyph(glyph: string, fallback: string): string {
	try {
		return visibleWidth(glyph) === 1 ? glyph : fallback;
	} catch {
		return fallback;
	}
}

// ---------------------------------------------------------------------------
// Wide (multi-cell) animations

/** One comet shape: `steps` run from the leading edge to the tail. */
interface CometShape {
	width: number;
	/** Luminance factor (× accent) per step. */
	factors: number[];
	/** Glyph per step; a single string repeats across every step. */
glyphs: string | string[];
	/** Glyph + factor for the cells the comet is not covering. */
	emptyGlyph: string;
	emptyFactor: number;
	/** Head glyph held against a wall (the "squash" frame), plus one extra step of reach. */
	squashGlyph?: string;
}

/**
 * One pass of head positions: a single off-track frame, the eased sweep across
 * the track (so the comet slows into both walls — the holds are what `squashGlyph`
 * paints) and then the linear run-off that drags the tail out of the frame.
 */
function passPositions(shape: CometShape, dir: 1 | -1): number[] {
	const tail = shape.factors.length - 1;
	const visible = dir === 1
		? easedPositions(shape.width, 0, shape.width - 1)
		: easedPositions(shape.width, shape.width - 1, 0);
	const runOff: number[] = [];
	for (let step = 1; step <= tail + 1; step++) {
		runOff.push(dir === 1 ? shape.width - 1 + step : -step);
	}
	return [dir === 1 ? -1 : shape.width, ...visible, ...runOff];
}
/**
 * Ease-in-out over `count` samples (duplicate positions = held frames), so a
 * sweep visibly slows near both ends of its travel and speeds through the middle.
 */
function easedPositions(count: number, from: number, to: number): number[] {
	const positions: number[] = [];
	const span = to - from;
	for (let i = 0; i < count; i++) {
		const p = count <= 1 ? 0 : i / (count - 1);
		const eased = p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p);
		positions.push(from + Math.round(span * eased));
	}
	return positions;
}

/**
 * The shared Slide/Bounce sweep: the comet slides left↔right, runs past both
 * ends of the track before it turns around, and mirrors (tail always behind the
 * head) while the track is empty, so the gradient flip is never visible. Motion
 * is eased and the head "squashes" for a frame at each wall. Every frame keeps
 * the same visible width, so the status text never shifts.
 */
function cometFrames(
	shape: CometShape,
	theme?: ThinkingStyleTheme,
	state: ThinkingStyleState = "working",
	tintVar?: string,
): string[] {
	const shade = makeShade(theme, state, tintVar);
	const glyphAt = (step: number): string =>
		typeof shape.glyphs === "string" ? shape.glyphs : shape.glyphs[step] ?? " ";
	const cells = shape.factors.map((factor, step) => shade(factor, glyphAt(step)));
	const empty = shape.emptyGlyph === " " ? " " : shade(shape.emptyFactor, shape.emptyGlyph);
	const squash = shape.squashGlyph ? shade(1, shape.squashGlyph) : undefined;

	const forward = passPositions(shape, 1);
	const backward = passPositions(shape, -1);
	const heads: Array<{ head: number; dir: 1 | -1 }> = [
		...forward.map((head) => ({ head, dir: 1 as const })),
		...backward.map((head) => ({ head, dir: -1 as const })),
	];
	return heads.map(({ head, dir }) => {
		const row: string[] = new Array<string>(shape.width).fill(empty);
		const wall = squash !== undefined && head === (dir === 1 ? shape.width - 1 : 0);
		cells.forEach((cell, step) => {
			const index = head - dir * step;
			if (index < 0 || index >= shape.width) return;
			row[index] = wall && step < 2 ? squash ?? cell : cell;
		});
		return row.join("");
	});
}

/**
 * Meteor: a bright `●` streaking across the row with a star/bullet tail, on an
 * otherwise empty track.
 */
function meteorFrames(
	theme?: ThinkingStyleTheme,
	state?: ThinkingStyleState,
	_tintVar?: string,
): string[] {
	const shape: CometShape = {
		width: BAR_WIDTH,
		factors: [1, 1, 0.8, 0.62, 0.48, 0.36, 0.26],
		glyphs: ["●", "●", "•", "•", "·", "·", "·"],
		emptyGlyph: " ",
		emptyFactor: 0,
		squashGlyph: "○",
	};
	// Keep one colour for the complete forward/backward pass, then switch colour.
	return [
		...cometFrames(shape, theme, state, "orange"),
		...cometFrames(shape, theme, state, "purple"),
	];
}

/**
 * Fireflies: three glowing `•` lights drift over the row on eased sine paths
 * while their brightness flickers independently.
 */
function fireflyFrames(
	theme?: ThinkingStyleTheme,
	state?: ThinkingStyleState,
	_tintVar?: string,
): string[] {
	const shade = makeShade(theme, state, "orange");
	const frames: string[] = [];
	const width = BAR_WIDTH;
	const flies = [
		{ phase: 0, speed: 1 },
		{ phase: 2.1, speed: 0.62 },
		{ phase: 4.4, speed: 0.84 },
	];
	const frameCount = 18;
	for (let frame = 0; frame < frameCount; frame++) {
		const cells: string[] = new Array<string>(width).fill(" ");
		flies.forEach((fly, index) => {
			const p = (frame / frameCount) * fly.speed + fly.phase;
			const position = Math.round(((Math.sin(p * Math.PI * 2) + 1) / 2) * (width - 1));
			const flicker = 0.62 + 0.38 * Math.abs(Math.sin(p * Math.PI * 3 + index));
			cells[position] = shade(flicker, "•");
			const halo = position + (index % 2 === 0 ? 1 : -1);
			if (halo >= 0 && halo < width && cells[halo] === " ") cells[halo] = shade(0.22, "·");
		});
		frames.push(cells.join(""));
	}
	return frames;
}

/**
 * Variant C — BOLD: the same font family as `moon`, but 10 deliberately LARGE steps
 * (measured ink 34 → 118 → 28) instead of 25 tiny ones, so every frame is visibly different.
 *
 * Colour ramps with the phase, symmetrically around the held full moon:
 * yellow → dim yellow → dim text → text (full) → dim text → dim yellow → yellow.
 * That is the pre-v1.6.2 "Bold Moon" look (which jumped muted → warning → text → warning),
 * smoothed into a gradual shoulder on each side: the two shoulders below are two frames
 * long each because `dim`/`muted` have to travel from saturated yellow to plain white and
 * back, and the four `text` frames cover the final gibbous plus the three held full frames.
 * The trailing blank frame closes the cycle (new moon), so the fade lands back on yellow.
 */
function moonFrames(theme?: ThinkingStyleTheme): string[] {
	const glyphs = ["\ue390", "\ue393", "\ue394", "\ue397", "\ue39a", "\ue39b", "\ue39b", "\ue39b", "\ue39e", "\ue3a2", "\ue3a5", "\ue3a8", " "];
	const colors = [
		"warning", "muted", "dim", "dim",
		"text", "text", "text", "text",
		"dim", "dim", "muted", "warning",
		"warning",
	];
	return glyphs.map((glyph, index) => themeFg(theme, colors[index] ?? "warning", glyph));
}

// Each phase supplies a glyph, a one-cell fallback, peak brightness and tick count.
// Holding glyphs for several ticks lets colour fade smoothly between short bursts.
function oneCellPhases(
	phases: readonly (readonly [string, string, number, number])[],
	theme?: ThinkingStyleTheme,
	state?: ThinkingStyleState,
	tintVar?: string,
): string[] {
	const shade = makeShade(theme, state, tintVar);
	return phases.flatMap(([glyph, fallback, brightness, ticks], index) => {
		const previous = phases[(index + phases.length - 1) % phases.length]![2];
		const cell = safeGlyph(glyph, fallback);
		return Array.from({ length: ticks }, (_, tick) => {
			const progress = (tick + 1) / ticks;
			const eased = (1 - Math.cos(Math.PI * progress)) / 2;
			return shade(previous + (brightness - previous) * eased, cell);
		});
	});
}

function rippleFrames(theme?: ThinkingStyleTheme, state?: ThinkingStyleState, tintVar?: string): string[] {
	return oneCellPhases([
		["·", ".", 0.25, 3], ["∘", "o", 0.5, 3], ["○", "O", 0.75, 3],
		["◉", "O", 1, 2], ["✳", "*", 1, 1], ["✧", "*", 0.6, 3], ["·", ".", 0.2, 4],
	], theme, state, tintVar);
}

function shimmerFrames(theme?: ThinkingStyleTheme, state?: ThinkingStyleState, tintVar?: string): string[] {
	return oneCellPhases([
		["·", ".", 0.22, 4], ["✧", "*", 0.45, 3], ["✦", "*", 0.85, 3],
		["✴", "*", 1, 1], ["✦", "*", 0.75, 2], ["✧", "*", 0.4, 4], ["·", ".", 0.2, 4],
	], theme, state, tintVar);
}

function orbitFrames(theme?: ThinkingStyleTheme, state?: ThinkingStyleState, tintVar?: string): string[] {
	return oneCellPhases([
		["◜", "/", 0.65, 2], ["◝", "\\", 0.8, 2], ["◞", "/", 1, 2], ["◟", "\\", 0.8, 2],
		["/", "/", 0.9, 1], ["─", "-", 1, 1], ["\\", "\\", 0.9, 1],
		["✦", "*", 1, 1], ["·", ".", 0.3, 3],
	], theme, state, tintVar);
}

/** Definition for `id`, falling back to the default style when unknown. */
function styleDefinition(id: ThinkingStyleId): ThinkingStyleDefinition {
	return THINKING_STYLES[id] ?? THINKING_STYLES[DEFAULT_THINKING_STYLE_ID];
}

/** Claude frames in the theme's orange, or the accent when `tintVar` asks for it. */
function claudeFrames(theme?: ThinkingStyleTheme, _state?: ThinkingStyleState, tintVar?: string): string[] {
	const frames = claudeCharacters();
	// Callers such as the sidebar keep Claude's glyphs but use the system accent.
	if (tintVar === "accent") return frames.map((frame) => themeFg(theme, "accent", frame));
	const paint = themeVarPainter(theme, tintVar ?? "orange")
		?? ((text: string) => fgHex(theme ?? {}, themeVarHex(theme, "orange", FALLBACK_ORANGE_HEX), text));
	return frames.map(paint);
}

/** pi's own braille spinner in the theme accent. */
function defaultFrames(theme?: ThinkingStyleTheme): string[] {
	return DEFAULT_SPINNER_FRAMES.map((frame) => themeFg(theme, "accent", frame));
}

/**
 * Coloured frames with a fixed cell width, played at `thinkingStyleFrameIntervalMs(id)`.
 * `state` selects the accent; `tintVar` overrides it for e.g. compaction.
 */
export function thinkingStyleFrames(
	id: ThinkingStyleId,
	theme?: ThinkingStyleTheme,
	state?: ThinkingStyleState,
	tintVar?: string,
): string[] {
	return styleDefinition(id).frames(theme, state ?? "working", tintVar);
}

/**
 * Tool turns run a little faster, long "thinking" stretches a little calmer, so
 * the indicator says something about the phase even without reading the label.
 */
const STATE_SPEED_SCALES: Record<ThinkingStyleState, number> = {
	working: 1,
	thinking: 1.5,
	answering: 1,
	running: 0.85,
};

export function thinkingStyleFrameIntervalMs(
	id: ThinkingStyleId,
	state: ThinkingStyleState = "working",
): number {
	const scale = STATE_SPEED_SCALES[state] ?? 1;
	return Math.max(16, Math.round(styleDefinition(id).intervalMs * scale));
}

// ---------------------------------------------------------------------------
// Status text
// ---------------------------------------------------------------------------

function dotsForStep(step: number): string {
	return ".".repeat((Math.max(0, Math.floor(step)) % 3) + 1);
}

/** Claude Code spinner verbs (constants/spinnerVerbs.ts). */
const CLAUDE_VERBS = [
	"Accomplishing", "Actioning", "Actualizing", "Architecting", "Baking", "Beaming",
	"Beboppin'", "Befuddling", "Billowing", "Blanching", "Bloviating", "Boogieing",
	"Boondoggling", "Booping", "Bootstrapping", "Brewing", "Bunning", "Burrowing",
	"Calculating", "Canoodling", "Caramelizing", "Cascading", "Catapulting", "Cerebrating",
	"Channeling", "Channelling", "Choreographing", "Churning", "Clauding", "Coalescing",
	"Cogitating", "Combobulating", "Composing", "Computing", "Concocting", "Considering",
	"Contemplating", "Cooking", "Crafting", "Creating", "Crunching", "Crystallizing",
	"Cultivating", "Deciphering", "Deliberating", "Determining", "Dilly-dallying",
	"Discombobulating", "Doing", "Doodling", "Drizzling", "Ebbing", "Effecting",
	"Elucidating", "Embellishing", "Enchanting", "Envisioning", "Evaporating",
	"Fermenting", "Fiddle-faddling", "Finagling", "Flambéing", "Flibbertigibbeting",
	"Flowing", "Flummoxing", "Fluttering", "Forging", "Forming", "Frolicking",
	"Frosting", "Gallivanting", "Galloping", "Garnishing", "Generating", "Gesticulating",
	"Germinating", "Gitifying", "Grooving", "Gusting", "Harmonizing", "Hashing",
	"Hatching", "Herding", "Honking", "Hullaballooing", "Hyperspacing", "Ideating",
	"Imagining", "Improvising", "Incubating", "Inferring", "Infusing", "Ionizing",
	"Jitterbugging", "Julienning", "Kneading", "Leavening", "Levitating", "Lollygagging",
	"Manifesting", "Marinating", "Meandering", "Metamorphosing", "Misting", "Moonwalking",
	"Moseying", "Mulling", "Mustering", "Musing", "Nebulizing", "Nesting",
	"Newspapering", "Noodling", "Nucleating", "Orbiting", "Orchestrating", "Osmosing",
	"Perambulating", "Percolating", "Perusing", "Philosophising", "Photosynthesizing",
	"Pollinating", "Pondering", "Pontificating", "Pouncing", "Precipitating",
	"Prestidigitating", "Processing", "Proofing", "Propagating", "Puttering", "Puzzling",
	"Quantumizing", "Razzle-dazzling", "Razzmatazzing", "Recombobulating", "Reticulating",
	"Roosting", "Ruminating", "Sautéing", "Scampering", "Schlepping", "Scurrying",
	"Seasoning", "Shenaniganing", "Shimmying", "Simmering", "Skedaddling", "Sketching",
	"Slithering", "Smooshing", "Sock-hopping", "Spelunking", "Spinning", "Sprouting",
	"Stewing", "Sublimating", "Swirling", "Swooping", "Symbioting", "Synthesizing",
	"Tempering", "Thinking", "Thundering", "Tinkering", "Tomfoolering", "Topsy-turvying",
	"Transfiguring", "Transmuting", "Twisting", "Undulating", "Unfurling", "Unravelling",
	"Vibing", "Waddling", "Wandering", "Warping", "Whatchamacalliting", "Whirlpooling",
	"Whirring", "Whisking", "Wibbling", "Working", "Wrangling", "Zesting", "Zigzagging",
];

/** Moon/night-themed gerunds for the moon style (same sampling as claude). */
const MOON_VERBS = [
	"Orbiting", "Waxing", "Waning", "Eclipsing", "Phasing", "Glowing", "Drifting", "Reflecting",
	"Gravitating", "Circling", "Moonwalking", "Twinkling", "Glimmering", "Illuminating", "Radiating",
	"Transiting", "Floating", "Soaring", "Shimmering", "Dreaming", "Basking", "Nightwalking",
	"Star-gazing", "Crescenting", "Constellating",
];

/** Word lists for the extra styles (same one-verb-per-state sampling). */
const METEOR_VERBS = [
	"Swooping", "Streaking", "Blazing", "Plummeting", "Rocketing", "Sizzling",
	"Flashing", "Scorching", "Hurtling",
];
const FIREFLY_VERBS = [
	"Flickering", "Glowing", "Twinkling", "Drifting", "Blinking", "Shimmering",
	"Buzzing", "Wandering", "Lingering",
];
/** One status-text line for a style at a given animation step. */
// One verb is sampled per state phase (never per tick) so the text reads live
// without flickering. Cached per word list so styles can share the engine.
const verbCacheByWordList = new Map<readonly string[], { state: ThinkingStyleState; verb: string }>();

function verbFor(wordList: readonly string[], state: ThinkingStyleState, cacheKey = wordList): string {
	const cached = verbCacheByWordList.get(cacheKey);
	if (!cached || cached.state !== state) {
		const verb = wordList[Math.floor(Math.random() * wordList.length)] ?? "Working";
		verbCacheByWordList.set(cacheKey, { state, verb });
		return verb;
	}
	return cached.verb;
}

function renderDefaultText(state: ThinkingStyleState, step: number, theme: ThinkingStyleTheme | undefined): string {
	const label = DEFAULT_MESSAGES[state];
	return themeFg(theme, "muted", `${label}${dotsForStep(step)}`);
}

function renderRandomVerbText(wordList: readonly string[], state: ThinkingStyleState, theme: ThinkingStyleTheme | undefined, cacheKey = wordList): string {
	const verb = verbFor(wordList, state, cacheKey);
	const text = `${verb}…`;
	return themeFg(theme, "muted", text);
}

/** A thinking style's label, cadence, frame builder and status-text vocabulary. */
type ThinkingStyleDefinition = {
	label: string;
	/** Base frame cadence in ms, before the per-state speed scale. */
	intervalMs: number;
	frames: (theme: ThinkingStyleTheme | undefined, state: ThinkingStyleState, tintVar?: string) => string[];
	/** One verb list, sampled once per state phase. */
	verbs?: readonly string[];
	/** Per-state verb lists; wins over `verbs` when present. */
	phaseVerbs?: Record<ThinkingStyleState, readonly string[]>;
};

/**
 * One entry per style — the single place to add or tune a thinking style. The
 * declaration order is `THINKING_STYLE_IDS`.
 */
const THINKING_STYLES: Record<ThinkingStyleId, ThinkingStyleDefinition> = {
	default: { label: "Default", intervalMs: DEFAULT_SPINNER_INTERVAL_MS, frames: defaultFrames },
	claude: { label: "Claude Code Style", intervalMs: 120, frames: claudeFrames, verbs: CLAUDE_VERBS },
	// 13 moon frames → ~1.17 s; each step is a LARGE shape change (10+ ink units) and needs the time.
	moon: { label: "Moon", intervalMs: 90, frames: moonFrames, verbs: MOON_VERBS },
	meteor: { label: "Meteor", intervalMs: 30, frames: meteorFrames, verbs: METEOR_VERBS },
	fireflies: { label: "Fireflies", intervalMs: 110, frames: fireflyFrames, verbs: FIREFLY_VERBS },
	ripple: {
		label: "Ripple",
		intervalMs: 80,
		frames: rippleFrames,
		phaseVerbs: {
			working: ["Rippling", "Flowing"],
			thinking: ["Sounding depths", "Tracing currents"],
			answering: ["Surfacing", "Channeling"],
			running: ["Propagating", "Streaming"],
		},
	},
	shimmer: {
		label: "Shimmer",
		intervalMs: 70,
		frames: shimmerFrames,
		phaseVerbs: {
			working: ["Shimmering", "Glimmering"],
			thinking: ["Illuminating", "Reflecting"],
			answering: ["Revealing", "Polishing"],
			running: ["Sparking", "Focusing"],
		},
	},
	orbit: {
		label: "Orbit",
		intervalMs: 90,
		frames: orbitFrames,
		phaseVerbs: {
			working: ["Orbiting", "Navigating"],
			thinking: ["Charting", "Triangulating"],
			answering: ["Aligning", "Landing"],
			running: ["Launching", "Maneuvering"],
		},
	},
};

/** Style ids in registry order. */
export const THINKING_STYLE_IDS = Object.keys(THINKING_STYLES) as ThinkingStyleId[];

/** One status-text line for a style at a given animation step. */
export function thinkingStyleText(
	id: ThinkingStyleId,
	state: ThinkingStyleState,
	step: number,
	theme?: ThinkingStyleTheme,
): string {
	const style = styleDefinition(id);
	if (style.phaseVerbs) return renderRandomVerbText(style.phaseVerbs[state], state, theme, style.phaseVerbs.working);
	if (style.verbs) return renderRandomVerbText(style.verbs, state, theme);
	return renderDefaultText(state, step, theme);
}
