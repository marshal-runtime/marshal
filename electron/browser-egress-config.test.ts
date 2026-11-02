import * as fs from "node:fs";
import * as path from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { buildPlaywrightEgressConfig } from "./platform/browser-egress-config";

describe("buildPlaywrightEgressConfig", () => {
  it("sets allowUnrestrictedFileAccess to false", () => {
    const config = buildPlaywrightEgressConfig("/path/to/init.js", []);
    expect(config.allowUnrestrictedFileAccess).toBe(false);
  });

  it("sets acceptDownloads to false", () => {
    const config = buildPlaywrightEgressConfig("/path/to/init.js", []);
    expect(config.browser.contextOptions.acceptDownloads).toBe(false);
  });

  it("includes initScriptPath in browser.initScript", () => {
    const config = buildPlaywrightEgressConfig("/abs/path/beacon-block.js", []);
    expect(config.browser.initScript).toEqual(["/abs/path/beacon-block.js"]);
  });

  it("omits the network key when blockedOrigins is empty", () => {
    const config = buildPlaywrightEgressConfig("/path/to/init.js", []);
    expect(config).not.toHaveProperty("network");
  });

  it("includes network.blockedOrigins when the list is non-empty", () => {
    const config = buildPlaywrightEgressConfig("/path/to/init.js", [
      "https://evil.com",
      "https://bad.org",
    ]);
    expect(config.network?.blockedOrigins).toEqual(["https://evil.com", "https://bad.org"]);
  });
});

describe("marshal-playwright-init-egress-block.js", () => {
  it("overrides navigator.sendBeacon to return true", () => {
    const scriptPath = path.join(__dirname, "..", "resources", "marshal-playwright-init-egress-block.js");
    const content = fs.readFileSync(scriptPath, "utf-8");
    const ctx: { navigator: { sendBeacon: (...args: unknown[]) => unknown } } = {
      navigator: { sendBeacon: () => "not-overridden" },
    };
    runInNewContext(content, ctx);
    expect(ctx.navigator.sendBeacon()).toBe(true);
  });

  it("sendBeacon override survives delete attempt", () => {
    const scriptPath = path.join(__dirname, "..", "resources", "marshal-playwright-init-egress-block.js");
    const content = fs.readFileSync(scriptPath, "utf-8");
    const ctx: { navigator: { sendBeacon: (...args: unknown[]) => unknown } } = {
      navigator: { sendBeacon: () => "original" },
    };
    runInNewContext(content, ctx);
    // delete on a non-configurable property is a no-op in sloppy mode / throws in strict
    try {
      delete (ctx.navigator as Record<string, unknown>).sendBeacon;
    } catch {
      /* strict mode */
    }
    expect(ctx.navigator.sendBeacon()).toBe(true);
  });

  it("sendBeacon override survives reassignment attempt", () => {
    const scriptPath = path.join(__dirname, "..", "resources", "marshal-playwright-init-egress-block.js");
    const content = fs.readFileSync(scriptPath, "utf-8");
    const ctx: { navigator: { sendBeacon: (...args: unknown[]) => unknown } } = {
      navigator: { sendBeacon: () => "original" },
    };
    runInNewContext(content, ctx);
    // writable: false — silent no-op in sloppy mode / throws in strict
    try {
      ctx.navigator.sendBeacon = () => "reassigned";
    } catch {
      /* strict mode */
    }
    expect(ctx.navigator.sendBeacon()).toBe(true);
  });
});
