import { describe, expect, it } from "vitest";

import {
  classifyToolActivityKind,
  getToolActivityCopy,
  humanizeActivityToolName,
  isCancelledToolError,
} from "./tool-activity";
import { humanizeToolName } from "./tool-names";

describe("tool activity metadata", () => {
  it.each([
    ["listLocalFiles", "read"],
    ["getLocalFileTree", "read"],
    ["statLocalPath", "read"],
    ["browser_snapshot", "read"],
    ["powershell", "command"],
    ["bash", "command"],
    ["custom_command", "other"],
    ["shellfish", "other"],
    ["createLocalDirectory", "mutation"],
    ["moveLocalPath", "mutation"],
    ["browser_click", "mutation"],
  ] as const)("classifies %s as %s", (toolName, expected) => {
    expect(classifyToolActivityKind(toolName)).toBe(expected);
  });

  it("normalizes legacy and prefixed tool names", () => {
    expect(classifyToolActivityKind("marshal_filesystem_move")).toBe("mutation");
    expect(classifyToolActivityKind("playwright-browser_snapshot")).toBe("read");
    expect(classifyToolActivityKind("mcp:playwright:browser_click")).toBe("mutation");
  });

  it.each([
    ["listSubagents", "List subagents"],
    ["mcp:custom:archiveRecords", "Archive records"],
    ["filesystem__read_text_file", "Read text file"],
    ["take-screenshot", "Take screenshot"],
    ["mcp:github:listPRs", "List PRs"],
    ["getOAuthToken", "Get OAuth token"],
    ["getURL", "Get URL"],
    ["parseJSONResponse", "Parse JSON response"],
    ["OAuth2", "OAuth2"],
  ])("humanizes %s as %s", (toolName, expected) => {
    expect(humanizeActivityToolName(toolName)).toBe(expected);
  });

  it.each([
    ["toString", "To string"],
    ["constructor", "Constructor"],
    ["__proto__", "Proto"],
    ["mcp:custom:constructor", "Constructor"],
    ["mcp:vendor:unknownToolName", "Unknown tool name"],
  ])("handles prototype-like or unknown identity %s conservatively", (toolName, expected) => {
    expect(() => humanizeActivityToolName(toolName)).not.toThrow();
    expect(humanizeActivityToolName(toolName)).toBe(expected);
    expect(classifyToolActivityKind(toolName)).toBe("other");
    expect(getToolActivityCopy(toolName)).toBeUndefined();
  });

  it("rejects non-string humanization inputs without throwing", () => {
    expect(humanizeToolName(null)).toBe("");
    expect(humanizeToolName(Object.create(null))).toBe("");
    expect(humanizeActivityToolName(undefined)).toBe("");
  });

  it("provides human activity copy for representative reads and mutations", () => {
    expect(getToolActivityCopy("browser_snapshot")).toEqual({
      active: "Reading page content",
      completed: "Read page content",
    });
    expect(getToolActivityCopy("playwright-browser_click")).toEqual({
      active: "Clicking something on the page",
      completed: "Clicked something on the page",
    });
    expect(getToolActivityCopy("create_file")).toEqual({
      active: "Creating file",
      completed: "Created file",
    });
    expect(getToolActivityCopy("move_file")).toEqual({
      active: "Moving file",
      completed: "Moved file",
    });
  });

  it("recognizes cancellation-shaped terminal errors", () => {
    expect(isCancelledToolError("Operation cancelled")).toBe(true);
    expect(isCancelledToolError("Request aborted")).toBe(true);
    expect(isCancelledToolError("Command failed")).toBe(false);
  });
});
