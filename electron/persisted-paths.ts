import fs from "node:fs";
import path from "node:path";

import { createLogger } from "../common/marshal-logger";

const log = createLogger("PersistedPaths");

export interface PersistedPathMigration {
  readonly current: string;
  readonly legacy: string | readonly string[];
}

const TOP_LEVEL_APP_DATA_MIGRATIONS: readonly PersistedPathMigration[] = [
  { legacy: "m-agent-message-outbox.enc", current: "marshal-agent-message-outbox.enc" },
  { legacy: "m-gateway-auth.json", current: "marshal-gateway-auth.json" },
  { legacy: "m-auth", current: "marshal-auth" },
  { legacy: "m-automations", current: "marshal-automations" },
  { legacy: "m-workflows", current: "marshal-workflows" },
  { legacy: "m-avatar-cache.json", current: "marshal-avatar-cache.json" },
  { legacy: "m-command-center", current: "marshal-command-center" },
  { legacy: "m-crashes", current: "marshal-crashes" },
  { legacy: "m-diagnostics.jsonl", current: "marshal-diagnostics.jsonl" },
  { legacy: "m-diagnostics.jsonl.old", current: "marshal-diagnostics.jsonl.old" },
  { legacy: "m-external-operations.enc", current: "marshal-external-operations.enc" },
  { legacy: "m-github-update-token.enc", current: "marshal-github-update-token.enc" },
  { legacy: "m-github-import-token.enc", current: "marshal-github-import-token.enc" },
  { legacy: "m-goal-runtime", current: "marshal-goal-runtime" },
  { legacy: "m-mcp-servers.json", current: "marshal-mcp-servers.json" },
  { legacy: "m-memory.json", current: "marshal-memory.json" },
  { legacy: "m-memory-settings.json", current: "marshal-memory-settings.json" },
  { legacy: "m-mcp-bridge.json", current: "marshal-mcp-bridge.json" },
  { legacy: "m-audit-logs", current: "marshal-audit-logs" },
  { legacy: "m-preferences.json", current: "marshal-preferences.json" },
  { legacy: "m-mcp-env", current: "marshal-mcp-env" },
  { legacy: "m-encryption-key.enc", current: "marshal-encryption-key.enc" },
  { legacy: "m-encryption-key.enc.bak", current: "marshal-encryption-key.enc.bak" },
  { legacy: "m-sessions", current: "marshal-sessions" },
  { legacy: "m-settings.json", current: "marshal-settings.json" },
  { legacy: "m-skills", current: "marshal-skills" },
  { legacy: "m-sync-state.json", current: "marshal-sync-state.json" },
  { legacy: "m-teams-attachments", current: "marshal-teams-attachments" },
  { legacy: "m-window-state.json", current: "marshal-window-state.json" },
  { legacy: "m-process-lifecycle.jsonl", current: "marshal-process-lifecycle.jsonl" },
  { legacy: "m-process-lifecycle.jsonl.old", current: "marshal-process-lifecycle.jsonl.old" },
  { legacy: "m-workflow-diagnostics.jsonl", current: "marshal-workflow-diagnostics.jsonl" },
  { legacy: "m-workflow-runs", current: "marshal-workflow-runs" },
  { legacy: "m-workflow-state", current: "marshal-workflow-state" },
  { legacy: "m-workflow-schedules", current: "marshal-workflow-schedules" },
] as const;

const NESTED_APP_DATA_MIGRATIONS: readonly PersistedPathMigration[] = [
  {
    legacy: [
      path.join("marshal-crashes", "m-process-heartbeat.json"),
      path.join("m-crashes", "m-process-heartbeat.json"),
    ],
    current: path.join("marshal-crashes", "marshal-process-heartbeat.json"),
  },
  {
    legacy: [
      path.join("marshal-crashes", "watchdog", "m-process-watchdog.ps1"),
      path.join("m-crashes", "watchdog", "m-process-watchdog.ps1"),
    ],
    current: path.join("marshal-crashes", "watchdog", "marshal-process-watchdog.ps1"),
  },
  {
    legacy: [
      path.join("marshal-crashes", "watchdog", "m-process-watchdog.jsonl"),
      path.join("m-crashes", "watchdog", "m-process-watchdog.jsonl"),
    ],
    current: path.join("marshal-crashes", "watchdog", "marshal-process-watchdog.jsonl"),
  },
] as const;

export const APP_DATA_MIGRATIONS = [
  ...TOP_LEVEL_APP_DATA_MIGRATIONS,
  ...NESTED_APP_DATA_MIGRATIONS,
] as const;

export interface ResolvePersistedPathOptions {
  readonly migrate?: boolean;
}

/**
 * Prefer the current path, migrating the first existing legacy path in place.
 * If migration fails, return the legacy path so callers still load existing data.
 */
export function resolveLegacyPersistedPath(
  currentPath: string,
  legacyPaths: string | readonly string[],
  options: ResolvePersistedPathOptions = {},
): string {
  const legacyCandidates = typeof legacyPaths === "string" ? [legacyPaths] : legacyPaths;
  // No "both exist" warning: since migration copies rather than moves, the
  // legacy path surviving alongside the current one is the steady state, not an
  // anomaly. Current always wins, so this is also what stops a re-copy from
  // overwriting newer data with the predecessor's stale snapshot.
  if (fs.existsSync(currentPath)) return currentPath;

  const legacyPath = legacyCandidates.find((candidate) => fs.existsSync(candidate));
  if (!legacyPath) return currentPath;
  if (options.migrate === false) return legacyPath;

  try {
    fs.mkdirSync(path.dirname(currentPath), { recursive: true, mode: 0o700 });
    // Copy rather than move: the legacy name may still be read by a co-installed
    // predecessor, which still reads the legacy name. Moving it would migrate
    // this app by breaking that one. See docs/architecture/36.
    fs.cpSync(legacyPath, currentPath, { recursive: true, force: true });
    log.info(`Copied legacy persisted path to ${path.basename(currentPath)}`);
    return currentPath;
  } catch (err) {
    const rawCode =
      err != null && typeof err === "object" && "code" in err
        ? Reflect.get(err, "code")
        : undefined;
    const code =
      typeof rawCode === "string" || typeof rawCode === "number" ? String(rawCode) : "unknown";
    log.warn(`Could not migrate ${path.basename(currentPath)}; using the legacy path (${code})`);
    return legacyPath;
  }
}

export function migrateLegacyAppDataEntries(appDataDir: string): void {
  for (const migration of APP_DATA_MIGRATIONS) {
    const legacy = (
      typeof migration.legacy === "string" ? [migration.legacy] : migration.legacy
    ).map((relativePath) => path.join(appDataDir, relativePath));
    resolveLegacyPersistedPath(path.join(appDataDir, migration.current), legacy);
  }
}

export function resolveWorktreesDir(appDataDir: string): string {
  return resolveLegacyPersistedPath(
    path.join(appDataDir, "marshal-worktrees"),
    path.join(appDataDir, "m-worktrees"),
    { migrate: false },
  );
}
