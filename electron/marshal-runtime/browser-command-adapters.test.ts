import { describe, expect, it } from "vitest";

import {
  adaptMarshalBrowserCommand,
  MARSHAL_BROWSER_COMMAND_ADAPTERS,
} from "./browser-command-adapters";

describe("Marshal browser command adapters", () => {
  it("publishes closed Agentic Browser schemas", () => {
    expect(Object.keys(MARSHAL_BROWSER_COMMAND_ADAPTERS).sort()).toEqual([
      "browser_accessibility_tree",
      "browser_click",
      "browser_close_tab",
      "browser_console",
      "browser_create_tab",
      "browser_execute_script",
      "browser_file_upload",
      "browser_go_back",
      "browser_handle_dialog",
      "browser_hover",
      "browser_list_tabs",
      "browser_navigate",
      "browser_screenshot",
      "browser_select",
      "browser_switch_tab",
      "browser_type",
    ]);
    for (const adapter of Object.values(MARSHAL_BROWSER_COMMAND_ADAPTERS)) {
      expect(adapter.target).toMatch(/^browser_/);
      expect(adapter.title).not.toBe("");
      expect(adapter.description).not.toBe("");
      expect(adapter.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
    expect(MARSHAL_BROWSER_COMMAND_ADAPTERS.browser_click.inputSchema).toMatchObject({
      properties: {
        selector: { type: "string", minLength: 1 },
        modifiers: {
          type: "array",
          items: { enum: ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"] },
        },
      },
    });
    expect(MARSHAL_BROWSER_COMMAND_ADAPTERS.browser_switch_tab.inputSchema).toMatchObject({
      required: ["index"],
      properties: { index: { type: "integer", minimum: 0 } },
    });
  });

  it("translates dialog, tab, element, screenshot, and script inputs exactly", () => {
    expect(
      adaptMarshalBrowserCommand("browser_handle_dialog", {
        action: "dismiss",
        promptText: "unused",
      }),
    ).toEqual({
      toolName: "browser_handle_dialog",
      input: { accept: false, promptText: "unused" },
    });
    expect(adaptMarshalBrowserCommand("browser_create_tab", {})).toEqual({
      toolName: "browser_tabs",
      input: { action: "new" },
    });
    expect(adaptMarshalBrowserCommand("browser_switch_tab", { index: 2 })).toEqual({
      toolName: "browser_tabs",
      input: { action: "select", index: 2 },
    });
    expect(
      adaptMarshalBrowserCommand("browser_click", {
        selector: "#submit",
        doubleClick: true,
        modifiers: ["ControlOrMeta"],
      }),
    ).toEqual({
      toolName: "browser_click",
      input: {
        selector: "#submit",
        doubleClick: true,
        modifiers: ["ControlOrMeta"],
      },
    });
    expect(
      adaptMarshalBrowserCommand("browser_screenshot", { format: "jpeg", fullPage: true }),
    ).toEqual({
      toolName: "browser_take_screenshot",
      input: { type: "jpeg", fullPage: true },
    });
    expect(adaptMarshalBrowserCommand("browser_execute_script", { script: "() => 42" })).toEqual({
      toolName: "browser_evaluate",
      input: { function: "() => 42" },
    });
  });

  it("rejects unsupported commands and invalid Agentic Browser inputs", () => {
    expect(adaptMarshalBrowserCommand("browser_reload", {})).toEqual({
      toolName: "browser_reload",
      input: {},
    });
    expect(() => adaptMarshalBrowserCommand("browser_unknown", {})).toThrow(
      "Unsupported Marshal browser command",
    );
    expect(() => adaptMarshalBrowserCommand("browser_click", {})).toThrow("requires selector");
    expect(() => adaptMarshalBrowserCommand("browser_handle_dialog", { action: "ignore" })).toThrow(
      "invalid action",
    );
    expect(() => adaptMarshalBrowserCommand("browser_switch_tab", { index: -1 })).toThrow(
      "non-negative integer",
    );
  });
});
