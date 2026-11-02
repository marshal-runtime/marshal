import { useSyncExternalStore } from "react";

import { createWindowStore } from "./window-state-store";

type WindowState = ReturnType<ReturnType<typeof createWindowStore>["getSnapshot"]>;

const windowStore = createWindowStore();

export function useWindowState(): WindowState {
  return useSyncExternalStore(windowStore.subscribe, windowStore.getSnapshot);
}
