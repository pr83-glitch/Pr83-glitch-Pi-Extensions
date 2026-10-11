# Bundled themes

The original bundled palettes are ported from pi-zazz (itself vendoring 4 files from
[**@sting8k/pi-themes**](https://github.com/sting8k/pi-themes), MIT, © sting8k, plus
pi-zazz-original hex palettes). Kanagawa Wave and Dragon are adapted from
[rebelot/kanagawa.nvim](https://github.com/rebelot/kanagawa.nvim). Olive CRT, Cendre, Ayu,
Vague, Melange, Burgundy, and Vercel are adapted from their respective upstream theme
repositories. Keeping the files here means no `npm install` is required and Sleek is
self-contained.

pi-zazz's extension-only `extras` block is not carried over: Sleek never read it, so
it has been stripped from every file. Themes are otherwise unmodified. The Catppuccin
family includes Latte, Frappe, Macchiato, and Mocha. Kanagawa includes Wave and Dragon.
Tokyo Night includes the Night, Storm, Moon, and Day variants adapted from
[folke/tokyonight.nvim](https://github.com/folke/tokyonight.nvim).
The new upstream adaptations include dark variants where a repository provides multiple
styles (Ayu Dark and Vercel Dark).

One deliberate Sleek override: `colors.userMessageBg` points at a surface instead of
being empty, so user messages render on their own block. That surface is accent-tinted —
`blend(theme.bg, theme.accent, ~0.24)` for the dark themes and ~0.07–0.12 for the light
ones, precomputed per theme — and the light themes use a near-page `toolBg` surface (`blend(bg, bgCard, 0.5)`) for their tool
and custom-message blocks, with `bgSubtle` lifted halfway to `bg` so the agent text tint
(and selections) stay subtle.

`terminal.json` is maintained in Sleek and is the terminal-native theme: `vars` map to
ANSI palette indices (0-15), so every foreground follows the terminal's colour scheme.
In dark mode, `palette-tint.ts` queries the terminal's reported background and ANSI palette
and derives a darker accent-tinted surface for user/agent messages plus a separate neutral
tool surface. In light mode, all text uses the terminal foreground and user/agent messages
use a pale accent-tinted surface, with tool blocks on an even lighter accent tint. `selectedBg` /
`searchMatchBg` use index `8` (bright black) so selections stay visible on both light and
dark terminals, and the scrollbar uses `8` / `accent`.

`theme/companion-themes.ts` registers every file in this directory as a
companion theme on each session bind.
