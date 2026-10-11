# edit-message

Use a previous user message to revise a prompt, copy its text, or start a new session from that point. Also includes optional AI-assisted session naming.

**Requirements:** Pi 1.1.x. This extension is designed for Pi’s interactive terminal interface.

## Install

From the repository folder containing `edit-message/`, run:

```bash
pi install ./edit-message
```

This personal install loads the extension from that folder, so keep it in place. Restart Pi or run `/reload` to activate it. Review the source before installing; extensions run with Pi’s operating-system permissions.

## Use

Press **Alt+E** or run `/edit-message` to choose a previous user message.

| Key | Action |
| --- | --- |
| ↑ / ↓ | Select a message |
| E | Restore it for editing |
| C | Copy its text |
| Ctrl+F | Summarize and fork into a new session |
| Enter | Open the action menu |
| Esc | Cancel |

Keyboard controls work in regular mode. Mouse selection and scrolling require fullscreen mode with mouse tracking. Messages cannot be clicked directly in the transcript.

### Edit

Pi returns to just before the selected message and restores its text in the editor. Edit it and submit it yourself to get a new response. The message and later entries leave the active conversation path but remain in session history. This does **not** undo files changed by tools.

You cannot edit a message containing attachments, and image-only messages are not listed. Pi also cannot navigate to the latest user message until a later entry is saved; choose an earlier message or wait for more output.

Editing or forking during a response asks before stopping it. Edit replaces the current draft; fork clears it. Stopping a response may restore queued text into the draft, and remaining queued messages may be lost when navigating. Copy and Cancel do not stop a response or change the draft. Cancelling a later confirmation does not restart a response already stopped.

### Copy

Copies plain text only. Attachments are not copied; your conversation and draft are unchanged.

### Summarize and fork

Creates and switches to a new session containing the conversation up to and including the selected message’s saved reply, then summarizes older history. The original session stays intact. A reply can be partial or missing if the response was interrupted. Recent messages remain alongside the summary; this is not a summary-only session. If summarization fails or there is too little history, the fork still exists and Pi shows a warning. Summarization may use your configured model and incur provider charges.

## AI session naming

Press **Alt+R** or run `/edit-message-name` to ask the selected model for a short session title. Use `/edit-message-name cancel` to cancel a request. Only one naming request runs at a time; it times out after 30 seconds.

The request sends up to about 4,000 characters of recent user and assistant text—no images, tool output, or thinking blocks. It renames the session without adding a chat turn. Provider usage may incur charges; reasoning behavior depends on the provider. If the conversation or selected model changes before the title is ready, the result may be discarded. Pi does not record separate usage for this request. Cancelling or timing out stops waiting for the result, but a provider that ignores cancellation may continue processing and incur charges.

## Change shortcuts

Edit `config.json` in the installed extension folder, then restart Pi or run `/reload`:

```json
{
  "keybinding": "alt+e",
  "nameKeybinding": "alt+r"
}
```

On macOS, your terminal may need Option configured as Meta/Alt. These settings are separate from Pi’s `keybindings.json`.

For more detail on behavior and limitations, see the sections above before using Edit or Fork on an important session.

## Credits

Created by [Pr83-glitch](https://github.com/pr83-glitch).
