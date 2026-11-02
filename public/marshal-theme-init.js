/* global window, document, localStorage */
// Synchronously set data-theme before React/CSS loads to prevent flash of wrong theme.
// Must run before any Tailwind/shadcn CSS variables are evaluated.
// applyTheme() in src/app-theme.ts writes to localStorage and will override this once
// persisted settings load.
(function () {
  var theme = "light";
  try {
    // Prefer the user's last explicit choice (persisted by applyTheme in src/app-theme.ts).
    // Falls back to OS preference, then "light" if matchMedia is unavailable.
    var stored = localStorage.getItem("theme-mode");
    if (stored === "light" || stored === "dark") {
      theme = stored;
    } else if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    ) {
      theme = "dark";
    }
  } catch {
    // localStorage or matchMedia blocked — fall back to light
  }
  document.documentElement.setAttribute("data-theme", theme);
})();
