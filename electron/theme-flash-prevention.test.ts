/**
 * Structural regression tests for dark-mode flash prevention.
 *
 * The app must set data-theme on <html> *synchronously* before React/CSS loads,
 * so the correct background and CSS-variable values apply on the very first frame.
 *
 * Regression context: a CSP hardening PR extracted the inline <style> into an
 * external CSS file and removed the synchronous data-theme setter, causing a
 * white flash on dark-mode systems until React mounted.
 */
import fs from "fs";
import path from "path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");

describe("theme flash prevention", () => {
  // ---------- index.html structure ----------

  it("index.html loads marshal-theme-init.js synchronously before the React entry point", () => {
    const html = fs.readFileSync(path.join(root, "index.html"), "utf-8");

    // marshal-theme-init.js must be a regular (non-module, non-deferred) script
    expect(html).toMatch(/<script\b[^>]*\bsrc=["']\/marshal-theme-init\.js["'][^>]*>/);
    // It must NOT have type="module", defer, or async (those are non-blocking)
    expect(html).not.toMatch(
      /<script\b[^>]*\bsrc=["']\/marshal-theme-init\.js["'][^>]*\btype=["']module["'][^>]*>/,
    );
    expect(html).not.toMatch(
      /<script\b[^>]*\bsrc=["']\/marshal-theme-init\.js["'][^>]*\bdefer\b[^>]*>/,
    );
    expect(html).not.toMatch(
      /<script\b[^>]*\bsrc=["']\/marshal-theme-init\.js["'][^>]*\basync\b[^>]*>/,
    );

    // marshal-theme-init.js must appear before the React entry script
    const themePos = html.indexOf("marshal-theme-init.js");
    const reactPos = html.indexOf("/src/main.tsx");
    expect(themePos).toBeGreaterThan(-1);
    expect(reactPos).toBeGreaterThan(-1);
    expect(themePos).toBeLessThan(reactPos);
  });

  it("index.html loads marshal-flash-prevention.css before marshal-theme-init.js", () => {
    const html = fs.readFileSync(path.join(root, "index.html"), "utf-8");
    const cssPos = html.indexOf("marshal-flash-prevention.css");
    const jsPos = html.indexOf("marshal-theme-init.js");
    expect(cssPos).toBeGreaterThan(-1);
    expect(jsPos).toBeGreaterThan(-1);
    expect(cssPos).toBeLessThan(jsPos);
  });

  // ---------- marshal-theme-init.js ----------

  it("marshal-theme-init.js reads localStorage then falls back to prefers-color-scheme", () => {
    const js = fs.readFileSync(path.join(root, "public", "marshal-theme-init.js"), "utf-8");
    // Must check localStorage for persisted theme-mode
    expect(js).toContain("localStorage");
    expect(js).toContain("theme-mode");
    // Must fall back to prefers-color-scheme if no stored value
    expect(js).toContain("prefers-color-scheme: dark");
    expect(js).toContain("data-theme");
    expect(js).toContain('"dark"');
    expect(js).toContain('"light"');
    // Must guard against matchMedia being unavailable
    expect(js).toContain("matchMedia");
    expect(js).toMatch(/typeof\s+window\.matchMedia/);
  });

  // ---------- marshal-flash-prevention.css ----------

  /**
   * The values in marshal-flash-prevention.css are duplicated literals: the file loads
   * before any JS, so it cannot reference the theme variables it has to agree
   * with. Derive the expectations from src/index.css instead of pinning them,
   * so a palette change fails here with a useful message instead of silently
   * flashing the previous brand's colours on every cold start.
   */
  function topLevelBlocks(css: string, selector: string): string[] {
    const blocks: string[] = [];
    for (let from = 0; ; ) {
      const start = css.indexOf(`${selector} {`, from);
      if (start === -1) break;
      const end = css.indexOf("\n}", start);
      if (end === -1) break;
      blocks.push(css.slice(start, end));
      from = end + 1;
    }
    return blocks;
  }

  function declaration(blocks: string[], name: string): string {
    for (const block of blocks) {
      const match = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
      if (match) return match[1].trim();
    }
    throw new Error(`--${name} not found in src/index.css`);
  }

  it("marshal-flash-prevention.css has dark-mode background and color rules", () => {
    const css = fs.readFileSync(path.join(root, "public", "marshal-flash-prevention.css"), "utf-8");
    // Must handle both explicit data-theme and system preference
    expect(css).toContain('data-theme="dark"');
    expect(css).toContain("prefers-color-scheme: dark");

    // Dark mode must also set text color to avoid a light-foreground flash
    const darkRuleMatch = css.match(/\[data-theme="dark"\][^{]*\{([^}]+)\}/);
    expect(darkRuleMatch).not.toBeNull();
    expect(darkRuleMatch![1]).toMatch(/color\s*:/);

    // Light-mode defaults (bare html selector) must set both background and color
    const bareHtmlMatch = css.match(/^html\s*\{([^}]+)\}/m);
    expect(bareHtmlMatch).not.toBeNull();
    expect(bareHtmlMatch![1]).toMatch(/background\s*:/);
    expect(bareHtmlMatch![1]).toMatch(/color\s*:/);
  });

  it("marshal-flash-prevention.css colours match the --background/--foreground tokens", () => {
    const themeCss = fs.readFileSync(path.join(root, "src", "index.css"), "utf-8");
    const flashCss = fs.readFileSync(path.join(root, "public", "marshal-flash-prevention.css"), "utf-8");

    const light = topLevelBlocks(themeCss, ":root");
    const dark = topLevelBlocks(themeCss, '[data-theme="dark"]');
    expect(light.length).toBeGreaterThan(0);
    expect(dark.length).toBeGreaterThan(0);

    const expected = {
      lightBg: declaration(light, "background-base"),
      lightFg: declaration(light, "foreground"),
      darkBg: declaration(dark, "background-base"),
      darkFg: declaration(dark, "foreground"),
    };

    const bareHtml = flashCss.match(/^html\s*\{([^}]+)\}/m)![1];
    expect(bareHtml).toContain(expected.lightBg);
    expect(bareHtml).toContain(expected.lightFg);

    const darkRule = flashCss.match(/^html\[data-theme="dark"\]\s*\{([^}]+)\}/m)![1];
    expect(darkRule).toContain(expected.darkBg);
    expect(darkRule).toContain(expected.darkFg);

    // The system-preference fallback must agree with the explicit dark rule,
    // otherwise dark-by-OS users get a different first frame from dark-by-choice.
    const mediaRule = flashCss.match(/prefers-color-scheme:\s*dark\s*\)\s*\{([\s\S]*?)\n\}/)![1];
    expect(mediaRule).toContain(expected.darkBg);
    expect(mediaRule).toContain(expected.darkFg);
  });
});
