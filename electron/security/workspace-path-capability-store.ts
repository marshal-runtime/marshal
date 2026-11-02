import { randomUUID } from "crypto";

export type WorkspacePathCapabilityKind = "directory" | "external-files";

export interface WorkspacePathCapabilityEntry {
  kind: WorkspacePathCapabilityKind;
  paths: string[];
  webContentsId: number;
}

export interface WorkspacePathCapabilityExpected {
  kind: WorkspacePathCapabilityKind;
  webContentsId: number;
}

export interface WorkspacePathCapabilitiesOptions {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
}

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 64;
const INVALID_TOKEN_ERROR = "Invalid or expired workspace path token";

interface StoredWorkspacePathCapabilityEntry extends WorkspacePathCapabilityEntry {
  issuedAt: number;
}

export function createWorkspacePathCapabilityStore(options: WorkspacePathCapabilitiesOptions = {}) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries = new Map<string, StoredWorkspacePathCapabilityEntry>();

  function pruneExpired() {
    const currentTime = now();
    for (const [token, entry] of entries) {
      if (currentTime - entry.issuedAt > ttlMs) {
        entries.delete(token);
      }
    }
  }

  function evictOldestEntries() {
    while (entries.size > maxEntries) {
      const oldestToken = entries.keys().next().value;
      if (oldestToken === undefined) {
        return;
      }
      entries.delete(oldestToken);
    }
  }

  return {
    issue(entry: WorkspacePathCapabilityEntry): string {
      pruneExpired();
      const token = randomUUID();
      entries.set(token, {
        kind: entry.kind,
        paths: [...entry.paths],
        webContentsId: entry.webContentsId,
        issuedAt: now(),
      });
      evictOldestEntries();
      return token;
    },

    consume(
      token: string,
      expected: WorkspacePathCapabilityExpected,
    ): WorkspacePathCapabilityEntry | { error: typeof INVALID_TOKEN_ERROR } {
      pruneExpired();
      const entry = entries.get(token);
      if (!entry) {
        return { error: INVALID_TOKEN_ERROR };
      }

      if (entry.kind !== expected.kind || entry.webContentsId !== expected.webContentsId) {
        return { error: INVALID_TOKEN_ERROR };
      }

      entries.delete(token);

      return {
        kind: entry.kind,
        paths: [...entry.paths],
        webContentsId: entry.webContentsId,
      };
    },
  };
}
