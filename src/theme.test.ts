import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { applyTheme } from "./app-theme";

describe("applyTheme", () => {
  let originalPlatform: string | undefined;

  beforeEach(() => {
    originalPlatform = window.platform;
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-theme-mode");
    document.documentElement.removeAttribute("data-vibrancy");
    localStorage.clear();
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- restoring test mock
    (window as { platform?: string }).platform = originalPlatform;
    document.documentElement.removeAttribute("data-vibrancy");
  });

  it("sets data-theme-mode to 'system' when theme is system", () => {
    applyTheme("system");
    expect(document.documentElement.getAttribute("data-theme-mode")).toBe("system");
  });

  it("stores 'system' in localStorage when theme is system", () => {
    applyTheme("system");
    expect(localStorage.getItem("theme-mode")).toBe("system");
  });

  it("stores 'light' in localStorage when theme is light", () => {
    applyTheme("light");
    expect(localStorage.getItem("theme-mode")).toBe("light");
  });

  it("stores 'dark' in localStorage when theme is dark", () => {
    applyTheme("dark");
    expect(localStorage.getItem("theme-mode")).toBe("dark");
  });

  it("round-trips: reading cached system theme preserves system mode", () => {
    applyTheme("system");
    const cached = localStorage.getItem("theme-mode");
    expect(cached).toBe("system");

    // Simulate boot: read from localStorage and re-apply
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test validates the round-trip value is a valid ThemeMode
    applyTheme(cached as "system" | "light" | "dark");
    expect(document.documentElement.getAttribute("data-theme-mode")).toBe("system");
  });

  it("REGRESSION: system theme must NOT store resolved value in localStorage", () => {
    // Pre-v0.22.73 bug: applyTheme("system") stored "light" or "dark" in
    // localStorage instead of "system". On next boot, main.tsx read "dark",
    // called applyTheme("dark"), set data-theme-mode="dark", and vibrancy
    // CSS (gated on data-theme-mode="system") stopped matching.
    applyTheme("system");
    const stored = localStorage.getItem("theme-mode");
    // Must be "system", never "light" or "dark"
    expect(stored).not.toBe("light");
    expect(stored).not.toBe("dark");
    expect(stored).toBe("system");
  });

  it("sets data-vibrancy when platform is darwin and theme is system", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test mock
    (window as { platform?: string }).platform = "darwin";
    applyTheme("system");
    expect(document.documentElement.hasAttribute("data-vibrancy")).toBe(true);
  });

  it("removes data-vibrancy when platform is darwin and theme is explicit", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test mock
    (window as { platform?: string }).platform = "darwin";
    applyTheme("system");
    expect(document.documentElement.hasAttribute("data-vibrancy")).toBe(true);

    applyTheme("dark");
    expect(document.documentElement.hasAttribute("data-vibrancy")).toBe(false);
  });

  it("does not set data-vibrancy on non-darwin platform", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test mock
    (window as { platform?: string }).platform = "win32";
    applyTheme("system");
    expect(document.documentElement.hasAttribute("data-vibrancy")).toBe(false);
  });
});
