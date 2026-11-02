// Owned by the sensitive-path permission guard.

import os from "node:os";
import path from "node:path";

import type { ApprovalRequest } from "./backend/types";
import { splitShellSegments } from "./permission-patterns";
import { getShellMode, type ShellMode } from "./shell-syntax-permission-utils";

export interface SensitivePathHit {
  resolvedPath: string;
  matchedPattern: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export function normalizeSensitivePath(p: string): string {
  const resolved = path.resolve(expandHome(p));
  return process.platform === "win32" || process.platform === "darwin"
    ? resolved.toLowerCase()
    : resolved;
}

export function extractWritePaths(request: ApprovalRequest, shellMode?: ShellMode): string[] {
  const mode = shellMode ?? getShellMode();

  if (request.kind === "read") {
    return request.path ? [request.path] : [];
  }

  if (request.kind === "write") {
    const p = request.path;
    return p ? [p] : [];
  }

  if (request.kind === "mcp") {
    const toolName = request.toolName.toLowerCase();
    const isWriteTool =
      toolName.includes("edit_file") ||
      toolName.includes("write_file") ||
      toolName.includes("create_directory") ||
      toolName.includes("move_file") ||
      toolName.includes("delete_file");
    if (!isWriteTool) return [];
    const args: Record<string, unknown> =
      request.toolArgs && Object.keys(request.toolArgs).length > 0 ? request.toolArgs : {};
    const pathsArr = Array.isArray(args.paths) ? (args.paths as unknown[]) : undefined;
    // move_file writes to destination; other tools write to path
    const p = str(args.destination) || str(args.path) || str(pathsArr?.[0]);
    return p ? [p] : [];
  }

  if (request.kind === "shell") {
    const command = request.command;
    if (!command) return [];
    return extractShellWritePaths(command, mode);
  }

  return [];
}

export function extractShellWritePaths(command: string, shellMode?: ShellMode): string[] {
  const mode = shellMode ?? getShellMode();
  const { segments } = splitShellSegments(command, mode);
  const paths: string[] = [];

  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === undefined) continue;
      if ((t === ">" || t === ">>") && i + 1 < tokens.length) {
        const target = tokens[i + 1];
        if (target && !target.startsWith("-")) paths.push(target);
      }
      if (t.toLowerCase() === "tee") {
        const next = tokens[i + 1];
        if (next === "-a" && i + 2 < tokens.length) {
          const after = tokens[i + 2];
          if (after) paths.push(after);
        } else if (next && !next.startsWith("-")) {
          paths.push(next);
        }
      }
    }
  }

  return paths.filter(Boolean);
}

export function isPathAllowed(resolvedTarget: string, allowedPaths: string[]): boolean {
  const normTarget = normalizeSensitivePath(resolvedTarget);
  for (const entry of allowedPaths) {
    const normEntry = normalizeSensitivePath(entry);
    if (normTarget === normEntry) return true;
    if (normEntry.endsWith(path.sep + "*")) {
      const dir = normEntry.slice(0, -(path.sep.length + 1));
      const rel = normTarget.slice(dir.length + path.sep.length);
      if (normTarget.startsWith(dir + path.sep) && !rel.includes(path.sep)) return true;
    }
    if (normEntry.endsWith(path.sep + "**")) {
      const dir = normEntry.slice(0, -(path.sep.length + 2));
      if (normTarget.startsWith(dir + path.sep)) return true;
    }
  }
  return false;
}

interface DenyEntry {
  pattern: string;
  dir: boolean;
}

function getBuiltInDenyEntries(): DenyEntry[] {
  const home = os.homedir();
  const entries: DenyEntry[] = [
    { pattern: path.join(home, ".ssh"), dir: true },
    { pattern: path.join(home, ".gitconfig"), dir: false },
    { pattern: path.join(home, ".bashrc"), dir: false },
    { pattern: path.join(home, ".zshrc"), dir: false },
    { pattern: path.join(home, ".profile"), dir: false },
    { pattern: path.join(home, ".bash_profile"), dir: false },
    { pattern: path.join(home, ".zprofile"), dir: false },
    { pattern: path.join(home, ".zshenv"), dir: false },
    { pattern: path.join(home, ".bash_logout"), dir: false },
  ];

  if (process.platform === "darwin") {
    entries.push(
      { pattern: path.join(home, "Library", "LaunchAgents"), dir: true },
      { pattern: "/Library/LaunchAgents", dir: true },
      { pattern: "/Library/LaunchDaemons", dir: true },
    );
  }

  if (process.platform === "win32") {
    const appdata = process.env["APPDATA"] ?? "";
    if (appdata) {
      entries.push({
        pattern: path.join(appdata, "Microsoft", "Windows", "Start Menu", "Programs", "Startup"),
        dir: true,
      });
    }
    const userProfile = process.env["USERPROFILE"] ?? "";
    if (userProfile) {
      const docs = path.join(userProfile, "Documents");
      for (const sub of ["PowerShell", "WindowsPowerShell"]) {
        entries.push(
          { pattern: path.join(docs, sub, "Microsoft.PowerShell_profile.ps1"), dir: false },
          { pattern: path.join(docs, sub, "profile.ps1"), dir: false },
        );
      }
    }
  }

  if (process.platform === "linux") {
    entries.push({ pattern: path.join(home, ".config", "autostart"), dir: true });
  }

  return entries;
}

function matchBuiltIn(resolvedTarget: string): string | null {
  const normTarget = normalizeSensitivePath(resolvedTarget);

  // **/.git/config — repo git config anywhere in path
  const gitConfigSuffix = path.sep + path.join(".git", "config");
  if (normTarget.endsWith(gitConfigSuffix)) return "**/.git/config";

  for (const { pattern, dir } of getBuiltInDenyEntries()) {
    const normPattern = normalizeSensitivePath(pattern);
    if (dir) {
      if (normTarget === normPattern || normTarget.startsWith(normPattern + path.sep)) {
        return pattern;
      }
    } else {
      if (normTarget === normPattern) return pattern;
    }
  }

  return null;
}

function isInPathDirectories(resolvedTarget: string): boolean {
  const pathEnv = process.env["PATH"] ?? "";
  const dirs = new Set(
    pathEnv
      .split(path.delimiter)
      .filter((d) => Boolean(d) && path.isAbsolute(d))
      .map((d) => normalizeSensitivePath(d)),
  );
  const parentDir = normalizeSensitivePath(path.dirname(resolvedTarget));
  return dirs.has(parentDir);
}

export function checkSensitivePath(
  request: ApprovalRequest,
  allowedSensitivePaths: string[],
  shellMode?: ShellMode,
): SensitivePathHit | null {
  const mode = shellMode ?? getShellMode();
  const rawPaths = extractWritePaths(request, mode);
  if (rawPaths.length === 0) return null;

  for (const raw of rawPaths) {
    if (!raw) continue;
    const resolved = path.resolve(expandHome(raw));

    const builtInMatch = matchBuiltIn(resolved);
    if (builtInMatch !== null) {
      if (isPathAllowed(resolved, allowedSensitivePaths)) continue;
      return { resolvedPath: resolved, matchedPattern: builtInMatch };
    }

    if (isInPathDirectories(resolved)) {
      if (isPathAllowed(resolved, allowedSensitivePaths)) continue;
      return { resolvedPath: resolved, matchedPattern: "PATH directory" };
    }
  }

  return null;
}
