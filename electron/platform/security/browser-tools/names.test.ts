import { describe, expect, it } from "vitest";

import {
  getBarePlaywrightToolName,
  isBrowserCodeExecutionTool,
  PLAYWRIGHT_CODE_EXECUTION_TOOLS,
  PLAYWRIGHT_EXPLICIT_WRITE_TOOLS,
} from "./names";

describe("PLAYWRIGHT_EXPLICIT_WRITE_TOOLS", () => {
  it("covers the 6 expected explicit-path tools", () => {
    const expected = [
      "browser_take_screenshot",
      "browser_pdf_save",
      "browser_snapshot",
      "browser_console_messages",
      "browser_network_requests",
      "browser_stop_video",
    ];
    for (const tool of expected) {
      expect(PLAYWRIGHT_EXPLICIT_WRITE_TOOLS).toHaveProperty(tool);
    }
  });
});

describe("isBrowserCodeExecutionTool", () => {
  it.each(PLAYWRIGHT_CODE_EXECUTION_TOOLS)("returns true for %s", (tool) => {
    expect(isBrowserCodeExecutionTool(tool)).toBe(true);
  });

  it.each([
    "browser_navigate",
    "browser_take_screenshot",
    "shell",
    "filesystem__edit_file",
    "browser_evaluate_extra",
  ])("returns false for %s", (tool) => {
    expect(isBrowserCodeExecutionTool(tool)).toBe(false);
  });
});

describe("getBarePlaywrightToolName", () => {
  it("strips playwright- prefix", () => {
    expect(getBarePlaywrightToolName("playwright-browser_take_screenshot")).toBe(
      "browser_take_screenshot",
    );
  });

  it("strips playwright__ prefix", () => {
    expect(getBarePlaywrightToolName("playwright__browser_take_screenshot")).toBe(
      "browser_take_screenshot",
    );
  });

  it("lowercases the result", () => {
    expect(getBarePlaywrightToolName("Playwright-Browser_Take_Screenshot")).toBe(
      "browser_take_screenshot",
    );
  });

  it("returns bare name unchanged when no prefix", () => {
    expect(getBarePlaywrightToolName("browser_navigate")).toBe("browser_navigate");
  });
});
