import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { app } from "electron";

import { createLogger } from "../common/marshal-logger";
import { E2E_DATA_DIR, isMockMode } from "./mock-mode";
import { migrateLegacyAppDataEntries } from "./persisted-paths";
import { secureMkdirSync, secureWriteFileSync } from "./platform-security";

export { E2E_DATA_DIR };

const log = createLogger("AppPaths");
const migratedAppDataDirs = new Set<string>();

/** True when running via `pnpm run dev` (unpackaged Electron). */
export function isDevMode(): boolean {
  return !app.isPackaged && !isMockMode();
}

export function getAppDataDir(): string {
  let appDataDir: string;
  if (isMockMode()) {
    appDataDir = E2E_DATA_DIR;
  } else if (isDevMode()) {
    const override = process.env.MARSHAL_DEV_DATA_DIR?.trim();
    appDataDir = override ? path.resolve(override) : path.join(os.homedir(), ".marshal-dev");
  } else {
    appDataDir = path.join(os.homedir(), ".marshal");
  }
  if (!migratedAppDataDirs.has(appDataDir)) {
    migrateLegacyAppDataEntries(appDataDir);
    migratedAppDataDirs.add(appDataDir);
  }
  return appDataDir;
}

/** Create the active Marshal-owned state root during application startup. */
export function initializeAppDataDir(): string {
  const appDataDir = getAppDataDir();
  secureMkdirSync(appDataDir, 0o700);
  return appDataDir;
}

/** Error codes that indicate the directory itself is inaccessible (not disk/IO failures). */
const ACCESS_DENIED_CODES = new Set(["EPERM", "EACCES", "EROFS"]);

function isAccessDenied(err: unknown): boolean {
  if (err == null || typeof err !== "object" || !("code" in err)) return false;
  const { code } = err as Record<string, unknown>;
  return typeof code === "string" && ACCESS_DENIED_CODES.has(code);
}

/** Rethrow OS errors with the code preserved but path details stripped (PII). */
function rethrowSanitized(err: unknown): never {
  const code =
    err != null && typeof err === "object" && "code" in err
      ? (err as Record<string, unknown>).code
      : undefined;

  const sanitizedMessage = `Workspace probe failed${typeof code === "string" ? ` (${code})` : ""}`;
  const wrapped = new Error(sanitizedMessage);
  (wrapped as NodeJS.ErrnoException).code = typeof code === "string" ? code : undefined;

  // Node's err.stack starts with the original message (line 0) which contains
  // the probe file path. Keep the stack frames (lines 1+) for debugging but
  // swap line 0 with our sanitized message to strip PII.
  if (err instanceof Error && err.stack) {
    const [, ...frames] = err.stack.split("\n");
    wrapped.stack = [`Error: ${sanitizedMessage}`, ...frames].join("\n");
  }

  throw wrapped;
}

/** Create `dir` if needed and verify it is genuinely writable via temp file probe. */
function ensureUsableDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 /* owner-only rwx */ });
  } catch (err) {
    if (isAccessDenied(err)) return false;
    rethrowSanitized(err);
  }

  // Probe with actual write — fs.accessSync doesn't check Windows ACLs
  const probe = path.join(dir, `.marshal-probe-${crypto.randomUUID()}`);
  try {
    fs.writeFileSync(probe, "", { flag: "wx", mode: 0o600 /* owner-only rw */ });
  } catch (err) {
    if (isAccessDenied(err)) return false;
    rethrowSanitized(err);
  }

  // Cleanup is best-effort — write succeeded so dir is usable
  try {
    fs.unlinkSync(probe);
  } catch {
    // Non-fatal: probe file left behind
  }

  return true;
}

const WORKSPACE_PREF_FILENAME = ".workspace-preference";

/** Read the persisted workspace preference (sync). */
function readWorkspacePreference(): "fallback" | null {
  try {
    const raw = fs.readFileSync(path.join(getAppDataDir(), WORKSPACE_PREF_FILENAME), "utf8").trim();
    return raw === "fallback" ? "fallback" : null;
  } catch {
    return null;
  }
}

/** Persist workspace fallback preference to a dedicated file (sync, best-effort). */
function persistWorkspacePreference(): void {
  try {
    secureMkdirSync(getAppDataDir(), 0o700 /* owner-only rwx */);
    secureWriteFileSync(path.join(getAppDataDir(), WORKSPACE_PREF_FILENAME), "fallback", {
      mode: 0o600 /* owner-only rw */,
    });
  } catch {
    // Best-effort — re-probe on next launch if this fails
  }
}

/** Clear a stale workspace preference (sync, best-effort). */
function clearWorkspacePreference(): void {
  try {
    fs.unlinkSync(path.join(getAppDataDir(), WORKSPACE_PREF_FILENAME));
  } catch {
    // Already absent or unremovable — either way, fine
  }
}

/**
 * Wrap `app.getPath("documents")` to return null when it throws. A stale
 * cloud-sync client folder-redirect symlink (CloudStorage target removed)
 * makes the unguarded call kill the main process before any window can load.
 */
export function getDocumentsPathOrNull(): string | null {
  try {
    return app.getPath("documents");
  } catch {
    // Don't log err.message — macOS surfaces the resolved-but-missing path in it.
    log.warn("Failed to resolve documents path; will use fallback workspace");
    return null;
  }
}

export interface WorkspaceResolution {
  readonly dir: string;
  /**
   * True only on the launch that transitions into the fallback workspace; false
   * on the happy path and on steady-state launches honouring a persisted
   * preference. `main.ts` reads this to fire telemetry once per transition.
   */
  readonly usedFallback: boolean;
}

/**
 * Resolve a usable workspace directory. Prefers `~/Documents/Marshal`;
 * falls back to app data if Documents is inaccessible (macOS TCC, cloud-sync client).
 * Once fallen back, the choice is persisted so a later TCC grant doesn't
 * silently flip back and orphan data created under the fallback.
 *
 * `documentsPath` may be `null` when `app.getPath("documents")` itself threw
 * (see {@link getDocumentsPathOrNull}) — the null case skips the preferred
 * probe and goes straight to the fallback.
 *
 * An explicit `override` (from settings) bypasses probe logic when absolute;
 * a non-absolute override is treated as no override.
 */
export function resolveWorkspaceDir(
  documentsPath: string | null,
  override?: string,
): WorkspaceResolution {
  if (isMockMode()) {
    return { dir: path.join(E2E_DATA_DIR, "workspace"), usedFallback: false };
  }

  const fallback = path.join(getAppDataDir(), "workspace");

  if (override) {
    if (path.isAbsolute(override)) {
      return { dir: path.resolve(override), usedFallback: false };
    }
    // Fall through to the probe ladder so persistence stays consistent.
    log.warn("Workspace override is not an absolute path, falling through to probe");
  }

  // Sticky: honour a previously-persisted fallback choice
  let fallbackBroken = false;
  if (readWorkspacePreference() === "fallback") {
    if (ensureUsableDir(fallback)) {
      // Steady state, not a new transition — telemetry stays silent.
      return { dir: fallback, usedFallback: false };
    }
    // Persisted fallback is now broken — clear and re-probe from scratch
    clearWorkspacePreference();
    fallbackBroken = true;
    log.warn("Persisted fallback workspace is inaccessible, re-probing");
  }

  if (documentsPath !== null) {
    const preferred = path.join(documentsPath, "Marshal");
    if (ensureUsableDir(preferred)) {
      return { dir: preferred, usedFallback: false };
    }
  }

  if (!fallbackBroken && ensureUsableDir(fallback)) {
    log.warn(
      documentsPath === null
        ? "Documents path unresolvable, using fallback workspace"
        : "Documents folder is inaccessible, using fallback workspace",
    );
    persistWorkspacePreference();
    return { dir: fallback, usedFallback: true };
  }

  throw new Error("Cannot access workspace directory (Documents and app data both inaccessible)");
}
