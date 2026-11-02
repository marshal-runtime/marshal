import { describe, expect, it } from "vitest";

import { READ_ONLY_AUTO_APPROVE_RULE } from "./read-only-tool-auto-approval-rule";
import { makeCtx, makeRequest } from "./test-helpers";

describe("READ_ONLY_AUTO_APPROVE_RULE", () => {
  it("returns null when autoApproveReadOnly is false", () => {
    const ctx = makeCtx({
      permissions: { autoApproveReadOnly: false },
    });
    const request = makeRequest({ kind: "shell", command: "ls /tmp" });
    expect(READ_ONLY_AUTO_APPROVE_RULE.apply(request, ctx)).toBeNull();
  });

  it("approves read-only shell command when autoApproveReadOnly is true", () => {
    const ctx = makeCtx({
      permissions: { autoApproveReadOnly: true },
    });
    const request = makeRequest({ kind: "shell", command: "ls /tmp" });
    const result = READ_ONLY_AUTO_APPROVE_RULE.apply(request, ctx);
    expect(result?.decision).toBe("approve");
    expect(result?.auditOutcome).toBe("approved");
  });

  it("returns null for mutating shell command even with autoApproveReadOnly", () => {
    const ctx = makeCtx({
      permissions: { autoApproveReadOnly: true },
    });
    const request = makeRequest({ kind: "shell", command: "rm -rf /tmp/dir" });
    expect(READ_ONLY_AUTO_APPROVE_RULE.apply(request, ctx)).toBeNull();
  });

  it("approves read-only custom-tool in foreground session", () => {
    const ctx = makeCtx({
      permissions: { autoApproveReadOnly: true },
    });
    // recall is a known read-only custom tool (see READ_ONLY_CUSTOM_TOOLS in permission-policy.ts)
    const request = makeRequest({
      kind: "custom-tool",
      toolName: "recall",
      toolDescription: undefined,
      toolArgs: {},
      intention: undefined,
      warning: undefined,
      commandIdentifiers: [],
      toolCallId: undefined,
    });
    const result = READ_ONLY_AUTO_APPROVE_RULE.apply(request, ctx);
    expect(result).not.toBeNull();
    expect(result?.decision).toBe("approve");
  });
});
