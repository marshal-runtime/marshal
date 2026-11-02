import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { shell } from "electron";

import { isInsideWorkspace } from "./platform/image-utils";

const ALLOWED_PROTOCOLS = ["http:", "https:", "mailto:"];

/**
 * File extensions allowed to open via shell.openPath.
 * Fail-closed: files with unlisted extensions are blocked.
 * Extensionless files (e.g., Dockerfile, .env) are allowed separately.
 */
const ALLOWED_EXTENSIONS = new Set([
  // Text / code
  ".txt",
  ".md",
  ".markdown",
  ".log",
  ".csv",
  ".tsv",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".ini",
  ".cfg",
  ".conf",
  // Documents
  ".pdf",
  ".rtf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  // Web
  ".html",
  ".htm",
  // Images
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".tiff",
  ".tif",
  ".avif",
  ".heic",
  ".heif",
  // Audio / video
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".webm",
  ".m4a",
  ".m4v",
  ".mov",
  ".avi",
  ".flac",
  ".mkv",
  // Archives (view only — OS shows contents)
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".rar",
]);

/**
 * macOS bundle extensions that are directories but launch code via shell.openPath.
 * Blocked even though isDirectory() returns true.
 */
const MACOS_BUNDLE_EXTENSIONS = new Set([
  ".app",
  ".action",
  ".workflow",
  ".bundle",
  ".plugin",
  ".framework",
]);

/**
 * Opens a URL in the user's default browser/app, restricted to safe protocols.
 * Silently ignores invalid or disallowed URLs.
 */
export function openExternalSafe(url: string): void {
  try {
    const parsed = new URL(url);
    if (ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
      shell.openExternal(url).catch(() => {});
    }
  } catch {
    // Invalid URL — ignore
  }
}

/**
 * Opens a local file or directory via shell.openPath, with security checks:
 * 1. Convert local-file: URL → filesystem path (cross-platform)
 * 2. Resolve symlinks to prevent traversal
 * 3. Extension allowlist — block executable or unknown file types. Extensionless
 *    files remain allowed only inside the managed workspace.
 *
 * @returns An error string if blocked, or empty string on success (matches shell.openPath convention).
 */
export async function openLocalFileSafe(
  url: string,
  _workspaceDir?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Convert local-file: → file: for fileURLToPath
    const fileUrl = url.replace(/^local-file:/i, "file:");
    let filePath: string;
    try {
      filePath = fileURLToPath(fileUrl);
    } catch {
      return { success: false, error: "Invalid file URL" };
    }

    const resolved = path.resolve(filePath);

    // Resolve symlinks to prevent traversal
    let realPath: string;
    try {
      realPath = fs.realpathSync(resolved);
    } catch {
      return { success: false, error: "File not found" };
    }

    // Security gate: stat first, then branch on directory vs file.
    const ext = path.extname(realPath).toLowerCase();
    const stat = fs.statSync(realPath);
    const insideWorkspace = _workspaceDir ? isInsideWorkspace(realPath, _workspaceDir) : false;

    if (stat.isDirectory()) {
      // Block macOS bundles (directories that execute code via shell.openPath)
      if (ext && MACOS_BUNDLE_EXTENSIONS.has(ext)) {
        return { success: false, error: `Blocked file type: ${ext}` };
      }
      // Plain directories open Finder/Explorer
    } else {
      if (!ext && !insideWorkspace) {
        return { success: false, error: "Blocked extensionless file outside workspace" };
      }
      // Files: allow workspace-contained extensionless files (e.g., Dockerfile,
      // .env, Makefile) or files with an allowlisted extension.
      if (ext && !ALLOWED_EXTENSIONS.has(ext)) {
        return { success: false, error: `Blocked file type: ${ext}` };
      }
    }

    const openError = await shell.openPath(realPath);
    if (openError) {
      return { success: false, error: openError };
    }
    return { success: true };
  } catch {
    return { success: false, error: "Failed to open file" };
  }
}
