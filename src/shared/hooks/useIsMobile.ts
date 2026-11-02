import { useSyncExternalStore } from "react";

/**
 * Matches LeftNav's narrow/icon-rail breakpoint (src/shell/LeftNav.tsx) so
 * "mobile" means the same viewport width everywhere in the app.
 */
const MOBILE_BREAKPOINT_QUERY = "(max-width: 599px)";

function subscribe(callback: () => void): () => void {
  const mql = window.matchMedia(MOBILE_BREAKPOINT_QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function getSnapshot(): boolean {
  return window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

/** Reactive hook that tracks whether the viewport is at or below the app's mobile breakpoint. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
