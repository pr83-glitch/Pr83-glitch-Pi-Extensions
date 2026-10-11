# pi-edit-message

Need to revisit an earlier prompt? pi-edit-message lets you restore it for editing, copy its text, or fork a session from that point. It also offers optional AI-assisted session naming.

## Install

1. From the repository folder containing `pi-edit-message/`, install it:
   ```bash
   pi install ./pi-edit-message
   ```
2. Keep the folder where it is; the personal install loads the extension from that location.
3. Restart Pi or run `/reload`.

## First use

Press **Alt+E** or run `/pi-edit-message`, then select a message with **↑ / ↓**. Press **E** to restore it for editing, **C** to copy its text, or **Ctrl+F** to summarize and fork. Alternatively, press **Enter** to open the action menu and choose with **↑ / ↓** and **Enter**. Press **Esc** to cancel. Keyboard controls work in regular mode; mouse selection and scrolling require fullscreen mode with mouse tracking. You cannot click messages in the transcript.

### Edit a prompt

Pi returns to just before the selected message and puts its text in the editor. Make changes and **submit manually** to get a new response. The original and following entries leave the active conversation path but remain in session history. This does **not** undo files changed by tools.

Messages containing attachments cannot be edited; image-only messages are not listed. The latest user message may not be selectable until a later entry is saved.

### Before editing or forking

If a response is in progress, Edit and Fork ask before stopping it. Edit replaces the current draft; Fork clears it. Stopping may restore queued text into the draft, and other queued messages may be lost when navigating. Cancelling a later confirmation does not restart a response already stopped. Copy and Cancel do not stop the response or change the draft.

### Copy or fork

Copy gets plain text only—no attachments—and leaves the conversation and draft unchanged. Summarize and fork creates a new session through the selected message’s saved reply and keeps the original session intact. The reply may be partial or missing if interrupted; recent messages remain alongside the summary. If there is too little history or summarization fails, the fork still exists and Pi shows a warning. Summarization may use your configured model and incur provider charges.

## Name a session

Press **Alt+R** or run `/pi-edit-message-name`. The selected model uses up to about 4,000 characters of recent user and assistant text (not images, tool output, or thinking blocks) to create a title without adding a chat turn. Provider charges may apply, and Pi does not record separate usage for this request. If the conversation or model changes before the title is ready, it may be discarded. Use `/pi-edit-message-name cancel` to cancel; only one request runs at a time, with a 30-second timeout. A provider that ignores cancellation may continue processing and incur charges.

## Shortcuts and compatibility

Requires **Pi 1.1.x** and is intended for Pi’s interactive terminal interface. To change shortcuts, edit `config.json` in the installed extension folder, then restart Pi or run `/reload`:

```json
{
  "keybinding": "alt+e",
  "nameKeybinding": "alt+r"
}
```

On macOS, configure Option as Meta/Alt in your terminal if needed. These settings are separate from Pi’s `keybindings.json`.

Review the extension source before installing: extensions run with Pi’s operating-system permissions.

## Credits

Created by [Pr83-glitch](https://github.com/pr83-glitch).
