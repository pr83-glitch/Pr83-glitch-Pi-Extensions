# Pi extensions by pr83-glitch

A collection of custom extensions for [Pi](https://github.com/earendil-works/pi), the terminal-based coding agent. These are tools I use regularly; I’m sharing them in case they’re useful to you too. Each extension is independent, so you can install just the ones you want.

## The extensions

### [pi-sleek-ui](./pi-sleek-ui/README.md)
As the name suggests, this is full ui rework for Pi with bundled themes, user and assistant message styles, animated thinking and tool indicators, several status-bar layouts, notifications, and a task/agent side panel. The side panel displays task and delegated-agent information from compatible tools; it does not provide those tools itself. Open `/sleek` in Pi to browse its settings.

### [pi-edit-message](./pi-edit-message/README.md)
Act on an earlier user message with **Alt+E** or `/pi-edit-message`: restore it to edit and submit again, copy its text, or summarize and fork into a new session. **Alt+R** or `/pi-edit-message-name` can ask the selected model to suggest a session title. Editing changes the active conversation branch; it does not undo file changes made by tools. Naming and summarization may use your configured model and incur provider charges. See its README for details.

### [pi-guard](./pi-guard/README.md)
Switch between **Plan** and **Build** modes to apply different tool permissions, with approval prompts for configured actions. Use **Alt+P**, `/plan`, `/build`, or `/guard` to control it. Pi Guard is a trusted in-process extension—not an operating-system sandbox—so read its safety notes before relying on it.

## Install an extension

You’ll need Pi installed and available as the `pi` command. These copies target **Pi 1.1.x**; Pi Guard also requires **Node.js 22.13 or newer**. Check each extension’s README for its full requirements.

1. Download and extract this repository, or clone it if you have its repository URL.
2. Open a terminal in the extracted/cloned folder—the one containing this README and the three extension folders.
3. Run `pi install` for each extension you want:

```bash
pi install ./pi-sleek-ui
pi install ./pi-edit-message
pi install ./pi-guard
```

You can skip commands for extensions you don’t want. These are **personal installs**, so Pi records them in your user settings and makes them available across projects. Pi loads the extensions directly from these folders; keep the downloaded folder in place. If you move or delete it, the installation will stop working.

Review the extension source before installing: extensions run as code inside Pi with your operating-system permissions. After installation, restart Pi or enter `/reload` in an existing session.

To use them:

- Open `/sleek` to configure pi-sleek-ui.
- Press **Alt+E** or run `/pi-edit-message` to open the message picker.
- Press **Alt+P** or run `/guard` to change pi-guard mode.

For updates, replace each extension’s files in the same location with the newer copy, then restart Pi or use `/reload`. See the extension READMEs for detailed settings, behavior, and any important limitations.

## Learn more

- [pi-sleek-ui details and settings](./pi-sleek-ui/README.md)
- [pi-edit-message usage and behavior](./pi-edit-message/README.md)
- [pi-guard permissions and safety notes](./pi-guard/README.md)
