import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 256;
const ACCESS_ERROR = "File access is no longer available";

interface RuntimeDocumentAccessEntry {
  readonly resolvedPath: string;
  readonly expiresAt: number;
}

export interface RuntimeDocumentAccessStoreOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

export function createRuntimeDocumentAccessStore(options: RuntimeDocumentAccessStoreOptions = {}) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries = new Map<string, RuntimeDocumentAccessEntry>();

  function prune(): void {
    const currentTime = now();
    for (const [token, entry] of entries) {
      if (entry.expiresAt <= currentTime) entries.delete(token);
    }
    while (entries.size > maxEntries) {
      const oldestToken = entries.keys().next().value;
      if (oldestToken === undefined) break;
      entries.delete(oldestToken);
    }
  }

  function resolveFile(filePath: string): string | null {
    if (!path.isAbsolute(filePath)) return null;
    try {
      const resolvedPath = fs.realpathSync(path.resolve(filePath));
      return fs.statSync(resolvedPath).isFile() ? resolvedPath : null;
    } catch {
      return null;
    }
  }

  return {
    issue(filePath: string): string {
      const resolvedPath = resolveFile(filePath);
      if (!resolvedPath) {
        throw Object.assign(new Error("Document must be an existing local file"), {
          code: "invalid-request",
        });
      }
      prune();
      for (const [token, entry] of entries) {
        if (entry.resolvedPath === resolvedPath) return token;
      }
      const token = randomUUID();
      entries.set(token, { resolvedPath, expiresAt: now() + ttlMs });
      prune();
      return token;
    },

    resolve(
      token: string | undefined,
      filePath: string,
    ): { resolved: string } | { error: typeof ACCESS_ERROR } {
      prune();
      if (!token) return { error: ACCESS_ERROR };
      const entry = entries.get(token);
      const resolvedPath = resolveFile(filePath);
      if (!entry || !resolvedPath || resolvedPath !== entry.resolvedPath) {
        return { error: ACCESS_ERROR };
      }
      return { resolved: resolvedPath };
    },
  };
}

export type RuntimeDocumentAccessStore = ReturnType<typeof createRuntimeDocumentAccessStore>;
