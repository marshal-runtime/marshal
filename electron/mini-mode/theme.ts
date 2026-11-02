import type { MiniModePalette, MiniModeThemeMode } from "../platform/windowing/mini-mode/contracts";
import { resolveThemeBg, resolveThemeMode, type ResolvedTheme } from "../theme";

export function getResolvedMiniModeTheme(themeMode: MiniModeThemeMode): ResolvedTheme {
  return resolveThemeMode(themeMode);
}

export function getMiniModePalette(themeMode: MiniModeThemeMode): MiniModePalette {
  const theme = getResolvedMiniModeTheme(themeMode);
  if (theme === "dark") {
    return {
      theme,
      windowBackground: resolveThemeBg("dark"),
      surfaceBackground: "#1a1a20",
      borderColor: "rgba(255, 255, 255, 0.1)",
      textPrimary: "#e6e6ec",
      textSecondary: "#91919e",
      codeBackground: "#0c0c10",
      secondaryButtonBackground: "rgba(255, 255, 255, 0.1)",
      secondaryButtonText: "#e6e6ec",
      approvalKindBackground: "rgba(246, 196, 85, 0.14)",
      approvalKindText: "#f6c455",
      approvalKindBorderColor: "rgba(246, 196, 85, 0.18)",
      countBackground: "rgba(255, 255, 255, 0.08)",
      countText: "#91919e",
      warningBadgeBackground: "#f6c455",
      warningBadgeText: "#1f1f29",
      linkColor: "#a89bff",
    };
  }

  return {
    theme,
    windowBackground: resolveThemeBg("light"),
    surfaceBackground: "#ffffff",
    borderColor: "rgba(21, 21, 32, 0.1)",
    textPrimary: "#15151a",
    // Light-mode literals below mirror the renderer's light tokens in
    // src/index.css — mini-mode paints in the main process and cannot read
    // them. Keep them in step when the light palette moves:
    //   textSecondary/countText  --muted-foreground      hsl(240 10% 42%)
    //   codeBackground           --muted                 hsl(240 24% 94%)
    //   approvalKindBackground   --accent                hsl(240 26% 92%)
    //   approvalKindText         --foreground-secondary  hsl(240 12% 38%)
    //   linkColor                --color-link            hsl(250 66% 50%)
    textSecondary: "#606076",
    codeBackground: "#ececf3",
    secondaryButtonBackground: "rgba(21, 21, 32, 0.06)",
    secondaryButtonText: "#15151a",
    approvalKindBackground: "#e5e5f0",
    approvalKindText: "#55556d",
    approvalKindBorderColor: "rgba(21, 21, 32, 0.08)",
    countBackground: "rgba(21, 21, 32, 0.06)",
    countText: "#606076",
    warningBadgeBackground: "#eb9d17",
    warningBadgeText: "#15151a",
    linkColor: "#472bd4",
  };
}
