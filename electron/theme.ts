import { nativeTheme } from "electron";

// Native window background shown before the renderer paints. Must track
// --background in src/index.css (and public/marshal-flash-prevention.css) for each
// theme, or the window flashes the wrong colour on open.
const THEME_BG: Record<string, string> = { light: "#F8F8FB", dark: "#101014" };

export type ResolvedTheme = "light" | "dark";

/** Whether to use native macOS vibrancy (translucent window background). */
export const useMacVibrancy = process.platform === "darwin";

export function resolveThemeMode(theme?: string): ResolvedTheme {
  if (theme === "light" || theme === "dark") {
    return theme;
  }
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

export function resolveThemeBg(theme?: string): string {
  return THEME_BG[resolveThemeMode(theme)];
}
