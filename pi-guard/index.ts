import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import planMode from "./modes/plan.js";
import buildMode from "./modes/build.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext, Theme, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type KeyId, type TUI } from "@earendil-works/pi-tui";
import { bindParentPolicy, inheritParentPolicy, isSupportedChild, requestParentApproval, type ApprovalRequest } from "./subagent-mode.js";

export type Mode = "plan" | "build";

export interface ModeDefinition {
  id: string;
  label: string;
  description: string;
  /** Existing pi-guard permission policy used by this mode. */
  permissions: Mode;
  /** Instructions appended to the agent prompt while this mode is active. */
  instructions: string;
}

type ToolAction = "allow" | "ask" | "deny";
type ToolProfile = Mode | "subagent-plan" | "subagent-build";
const TOOL_PROFILES: readonly ToolProfile[] = ["plan", "build", "subagent-plan", "subagent-build"];
const PROFILE_LABELS: Record<ToolProfile, string> = {
  plan: "Plan", build: "Build", "subagent-plan": "Subagent Plan", "subagent-build": "Subagent Build",
};

interface GuardConfig {
  sensitivePatterns: string[];
  destructiveCommands: string[];
  deniedCommands: string[];
  planTools: string[];
  planBashCommands: string[];
  toolRules: Record<ToolProfile, Record<string, ToolAction>>;
  toggleModeShortcut: string;
}

const MODE_ENTRY = "pi-guard-mode";
const MODE_PROMPT_SECTION = "pi-guard-mode";
const DEFAULT_CONFIG: GuardConfig = {
  sensitivePatterns: [
    "*.env",
    "*.env.*",
    "~/.ssh/*",
    "~/.aws/*",
    "~/.config/gh/hosts.yml",
    "*.pem",
    "*.key",
    "id_rsa*",
    "credentials.json",
    "secrets*.yaml",
    ".npmrc",
  ],
  destructiveCommands: [
    "rm *",
    "rmdir *",
    "git reset *",
    "git clean *",
    "git push --force*",
    "git push -f*",
    "sudo *",
    "su *",
    "dd *",
    "mkfs*",
    "chmod -R *",
    "chown -R *",
    "curl * | sh*",
    "curl * | bash*",
    "wget * | sh*",
    "wget * | bash*",
  ],
  deniedCommands: [
    "sudo *",
    "su *",
    "dd *",
    "mkfs*",
    "curl * | sh*",
    "curl * | bash*",
    "wget * | sh*",
    "wget * | bash*",
    "chmod -R *",
    "chown -R *",
  ],
  planTools: ["read", "grep", "find", "ls", "recall", "bash", "todo", "ask_user_question"],
  // Plan keeps its shell access read-only: every command (and every segment of
  // a chain or pipe) must match one of these, with no redirects or substitutions.
  planBashCommands: [
    "pwd",
    "whoami",
    "id",
    "uname",
    "uname *",
    "date",
    "cd",
    "cd *",
    "echo *",
    "printf *",
    "cat *",
    "head *",
    "tail *",
    "wc *",
    "ls",
    "ls *",
    "find",
    "find *",
    "grep *",
    "rg *",
    "fd *",
    "tree *",
    "file *",
    "stat *",
    "du *",
    "df *",
    "which *",
    "type *",
    "command -v *",
    "printenv *",
    "realpath *",
    "readlink *",
    "dirname *",
    "basename *",
    "sort *",
    "uniq *",
    "cut *",
    "tr *",
    "jq *",
    "diff *",
    "cmp *",
    "test *",
    "true",
    "false",
    "node --version",
    "npm --version",
    "python3 --version",
    "git status",
    "git status *",
    "git diff",
    "git diff *",
    "git log",
    "git log *",
    "git show",
    "git show *",
    "git blame *",
    "git ls-files",
    "git ls-files *",
    "git rev-parse *",
    "git describe *",
    "git branch",
    "git branch -a",
    "git branch -r",
    "git branch -v",
    "git branch -vv",
    "git branch --list*",
    "git remote",
    "git remote -v",
    "git remote show *",
    "git config --get*",
    "git config --list*",
  ],
  toolRules: { plan: {}, build: {}, "subagent-plan": {}, "subagent-build": {} },
  toggleModeShortcut: "alt+p",
};

const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR;
  if (!configured) return path.join(os.homedir(), ".pi", "agent");
  return configured === "~" || configured.startsWith("~/")
    ? path.join(os.homedir(), configured.slice(2))
    : configured;
}

function readObject(file: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function loadConfig(cwd: string, trusted: boolean): GuardConfig {
  const globalFile = path.join(agentDir(), "extensions", "pi-guard", "config.json");
  const projectFile = path.join(cwd, ".pi", "extensions", "pi-guard", "config.json");
  const sources = [readObject(globalFile), ...(trusted ? [readObject(projectFile)] : [])];
  const config: GuardConfig = {
    ...DEFAULT_CONFIG,
    toolRules: { plan: {}, build: {}, "subagent-plan": {}, "subagent-build": {} },
  };
  for (const source of sources) {
    for (const key of ["sensitivePatterns", "destructiveCommands", "deniedCommands", "planTools", "planBashCommands"] as const) {
      const value = source[key];
      if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
        config[key] = [...new Set([...config[key], ...value])];
      }
    }
    const rules = source.toolRules;
    if (rules !== null && typeof rules === "object" && !Array.isArray(rules)) {
      for (const mode of TOOL_PROFILES) {
        const modeRules = (rules as Record<string, unknown>)[mode];
        if (modeRules === null || typeof modeRules !== "object" || Array.isArray(modeRules)) continue;
        for (const [tool, action] of Object.entries(modeRules)) {
          if (action === "allow" || action === "ask" || action === "deny") config.toolRules[mode][tool] = action;
        }
      }
    }
    if (typeof source.toggleModeShortcut === "string") config.toggleModeShortcut = source.toggleModeShortcut;
  }
  return config;
}

function writeGlobalConfig(patch: (config: Record<string, unknown>) => void): void {
  const file = path.join(agentDir(), "extensions", "pi-guard", "config.json");
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  let config: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Config must be an object; refusing to overwrite it");
    config = value as Record<string, unknown>;
  }
  patch(config);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* rename already removed it */ }
  }
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function globMatch(pattern: string, value: string): boolean {
  let regex = "^";
  for (const char of pattern) {
    if (char === "*") regex += ".*";
    else if (char === "?") regex += ".";
    else regex += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${regex}$`, "is").test(value);
}

function normalizedPath(target: string, cwd: string): string {
  // Pi's file tools accept @/absolute/path and normalize non-breaking spaces.
  return path.resolve(cwd, expandHome(target.replace(/^@/, "").replace(/[\u00a0\u202f\u2007]/g, " ")));
}

function canonicalPath(target: string, depth = 0): string {
  if (depth > 40) throw new Error("Too many path indirections");
  try { return fs.realpathSync(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      if (fs.lstatSync(target).isSymbolicLink()) {
        return canonicalPath(path.resolve(path.dirname(target), fs.readlinkSync(target)), depth + 1);
      }
    } catch (linkError) {
      if ((linkError as NodeJS.ErrnoException).code !== "ENOENT") throw linkError;
    }
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.join(canonicalPath(parent, depth + 1), path.basename(target));
  }
}

function sensitivePath(target: string, patterns: readonly string[], cwd: string): boolean {
  try {
    const absolute = normalizedPath(target, cwd);
    const candidates = [absolute, canonicalPath(absolute)];
    return patterns.some((pattern) => {
      const expanded = expandHome(pattern);
      if (!expanded.includes("/")) return candidates.some((candidate) => globMatch(expanded, path.basename(candidate)));
      const normalized = path.resolve(cwd, expanded);
      const wildcard = normalized.search(/[?*]/);
      const prefix = wildcard < 0 ? normalized : normalized.slice(0, wildcard);
      const staticDirectory = wildcard < 0 ? path.dirname(normalized) : prefix.slice(0, prefix.lastIndexOf("/")) || path.parse(normalized).root;
      const canonicalPattern = path.join(canonicalPath(staticDirectory), path.relative(staticDirectory, normalized));
      const directoryRoot = normalized.endsWith("/*") ? normalized.slice(0, -2) : undefined;
      return candidates.some((candidate) => globMatch(normalized, candidate) || globMatch(canonicalPattern, candidate) ||
        (directoryRoot !== undefined && (candidate === directoryRoot || candidate === canonicalPath(directoryRoot))));
    });
  } catch { return true; } // unreadable/broken resolution fails closed
}

function unsafeSearch(event: ToolCallEvent, config: GuardConfig, cwd: string): boolean {
  // find/ls list names, not file contents. Direct protected roots remain blocked
  // by sensitivePath; only recursive content search needs a traversal boundary.
  if (event.toolName !== "grep") return false;
  const target = toolSubject(event) || ".";
  try {
    const absolute = canonicalPath(normalizedPath(target, cwd));
    if (event.toolName === "grep" && fs.statSync(absolute).isFile()) return false;
    // A directory content search can follow protected names or symlinks. There
    // is no common per-call exclusion contract; permit single-file grep only.
    return config.sensitivePatterns.length > 0;
  } catch { return true; }
}

function commandTokens(command: string): string[] {
  return command.match(/(?:[^\s"'`]+|"[^"]*"|'[^']*')/g)?.map((token) => token.replace(/^['"`]|['"`]$/g, "")) ?? [];
}

function sensitiveCommand(command: string, patterns: readonly string[], cwd: string): boolean {
  return commandTokens(command).some((token) => sensitivePath(token, patterns, cwd));
}

function normalizedCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim().toLowerCase();
}

function isDestructive(command: string, patterns: readonly string[]): boolean {
  const normalized = normalizedCommand(command);
  return patterns.some((pattern) => globMatch(pattern.toLowerCase(), normalized));
}

// Options that turn an otherwise read-only command into a writer.
const PLAN_WRITE_FLAGS = /^(?:--output(?:=.*)?|-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fls|fprintf))$/u;

/**
 * Plan shell access stays read-only. Redirects, substitutions and newlines are
 * rejected outright (they can write files or smuggle a second command), and
 * composition is permitted only when every segment is itself an allowlisted
 * read-only command. This is still lexical, not a shell parser.
 */
function planBashAllows(command: string, patterns: readonly string[]): boolean {
  // "2>/dev/null" and "2>&1" discard diagnostics without writing a file.
  const cleaned = command.replace(/\s*2>\s*(?:\/dev\/null|&1)/gu, "");
  if (/[>\n\r`]|\$\(|\$\{/u.test(cleaned)) return false;
  const segments = cleaned.split(/&&|\|\||[&;|]/u).map(normalizedCommand).filter((segment) => segment !== "");
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    if (commandTokens(segment).some((token) => PLAN_WRITE_FLAGS.test(token))) return false;
    return patterns.some((pattern) => globMatch(pattern.toLowerCase(), segment));
  });
}

function sessionKey(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager?.getSessionId?.() ?? "global";
  } catch {
    return "global";
  }
}

function toolSubject(event: ToolCallEvent): string {
  const input = event.input as Record<string, unknown>;
  if (event.toolName === "bash") return typeof input.command === "string" ? input.command : "";
  if (PATH_TOOLS.has(event.toolName)) return typeof input.path === "string" ? input.path : "";
  return "";
}

function hasSensitiveInput(event: ToolCallEvent, config: GuardConfig, cwd: string): boolean {
  const subject = toolSubject(event);
  return event.toolName === "bash"
    ? sensitiveCommand(subject, config.sensitivePatterns, cwd)
    : subject !== "" && sensitivePath(subject, config.sensitivePatterns, cwd);
}

function stableInput(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object") return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort((item as Record<string, unknown>)[key])]));
    return item;
  };
  return JSON.stringify(sort(value));
}

function approvalDetails(event: ToolCallEvent): string | undefined {
  const input = stableInput(event.input);
  // Never approve truncated arguments. Escaped controls cannot inject ANSI/OSC.
  if (input.length > 12000) return undefined;
  return input.replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function decision(event: ToolCallEvent, config: GuardConfig, cwd: string, mode: Mode, child: boolean): ToolAction {
  if (hasSensitiveInput(event, config, cwd) || unsafeSearch(event, config, cwd)) return "deny";
  if (event.toolName === "bash" && isDestructive(toolSubject(event), config.deniedCommands)) return "deny";
  if (mode === "plan" && WRITE_TOOLS.has(event.toolName)) return "deny";
  if (mode === "plan" && event.toolName === "bash" && !planBashAllows(toolSubject(event), config.planBashCommands)) return "deny";
  const profile: ToolProfile = child ? `subagent-${mode}` : mode;
  const manual = config.toolRules[profile][event.toolName] ?? config.toolRules[mode][event.toolName];
  if (manual === "deny") return "deny";
  const destructive = event.toolName === "bash" && isDestructive(toolSubject(event), config.destructiveCommands);
  // Build remains usable for ordinary project work: only explicitly-asked tools
  // and commands matching the destructive-command policy require approval.
  if (manual === "ask" || destructive) return "ask";
  return manual ?? (mode === "plan" && !config.planTools.includes(event.toolName) ? "deny" : "allow");
}

function isModeDefinition(value: unknown): value is ModeDefinition {
  if (!value || typeof value !== "object") return false;
  const mode = value as Partial<ModeDefinition>;
  return (
    typeof mode.id === "string" && /^[a-z][a-z0-9-]*$/.test(mode.id) &&
    typeof mode.label === "string" && mode.label.trim().length > 0 &&
    typeof mode.description === "string" &&
    (mode.permissions === "plan" || mode.permissions === "build") &&
    typeof mode.instructions === "string"
  );
}

/** Load every mode file from the extension's modes folder. */
export async function loadModes(): Promise<ModeDefinition[]> {
  const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "modes");
  let files: string[];
  try {
    files = fs.readdirSync(directory)
      .filter((file) => /\.(?:[cm]?js|ts)$/u.test(file) && !file.endsWith(".d.ts"))
      .sort()
      .map((file) => path.join(directory, file));
  } catch {
    return [{ ...planMode }, { ...buildMode }];
  }

  const modes: ModeDefinition[] = [{ ...planMode }, { ...buildMode }];
  const ids = new Set<string>(["plan", "build", "guard", "guard-tools", "reload", "tools", "model", "settings", "tree", "fork", "resume", "new", "quit", "help"]);
  for (const file of files) {
    try {
      if (["plan.ts", "build.ts"].includes(path.basename(file))) continue;
      // Public Node strip-types supports self-contained erasable TS mode files.
      // No Pi-private Jiti dependency. Unsupported imports/syntax skip safely.
      const url = file.endsWith(".ts")
        ? `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(fs.readFileSync(file, "utf8"))).toString("base64")}`
        : pathToFileURL(file).href;
      const loaded = await import(url) as { default?: ModeDefinition };
      const mode = (loaded as { default?: ModeDefinition }).default ?? loaded;
      if (!isModeDefinition(mode)) {
        console.warn(`[pi-guard] skipped invalid mode file: ${file}`);
        continue;
      }
      if (ids.has(mode.id)) {
        console.warn(`[pi-guard] skipped duplicate mode id "${mode.id}": ${file}`);
        continue;
      }
      ids.add(mode.id);
      modes.push({ ...mode, label: mode.label.trim(), instructions: mode.instructions.trim() });
    } catch (error) {
      console.warn(`[pi-guard] could not load mode file ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const builtInOrder = ["plan", "build"];
  modes.sort((left, right) => {
    const leftIndex = builtInOrder.indexOf(left.id);
    const rightIndex = builtInOrder.indexOf(right.id);
    if (leftIndex !== -1 || rightIndex !== -1) {
      return (leftIndex === -1 ? builtInOrder.length : leftIndex) - (rightIndex === -1 ? builtInOrder.length : rightIndex);
    }
    return left.id.localeCompare(right.id);
  });
  return modes;
}

class ModeStore {
  private readonly modes = new Map<string, ModeDefinition>();
  private readonly active = new Map<string, string>();

  constructor(modes: readonly ModeDefinition[]) {
    for (const mode of modes) this.modes.set(mode.id, mode);
  }

  getModes(): ModeDefinition[] {
    return [...this.modes.values()];
  }

  getDefinition(id: string): ModeDefinition {
    return this.modes.get(id) ?? this.modes.get("plan") ?? [...this.modes.values()][0]!;
  }

  get(key: string): string {
    return this.active.get(key) ?? this.getDefinition("plan").id;
  }

  getPermissionMode(key: string): Mode {
    return this.getDefinition(this.get(key)).permissions;
  }

  reset(key: string): void { this.active.delete(key); }

  restore(key: string, mode: string): void {
    if (this.modes.has(mode)) this.active.set(key, mode);
  }

  async set(key: string, id: string, pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
    const mode = this.getDefinition(id);
    const previousId = this.get(key);
    this.active.set(key, mode.id);
    // Enforce policy in tool_call, not by changing the user's tool loadout.
    // Saved Plan loadouts otherwise lose write/edit across reload and resume.
    try {
      ctx.ui.setStatus("pi-guard-mode", mode.label);
    } catch {
      // status bars are unavailable in non-interactive clients
    }
    if (mode.id !== previousId) {
      try {
        pi.appendEntry(MODE_ENTRY, { mode: mode.id });
      } catch {
        // session persistence is best effort
      }
    }
  }
}

type PermissionChoice = "allow" | "deny" | "session";

function permissionDescription(toolName: string, subject: string, mode: Mode, destructive: boolean): string {
  if (toolName === "bash") {
    const command = subject.trim().toLowerCase();
    if (command.startsWith("rm ") || command.startsWith("rmdir ")) return "This will permanently delete files or directories.";
    if (command.startsWith("git reset") || command.startsWith("git clean")) return "This may discard local Git changes or untracked files.";
    if (command.startsWith("git push --force") || command.startsWith("git push -f")) return "This will force-update a remote Git branch and may overwrite other work.";
    if (command.startsWith("sudo ") || command.startsWith("su ")) return "This will run a command with elevated system privileges.";
    if (command.startsWith("dd ") || command.startsWith("mkfs")) return "This may overwrite or format storage and cause permanent data loss.";
    if (command.startsWith("chmod -r") || command.startsWith("chown -r")) return "This will recursively change file permissions or ownership.";
    if (command.includes("| sh") || command.includes("| bash")) return "This downloads and executes a remote script on your system.";
    if (destructive) return "This command may make destructive changes to files or the system.";
    return `This will run a Bash command that may change files or system state in ${mode} mode.`;
  }
  if (toolName === "write") return "This will create or overwrite a file.";
  if (toolName === "edit") return "This will modify an existing file.";
  if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") {
    return `This will let Pi inspect a file or directory using the ${toolName} tool.`;
  }
  return `This will let Pi run the ${toolName} tool, which may change project data.`;
}

function createPermissionPrompt(
  tui: TUI,
  theme: Theme,
  description: string,
  subject: string,
  done: (result: PermissionChoice) => void,
  onceOnly = false,
): Component {
  const options: Array<{ key: string; label: string; value: PermissionChoice }> = [
    { key: "Y", label: "Allow once", value: "allow" },
    { key: "S", label: "Allow for this session", value: "session" },
    { key: "N", label: "Deny", value: "deny" },
  ];
  if (onceOnly) options.splice(1, 1);
  let selected = 0;
  let scroll = 0;
  let reviewable = true;

  const finish = (choice: PermissionChoice): void => done(choice);
  const keyChoice = (data: string): PermissionChoice | undefined => {
    if (matchesKey(data, "y") || matchesKey(data, "shift+y")) return "allow";
    if (!onceOnly && (matchesKey(data, "s") || matchesKey(data, "shift+s"))) return "session";
    if (matchesKey(data, "n") || matchesKey(data, "shift+n")) return "deny";
    return undefined;
  };
  const fit = (text: string, width: number): string => {
    const clipped = truncateToWidth(text, width, "…");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  };

  return {
    invalidate() {},
    handleInput(data: string) {
      if (!reviewable) {
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) finish("deny");
        return;
      }
      const quickChoice = keyChoice(data);
      if (quickChoice) {
        finish(quickChoice);
        return;
      }
      if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
        scroll = Math.max(0, scroll + (matchesKey(data, "pageUp") ? -3 : 3));
        tui.requestRender();
      } else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        finish("deny");
      } else if (matchesKey(data, "up")) {
        selected = (selected + options.length - 1) % options.length;
        tui.requestRender();
      } else if (matchesKey(data, "down")) {
        selected = (selected + 1) % options.length;
        tui.requestRender();
      } else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
        finish(options[selected]!.value);
      }
    },
    render(renderWidth: number): string[] {
      const width = Math.max(1, Math.min(renderWidth, 92));
      const budget = Math.max(1, Math.floor((tui.terminal?.rows ?? 24) * 0.7));
      reviewable = width >= 12 && budget >= options.length + 5;
      if (!reviewable) return [truncateToWidth("Resize to review; Esc denies", width, "")];
      const innerWidth = width - 4;
      const border = theme.fg("accent", "│");
      const line = (content: string): string => `${border} ${fit(content, innerWidth)} ${border}`;
      const top = `${theme.fg("accent", "┌")}${theme.fg("accent", "─".repeat(width - 2))}${theme.fg("accent", "┐")}`;
      const bottom = `${theme.fg("accent", "└")}${theme.fg("accent", "─".repeat(width - 2))}${theme.fg("accent", "┘")}`;
      const output: string[] = [top, line(theme.bold(theme.fg("warning", "Pi Guard · review action")))];
      const details = wrapTextWithAnsi(`${description}\nArguments (JSON):\n${subject}`, Math.max(1, innerWidth));
      const available = Math.max(0, budget - options.length - 5);
      scroll = Math.min(scroll, Math.max(0, details.length - available));
      output.push(...details.slice(scroll, scroll + available).map(line));
      for (const [index, option] of options.entries()) {
        const content = `${option.key} - ${option.label}`;
        output.push(index === selected ? line(theme.bg("selectedBg", fit(content, innerWidth))) : line(content));
      }
      output.push(line(theme.fg("dim", onceOnly ? "Y/N · enter · esc · PgUp/PgDn details" : "Y/S/N · enter · esc · PgUp/PgDn details")));
      output.push(bottom);
      return output;
    },
  };
}

async function choosePermission(ctx: ExtensionContext, description: string, subject: string, signal: AbortSignal, onceOnly = false): Promise<PermissionChoice> {
  if (!ctx.hasUI) return "deny";
  if (ctx.mode === "tui") {
    try {
      return await ctx.ui.custom<PermissionChoice>(
        (tui, theme, _keybindings, done) => {
          const cancel = () => done("deny");
          signal.addEventListener("abort", cancel, { once: true });
          const prompt = createPermissionPrompt(tui, theme, description, subject, (choice) => { signal.removeEventListener("abort", cancel); done(choice); }, onceOnly);
          return { ...prompt, dispose() { signal.removeEventListener("abort", cancel); } };
        },
        { overlay: true, overlayOptions: { width: 78, maxHeight: "70%" } },
      );
    } catch {
      return "deny";
    }
  }
  try {
    const choice = await ctx.ui.select(`${description}\nArguments (JSON):\n${subject}`, onceOnly ? ["Y - Allow once", "N - Deny"] : ["Y - Allow once", "S - Allow for this session", "N - Deny"], { signal });
    if (choice === "Y - Allow once") return "allow";
    if (!onceOnly && choice === "S - Allow for this session") return "session";
  } catch {
    // A failed or dismissed prompt fails closed
  }
  return "deny";
}

type PickerAction = ToolAction | "default";

type ToolRules = GuardConfig["toolRules"];

function createToolPicker(
  tools: readonly string[],
  initialMode: ToolProfile,
  rules: ToolRules,
  planTools: readonly string[],
  theme: Theme,
  tui: TUI,
  onSave: (mode: ToolProfile, tool: string, action: PickerAction) => boolean,
  done: () => void,
): Component {
  const actions = (): readonly PickerAction[] => (mode === "plan" || mode === "subagent-plan") && (selectedTool === "bash" || WRITE_TOOLS.has(selectedTool)) ? ["default", "deny"] : selectedTool === "bash" ? ["default", "ask", "deny"] : ["default", "allow", "ask", "deny"];
  let query = "";
  let selected = 0;
  let scroll = 0;
  let mode: ToolProfile = initialMode;
  let phase: "modes" | "tools" | "actions" = "modes";
  let modeIndex = TOOL_PROFILES.indexOf(mode);
  let selectedTool = tools[0] ?? "";
  let actionIndex = 0;
  let reviewable = true;

  const filteredTools = (): string[] => {
    const needle = query.trim().toLowerCase();
    return needle === "" ? [...tools] : tools.filter((tool) => tool.toLowerCase().includes(needle));
  };
  const currentRules = (): Record<string, ToolAction> => rules[mode];
  const effectiveDefault = (tool: string): string => {
    const base: Mode = mode === "plan" || mode === "subagent-plan" ? "plan" : "build";
    const inherited = mode.startsWith("subagent-") ? rules[base][tool] : undefined;
    if (base === "plan" && WRITE_TOOLS.has(tool)) return "deny";
    if (base === "plan" && tool === "bash") return "read-only allowlist";
    if (tool === "bash") return "ask (every call)";
    if (inherited) return `inherit ${PROFILE_LABELS[base]}: ${inherited}`;
    if (base === "plan") return planTools.includes(tool) ? "allow" : "deny";
    return "allow";
  };
  const shownAction = (tool: string): string => {
    const manual = currentRules()[tool];
    return manual ?? `default [${effectiveDefault(tool)}]`;
  };
  const clamp = (count: number, visible: number): void => {
    selected = Math.max(0, Math.min(selected, Math.max(0, count - 1)));
    if (selected < scroll) scroll = selected;
    if (selected >= scroll + visible) scroll = selected - visible + 1;
    scroll = Math.max(0, Math.min(scroll, Math.max(0, count - visible)));
  };
  const actionLabel = (action: PickerAction): string => action[0].toUpperCase() + action.slice(1);
  const actionMarker = (action: PickerAction, active: boolean): string => {
    const marker = active ? "●" : "○";
    return theme.fg(active ? "success" : "accent", marker) + ` ${actionLabel(action)}`;
  };
  const fit = (text: string, width: number): string => {
    const clipped = truncateToWidth(text, width, "…");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  };

  return {
    invalidate() {},
    handleInput(data: string) {
      if (!reviewable) {
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) done();
        return;
      }
      if (phase === "modes") {
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
          done();
          return;
        }
        if (matchesKey(data, "up") || matchesKey(data, "down")) {
          const delta = matchesKey(data, "up") ? -1 : 1;
          modeIndex = (modeIndex + delta + TOOL_PROFILES.length) % TOOL_PROFILES.length;
        } else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
          mode = TOOL_PROFILES[modeIndex]!;
          phase = "tools";
          query = "";
          selected = 0;
          scroll = 0;
          tui.requestRender();
          return;
        } else {
          return;
        }
        tui.requestRender();
        return;
      }
      if (phase === "actions") {
        if (matchesKey(data, "escape")) {
          phase = "tools";
          tui.requestRender();
          return;
        }
        if (matchesKey(data, "up") || matchesKey(data, "down")) {
          const delta = matchesKey(data, "up") ? -1 : 1;
          actionIndex = (actionIndex + delta + actions().length) % actions().length;
          tui.requestRender();
        } else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
          if (onSave(mode, selectedTool, actions()[actionIndex]!)) {
            phase = "tools";
            tui.requestRender();
          }
        }
        return;
      }
      if (matchesKey(data, "escape")) {
        phase = "modes";
        tui.requestRender();
        return;
      }
      const rows = filteredTools();
      if (matchesKey(data, "up") || matchesKey(data, "down")) {
        if (rows.length > 0) {
          const delta = matchesKey(data, "up") ? -1 : 1;
          selected = (selected + delta + rows.length) % rows.length;
          clamp(rows.length, Math.max(3, (tui.terminal?.rows ?? 24) - 11));
        }
      } else if (matchesKey(data, "backspace")) {
        query = query.slice(0, -1);
        selected = 0;
        scroll = 0;
      } else if (matchesKey(data, "ctrl+u")) {
        query = "";
        selected = 0;
        scroll = 0;
      } else if (data.length === 1 && data >= " " && data !== "\x7f") {
        query += data;
        selected = 0;
        scroll = 0;
      } else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
        const tool = rows[selected];
        if (tool) {
          selectedTool = tool;
          const current = currentRules()[tool] ?? "default";
          actionIndex = Math.max(0, actions().indexOf(current));
          phase = "actions";
        }
      } else {
        return;
      }
      tui.requestRender();
    },
    render(renderWidth: number): string[] {
      const width = Math.max(1, renderWidth);
      const budget = Math.max(1, Math.floor((tui.terminal?.rows ?? 24) * 0.85));
      reviewable = width >= 16 && budget >= 9;
      if (!reviewable) return [truncateToWidth("Resize to configure; Esc exits", width, "")];
      const bodyWidth = width - 4;
      const border = theme.fg("accent", "│");
      const rule = theme.fg("dim", "─".repeat(bodyWidth));
      const line = (content: string): string => `${border} ${fit(content, bodyWidth)} ${border}`;
      const output: string[] = [`${theme.fg("accent", "┌")}${theme.fg("accent", "─".repeat(width - 2))}${theme.fg("accent", "┐")}`];
      const title = theme.bold(theme.fg("accent", phase === "modes" ? "Pi Guard · tool permissions" : `Pi Guard · ${PROFILE_LABELS[mode]} tool permissions`));
      const search = phase === "tools" ? (query === "" ? theme.fg("dim", "⌕ Type to filter…") : theme.fg("text", `⌕ ${query}`)) : theme.fg("dim", phase === "modes" ? "⌕ choose a mode" : "⌕ choose an action");
      output.push(line(`${title}${" ".repeat(Math.max(1, bodyWidth - visibleWidth(title) - visibleWidth(search)))}${search}`));
      output.push(line(rule));

      if (phase === "modes") {
        output.push(line(theme.fg("muted", "MODE")));
        output.push(line(theme.fg("dim", "─".repeat(bodyWidth))));
        const visible = Math.min(TOOL_PROFILES.length, budget - 8);
        const start = Math.max(0, Math.min(modeIndex - visible + 1, TOOL_PROFILES.length - visible));
        for (const [offset, value] of TOOL_PROFILES.slice(start, start + visible).entries()) {
          const index = start + offset;
          const content = `${index === modeIndex ? theme.fg("success", "●") : theme.fg("accent", "○")} ${PROFILE_LABELS[value]}`;
          output.push(index === modeIndex ? line(theme.bg("selectedBg", fit(content, bodyWidth))) : line(content));
        }
        output.push(line(theme.fg("dim", "↑/↓ choose · enter open · esc cancel")));
      } else if (phase === "tools") {
        const rows = filteredTools();
        const activeRules = currentRules();
        const visible = Math.max(1, Math.min(18, budget - 8));
        clamp(rows.length, visible);
        output.push(line(`${theme.fg("muted", "TOOL")}  ${theme.fg("muted", "ACTION")}`));
        output.push(line(theme.fg("dim", "─".repeat(bodyWidth))));
        if (rows.length === 0) output.push(line(theme.fg("dim", "No matching tools.")));
        for (const [offset, tool] of rows.slice(scroll, scroll + visible).entries()) {
          const index = scroll + offset;
          const action = activeRules[tool];
          const shown = shownAction(tool);
          const marker = action === "allow" ? theme.fg("success", "●") : action === "ask" ? theme.fg("warning", "?") : action === "deny" ? theme.fg("error", "×") : theme.fg("dim", "·");
          const content = `${marker} ${tool}${" ".repeat(Math.max(2, 28 - visibleWidth(tool)))}${theme.fg(action ? "text" : "dim", shown)}`;
          output.push(index === selected ? line(theme.bg("selectedBg", fit(content, bodyWidth))) : line(content));
        }
        output.push(line(theme.fg("dim", "↑/↓ navigate · type search · enter configure · esc back")));
      } else {
        output.push(line(theme.fg("muted", `ACTION FOR ${selectedTool.toUpperCase()} · ${PROFILE_LABELS[mode].toUpperCase()}`)));
        output.push(line(theme.fg("dim", "─".repeat(bodyWidth))));
        const visible = Math.min(actions().length, budget - 8);
        const start = Math.max(0, Math.min(actionIndex - visible + 1, actions().length - visible));
        for (const [offset, action] of actions().slice(start, start + visible).entries()) {
          const index = start + offset;
          const content = actionMarker(action, index === actionIndex);
          output.push(index === actionIndex ? line(theme.bg("selectedBg", fit(content, bodyWidth))) : line(content));
        }
        output.push(line(theme.fg("dim", "↑/↓ choose · enter save · esc back")));
      }
      output.push(line(rule));
      output.push(`${theme.fg("accent", "└")}${theme.fg("accent", "─".repeat(width - 2))}${theme.fg("accent", "┘")}`);
      return output;
    },
  };
}

async function configureToolPermissions(pi: ExtensionAPI, ctx: ExtensionContext, config: GuardConfig): Promise<void> {
  if (!ctx.hasUI) return;
  if (ctx.mode !== "tui") { ctx.ui.notify("[pi-guard] Tool picker requires TUI. Edit global config manually; RPC custom components are unsupported.", "warning"); return; }
  ctx.ui.notify("[pi-guard] Saves target global config only. Trusted project rules override global rules; reopen to see effective policy.", "info");
  const tools = [...new Set(pi.getAllTools().map((tool) => tool.name))].sort();
  if (tools.length === 0) {
    ctx.ui.notify("[pi-guard] no tools available", "info");
    return;
  }
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => createToolPicker(
      tools,
      "plan",
      config.toolRules,
      config.planTools,
      theme,
      tui,
      (mode, tool, action) => {
        const value = action === "default" ? undefined : action;
        try {
          writeGlobalConfig((saved) => {
            const rules = saved.toolRules !== null && typeof saved.toolRules === "object" && !Array.isArray(saved.toolRules)
              ? saved.toolRules as Record<string, Record<string, string>>
              : {};
            const modeRules = rules[mode] ?? {};
            if (value) modeRules[tool] = value;
            else delete modeRules[tool];
            rules[mode] = modeRules;
            saved.toolRules = rules;
          });
          const refreshed = loadConfig(ctx.cwd, ctx.isProjectTrusted()).toolRules;
          for (const profile of TOOL_PROFILES) config.toolRules[profile] = refreshed[profile];
          ctx.ui.notify(`[pi-guard] ${tool} in ${PROFILE_LABELS[mode]}: ${value ?? "default"}`, "info");
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`[pi-guard] failed to save tool rule: ${message}`, "error");
          return false;
        }
      },
      () => done(),
    ),
    { overlay: true, overlayOptions: { width: 82, maxHeight: "85%" } },
  );
}

async function openMenu(pi: ExtensionAPI, ctx: ExtensionContext, store: ModeStore, config: GuardConfig): Promise<void> {
  if (!ctx.hasUI) return;
  const current = store.get(sessionKey(ctx));
  const modeOptions = store.getModes().map((mode) => `${mode.id}: ${mode.label} mode`);
  const choice = await ctx.ui.select(`Pi Guard — currently ${store.getDefinition(current).label}`, [
    ...modeOptions,
    "Tool permissions",
    `Plan tools: ${config.planTools.join(", ")}`,
    "Cancel",
  ]);
  const selectedMode = modeOptions.indexOf(choice ?? "");
  if (selectedMode !== -1) {
    const mode = store.getModes()[selectedMode]!;
    await store.set(sessionKey(ctx), mode.id, pi, ctx);
    ctx.ui.notify(`[pi-guard] switched to ${mode.label} mode`, "info");
  } else if (choice === "Tool permissions") {
    await configureToolPermissions(pi, ctx, config);
  }
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const store = new ModeStore(await loadModes());
  const sessionAllows = new Set<string>();
  const lastAgentStartMode = new Map<string, string>();
  const shortcut = loadConfig(process.cwd(), false).toggleModeShortcut.trim();
  let epoch = new AbortController();
  let revision = 0;
  let approvalTail: Promise<unknown> = Promise.resolve();
  const revoke = (): void => { revision++; epoch.abort(); epoch = new AbortController(); sessionAllows.clear(); };
  const serial = async <T>(signal: AbortSignal, work: () => Promise<T>, denied: T): Promise<T> => {
    const previous = approvalTail;
    let release!: () => void;
    approvalTail = new Promise<void>((resolve) => { release = resolve; });
    try { await previous; return signal.aborted ? denied : await work(); } finally { release(); }
  };
  let parentPolicy: ReturnType<typeof bindParentPolicy> | undefined;
  let inheritedPolicy: ReturnType<typeof inheritParentPolicy> | undefined;

  const syncPolicy = (ctx: ExtensionContext): void => {
    const key = sessionKey(ctx);
    if (inheritedPolicy) {
      const next = inheritedPolicy();
      if (store.getPermissionMode(key) !== next) revoke();
      store.restore(key, next);
    }
    parentPolicy?.update(store.getPermissionMode(key));
  };

  const setMode = async (mode: string, ctx: ExtensionContext): Promise<void> => {
    if (inheritedPolicy) {
      syncPolicy(ctx);
      if (ctx.hasUI) ctx.ui.notify("[pi-guard] subagents follow their parent's permission mode", "warning");
      return;
    }
    revoke();
    await store.set(sessionKey(ctx), mode, pi, ctx);
    syncPolicy(ctx);
    if (ctx.hasUI) ctx.ui.notify(`[pi-guard] switched to ${store.getDefinition(mode).label} mode`, "info");
  };

  for (const mode of store.getModes()) {
    pi.registerCommand(mode.id, {
      description: mode.description,
      handler: async (_args, ctx) => setMode(mode.id, ctx),
    });
  }
  pi.registerCommand("guard", {
    description: "Open the pi-guard mode menu",
    handler: async (_args, ctx) => {
      if (inheritedPolicy) return;
      revoke();
      await openMenu(pi, ctx, store, loadConfig(ctx.cwd, ctx.isProjectTrusted()));
      syncPolicy(ctx);
    },
  });
  pi.registerCommand("guard-tools", {
    description: "Configure tool rules for Plan, Build, Subagent Plan and Subagent Build",
    handler: async (_args, ctx) => configureToolPermissions(pi, ctx, loadConfig(ctx.cwd, ctx.isProjectTrusted())),
  });
  if (shortcut) {
    pi.registerShortcut(shortcut as KeyId, {
      description: "Toggle pi-guard permission mode",
      handler: async (ctx) => {
        const modes = store.getModes();
        const current = store.get(sessionKey(ctx));
        const index = modes.findIndex((mode) => mode.id === current);
        const next = modes[(index + 1 + modes.length) % modes.length]?.id ?? "plan";
        await setMode(next, ctx);
      },
    });
  }

  pi.on("before_agent_start", (event, ctx) => {
    syncPolicy(ctx);
    const key = sessionKey(ctx);
    const mode = store.getDefinition(store.get(key));
    const previous = lastAgentStartMode.get(key);
    lastAgentStartMode.set(key, mode.id);
    const transition = previous !== undefined && previous !== mode.id
      ? `Mode changed: you are now in ${mode.label} mode. Follow this mode's instructions instead of any earlier mode instructions.`
      : "";

    // Use a named section instead of replacing the whole prompt. This keeps the mode
    // instruction when another extension also updates before_agent_start.
    event.systemPromptOptions.sections[MODE_PROMPT_SECTION] = [mode.instructions, transition]
      .filter(Boolean)
      .join("\n\n");
  });

  const checkTool = async (event: ToolCallEvent, ctx: ExtensionContext) => {
    syncPolicy(ctx);
    const key = sessionKey(ctx);
    const modeId = store.get(key);
    const mode = store.getPermissionMode(key);
    const trusted = ctx.isProjectTrusted();
    const config = loadConfig(ctx.cwd, trusted);
    const action = decision(event, config, ctx.cwd, mode, !!inheritedPolicy);
    const deny = { block: true, reason: "[pi-guard] operation denied by policy, user, cancellation or stale approval. In Plan mode, shell commands must be allowlisted read-only commands with no redirects or substitutions; directory content searches require a safe single-file target." };
    if (action === "deny") return deny;
    if (action === "allow") return undefined;
    const details = approvalDetails(event);
    if (!details) return { block: true, reason: "[pi-guard] arguments exceed the 12000-character review limit; split the request." };
    const originalInput = stableInput(event.input);
    const configKey = stableInput(config);
    const startRevision = revision;
    const signal = ctx.signal ? AbortSignal.any([epoch.signal, ctx.signal]) : epoch.signal;
    const fresh = () => {
      syncPolicy(ctx);
      return !signal.aborted && revision === startRevision && sessionKey(ctx) === key &&
        store.get(key) === modeId && store.getPermissionMode(key) === mode &&
        stableInput(event.input) === originalInput && ctx.isProjectTrusted() === trusted &&
        stableInput(loadConfig(ctx.cwd, trusted)) === configKey &&
        decision(event, loadConfig(ctx.cwd, trusted), ctx.cwd, mode, !!inheritedPolicy) === "ask";
    };
    if (inheritedPolicy) {
      const approved = await requestParentApproval(ctx.sessionManager, { event, cwd: ctx.cwd, trusted, mode, signal });
      return approved && fresh() ? undefined : deny;
    }
    const approvalKey = stableInput([key, modeId, ctx.cwd, trusted, configKey, event.toolName, originalInput]);
    return serial(signal, async () => {
      if (!fresh()) return deny;
      if (sessionAllows.has(approvalKey)) return undefined;
      const choice = await choosePermission(ctx, permissionDescription(event.toolName, toolSubject(event), mode,
        event.toolName === "bash" && isDestructive(toolSubject(event), config.destructiveCommands)), details, signal, event.toolName === "bash");
      if (!fresh() || choice === "deny") return deny;
      if (choice === "session" && event.toolName !== "bash") sessionAllows.add(approvalKey);
      return undefined;
    }, deny);
  };
  pi.on("tool_call", checkTool);
  pi.on("user_bash", async (event, ctx) => {
    // Pi 1.1.0 accepts a full BashResult replacement, not {block:true}.
    const blocked = await checkTool({ type: "tool_call", toolName: "bash", toolCallId: "user-bash", input: { command: event.command } } as ToolCallEvent, ctx);
    if (blocked) return { result: { output: blocked.reason, exitCode: 1, cancelled: false, truncated: false } };
    return undefined;
  });

  const restoreBranch = async (ctx: ExtensionContext): Promise<void> => {
    revoke();
    const key = sessionKey(ctx);
    store.reset(key);
    lastAgentStartMode.delete(key);
    try {
      for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
        if (entry.type !== "custom" || entry.customType !== MODE_ENTRY) continue;
        const mode = (entry.data as { mode?: string } | undefined)?.mode;
        if (typeof mode === "string") store.restore(key, mode);
        break;
      }
    } catch { /* unreadable branch remains Plan */ }
    syncPolicy(ctx);
    try { ctx.ui.setStatus("pi-guard-mode", store.getDefinition(store.get(key)).label); } catch { /* headless */ }
  };
  pi.on("session_tree", async (_event, ctx) => restoreBranch(ctx));

  pi.on("session_start", async (_event, ctx) => {
    parentPolicy?.dispose();
    parentPolicy = undefined;
    inheritedPolicy = isSupportedChild(ctx) ? inheritParentPolicy(ctx.sessionManager) : undefined;
    await restoreBranch(ctx);
    const key = sessionKey(ctx);
    if (ctx.hasUI && (ctx.mode === "tui" || ctx.mode === "rpc")) {
      parentPolicy = bindParentPolicy(key, store.getPermissionMode(key), async (request: ApprovalRequest, valid) => {
        const originalInput = stableInput(request.event.input);
        const details = approvalDetails(request.event);
        const configKey = stableInput(loadConfig(request.cwd, request.trusted));
        const startRevision = revision;
        const signal = AbortSignal.any([epoch.signal, request.signal]);
        const fresh = () => valid() && !signal.aborted && startRevision === revision &&
          store.getPermissionMode(key) === request.mode && originalInput === stableInput(request.event.input) &&
          configKey === stableInput(loadConfig(request.cwd, request.trusted)) &&
          decision(request.event, loadConfig(request.cwd, request.trusted), request.cwd, request.mode, true) === "ask";
        if (!details || !fresh()) return false;
        return serial(signal, async () => {
          if (!fresh()) return false;
          // Parent reviews this exact child call; no session grants are used or created.
          const choice = await choosePermission(ctx, `Subagent · ${request.event.toolName} · ${request.mode} · ${request.cwd}`, details, signal, true);
          return choice === "allow" && fresh();
        }, false);
      });
    }
  });

  pi.on("session_shutdown", () => {
    parentPolicy?.dispose();
    parentPolicy = undefined;
    inheritedPolicy = undefined;
    revoke();
    lastAgentStartMode.clear();
  });
}
