# pi-sleek-ui

Make Pi feel more like your workspace. Sleek brings a calmer, more personal look to Pi’s terminal interface, with thoughtful themes, clearer tool previews, and useful session details—all in one extension.

![license](https://img.shields.io/badge/license-MIT-blue)
![version](https://img.shields.io/badge/version-0.57.1-blue)
![pi](https://img.shields.io/badge/pi-%3E%3D1.1-%3C1.2-7aa2f7)

## Install

1. From the repository folder containing `pi-sleek-ui/`, run:

   ```bash
   pi install ./pi-sleek-ui
   ```
2. Keep that folder in place: this install loads Sleek directly from it.
3. Restart Pi, or run `/reload` to activate it.

Extensions run with Pi’s operating-system permissions, so review the source before installing.

## Get started

1. Run `/sleek` to explore settings. Choose an option with the arrow keys and Enter; most changes take effect right away.
2. Press **Ctrl+\\** to show or hide the side panel.
3. Where supported, press **Ctrl+O** to expand a collapsed tool or task preview.

## What you’ll get

- **A look that feels yours:** 24 bundled themes, including a terminal-native theme, plus styles for user and assistant messages.
- **Easier-to-scan activity:** compact or expanded tool displays, animated working details, and side-by-side edit previews. Very large diffs may be collapsed or lack syntax highlighting.
- **Helpful session context:** customizable status bars, a live turn timer, and a side panel. Project and usage details are available independently; task and agent sections appear when compatible tools provide them.
- **A more polished start and finish:** startup effects, home-screen options, and an automatic reply footer with elapsed time and, when available, cost and speed. The response footer is always shown and cannot currently be turned off.
- **Optional desktop alerts:** notification and sound choices for when a reply is ready, depending on your system and available helper programs.

## Requirements and notes

Sleek supports **Pi 1.1.x**. A Nerd Font is recommended for some icons, and some mouse interactions require Pi’s fullscreen mode.

Task and agent sections need compatible tools; project and usage details are available independently. The panel hides when the terminal is narrower than 100 columns. Live agent activity requires a compatible in-process child session; separately launched agents may not report activity. Sleek displays available task and agent information—it does not create tasks or agents.

Desktop alerts, sounds, and the sound-file picker rely on optional system programs (`notify-send`, audio players, and `zenity` or `kdialog`). Focus-aware alerts also depend on terminal support. Notifications may include reply excerpts or question and permission details, so consider your lock-screen privacy settings.

Sleek changes presentation, not how Pi executes commands or applies its sandbox. If another extension has already taken control of the editor, Sleek leaves it in place.

## License and theme credits

Sleek is MIT-licensed. Bundled themes include work adapted from [pi-themes](https://github.com/sting8k/pi-themes), [kanagawa.nvim](https://github.com/rebelot/kanagawa.nvim), and [tokyonight.nvim](https://github.com/folke/tokyonight.nvim), as well as other upstream theme projects. See [`themes/README.md`](./themes/README.md) for full credits and licensing.
