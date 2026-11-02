import { useEffect } from "react";

import { useWindowFocused } from "./useWindowFocused";

export function useWindowInactiveAttribute(): { focused: boolean; ready: boolean } {
  const { focused, ready } = useWindowFocused();
  useEffect(() => {
    const el = document.documentElement;
    if (focused) {
      el.removeAttribute("data-window-inactive");
    } else {
      el.setAttribute("data-window-inactive", "");
    }
  }, [focused]);
  return { focused, ready };
}
