import { useSyncExternalStore } from "react";

/** Dispatched on window by the phone transport after it re-establishes its socket. */
export const TRANSPORT_RECONNECTED_EVENT = "marshal:reconnected";

let reconnects = 0;
let listening = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  if (!listening && typeof window !== "undefined") {
    listening = true;
    window.addEventListener(TRANSPORT_RECONNECTED_EVENT, () => {
      reconnects++;
      listeners.forEach((notify) => notify());
    });
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Counts reconnects of a socket-backed transport (the phone client). The Mac
 * drops per-connection subscriptions when a socket closes, so effects that
 * register them include this value to register again. Desktop IPC never
 * reconnects, so the value stays 0 there.
 */
export function useTransportReconnects(): number {
  return useSyncExternalStore(
    subscribe,
    () => reconnects,
    () => 0,
  );
}
