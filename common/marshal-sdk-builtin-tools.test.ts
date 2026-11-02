import { describe, expect, it } from "vitest";

import {
  getServerForSdkTool,
  isSdkBuiltinTool,
  isSdkFilesystemReadTool,
  isSdkHitlRequired,
  normalizeSdkToolName,
  SDK_RESERVED_TOOL_NAMES,
} from "./marshal-sdk-builtin-tools";

describe("SDK builtin tool metadata", () => {
  it("maps web_fetch to the Browser Control server case-insensitively", () => {
    expect(getServerForSdkTool("web_fetch")).toBe("playwright");
    expect(getServerForSdkTool("WEB_FETCH")).toBe("playwright");
  });

  it("recognizes only registered SDK builtin tools", () => {
    expect(isSdkBuiltinTool("web_fetch")).toBe(true);
    expect(isSdkBuiltinTool("browser_navigate")).toBe(false);
  });

  it("normalizes known SDK builtin tool names", () => {
    expect(normalizeSdkToolName("WEB_FETCH")).toBe("web_fetch");
    expect(normalizeSdkToolName("browser_navigate")).toBeUndefined();
  });

  it("returns undefined for tools without a gated server", () => {
    expect(getServerForSdkTool("browser_navigate")).toBeUndefined();
  });

  it("reserves task and skill against host-tool registration", () => {
    expect(SDK_RESERVED_TOOL_NAMES.has("task")).toBe(true);
    expect(SDK_RESERVED_TOOL_NAMES.has("skill")).toBe(true);
  });
});

describe("filesystem SDK tools", () => {
  it.each(["view", "grep", "glob"])("isSdkBuiltinTool('%s') is true", (name) => {
    expect(isSdkBuiltinTool(name)).toBe(true);
  });

  it.each(["VIEW", "Grep", "GLOB"])("case-insensitive match for '%s'", (name) => {
    expect(isSdkBuiltinTool(name)).toBe(true);
  });

  it.each(["view", "grep", "glob"])("getServerForSdkTool('%s') returns 'filesystem'", (name) => {
    expect(getServerForSdkTool(name)).toBe("filesystem");
  });

  it("does not classify MCP filesystem tools as SDK builtins", () => {
    expect(isSdkBuiltinTool("filesystem__read_file")).toBe(false);
    expect(isSdkBuiltinTool("read_file")).toBe(false);
  });
});

describe("filesystem SDK write tools", () => {
  it.each(["edit", "create"])("isSdkBuiltinTool('%s') is true", (name) => {
    expect(isSdkBuiltinTool(name)).toBe(true);
  });

  it.each(["EDIT", "Create"])("case-insensitive match for '%s'", (name) => {
    expect(isSdkBuiltinTool(name)).toBe(true);
  });

  it.each(["edit", "create"])("getServerForSdkTool('%s') returns 'filesystem'", (name) => {
    expect(getServerForSdkTool(name)).toBe("filesystem");
  });

  it("does not classify MCP write tools as SDK builtins", () => {
    expect(isSdkBuiltinTool("filesystem__write_file")).toBe(false);
    expect(isSdkBuiltinTool("filesystem__edit_file")).toBe(false);
  });
});

describe("isSdkHitlRequired", () => {
  it.each(["edit", "create"])("returns true for write tool '%s'", (name) => {
    expect(isSdkHitlRequired(name)).toBe(true);
  });

  it.each(["EDIT", "Create"])("case-insensitive match for '%s'", (name) => {
    expect(isSdkHitlRequired(name)).toBe(true);
  });

  it.each(["view", "grep", "glob", "web_fetch"])(
    "returns false for read-only tool '%s'",
    (name) => {
      expect(isSdkHitlRequired(name)).toBe(false);
    },
  );

  it("returns false for unknown tools", () => {
    expect(isSdkHitlRequired("filesystem__edit_file")).toBe(false);
    expect(isSdkHitlRequired("apply_patch")).toBe(false);
  });
});

describe("isSdkFilesystemReadTool", () => {
  it.each(["view", "grep", "glob"])("returns true for read tool '%s'", (name) => {
    expect(isSdkFilesystemReadTool(name)).toBe(true);
  });

  it.each(["VIEW", "Grep"])("case-insensitive match for '%s'", (name) => {
    expect(isSdkFilesystemReadTool(name)).toBe(true);
  });

  it.each(["edit", "create"])("returns false for write tools '%s'", (name) => {
    expect(isSdkFilesystemReadTool(name)).toBe(false);
  });

  it("returns false for web_fetch (not filesystem server)", () => {
    expect(isSdkFilesystemReadTool("web_fetch")).toBe(false);
  });

  it("returns false for unknown tools", () => {
    expect(isSdkFilesystemReadTool("filesystem__read_file")).toBe(false);
  });
});
