import type { IpcHandler, IpcInvokeMap } from "../../../../common/marshal-ipc-contract";
import { createPreferencesStore } from "./store";

interface PreferencesDeps {
  ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => void;
  prefsPath: string;
  /**
   * How long to coalesce successive `set` calls before persisting to disk.
   * Defaults to 300ms; tests can pass 0 for synchronous writes.
   */
  persistDebounceMs?: number;
}

const ALLOWED_KEYS = new Set(["lastUpdateCheck", "cocreate.zoom"]);

export function registerPreferencesHandlers({
  ipcHandle,
  prefsPath,
  persistDebounceMs = 300,
}: PreferencesDeps): { flush: () => void } {
  const store = createPreferencesStore(prefsPath, persistDebounceMs);

  ipcHandle("preferences:get", (_event, key: string) => {
    if (!ALLOWED_KEYS.has(key)) return { success: true, value: null };
    return { success: true, value: store.get(key) };
  });

  ipcHandle("preferences:set", (_event, key: string, value: string | null) => {
    if (!ALLOWED_KEYS.has(key)) return { success: false, error: `Unknown preference key: ${key}` };
    if (value === null) {
      store.delete(key);
    } else {
      store.set(key, value);
    }
    return { success: true };
  });

  return { flush: store.flush };
}
