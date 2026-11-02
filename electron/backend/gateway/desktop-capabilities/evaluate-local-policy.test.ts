import { describe, expect, it, vi } from "vitest";

import type { PermissionPolicy, PermissionDecision } from "../../../permission-policy";
import { testDouble } from "../../../testing/harness/test-double";
import type { ApprovalRequest } from "../../types";
import type { LocalPolicyRequest } from "../../types";
import { makeEvaluateLocalPolicyHandler } from "./evaluate-local-policy";

type EvaluateFn = (request: ApprovalRequest) => PermissionDecision;

function fakePolicy(decision: PermissionDecision): {
  policy: PermissionPolicy;
  evaluate: ReturnType<typeof vi.fn<EvaluateFn>>;
} {
  const evaluate = vi.fn<EvaluateFn>(() => decision);
  const policy = testDouble<PermissionPolicy>({ evaluate });
  return { policy, evaluate };
}

const baseRequest: LocalPolicyRequest = {
  sessionId: "session-1",
  kind: "mcp",
  toolName: "filesystem.read_file",
  serverName: "filesystem",
  toolArgs: { path: "/tmp/x" },
};

describe("makeEvaluateLocalPolicyHandler", () => {
  it("returns { action: 'approve' } when policy approves", async () => {
    const { policy, evaluate } = fakePolicy("approve");
    const handler = makeEvaluateLocalPolicyHandler({ policy });

    const result = await handler(baseRequest);

    expect(result).toEqual({ action: "approve" });
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("returns { action: 'prompt' } when policy says prompt", async () => {
    const { policy } = fakePolicy("prompt");
    const handler = makeEvaluateLocalPolicyHandler({ policy });

    const result = await handler(baseRequest);

    expect(result).toEqual({ action: "prompt" });
  });

  it("returns { action: 'deny', reason } when policy denies", async () => {
    const { policy } = fakePolicy("deny");
    const handler = makeEvaluateLocalPolicyHandler({ policy });

    const result = await handler(baseRequest);

    if (result.action !== "deny") throw new Error(`expected deny, got ${result.action}`);
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("constructs ApprovalRequest with kind, sessionId, toolName/serverName/toolArgs as normalized fields", async () => {
    const { policy, evaluate } = fakePolicy("approve");
    const handler = makeEvaluateLocalPolicyHandler({ policy });

    await handler(baseRequest);

    const arg = evaluate.mock.calls[0][0];
    expect(arg.sessionId).toBe("session-1");
    expect(arg.kind).toBe("mcp");
    expect(arg.id).toBeDefined();
    expect(typeof arg.id).toBe("string");
    // Normalized shape: fields are top-level — narrow by kind to access them
    if (arg.kind !== "mcp") throw new Error(`expected mcp, got ${arg.kind}`);
    expect(arg.toolName).toBe("filesystem.read_file");
    expect(arg.serverName).toBe("filesystem");
    expect(arg.toolArgs).toEqual({ path: "/tmp/x" });
  });

  it("forwards different PermissionKinds without modification", async () => {
    const { policy, evaluate } = fakePolicy("approve");
    const handler = makeEvaluateLocalPolicyHandler({ policy });

    await handler({ ...baseRequest, kind: "shell", toolName: "shell" });

    const arg = evaluate.mock.calls[0][0];
    expect(arg.kind).toBe("shell");
  });

  it("works without serverName / toolArgs", async () => {
    const { policy, evaluate } = fakePolicy("approve");
    const handler = makeEvaluateLocalPolicyHandler({ policy });

    await handler({
      sessionId: "s",
      kind: "custom-tool",
      toolName: "getEvent",
    });

    const arg = evaluate.mock.calls[0][0];
    // Normalized shape: fields are top-level — narrow by kind to access them
    if (arg.kind !== "custom-tool") throw new Error(`expected custom-tool, got ${arg.kind}`);
    expect(arg.toolName).toBe("getEvent");
    // toolArgs defaults to empty object for custom-tool
    expect(arg.toolArgs).toEqual({});
  });

  it("canonicalizes only custom tools and preserves third-party MCP names", async () => {
    const { policy, evaluate } = fakePolicy("approve");
    const handler = makeEvaluateLocalPolicyHandler({ policy });

    await handler({ ...baseRequest, kind: "custom-tool", toolName: "marshal_recall" });
    await handler({
      ...baseRequest,
      kind: "mcp",
      serverName: "third-party",
      toolName: "mail_send_email",
    });

    expect(evaluate.mock.calls[0][0]).toEqual(
      expect.objectContaining({ kind: "custom-tool", toolName: "recall" }),
    );
    expect(evaluate.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        kind: "mcp",
        toolName: "mail_send_email",
        serverName: "third-party",
      }),
    );
  });

  it("does not depend on settingsManager / tenantPolicy — only the injected policy is touched", async () => {
    // Pure unit test: the handler should never reach for module-level singletons.
    // We assert this by giving it a policy whose evaluate is the only method
    // present, and confirming it returns the expected union shape.
    const evaluate = vi.fn<EvaluateFn>(() => "approve" as const);
    const handler = makeEvaluateLocalPolicyHandler({
      policy: testDouble<PermissionPolicy>({ evaluate }),
    });

    const result = await handler(baseRequest);
    expect(result).toEqual({ action: "approve" });
  });
});
