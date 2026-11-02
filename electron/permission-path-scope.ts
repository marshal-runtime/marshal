import fs from "node:fs";
import path from "node:path";

/**
 * Resolve + normalize a path for comparison. Normalizes ".." but does NOT
 * follow symlinks — matches read-tool-auto-approval-rule.ts and the filesystem MCP
 * server's own boundary check, so behavior stays consistent across gates.
 */
export function resolveScopePath(p: string): string {
  return path.resolve(p);
}

function norm(s: string): string {
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/** True when `child` is nested under `dir` (or equals it when includeSelf). */
export function isPathWithinDir(
  child: string,
  dir: string,
  { includeSelf = false }: { includeSelf?: boolean } = {},
): boolean {
  // Reject empty inputs and null bytes defensively (mirrors the filesystem MCP
  // server's path validation).
  if (!child || !dir) return false;
  if (child.includes("\x00") || dir.includes("\x00")) return false;

  const c = norm(resolveScopePath(child));
  const d = norm(resolveScopePath(dir));
  if (includeSelf && c === d) return true;

  // Filesystem roots: `d + path.sep` would double the separator and never match.
  // Unix root "/" — everything is under it.
  if (d === path.sep) return c.startsWith(path.sep);
  // Windows drive root ("c:\") — enforce same drive so a grant on C:\ never
  // includes D:\…, then anchor on the trailing backslash.
  if (path.sep === "\\" && /^[a-z]:\\?$/.test(d)) {
    if (c.charAt(0) !== d.charAt(0)) return false;
    return c.startsWith(d.replace(/\\?$/, "\\"));
  }

  return c.startsWith(d + path.sep);
}

/** True when `child` is the same as, or nested under, any of `dirs`. */
export function isPathUnderAnyDir(child: string, dirs: readonly string[]): boolean {
  return dirs.some((d) => isPathWithinDir(child, d, { includeSelf: true }));
}

/**
 * The folder a grant should cover for a given target path: the path itself when
 * it is an existing directory, otherwise its parent. Writes to a not-yet-created
 * file (e.g. ~/Downloads/new.txt) grant the parent (~/Downloads).
 */
export function grantFolderForPath(rawPath: string): string {
  const resolved = resolveScopePath(rawPath);
  try {
    if (fs.statSync(resolved).isDirectory()) return resolved;
  } catch {
    // Path may not exist yet (new-file write) — fall back to the parent dir.
  }
  return path.dirname(resolved);
}
