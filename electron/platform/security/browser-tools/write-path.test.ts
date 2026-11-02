import { describe, expect, it } from "vitest";

import { extractBrowserWritePath } from "./write-path";

describe("extractBrowserWritePath", () => {
  it("returns the filename from object toolArgs for browser_take_screenshot", () => {
    expect(extractBrowserWritePath("browser_take_screenshot", { filename: "/tmp/shot.png" })).toBe(
      "/tmp/shot.png",
    );
  });

  it("returns the filename from JSON-string toolArgs (SDK sends string in pre-hook)", () => {
    expect(extractBrowserWritePath("browser_take_screenshot", '{"filename":"/tmp/shot.png"}')).toBe(
      "/tmp/shot.png",
    );
  });

  it("returns null for absent, empty, or invalid filename args", () => {
    expect(extractBrowserWritePath("browser_take_screenshot", {})).toBeNull();
    expect(extractBrowserWritePath("browser_take_screenshot", { filename: "" })).toBeNull();
    expect(extractBrowserWritePath("browser_take_screenshot", { filename: 42 })).toBeNull();
    expect(extractBrowserWritePath("browser_take_screenshot", null)).toBeNull();
    expect(extractBrowserWritePath("browser_take_screenshot", "{bad json")).toBeNull();
  });

  it("returns null for a non-write tool", () => {
    expect(extractBrowserWritePath("browser_navigate", { url: "https://example.com" })).toBeNull();
  });

  it.each([
    "browser_pdf_save",
    "browser_snapshot",
    "browser_console_messages",
    "browser_network_requests",
    "browser_stop_video",
  ])("returns path for %s", (tool) => {
    expect(extractBrowserWritePath(tool, { filename: "/out/file.txt" })).toBe("/out/file.txt");
  });
});
