import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { READ_AUTO_APPROVE_RULE } from "./read-tool-auto-approval-rule";
import { makeCtx, makeRequest } from "./test-helpers";

describe("READ_AUTO_APPROVE_RULE", () => {
  it("returns null for non-read requests", () => {
    const ctx = makeCtx();
    const request = makeRequest({ kind: "shell", command: "ls /tmp" });
    expect(READ_AUTO_APPROVE_RULE.apply(request, ctx)).toBeNull();
  });

  it("approves read requests when filesystem is enabled", () => {
    const ctx = makeCtx();
    const request = makeRequest({ kind: "read", path: "/tmp/file.txt", toolCallId: undefined });
    const result = READ_AUTO_APPROVE_RULE.apply(request, ctx);
    expect(result?.decision).toBe("approve");
    expect(result?.auditOutcome).toBe("approved");
  });

  it("denies read requests when filesystem server is disabled", () => {
    const ctx = makeCtx({
      permissions: {
        servers: {
          filesystem: { enabled: false, autoApprove: false },
        },
      },
    });
    const request = makeRequest({ kind: "read", path: "/tmp/file.txt", toolCallId: undefined });
    const result = READ_AUTO_APPROVE_RULE.apply(request, ctx);
    expect(result?.decision).toBe("deny");
    expect(result?.auditOutcome).toBe("denied");
  });

  describe("workspace boundary", () => {
    const workspaceDir = path.join(os.homedir(), "workspace");

    it("approves reads inside the workspace when workspaceDir is set", () => {
      const ctx = makeCtx({ workspaceDir });
      const request = makeRequest({
        kind: "read",
        path: path.join(workspaceDir, "project", "file.ts"),
        toolCallId: undefined,
      });
      const result = READ_AUTO_APPROVE_RULE.apply(request, ctx);
      expect(result?.decision).toBe("approve");
    });

    it("falls through (returns null) for reads outside the workspace so later rules can approve", () => {
      const ctx = makeCtx({ workspaceDir });
      const request = makeRequest({
        kind: "read",
        path: path.join(os.homedir(), "other-folder", "secret.txt"),
        toolCallId: undefined,
      });
      const result = READ_AUTO_APPROVE_RULE.apply(request, ctx);
      expect(result).toBeNull();
    });

    it("approves reads when no workspaceDir is set (backward compat)", () => {
      const ctx = makeCtx(); // no workspaceDir
      const request = makeRequest({
        kind: "read",
        path: path.join(os.homedir(), "anywhere", "file.txt"),
        toolCallId: undefined,
      });
      const result = READ_AUTO_APPROVE_RULE.apply(request, ctx);
      expect(result?.decision).toBe("approve");
    });
  });
});
