declare global {
  interface Window {
    /** Observe-harness readiness signal (exposed by preload; consumed only for
     *  windows registered by ui-observe-window.ts). */
    uiObserveAPI?: { ready(info?: Record<string, unknown>): void };
  }
}
export {};
