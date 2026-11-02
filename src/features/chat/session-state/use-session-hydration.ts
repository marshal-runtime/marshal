import { useSyncExternalStore } from "react";

import { hydrationStore, IDLE, type HydrationSnapshot } from "./hydration-store";

export function useSessionHydration(sessionId: string | null): HydrationSnapshot {
  return useSyncExternalStore(
    hydrationStore.subscribe,
    () => hydrationStore.snapshot(sessionId),
    () => IDLE,
  );
}
