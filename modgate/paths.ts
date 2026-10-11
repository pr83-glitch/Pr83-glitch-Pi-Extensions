import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Action = "allow" | "ask" | "deny";
export interface PolicyResult {
  action: Action;
  code: string;
  reason: string;
}

export function result(action: Action, code: string, reason: string): PolicyResult {
  return { action, code, reason };
}

/** JSON escaping prevents paths/rules from injecting terminal controls. */
export function display(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function globMatch(pattern: string, value: string): boolean {
  let regex = "^";
  for (const char of pattern) {
    if (char === "*") regex += ".*";
    else if (char === "?") regex += ".";
    else regex += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${regex}$`, "s").test(value);
}

/** Preserve symlink/.. semantics until the filesystem resolves the path. */
export function absolutePath(target: string, cwd: string): string {
  const expanded = expandHome(target);
  return path.isAbsolute(expanded) ? expanded : `${cwd}/${expanded}`;
}

export function canonicalPath(target: string, depth = 0): string {
  if (depth > 40) throw new Error("Too many path indirections");
  try { return fs.realpathSync(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      if (fs.lstatSync(target).isSymbolicLink()) {
        const link = fs.readlinkSync(target);
        return canonicalPath(absolutePath(link, path.dirname(target)), depth + 1);
      }
    } catch (linkError) {
      if ((linkError as NodeJS.ErrnoException).code !== "ENOENT") throw linkError;
    }
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.resolve(canonicalPath(parent, depth + 1), path.basename(target));
  }
}

export function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export function inspectWritePath(target: string, cwd: string): PolicyResult | undefined {
  try {
    const resolved = canonicalPath(absolutePath(target, cwd));
    if (resolved.startsWith("/dev/") && resolved !== "/dev/null") return result("deny", "device_write", "writes to device paths are denied");
    if (resolved === "/" || ["/etc", "/usr", "/boot", "/sys", "/proc"].some(root => within(root, resolved))) {
      return result("ask", "system_write", "writing to a system path requires approval");
    }
  } catch {
    return result("deny", "path_resolution_failed", "cannot safely resolve write destination");
  }
  return undefined;
}

export function inspectPath(target: string, patterns: readonly string[], cwd: string, location = "path"): PolicyResult | undefined {
  const absolute = absolutePath(target, cwd);
  try {
    const candidates = [path.resolve(absolute), canonicalPath(absolute)];
    for (const pattern of patterns) {
      const expanded = expandHome(pattern);
      let matched = false;
      if (!expanded.includes("/")) {
        matched = candidates.some(candidate => globMatch(expanded, path.basename(candidate)));
      } else {
        const normalized = path.resolve(cwd, expanded);
        const wildcard = normalized.search(/[?*]/);
        const prefix = wildcard < 0 ? normalized : normalized.slice(0, wildcard);
        const directory = wildcard < 0 ? path.dirname(normalized) : prefix.slice(0, prefix.lastIndexOf("/")) || path.parse(normalized).root;
        const canonicalPattern = path.join(canonicalPath(directory), path.relative(directory, normalized));
        const directoryRoot = normalized.endsWith("/*") ? normalized.slice(0, -2) : undefined;
        matched = candidates.some(candidate => globMatch(normalized, candidate) || globMatch(canonicalPattern, candidate) ||
          (directoryRoot !== undefined && (candidate === directoryRoot || candidate === canonicalPath(directoryRoot))));
      }
      if (matched) return result("deny", "protected_path",
        `protected path at ${location}: ${display(path.resolve(absolute))}; rule ${display(pattern)}; resolved ${display(candidates[1]!)}`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "resolution_error";
    return result("deny", "path_resolution_failed", `cannot safely resolve ${location} ${display(path.resolve(absolute))}: ${display(code)}`);
  }
  return undefined;
}
