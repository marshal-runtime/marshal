// Renderer-owned app mode subscription.
import type { AppMode } from "@common/marshal-constants";
import { useSyncExternalStore } from "react";

function subscribe(onStoreChange: () => void): () => void {
  return window.appModeAPI?.onModeChanged(onStoreChange) ?? (() => {});
}

function getSnapshot(): AppMode {
  return window.appModeAPI?.getLatest() ?? "release";
}

/**
 * Returns the current app mode ("dev", "beta", or "release").
 * Uses useSyncExternalStore for tear-free reads — the preload-side listener
 * captures app:modeChanged events before React mounts, so getSnapshot()
 * always returns the latest value with no race window.
 */
export function useAppMode(): AppMode {
  return useSyncExternalStore(subscribe, getSnapshot, () => "release" as AppMode);
}
