import fs from "node:fs";
import path from "node:path";

import { secureMkdirSync, secureWriteFileSync } from "../../../platform-security";

const ALLOWED_KEYS = new Set(["lastUpdateCheck", "cocreate.zoom"]);

export function createPreferencesStore(prefsPath: string, persistDebounceMs: number) {
  let cache: Record<string, string> = {};
  try {
    if (fs.existsSync(prefsPath)) {
      const raw = JSON.parse(fs.readFileSync(prefsPath, "utf-8")); // SF-4: trusted — app-written local file containing only string key-value pairs; spread over empty object
      cache = { ...raw };
    }
  } catch {
    cache = {};
  }

  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  const persistSync = () => {
    try {
      const dir = path.dirname(prefsPath);
      if (!fs.existsSync(dir)) secureMkdirSync(dir, 0o700);
      secureWriteFileSync(prefsPath, JSON.stringify(cache, null, 2), { mode: 0o600 });
    } catch {
      /* best-effort persistence */
    }
  };
  const schedulePersist = () => {
    if (persistDebounceMs <= 0) {
      persistSync();
      return;
    }
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = undefined;
      persistSync();
    }, persistDebounceMs);
  };

  return {
    get: (key: string) => (ALLOWED_KEYS.has(key) ? (cache[key] ?? null) : null),
    set: (key: string, value: string) => {
      cache[key] = value;
      schedulePersist();
    },
    delete: (key: string) => {
      delete cache[key];
      schedulePersist();
    },
    flush: () => {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = undefined;
        persistSync();
      }
    },
  };
}

export { ALLOWED_KEYS };
