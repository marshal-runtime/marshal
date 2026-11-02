// Ownership: renderer theme module.

export type ThemeMode = "system" | "light" | "dark";

/** Apply theme to the document root and track the mode for the system listener */
/** Re-apply 'system' theme when the OS colour-scheme changes */
function onSystemThemeChange() {
  applyTheme("system");
}

let systemListenerActive = false;

const mqSupported = typeof window !== "undefined" && typeof window.matchMedia === "function";

export function applyTheme(theme: ThemeMode) {
  const root = document.documentElement;
  root.setAttribute("data-theme-mode", theme);

  // Vibrancy: active on macOS when theme is "system". Setting the attribute
  // here (the only place data-theme-mode changes) keeps vibrancy in sync
  // without needing a separate observer/hook.
  if (typeof window !== "undefined" && window.platform === "darwin" && theme === "system") {
    root.setAttribute("data-vibrancy", "");
  } else {
    root.removeAttribute("data-vibrancy");
  }

  if (theme === "system") {
    const prefersDark = mqSupported && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolved = prefersDark ? "dark" : "light";
    root.setAttribute("data-theme", resolved);
    try {
      localStorage.setItem("theme-mode", "system");
    } catch {
      /* localStorage unavailable */
    }
    if (mqSupported && !systemListenerActive) {
      window
        .matchMedia("(prefers-color-scheme: dark)")
        .addEventListener("change", onSystemThemeChange);
      systemListenerActive = true;
    }
  } else {
    root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("theme-mode", theme);
    } catch {
      /* localStorage unavailable */
    }
    if (mqSupported && systemListenerActive) {
      window
        .matchMedia("(prefers-color-scheme: dark)")
        .removeEventListener("change", onSystemThemeChange);
      systemListenerActive = false;
    }
  }
}

/**
 * Apply theme with a radial reveal View Transition animation.
 * Falls back to instant `applyTheme()` when the API is unavailable
 * or the user prefers reduced motion.
 */
export function applyThemeWithTransition(theme: ThemeMode, originEl?: HTMLElement | null) {
  const supportsVT = typeof document !== "undefined" && "startViewTransition" in document;
  const prefersReduced =
    mqSupported && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!supportsVT || prefersReduced) {
    applyTheme(theme);
    return;
  }

  // Mark the transition as a theme change so CSS can apply the radial reveal
  const root = document.documentElement;
  root.classList.add("theme-transitioning");

  if (originEl) {
    const rect = originEl.getBoundingClientRect();
    root.style.setProperty("--vt-x", `${rect.left + rect.width / 2}px`);
    root.style.setProperty("--vt-y", `${rect.top + rect.height / 2}px`);
  } else {
    root.style.setProperty("--vt-x", "50%");
    root.style.setProperty("--vt-y", "50%");
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- View Transitions API not in TS DOM types
  const doc = document as unknown as {
    startViewTransition: (cb: () => void) => { finished: Promise<void> };
  };
  const transition = doc.startViewTransition(() => {
    applyTheme(theme);
  });

  void transition.finished.finally(() => {
    root.classList.remove("theme-transitioning");
    root.style.removeProperty("--vt-x");
    root.style.removeProperty("--vt-y");
  });
}
