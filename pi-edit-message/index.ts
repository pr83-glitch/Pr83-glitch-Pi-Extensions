/**
 * pi-edit-message — act on a previous user message.
 *
 *   Alt+E (configurable via config.json) → pick a previous user message, then:
 *
 * - e / Enter menu: edit & regenerate (same session, later entries dropped,
 *   text in editor for editing).
 * - c: copy the message text to the clipboard.
 * - ctrl+f: summarize and fork — fork the conversation at the end of the
 *   selected message's persisted turn into a new session, then
 *   compact (summarize) that new branch. The new session is clean, ready for
 *   fresh instructions.
 *
 * Separately, Alt+R (configurable via config.json) → /pi-edit-message-name asks
 * the current model for a short title of the conversation so far and sets it
 * with pi.setSessionName(), so the session shows a readable name in /resume.
 *
 * Removal: delete this folder and run /reload. Pi itself is never modified.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

import { showActionMenu, showMessageSelector, type Action, type PickerItem } from "./overlays.js";

/** Keybindings from config.json (read once at extension load — needs /reload). */
interface ExtensionConfig {
  /** Opens the message picker. */
  keybinding: string;
  /** Generates a session name with the current model. */
  nameKeybinding: string;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/**
 * Read the optional config.json next to this file.
 * Missing/unreadable/invalid values fall back to the defaults.
 */
function announcePrompt(pi: ExtensionAPI): void {
  pi.events.emit("pi-extension:prompt", { source: "pi-edit-message" });
}

function loadConfig(): ExtensionConfig {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(dir, "config.json"), "utf8");
    const cfg = JSON.parse(raw) as { keybinding?: unknown; nameKeybinding?: unknown };
    return {
      keybinding: readString(cfg.keybinding, "alt+e"),
      nameKeybinding: readString(cfg.nameKeybinding, "alt+r"),
    };
  } catch {
    return { keybinding: "alt+e", nameKeybinding: "alt+r" };
  }
}

/** Extract plain text from a user message's content (string or block array). */
function extractText(
  content: string | Array<{ type: string; text?: string }> | undefined,
): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

/**
 * Given a user message's entry id on the active branch, return the id of the
 * last entry in that message's turn — its assistant reply plus any tool
 * results — so a fork there includes available persisted output. Non-message entries
 * after the reply (model/thinking changes, labels) are included too. Returns
 * null if the id is not on the branch.
 */
function turnEndId(entries: SessionEntry[], userId: string): string | null {
  const start = entries.findIndex((e) => e.id === userId);
  if (start < 0) return null;
  let end = start;
  for (let i = start + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === "message" && e.message.role === "user") break;
    end = i;
  }
  return entries[end]?.id ?? null;
}

/**
 * Flatten the branch's user/assistant text into a transcript for the naming
 * model. Capped to the tail so naming stays cheap on a long session.
 */
function buildTranscript(entries: SessionEntry[], maxChars = 4000): string {
  let tail = "";
  for (let i = entries.length - 1; i >= 0 && tail.length < maxChars; i--) {
    const e = entries[i];
    if (e.type !== "message" || (e.message.role !== "user" && e.message.role !== "assistant")) continue;
    const content = e.message.content;
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
    let text = "";
    for (let j = blocks.length - 1; j >= 0 && text.length < maxChars - tail.length; j--) {
      const block = blocks[j];
      if (block.type === "text") text = (block.text.slice(-maxChars) + (text ? "\n" + text : "")).slice(-maxChars);
    }
    if (text.trim()) tail = (`${e.message.role}: ${text}\n\n` + tail).slice(-maxChars);
  }
  return tail.trim();
}

/** Never touch an invalidated context, including in an error handler. */
function sessionGuard(ctx: ExtensionCommandContext, alive: () => boolean): () => boolean {
  const id = ctx.sessionManager.getSessionId();
  return () => {
    try { return alive() && ctx.sessionManager.getSessionId() === id; }
    catch { return false; }
  };
}

/** Strip quotes/markdown/punctuation the model may add, and cap the length. */
function sanitizeSessionName(raw: string): string {
  let name = raw.replace(/\s+/g, " ").trim();
  name = name.replace(/^title\s*[:\-]\s*/i, "");
  name = name.replace(/^["'`*#\s]+|["'`*#.\s]+$/g, "");
  return name.length > 60 ? `${name.slice(0, 59)}…` : name;
}

/** Ask the current model for a short session title and apply it. */
async function runSessionName(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  current: () => boolean,
  controller: AbortController,
): Promise<void> {
  const model = ctx.model;
  if (!model) {
    ctx.ui.notify("No active model to generate a name with", "error");
    return;
  }
  const transcript = buildTranscript(ctx.sessionManager.getBranch());
  if (!transcript) {
    ctx.ui.notify("No conversation to name yet", "warning");
    return;
  }

  ctx.ui.notify("Generating session name…", "info");

  const response = await ctx.modelRegistry.streamSimple(
    model,
    {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "Name the chat session below.",
                "Reply with ONLY a title: 3-6 words, at most 50 characters, plain text,",
                "no quotes, no markdown, no trailing punctuation.",
                "",
                "<conversation>",
                transcript,
                "</conversation>",
              ].join("\n"),
            },
          ],
          timestamp: Date.now(),
        },
      ],
    },
    { cacheRetention: "none", maxTokens: 48, signal: controller.signal },
  ).result();
  if (!current() || controller.signal.aborted) return;
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage || `Naming request ${response.stopReason}`);
  }

  const raw = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join(" ");
  const name = sanitizeSessionName(raw);
  if (!name) {
    ctx.ui.notify("The model returned an empty name", "warning");
    return;
  }

  pi.setSessionName(name);
  ctx.ui.notify(`Session named: ${name}`, "info");
}

/** Wrap the fire-and-forget ctx.compact() callback API in a Promise. */
function compactSession(ctx: ExtensionContext): Promise<void> {
  return new Promise((resolve, reject) => {
    ctx.compact({
      onComplete: () => resolve(),
      onError: (err) => reject(err),
    });
  });
}

async function runEditMessage(pi: ExtensionAPI, ctx: ExtensionCommandContext, current: () => boolean): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify("The message picker requires interactive TUI mode (not RPC/print/JSON)", "warning");
    return;
  }
  const entries = ctx.sessionManager.getBranch();
  const path = entries.map((e) => e.id);
  const valid = (id: string): boolean => {
    if (!current()) return false;
    const branch = ctx.sessionManager.getBranch();
    return path.every((entryId, i) => branch[i]?.id === entryId) && branch.some((e) => e.id === id);
  };
  const items: PickerItem[] = entries.flatMap((e) => {
    if (e.type !== "message" || e.message.role !== "user") return [];
    const text = extractText(e.message.content);
    return text ? [{ id: e.id, text }] : [];
  });
  if (!items.length) { ctx.ui.notify("No user messages to edit", "warning"); return; }
  const picked = await showMessageSelector(pi, ctx, items);
  if (!picked || !valid(picked.id)) return;
  const action: Action | undefined = picked.action === "menu" ? await showActionMenu(pi, ctx) : picked.action;
  if (!action || !valid(picked.id)) return;
  const entry = ctx.sessionManager.getEntry(picked.id);
  if (!entry || entry.type !== "message" || entry.message.role !== "user") return;
  const text = extractText(entry.message.content);
  if (action === "copy") {
    await copyToClipboard(text);
    if (current()) ctx.ui.notify("Copied message text to clipboard (attachments are not copied)", "info");
    return;
  }
  // Refuse lossy edits before any abort, draft or queue mutation guard.
  if (action === "edit" && Array.isArray(entry.message.content) && entry.message.content.some((b) => b.type !== "text")) {
    ctx.ui.notify("Cannot edit a message with attachments: the text editor cannot restore images. Copy text or summarize-and-fork instead.", "warning");
    return;
  }
  const leafEdit = (): boolean => action === "edit" && ctx.sessionManager.getLeafId() === picked.id;
  if (leafEdit()) {
    ctx.ui.notify("Cannot edit the current user-message leaf: Pi navigation to the current leaf is a no-op. Wait for a persisted reply or choose an earlier message.", "warning");
    return;
  }
  const confirm = async (title: string, message: string): Promise<boolean> => {
    announcePrompt(pi);
    return await ctx.ui.confirm(title, message) && valid(picked.id);
  };
  if (!ctx.isIdle()) {
    if (!await confirm("Agent is running", "Abort the current response? Pi restores queued steering/follow-up text into the editor; this action will then replace or clear that draft.")) return;
    ctx.abort();
    await ctx.waitForIdle();
    if (!valid(picked.id) || leafEdit()) return;
  }
  if (ctx.hasPendingMessages()) {
    if (!await confirm("Queued messages", "Pending steering/follow-up messages belong to the current run. Navigation or session replacement can discard them. Continue?")) return;
  }
  // Both Edit and fork-at drop/replace the editor. Check AFTER abort restores queues.
  if (ctx.ui.getEditorText().trim()) {
    if (!await confirm("Editor has text", action === "edit" ? "The editor draft (including restored queued text) will be replaced. Continue?" : "Forking at the persisted turn end clears the editor draft. Continue?")) return;
  }
  if (!valid(picked.id) || !ctx.isIdle() || leafEdit()) return;
  if (action === "edit") {
    const result = await ctx.navigateTree(picked.id, { summarize: false });
    if (!current()) return;
    if (result.cancelled) { ctx.ui.notify("Navigation cancelled", "warning"); return; }
    // A concurrent navigation/hook must not receive this old draft.
    if (ctx.sessionManager.getLeafId() !== entry.parentId) return;
    ctx.ui.setEditorText(text);
    ctx.ui.notify("Message restored — edit and resubmit to regenerate", "info");
    return;
  }
  // Recompute after all waits: includes newly persisted output, not a guaranteed complete reply.
  const targetId = turnEndId(ctx.sessionManager.getBranch(), picked.id);
  if (!targetId) return;
  const result = await ctx.fork(targetId, {
    position: "at",
    withSession: async (newCtx) => {
      try {
        await compactSession(newCtx);
        newCtx.ui.notify("Summarized and forked into a new session", "info");
      } catch (err) {
        try { newCtx.ui.notify(`Branch created, but summarization failed: ${errText(err)}`, "warning"); }
        catch { /* Session was replaced again; do not reuse it. */ }
      }
    },
  });
  if (result.cancelled && current()) ctx.ui.notify("Fork cancelled", "warning");
  // No old-context access after a successful replacement.
}

/** Error text for notifications. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run a command body, reporting any thrown error as a notification. */
function guarded(ctx: ExtensionCommandContext, current: () => boolean, run: () => Promise<void>): Promise<void> {
  return run().catch((err) => {
    if (current()) {
      try { ctx.ui.notify(errText(err), "error"); } catch { /* Failed replacement invalidated ctx. */ }
    }
  });
}

export default function (pi: ExtensionAPI): void {
  const config = loadConfig();
  let generation = 0;
  let naming: AbortController | undefined;
  const cleanup = () => { generation++; naming?.abort(); naming = undefined; };
  pi.on("session_shutdown", cleanup);
  pi.on("session_start", cleanup);
  const currentFor = (ctx: ExtensionCommandContext) => {
    const captured = generation;
    return sessionGuard(ctx, () => captured === generation);
  };
  pi.registerCommand("pi-edit-message", {
    description: "Edit, copy, or summarize-and-fork a previous user message",
    handler: (_args, ctx) => {
      const current = currentFor(ctx);
      return guarded(ctx, current, () => runEditMessage(pi, ctx, current));
    },
  });
  pi.registerCommand("pi-edit-message-name", {
    description: "Generate a session name with AI (use 'cancel' to stop)",
    handler: (args, ctx) => {
      if (args.trim() === "cancel") { naming?.abort(); return Promise.resolve(); }
      if (naming) { ctx.ui.notify("Session naming already running; /pi-edit-message-name cancel to stop", "warning"); return Promise.resolve(); }
      const controller = new AbortController();
      naming = controller;
      const sessionCurrent = currentFor(ctx);
      const leaf = ctx.sessionManager.getLeafId();
      const model = ctx.model;
      const current = () => sessionCurrent() && ctx.sessionManager.getLeafId() === leaf && ctx.model === model;
      const timer = setTimeout(() => controller.abort(), 30_000);
      // Race cancellation too: providers that ignore AbortSignal must not hold the command/lock forever.
      const cancelled = new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
      return guarded(ctx, sessionCurrent, () => Promise.race([runSessionName(pi, ctx, current, controller), cancelled]))
        .finally(() => { clearTimeout(timer); if (naming === controller) naming = undefined; });
    },
  });

  pi.registerShortcut(config.keybinding as KeyId, {
    description: "Edit a previous user message",
    handler: () => {
      // Bridge to the command: shortcut handlers only receive a plain
      // ExtensionContext (no navigateTree), and the command dispatches only
      // when expandPromptTemplates is true.
      pi.sendUserMessage("/pi-edit-message", { expandPromptTemplates: true });
    },
  });

  pi.registerShortcut(config.nameKeybinding as KeyId, {
    description: "Generate a session name with AI",
    handler: () => {
      pi.sendUserMessage("/pi-edit-message-name", { expandPromptTemplates: true });
    },
  });
}
