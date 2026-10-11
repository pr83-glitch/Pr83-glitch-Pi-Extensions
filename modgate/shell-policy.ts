import fs from "node:fs";
import path from "node:path";
import { parse, type Command, type ParsedScript, type Redirect, type Word, type WordPart } from "unbash";
import { absolutePath, canonicalPath, globMatch, inspectPath, inspectWritePath, result, within, type PolicyResult } from "./paths.js";

export interface ShellConfig {
  sensitivePatterns: string[];
  deniedCommands: string[];
  destructiveCommands: string[];
  planBashCommands: string[];
  generatedPaths: string[];
}

const ALLOW = result("allow", "ordinary_operation", "ordinary operation permitted");
const PRIORITY = { allow: 0, ask: 1, deny: 2 };
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh"]);
const READERS = new Set(["cat", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "jq", "diff", "cmp", "file"]);
const WRAPPERS = new Set(["env", "command", "exec", "nice", "nohup", "timeout", "gtimeout", "sudo"]);

function unwrap(argv: readonly (string | undefined)[], unknown: (reason: string) => void): readonly (string | undefined)[] | undefined {
  const name = path.basename(argv[0] ?? "");
  const args = argv.slice(1);
  if (!WRAPPERS.has(name)) return argv;
  const options: Record<string, { flags: string[]; values: string[] }> = {
    env: { flags: ["-i", "--ignore-environment"], values: ["-u", "--unset"] },
    command: { flags: ["-p"], values: [] },
    exec: { flags: ["-c", "-l"], values: ["-a"] },
    nice: { flags: [], values: ["-n", "--adjustment"] },
    nohup: { flags: [], values: [] },
    timeout: { flags: ["--foreground", "--preserve-status", "--verbose"], values: ["-k", "--kill-after", "-s", "--signal"] },
    gtimeout: { flags: ["--foreground", "--preserve-status", "--verbose"], values: ["-k", "--kill-after", "-s", "--signal"] },
    sudo: { flags: ["-E", "-H", "-n", "-S", "--non-interactive", "--preserve-env"], values: ["-u", "--user", "-g", "--group", "-p", "--prompt", "-h", "--host"] },
  };
  const grammar = options[name]!;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) { unknown(`unresolved ${name} wrapper arguments`); return undefined; }
    if (name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) { i++; continue; }
    if (arg === "--") { i++; break; }
    if (!arg.startsWith("-")) break;
    if (name === "command" && ["-v", "-V"].includes(arg)) return undefined;
    const option = arg.split("=", 1)[0]!;
    if (grammar.values.includes(option)) {
      if (!arg.includes("=")) {
        if (args[i + 1] === undefined) { unknown(`missing ${name} option value`); return undefined; }
        i++;
      }
    } else if (!grammar.flags.includes(arg) && !(name === "nice" && /^-[0-9]+$/.test(arg))) {
      unknown(`unsupported ${name} wrapper option`);
      return undefined;
    }
    i++;
  }
  if (name === "env") while (i < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i] ?? "")) i++;
  if (name === "timeout" || name === "gtimeout") i++;
  return i < args.length ? args.slice(i) : undefined;
}

function commandHead(argv: readonly (string | undefined)[], unknown: (reason: string) => void): string | undefined {
  for (let i = 0; i < 12 && argv[0] !== undefined; i++) {
    const name = path.basename(argv[0]!);
    if (!WRAPPERS.has(name)) return name;
    const next = unwrap(argv, unknown);
    if (!next) return undefined;
    argv = next;
  }
  return undefined;
}

/** Resolve only literal words and $PWD; other expansions remain explicitly unknown. */
function literal(word: Word | undefined, cwd: string): string | undefined {
  if (!word) return undefined;
  const parts = word.parts;
  if (!parts?.length) return /[\*?\[\]{}]/u.test(word.text) ? undefined : word.value;
  const resolve = (items: readonly WordPart[]): string | undefined => {
    let value = "";
    for (const part of items) {
      if (part.type === "Literal") {
        if (/[\*?\[\]]/u.test(part.text)) return undefined;
        value += part.value;
      } else if (part.type === "SingleQuoted" || part.type === "AnsiCQuoted") value += part.value;
      else if (part.type === "DoubleQuoted") {
        // Literal wildcards inside double quotes are not pathname expansions.
        const children = part.parts.map(child => child.type === "Literal" ? { ...child, text: "" } : child);
        const inner = resolve(children);
        if (inner === undefined) return undefined;
        value += inner;
      } else if (part.type === "SimpleExpansion" && part.text === "$PWD") value += cwd;
      else if (part.type === "ParameterExpansion" && part.parameter === "PWD" && !part.operator && !part.indirect && !part.index && !part.slice && !part.replace && !part.length) value += cwd;
      else return undefined;
    }
    return value;
  };
  return resolve(parts);
}

/** Analyze without executing or rewriting the request. YOLO relaxes risks, not parser failures. */
export function analyzeShell(source: string, mode: "plan" | "build" | "yolo", config: ShellConfig, cwd: string, nesting = 0): PolicyResult {
  if (nesting > 8) return result(mode === "build" ? "ask" : "deny", "shell_limit", "nested shell analysis limit reached");
  let outcome = ALLOW;
  const add = (finding: PolicyResult | undefined) => {
    // YOLO intentionally accepts ordinary risks and remote script execution.
    // All other existing hard blocks still protect paths/catastrophic targets.
    if (mode === "yolo" && (finding?.action === "ask" || finding?.code === "remote_shell")) return;
    if (finding && PRIORITY[finding.action] > PRIORITY[outcome.action]) outcome = finding;
  };
  const uncertain = (reason: string) => add(result(mode === "plan" ? "deny" : "ask", "unsupported_shell_syntax", reason));
  const analysisFailure = (reason: string) => add(result(mode === "build" ? "ask" : "deny", "shell_analysis_failed", reason));
  if (source.length > 64000) return result("deny", "shell_limit", "shell request exceeds the 64000-character analysis limit");
  let nodes = 0;
  const directories = new Set([cwd]);
  let unknownDirectory = false;
  let pwdChanged = false;
  const commands: Command[] = [];
  const redirects: Redirect[] = [];
  const seen = new WeakSet<object>();

  const walk = (value: unknown, depth: number): void => {
    if (!value || typeof value !== "object") return;
    if (++nodes > 10000 || depth > 64) { analysisFailure("shell analysis complexity limit reached"); return; }
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { for (const child of value) walk(child, depth + 1); return; }
    const node = value as Record<string, unknown>;
    if (node.type === "Script" && Array.isArray(node.errors) && node.errors.length) analysisFailure("shell parser reported malformed or incomplete syntax");
    if (node.type === "Command") commands.push(value as Command);
    if (node.type === "Pipeline") {
      const heads: string[] = [];
      const collect = (entry: unknown): void => {
        if (!entry || typeof entry !== "object") return;
        const item = entry as Record<string, unknown>;
        if (item.type === "Command") {
          const command = entry as Command;
          const head = commandHead([literal(command.name, cwd), ...command.suffix.map(word => literal(word, cwd))], uncertain);
          if (head) heads.push(head);
        } else if (Array.isArray(item.commands)) item.commands.forEach(collect);
      };
      collect(node);
      if (heads.some(head => ["curl", "wget"].includes(head)) && heads.some(head => SHELLS.has(head))) {
        add(result("deny", "remote_shell", "download-to-shell pipelines are denied"));
      }
    }
    if (node.operator && "fileDescriptor" in node && "target" in node) redirects.push(value as Redirect);
    if (node.type === "Assignment" && node.name === "PWD") pwdChanged = true;
    if (mode === "plan" && node.type === "Assignment") add(result("deny", "plan_assignment", "Plan does not permit shell assignments"));
    if (mode === "plan" && node.type === "Statement" && node.background) add(result("deny", "plan_background", "Plan does not permit background execution"));
    if (["Function", "Coproc", "ArithmeticCommand", "ArithmeticFor"].includes(String(node.type))) uncertain(`unsupported executable shell construct: ${node.type}`);
    // Word.parts is lazy and non-enumerable in unbash. Read it explicitly.
    if (typeof node.text === "string" && typeof node.pos === "number" && !node.type) walk((value as Word).parts, depth + 1);
    for (const [key, child] of Object.entries(node)) if (key !== "parts" && key !== "errors") walk(child, depth + 1);
    if (node.type && "parts" in node) walk(node.parts, depth + 1);
  };

  try {
    const script: ParsedScript = parse(source);
    walk(script, 0);
    if (!script.commands.length && !source.trim().startsWith("#")) uncertain("empty shell request");
  } catch { analysisFailure("shell parser could not analyze this request"); }

  // Keep all possible working directories; do not assume a conditional cd succeeded.
  let directoryChanged = false;
  for (const command of commands) {
    let argv: readonly (string | undefined)[] = [literal(command.name, cwd), ...command.suffix.map(word => literal(word, cwd))];
    for (let i = 0; i < 12 && WRAPPERS.has(path.basename(argv[0] ?? "")); i++) {
      const next = unwrap(argv, uncertain);
      if (!next) break;
      argv = next;
    }
    if (argv[0] !== "cd") continue;
    directoryChanged = true;
    const target = argv.slice(1).find(arg => arg === undefined || !arg.startsWith("-"));
    if (!target || directories.size >= 16) { unknownDirectory = true; continue; }
    for (const base of [...directories]) directories.add(absolutePath(target, base));
  }
  const staticValue = (word: Word | undefined) => {
    if ((pwdChanged || directoryChanged) && word && /\$.*PWD/u.test(word.text)) return undefined;
    return literal(word, cwd);
  };
  const checkPath = (target: string | undefined, location: string, writing = false): void => {
    if (target === undefined || (!path.isAbsolute(target) && unknownDirectory)) {
      uncertain(`unresolved ${location}; cannot check its path`);
      return;
    }
    for (const base of directories) {
      add(inspectPath(target, config.sensitivePatterns, base, location));
      if (writing && mode !== "plan") add(inspectWritePath(target, base));
    }
  };

  for (const redirect of redirects) {
    const target = staticValue(redirect.target);
    if (["<&", ">&"].includes(redirect.operator) && target !== undefined && /^(?:[0-9]+|-)$/.test(target)) {
      if (mode === "plan" && (target !== "-" && !/^[012]$/.test(target))) add(result("deny", "plan_redirect", "Plan cannot verify inherited nonstandard file descriptors"));
      continue;
    }
    if (["<<", "<<-", "<<<"].includes(redirect.operator)) continue; // nested expansions were walked
    const writing = redirect.operator !== "<";
    const diagnostic = redirect.operator === ">" && redirect.fileDescriptor === 2 && target === "/dev/null";
    if (writing && mode === "plan" && !diagnostic) add(result("deny", "plan_write", "Plan does not permit file output redirects"));
    checkPath(target, "redirect target", writing);
  }

  const patterns = (argv: readonly (string | undefined)[], list: readonly string[]) => {
    const text = argv.map(value => value ?? "<unresolved>").join(" ");
    return list.some(pattern => globMatch(pattern, text) || (argv.length === 1 && globMatch(pattern, `${text} `)));
  };
  const generated = (target: string): boolean => {
    if (unknownDirectory) return false;
    try {
      const root = canonicalPath(cwd);
      return [...directories].every(base => {
        const raw = path.resolve(absolutePath(target, base));
        const resolved = canonicalPath(absolutePath(target, base));
        return resolved !== root && within(root, resolved) && within(root, raw) && config.generatedPaths.some(entry => {
          if (path.isAbsolute(entry) || entry === "." || entry === "" || /[?*]/u.test(entry)) return false;
          const lexical = path.resolve(cwd, entry);
          const canonical = canonicalPath(absolutePath(entry, cwd));
          return lexical !== root && canonical !== root && within(root, lexical) && within(root, canonical) &&
            within(lexical, raw) && within(canonical, resolved);
        });
      });
    } catch { return false; }
  };
  const deleteTargets = (targets: readonly (string | undefined)[]) => {
    if (!targets.length) return;
    let safe = true;
    for (const target of targets) {
      if (target === undefined || target === "{}" || /[?*]/u.test(target)) { safe = false; continue; }
      checkPath(target, "deletion target", true);
      for (const base of directories) {
        try {
          const resolved = canonicalPath(absolutePath(target, base));
          const project = canonicalPath(cwd);
          const critical = ["/", "/etc", "/usr", "/boot", "/dev", "/proc", "/sys"];
          if (resolved === project || within(resolved, project) || critical.some(root => root === "/" ? resolved === root : within(root, resolved))) {
            add(result("deny", "critical_deletion", "deletion targets the project root, an ancestor, or a critical system path"));
          }
        } catch { safe = false; }
      }
      if (!generated(target)) safe = false;
    }
    if (!safe) add(result("ask", "destructive_target", "deletion outside verified generated paths requires approval"));
  };

  const inspect = (original: readonly (string | undefined)[], depth = 0): void => {
    if (depth > 12) { uncertain("wrapper nesting limit reached"); return; }
    const [executable, ...args] = original;
    if (!executable) { uncertain("unresolved command name"); return; }
    const name = path.basename(executable);
    const argv = [name, ...args];
    if (executable.includes("/")) {
      checkPath(executable, "executable path");
      if (mode === "plan") add(result("deny", "plan_executable", "Plan does not trust path-qualified executables"));
    }
    if (patterns(argv, config.deniedCommands)) add(result("deny", "denied_command", "command matches a configured denied-command rule"));
    if (patterns(argv, config.destructiveCommands)) add(result("ask", "configured_risk", "command matches a configured approval-required rule"));
    if (/^mkfs(?:\.|$)/u.test(name) || ["wipefs", "shred"].includes(name)) add(result("deny", "disk_destruction", "disk formatting or irreversible wiping is denied"));
    if (["sudo", "su", "doas"].includes(name)) add(result("ask", "privileged_operation", "privilege escalation requires approval"));
    if (["eval", "source", "."].includes(name)) uncertain("dynamic shell evaluation requires review");

    if (WRAPPERS.has(name)) {
      if (mode === "plan" && name === "nohup") add(result("deny", "plan_write", "nohup may write nohup.out and is not permitted in Plan"));
      if (mode === "plan" && name === "env" && args.some(arg => /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg ?? ""))) {
        add(result("deny", "plan_assignment", "Plan does not permit env assignments"));
      }
      const inner = unwrap(argv, uncertain);
      if (inner) inspect(inner, depth + 1);
      return;
    }
    if (SHELLS.has(name)) {
      const index = args.findIndex(arg => arg !== undefined && /^-[^-]*c/.test(arg));
      if (index >= 0) {
        const inner = args[index + 1];
        if (inner === undefined) uncertain("shell -c body is unresolved");
        else {
          if (unknownDirectory) uncertain("nested shell has an unresolved working directory");
          for (const base of directories) add(analyzeShell(inner, mode, { ...config, generatedPaths: [] }, base, nesting + 1));
        }
      } else {
        const script = args.find(arg => arg === undefined || !arg.startsWith("-"));
        if (script !== undefined) checkPath(script, "shell script");
        else if (args.some(arg => arg === undefined)) uncertain("unresolved shell script operand");
        if (mode === "plan") uncertain("Plan does not execute shell scripts");
      }
      // In Build, literal project scripts are trusted code, not statically audited.
      return;
    }
    if (name === "xargs") {
      let i = 0;
      const consumes = new Set(["-I", "-n", "-L", "-P", "-s", "-a", "-d", "--arg-file", "--delimiter", "--max-args", "--max-lines", "--max-procs"]);
      while (i < args.length && args[i]?.startsWith("-")) { const arg = args[i++]!; if (arg === "--") break; if (consumes.has(arg)) i++; }
      if (i < args.length) inspect([...args.slice(i), undefined], depth + 1);
      if (mode === "plan") uncertain("Plan does not execute xargs commands with runtime operands");
      return;
    }
    if (["ls", "stat", "du", "tree", "realpath", "readlink", "cd"].includes(name)) {
      let positional = false;
      const valueOptions = name === "stat" ? ["-c", "--format", "--printf"] : name === "du" ? ["-d", "--max-depth", "--exclude"] : [];
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (!positional && arg === "--") { positional = true; continue; }
        if (!positional && valueOptions.includes(arg ?? "")) { i++; continue; }
        if (!positional && arg?.startsWith("-")) continue;
        checkPath(arg, "inspection path");
      }
    }
    if (name === "find" || name === "fd") {
      if (name === "find") {
        for (const arg of args) {
          if (["-H", "-L", "-P"].includes(arg ?? "")) continue;
          if (arg?.startsWith("-")) break;
          checkPath(arg, "find root");
        }
      }
      for (let i = 0; i < args.length; i++) {
        const option = (args[i] ?? "").split("=", 1)[0]!;
        if (["-exec", "-execdir", "-ok", "-okdir", "-x", "--exec", "-X", "--exec-batch"].includes(option) || /^-[xX].+/.test(option)) {
          const end = args.findIndex((arg, index) => index > i && (arg === ";" || arg === "+"));
          const attached = args[i]?.includes("=") ? args[i]!.slice(args[i]!.indexOf("=") + 1) : undefined;
          inspect(attached ? [attached, ...args.slice(i + 1, end < 0 ? undefined : end)] : args.slice(i + 1, end < 0 ? undefined : end), depth + 1);
          if (mode === "plan") add(result("deny", "plan_exec", "Plan does not permit search execution options"));
          else add(result("ask", "dynamic_execution", "search execution uses runtime paths and requires review"));
        }
      }
      if (args.includes("-delete")) {
        if (mode === "plan") add(result("deny", "plan_write", "Plan does not permit find -delete"));
        else deleteTargets(args.filter(arg => arg !== undefined && !arg.startsWith("-")).slice(0, 1));
      }
      for (let i = 0; i < args.length; i++) if (/^-(?:fprint0?|fls|fprintf)$/.test(args[i] ?? "")) {
        checkPath(args[i + 1], "find output", true);
        if (mode === "plan") add(result("deny", "plan_write", "Plan does not permit find output files"));
      }
    }
    if (["rm", "rmdir", "unlink"].includes(name)) {
      const delimiter = args.indexOf("--");
      deleteTargets(delimiter >= 0 ? args.slice(delimiter + 1) : args.filter(arg => arg === undefined || !arg.startsWith("-")));
    }
    if (name === "dd" && args.some(arg => arg === undefined)) uncertain("dd has unresolved operands");
    if (name === "dd") for (const arg of args) {
      if (arg?.startsWith("if=")) checkPath(arg.slice(3), "dd input");
      if (arg?.startsWith("of=")) {
        checkPath(arg.slice(3), "dd output", true);
        add(result("ask", "destructive_target", "dd output requires approval"));
      }
    }
    if (name === "curl" || name === "wget") {
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (["-o", "--output", "-O", "--output-document"].includes(arg ?? "") && !(name === "curl" && arg === "-O")) checkPath(args[++i], "download output", true);
        else if (/^--(?:output|output-document)=/.test(arg ?? "")) checkPath(arg!.slice(arg!.indexOf("=") + 1), "download output", true);
        else if (["--config", "-K", "--netrc-file"].includes(arg ?? "")) checkPath(args[++i], "download configuration");
      }
    }
    if (["chmod", "chown", "chgrp"].includes(name) && args.some(arg => arg !== undefined && (arg === "--recursive" || /^-[^-]*R/.test(arg)))) add(result("ask", "recursive_permissions", "recursive permission or ownership changes require approval"));
    if (name === "git") {
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === undefined) continue;
        if (["--git-dir", "--work-tree", "-C"].includes(arg) || (args.includes("config") && ["--file", "-f"].includes(arg))) checkPath(args[++i], "Git path option");
        else if (/^--(?:file|git-dir|work-tree)=/.test(arg)) checkPath(arg.slice(arg.indexOf("=") + 1), "Git path option");
        else if (!arg.startsWith("-") && arg.includes(":")) checkPath(arg.slice(arg.indexOf(":") + 1), "Git object path");
      }
      const subcommand = args.find(arg => ["diff", "show", "blame"].includes(arg ?? ""));
      if (subcommand) {
        const index = args.indexOf(subcommand);
        for (const arg of args.slice(index + 1)) if (arg !== undefined && !arg.startsWith("-") && !arg.includes(":")) checkPath(arg, "Git file/ref operand");
      }
      const risky = args.includes("clean") || (args.includes("reset") && args.includes("--hard")) ||
        (args.includes("push") && args.some(arg => arg === "-f" || arg?.startsWith("--force"))) ||
        (args.includes("checkout") && args.includes("--"));
      if (risky) add(result("ask", "git_destructive", "Git operation may discard or overwrite work"));
      if (mode === "plan" && args.some(arg => arg?.startsWith("--output") || arg === "--ext-diff" || arg === "--textconv" || arg === "-c")) add(result("deny", "plan_git_option", "Plan does not permit Git output/external-execution options"));
    }
    if (["systemctl", "service", "shutdown", "reboot", "mount", "umount", "kill", "killall", "pkill"].includes(name)) add(result("ask", "system_operation", "system/process changes require approval"));

    // Search patterns are text, not paths. Only supported option grammar is accepted.
    if (name === "rg" || name === "grep") {
      let hasPattern = false;
      let positional = false;
      const targets: (string | undefined)[] = [];
      const values = new Set(["-e", "--regexp", "-f", "--file", "-g", "--glob", "--iglob", "-t", "--type", "--type-not", "-m", "--max-count", "-A", "-B", "-C", "--context", "--encoding", "--max-depth", "--max-filesize"]);
      const harmless = /^(?:-[nivwFxqcloHsUh]+|--(?:line-number|ignore-case|fixed-strings|word-regexp|count|files-with-matches|files-without-match|quiet|no-heading|heading|hidden|no-ignore|no-ignore-vcs|stats|text|only-matching|invert-match))$/;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (!positional && arg === "--") { positional = true; continue; }
        if (!positional && arg?.startsWith("-")) {
          const [option, attached] = arg.split(/=(.*)/s);
          if (option === "--pre" || option === "--pre-glob") add(result("deny", "search_execution", "search preprocessors are not permitted"));
          if (values.has(option!)) {
            const value = attached ?? args[++i];
            if (option === "-e" || option === "--regexp") hasPattern = true;
            if (option === "-f" || option === "--file") { hasPattern = true; checkPath(value, "search pattern file"); }
          } else if (!harmless.test(arg)) uncertain("unsupported search option; use modgate_search for protected directory searches");
          continue;
        }
        if (!hasPattern) hasPattern = true;
        else targets.push(arg);
      }
      for (const target of targets) {
        checkPath(target, "search target");
        for (const base of directories) {
          try {
            if (target === undefined || !fs.statSync(absolutePath(target, base)).isFile()) add(result("deny", "unsafe_search", "directory content searches require modgate_search or a safe single-file target"));
          } catch { add(result("deny", "unsafe_search", "search target must be an existing safe single file")); }
        }
      }
      if (!targets.length) add(result("deny", "unsafe_search", "implicit directory/stdin searches require modgate_search or an explicit safe file"));
    }
    if (READERS.has(name)) {
      if (name !== "jq" && name !== "tr") {
        const valueOptions: Record<string, string[]> = {
          head: ["-n", "--lines", "-c", "--bytes"], tail: ["-n", "--lines", "-c", "--bytes"],
          sort: ["-k", "--key", "-t", "--field-separator", "-S", "--buffer-size", "--parallel", "-T", "--temporary-directory"],
          cut: ["-d", "--delimiter", "-f", "--fields", "-b", "--bytes", "-c", "--characters", "--output-delimiter"],
          diff: ["-I", "--ignore-matching-lines", "-x", "--exclude", "--label"],
        };
        let positional = false;
        for (let i = 0; i < args.length; i++) {
          const arg = args[i];
          if (!positional && arg === "--") { positional = true; continue; }
          if (!positional && valueOptions[name]?.includes(arg ?? "")) { i++; continue; }
          if (!positional && arg?.startsWith("-")) continue;
          checkPath(arg, "file operand");
        }
      }
      if (name === "jq") {
        let program = false;
        for (let i = 0; i < args.length; i++) {
          const arg = args[i];
          if (["--arg", "--argjson"].includes(arg ?? "")) { i += 2; continue; }
          if (["--rawfile", "--slurpfile"].includes(arg ?? "")) { i++; checkPath(args[++i], "jq input file"); continue; }
          if (arg === "-f" || arg === "--from-file") { checkPath(args[++i], "jq program file"); program = true; continue; }
          if (arg?.startsWith("-")) continue;
          if (!program) program = true;
          else checkPath(arg, "jq file operand");
        }
      }
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (["--files-from", "--file-list", "--files0-from"].includes(arg ?? "") || (name === "file" && arg === "-f")) checkPath(args[++i], "reader file-list option");
        else if (/^--(?:files-from|file-list|files0-from)=/.test(arg ?? "")) checkPath(arg!.slice(arg!.indexOf("=") + 1), "reader file-list option");
        else if (name === "file" && arg?.startsWith("-f") && arg.length > 2) checkPath(arg.slice(2), "reader file-list option");
      }
      if (args.some(arg => /^--(?:files-from|file-list|files0-from)(?:=|$)/.test(arg ?? "") || (name === "file" && /^-f/.test(arg ?? "")))) {
        add(result("deny", "unsafe_input_list", "file-list readers can traverse unchecked protected paths; use explicit file operands"));
      }
      if (args.some(arg => arg === "-o" || arg?.startsWith("--output") || arg === "--run" || arg === "--exec")) {
        if (mode === "plan") add(result("deny", "plan_write", "Plan does not permit output/execution options"));
      }
    }
    if (["cp", "mv", "install", "tee", "truncate", "touch"].includes(name)) for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-t" || arg === "--target-directory") checkPath(args[++i], "write destination", true);
      else if (arg?.startsWith("--target-directory=")) checkPath(arg.slice(arg.indexOf("=") + 1), "write destination", true);
      else if (arg === undefined || !arg.startsWith("-")) checkPath(arg, "write operand", true);
    }

    if (mode === "plan") {
      if (!patterns(argv, config.planBashCommands)) add(result("deny", "plan_command", "Plan shell commands must be allowlisted inspection operations"));
      if (args.some(arg => arg === undefined) && !["echo", "printf"].includes(name)) uncertain("Plan command has unresolved operands");
      if (name === "printf" && args.includes("-v")) add(result("deny", "plan_assignment", "Plan does not permit printf variable assignments"));
      if (name === "sort" && args.some(arg => arg === "-o" || arg?.startsWith("-o") || arg?.startsWith("--output"))) add(result("deny", "plan_write", "Plan does not permit sort output files"));
      if (name === "jq" && args.some(arg => arg === "-f" || arg === "--from-file")) add(result("deny", "plan_exec", "Plan does not permit external jq programs"));
    }
  };

  for (const command of commands) {
    if (!command.name) continue; // assignments/redirects were already inspected
    inspect([staticValue(command.name), ...command.suffix.map(staticValue)]);
  }
  return outcome;
}
