import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { expandHome, resolveLocalFilePath, LOCAL_FILE_TOOL_DEFINITIONS } from "./shared";

describe("LOCAL_FILE_TOOL_DEFINITIONS", () => {
  it("maps the five tools to the right kind and path arg", () => {
    expect(LOCAL_FILE_TOOL_DEFINITIONS.listLocalFiles).toEqual({ kind: "read", pathArg: "path" });
    expect(LOCAL_FILE_TOOL_DEFINITIONS.getLocalFileTree).toEqual({ kind: "read", pathArg: "path" });
    expect(LOCAL_FILE_TOOL_DEFINITIONS.statLocalPath).toEqual({ kind: "read", pathArg: "path" });
    expect(LOCAL_FILE_TOOL_DEFINITIONS.createLocalDirectory).toEqual({
      kind: "write",
      pathArg: "path",
    });
    expect(LOCAL_FILE_TOOL_DEFINITIONS.moveLocalPath).toEqual({
      kind: "write",
      pathArg: "destination",
    });
  });
});

describe("expandHome", () => {
  it("expands a leading ~/ to the home dir", () => {
    expect(expandHome("~/Downloads")).toBe(path.join(os.homedir(), "Downloads"));
  });
  it("expands the Windows ~\\ form to the home dir", () => {
    expect(expandHome("~\\Downloads")).toBe(path.join(os.homedir(), "Downloads"));
  });
  it("leaves absolute paths untouched", () => {
    expect(expandHome("/tmp/x")).toBe("/tmp/x");
  });
});

describe("resolveLocalFilePath", () => {
  it("expands home then resolves to absolute", () => {
    expect(resolveLocalFilePath("~/Downloads")).toBe(
      path.resolve(path.join(os.homedir(), "Downloads")),
    );
  });
});
