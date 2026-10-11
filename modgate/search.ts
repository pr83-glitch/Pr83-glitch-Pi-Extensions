import fs from "node:fs/promises";
import path from "node:path";
import { absolutePath, globMatch, inspectPath } from "./paths.js";

/** Bounded literal search. Never follows symlinks or reads protected files. */
export async function searchFiles(
  root: string, query: string, fileGlob: string | undefined, cwd: string,
  patterns: readonly string[], signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  if (!query || query.length > 1000 || /[\r\n]/u.test(query)) throw new Error("query must be a nonempty single-line literal, at most 1000 characters");
  const start = absolutePath(root, cwd);
  const denial = inspectPath(start, patterns, cwd, "search root");
  if (denial) throw new Error(denial.reason);
  const output: string[] = [];
  let visited = 0;
  let bytes = 0;
  let truncated = false;
  const visit = async (file: string, depth: number): Promise<void> => {
    if (signal?.aborted) throw new Error("search cancelled");
    if (++visited > 10000 || depth > 40 || bytes > 16 * 1024 * 1024 || output.length >= 100) { truncated = true; return; }
    if (inspectPath(file, patterns, cwd)) return;
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      if ([".git", "node_modules"].includes(path.basename(file))) return;
      const entries = await fs.readdir(file);
      for (const entry of entries) {
        if (truncated) break;
        await visit(path.join(file, entry), depth + 1);
      }
    } else if (stat.isFile()) {
      const relative = path.relative(start, file) || path.basename(file);
      if (fileGlob && !globMatch(fileGlob, relative) && !globMatch(fileGlob, path.basename(file))) return;
      if (stat.size > 2 * 1024 * 1024) { truncated = true; return; }
      // O_NOFOLLOW closes the final-component symlink race; directory races still
      // need OS isolation. Recheck protection immediately before opening.
      if (inspectPath(file, patterns, cwd)) return;
      const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (!opened.isFile()) return;
        const limit = Math.min(2 * 1024 * 1024, 16 * 1024 * 1024 - bytes);
        if (opened.size > limit || limit <= 0) { truncated = true; return; }
        const buffer = Buffer.alloc(Math.min(opened.size + 1, limit + 1));
        const read = await handle.read(buffer, 0, buffer.length, 0);
        if (read.bytesRead > opened.size) { truncated = true; return; }
        const content = buffer.subarray(0, read.bytesRead);
        bytes += content.length;
        if (content.includes(0)) return;
        const lines = content.toString("utf8").split(/\r?\n/u);
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]!.includes(query)) output.push(`${path.relative(cwd, file)}:${i + 1}: ${lines[i]!.slice(0, 400)}`);
          if (output.length >= 100) { truncated = true; break; }
        }
      } finally { await handle.close(); }
    }
  };
  await visit(start, 0);
  // Escape controls in content so search output cannot inject terminal sequences.
  const text = output.join("\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return { text: text.slice(0, 24000) || "No matches in eligible files.", truncated: truncated || text.length > 24000 };
}
