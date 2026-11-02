import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../backend/types";
import { testDouble } from "../testing/harness";
import { FOLDER_GRANT_RULE } from "./folder-grant";
import type { PolicyContext } from "./types";

const ws = path.resolve("/tmp/ws");
const downloads = path.resolve("/tmp/Downloads");

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    permissions: { autoApproveReadOnly: false, allow: [], tools: {}, servers: {} },
    effectiveServerName: "filesystem",
    serverConfig: undefined,
    tenantPolicy: undefined,
    allowAllMode: false,
    unattendedSessions: new Set(),
    sessionDenyPrompt: new Set(),
    onDenyPromptCallback: undefined,
    workspaceDir: ws,
    ...over,
  };
}
function read(p: string): ApprovalRequest {
  return testDouble<ApprovalRequest>({ kind: "read", path: p, sessionId: "s1" });
}
function write(p: string): ApprovalRequest {
  return testDouble<ApprovalRequest>({ kind: "write", path: p, sessionId: "s1" });
}

describe("FOLDER_GRANT_RULE", () => {
  it("ignores in-workspace reads (handled earlier)", () => {
    expect(FOLDER_GRANT_RULE.apply(read(path.join(ws, "f.txt")), ctx())).toBeNull();
  });
  it("prompts for an ungranted out-of-workspace read", () => {
    expect(FOLDER_GRANT_RULE.apply(read(path.join(downloads, "f.txt")), ctx())?.decision).toBe(
      "prompt",
    );
  });
  it("approves a read under a granted read folder", () => {
    const c = ctx({
      permissions: {
        autoApproveReadOnly: false,
        allow: [],
        tools: {},
        servers: {},
        allowedReadFolders: [downloads],
      },
    });
    expect(FOLDER_GRANT_RULE.apply(read(path.join(downloads, "f.txt")), c)?.decision).toBe(
      "approve",
    );
  });
  it("does NOT let a read grant authorize a write (independent scopes)", () => {
    const c = ctx({
      permissions: {
        autoApproveReadOnly: false,
        allow: [],
        tools: {},
        servers: {},
        allowedReadFolders: [downloads],
      },
    });
    expect(FOLDER_GRANT_RULE.apply(write(path.join(downloads, "f.txt")), c)?.decision).toBe(
      "prompt",
    );
  });
  it("approves a write under a granted write folder", () => {
    const c = ctx({
      permissions: {
        autoApproveReadOnly: false,
        allow: [],
        tools: {},
        servers: {},
        allowedWriteFolders: [downloads],
      },
    });
    expect(FOLDER_GRANT_RULE.apply(write(path.join(downloads, "f.txt")), c)?.decision).toBe(
      "approve",
    );
  });
  it("denies (no card) when tenant restrictToWorkspace is set", () => {
    const c = ctx({
      tenantPolicy: testDouble<PolicyContext["tenantPolicy"]>({
        get: () => ({ restrictToWorkspace: true }),
      }),
    });
    expect(FOLDER_GRANT_RULE.apply(read(path.join(downloads, "f.txt")), c)?.decision).toBe("deny");
  });
  it("ignores non-read/write kinds", () => {
    const shell = testDouble<ApprovalRequest>({ kind: "shell", sessionId: "s1" });
    expect(FOLDER_GRANT_RULE.apply(shell, ctx())).toBeNull();
  });
  it("ignores a read with an empty path", () => {
    expect(FOLDER_GRANT_RULE.apply(read(""), ctx())).toBeNull();
  });
  it("gates an sdk-origin write outside the workspace (prompts when ungranted)", () => {
    const sdkWrite = testDouble<ApprovalRequest>({
      kind: "write",
      path: path.join(downloads, "f.txt"),
      origin: "sdk",
      sessionId: "s1",
    });
    expect(FOLDER_GRANT_RULE.apply(sdkWrite, ctx())?.decision).toBe("prompt");
  });
  it("tenant restrictToWorkspace wins even when the folder is granted", () => {
    const c = ctx({
      permissions: {
        autoApproveReadOnly: false,
        allow: [],
        tools: {},
        servers: {},
        allowedReadFolders: [downloads],
      },
      tenantPolicy: testDouble<PolicyContext["tenantPolicy"]>({
        get: () => ({ restrictToWorkspace: true }),
      }),
    });
    expect(FOLDER_GRANT_RULE.apply(read(path.join(downloads, "f.txt")), c)?.decision).toBe("deny");
  });
});
