/**
 * Startup logo animation styles.
 *
 * The animation plays on the start screen (process startup), on /new and when
 * /reload is run on an empty session; never on /resume or /fork. TUI mode only.
 * To add a style, extend the id union + IDS + LABELS here, add its frame builder
 * to startup-ui.ts and add it to the /sleek "Pi logo animation" picker
 * (LOGO_ANIMATION_OPTIONS in index.ts).
 */

export type LogoAnimationStyleId = "static" | "materialize" | "reveal" | "wipe";

/** Styles that actually animate ("static" is excluded). */
const ANIMATED_LOGO_ANIMATION_STYLE_IDS: LogoAnimationStyleId[] = ["materialize", "reveal", "wipe"];

const LOGO_ANIMATION_STYLE_IDS: LogoAnimationStyleId[] = [
	"static",
	...ANIMATED_LOGO_ANIMATION_STYLE_IDS,
];

const LOGO_ANIMATION_STYLE_LABELS: Record<LogoAnimationStyleId, string> = {
	static: "Static",
	materialize: "Materialize",
	reveal: "Reveal",
	wipe: "Wipe",
};

const DEFAULT_LOGO_ANIMATION_STYLE_ID: LogoAnimationStyleId = "static";

function isLogoAnimationStyleId(value: unknown): value is LogoAnimationStyleId {
	return typeof value === "string" && (LOGO_ANIMATION_STYLE_IDS as string[]).includes(value);
}

/**
 * Ids kept working for already-saved configs: the earlier names (`none` ->
 * `static`, `fluid` -> `reveal`) plus the retired styles (`random`/`cycle`/
 * `tetris` -> `materialize`). Always normalized to the canonical id on read.
 */
const LEGACY_LOGO_ANIMATION_STYLE_ALIASES: Record<string, LogoAnimationStyleId> = {
	none: "static",
	fluid: "reveal",
	random: "materialize",
	cycle: "materialize",
	tetris: "materialize",
};

export function resolveLogoAnimationStyleId(value: unknown): LogoAnimationStyleId {
	// Earlier ids — keep saved configs working.
	if (typeof value === "string") {
		if (Object.hasOwn(LEGACY_LOGO_ANIMATION_STYLE_ALIASES, value)) return LEGACY_LOGO_ANIMATION_STYLE_ALIASES[value]!;
	}
	return isLogoAnimationStyleId(value) ? value : DEFAULT_LOGO_ANIMATION_STYLE_ID;
}

export function logoAnimationStyleLabel(id: LogoAnimationStyleId): string {
	return LOGO_ANIMATION_STYLE_LABELS[id] ?? LOGO_ANIMATION_STYLE_LABELS[DEFAULT_LOGO_ANIMATION_STYLE_ID];
}

let activeLogoAnimationStyleId: LogoAnimationStyleId = DEFAULT_LOGO_ANIMATION_STYLE_ID;

export function getActiveLogoAnimationStyleId(): LogoAnimationStyleId {
	return activeLogoAnimationStyleId;
}

export function setActiveLogoAnimationStyleId(id: LogoAnimationStyleId): void {
	activeLogoAnimationStyleId = id;
}
