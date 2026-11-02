/**
 * Platform-specific security utilities.
 * macOS: exclude M-owned data from Time Machine / iCloud backup.
 * Cross-platform: restrictive file/dir permissions on sensitive data.
 */

import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { createLogger } from "../common/marshal-logger";

const log = createLogger("PlatformSecurity");
let windowsUserSid: string | undefined;

// ── Restrictive file permissions ────────────────────────────────────────────

/**
 * Write a file and enforce its permissions.
 *
 * Node's `writeFile(path, data, { mode })` only applies the mode when
 * *creating* a file — it is silently ignored for existing files.
 * This wrapper calls `chmod` after every write so the permissions are
 * always correct regardless of whether the file already existed.
 * On Windows the chmod is a no-op (mode is ignored by the OS).
 * The chmod is best-effort — failure is logged but does not throw.
 */
export function secureWriteFileSync(
  filePath: string,
  data: string | Buffer,
  opts?: fs.WriteFileOptions & { mode?: number },
): void {
  const mode = typeof opts === "object" ? opts?.mode : undefined;
  fs.writeFileSync(filePath, data, opts);
  if (mode !== undefined) {
    try {
      fs.chmodSync(filePath, mode);
    } catch {
      /* best effort */
    }
  }
}

/**
 * Durably replace a file without exposing readers to a truncated intermediate state.
 * The temporary file lives beside the destination so rename remains atomic.
 */
export function secureAtomicWriteFileSync(
  filePath: string,
  data: string | Buffer,
  opts: { encoding?: BufferEncoding; mode?: number; directoryMode?: number } = {},
): void {
  const mode = opts.mode ?? 0o600;
  const directoryMode = opts.directoryMode ?? 0o700;
  const directory = dirname(filePath);
  const directoryExisted = fs.existsSync(directory);
  secureMkdirSync(directory, directoryMode);
  if (!directoryExisted) syncDirectorySync(dirname(directory));

  const tempPath = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let tempHandle: number | undefined;
  let replaced = false;
  try {
    tempHandle = fs.openSync(tempPath, "wx", mode);
    fs.writeFileSync(
      tempHandle,
      data,
      opts.encoding === undefined ? undefined : { encoding: opts.encoding },
    );
    fs.fsyncSync(tempHandle);
    fs.closeSync(tempHandle);
    tempHandle = undefined;

    fs.renameSync(tempPath, filePath);
    replaced = true;
    try {
      fs.chmodSync(filePath, mode);
    } catch {
      /* best effort */
    }
    syncDirectorySync(directory);
  } finally {
    if (tempHandle !== undefined) {
      try {
        fs.closeSync(tempHandle);
      } catch {
        /* best effort */
      }
    }
    if (!replaced) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* best effort */
      }
    }
  }
}

/** Async variant of {@link secureWriteFileSync}. */
export async function secureWriteFile(
  filePath: string,
  data: string | Buffer,
  opts?: Parameters<typeof fs.promises.writeFile>[2] & { mode?: number },
): Promise<void> {
  const mode = typeof opts === "object" ? opts?.mode : undefined;
  await fs.promises.writeFile(filePath, data, opts);
  if (mode !== undefined) {
    try {
      await fs.promises.chmod(filePath, mode);
    } catch {
      /* best effort */
    }
  }
}

/** Async appendFile + chmod. */
export async function secureAppendFile(
  filePath: string,
  data: string,
  opts?: { mode?: number },
): Promise<void> {
  await fs.promises.appendFile(filePath, data, opts);
  if (opts?.mode !== undefined) {
    try {
      await fs.promises.chmod(filePath, opts.mode);
    } catch {
      /* best effort */
    }
  }
}

/**
 * Ensure a directory exists with the given permissions.
 * Like `secureWriteFileSync`, calls `chmod` explicitly because
 * `mkdirSync({ mode })` is ignored for existing directories.
 * On Windows, mode `0700` removes inherited broad-principal access and grants
 * full access only to the current user and Local System. ACL failure is fatal
 * because continuing would expose a directory advertised as owner-restricted.
 */
export function secureMkdirSync(dirPath: string, mode: number): void {
  const directoryExisted = existsSync(dirPath);
  fs.mkdirSync(dirPath, { recursive: true, mode });
  try {
    fs.chmodSync(dirPath, mode);
  } catch {
    /* best effort */
  }
  if (!directoryExisted && process.platform === "win32" && (mode & 0o777) === 0o700) {
    enforceWindowsOwnerOnlyDirectoryAcl(dirPath);
  }
}

function enforceWindowsOwnerOnlyDirectoryAcl(directory: string): void {
  const sid = getWindowsUserSid();
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  execFileSync(
    join(systemRoot, "System32", "icacls.exe"),
    [
      directory,
      "/inheritance:r",
      "/remove:g",
      "*S-1-1-0",
      "*S-1-5-11",
      "*S-1-5-32-545",
      "/grant:r",
      `*${sid}:(OI)(CI)F`,
      "*S-1-5-18:(OI)(CI)F",
      "/q",
    ],
    { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
}

function getWindowsUserSid(): string {
  if (windowsUserSid) return windowsUserSid;
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const output = execFileSync(
    join(systemRoot, "System32", "whoami.exe"),
    ["/user", "/fo", "csv", "/nh"],
    { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const match = /"(S-\d+(?:-\d+)+)"/i.exec(output);
  if (!match?.[1]) {
    throw new Error("Could not resolve the current Windows user SID.");
  }
  windowsUserSid = match[1];
  return windowsUserSid;
}

function syncDirectorySync(directory: string): void {
  if (process.platform === "win32") return;
  let handle: number | undefined;
  try {
    handle = fs.openSync(directory, "r");
    fs.fsyncSync(handle);
  } catch (error) {
    if (
      isNodeErrorCode(error, "EINVAL") ||
      isNodeErrorCode(error, "ENOTSUP") ||
      isNodeErrorCode(error, "EPERM") ||
      isNodeErrorCode(error, "EISDIR")
    ) {
      return;
    }
    throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** Async variant of {@link secureMkdirSync}. */
export async function secureMkdir(dirPath: string, mode: number): Promise<void> {
  await fs.promises.mkdir(dirPath, { recursive: true, mode });
  try {
    await fs.promises.chmod(dirPath, mode);
  } catch {
    /* best effort */
  }
}

/**
 * Remove all symlinks from a directory tree to prevent sandbox escape.
 * After copying an untrusted bundle, symlinks could point outside the
 * skill directory (e.g. `scripts/secrets -> ~/.ssh`). Stripping them
 * ensures the filesystem MCP server can't traverse outside the sandbox.
 */
export function stripSymlinks(dir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true, recursive: true });
  } catch {
    return; // dir may not exist or be inaccessible
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      // parentPath added in Node 20.12; Electron bundles Node >= 20 so
      // the fallback should never trigger, but we keep it defensive.
      const parent = (entry as { parentPath?: string }).parentPath ?? dir;
      try {
        fs.rmSync(join(parent, entry.name), { force: true });
      } catch {
        /* best effort per entry — don't abort remaining symlinks */
      }
    }
  }
}

/**
 * Exclude a path from macOS Time Machine / iCloud backup.
 * No-op on non-macOS platforms. Best-effort — never throws.
 */
export function excludeFromBackup(filePath: string): void {
  if (process.platform !== "darwin") return;
  if (!existsSync(filePath)) return;

  execFile(
    "xattr",
    ["-w", "com.apple.metadata:com_apple_backup_excludeItem", "com.apple.backupd", filePath],
    (err) => {
      if (err) {
        log.warn("Failed to set backup exclusion:", err.message);
      }
    },
  );
}

/**
 * Exclude all Marshal-owned data from macOS backup.
 * Safe to call on every startup — setting the same xattr is idempotent.
 */
export function excludeMDataFromBackup(appDataDir: string): void {
  // M-owned subdirectories (xattr on dir covers contents)
  for (const dir of [
    "marshal-auth",
    "marshal-sessions",
    "marshal-audit-logs",
    "marshal-automations",
    "marshal-skills",
    "marshal-teams-attachments",
  ]) {
    excludeFromBackup(join(appDataDir, dir));
  }
  // M-owned root-level files
  for (const file of [
    "marshal-settings.json",
    "marshal-memory.json",
    "marshal-memory-settings.json",
    "marshal-github-update-token.enc",
    "marshal-github-import-token.enc",
    "marshal-avatar-cache.json",
    "marshal-mcp-servers.json",
    "marshal-window-state.json",
  ]) {
    excludeFromBackup(join(appDataDir, file));
  }
}
