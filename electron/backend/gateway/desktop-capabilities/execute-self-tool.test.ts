import { describe, expect, it, vi } from "vitest";

import type { PermissionDecision, PermissionPolicy } from "../../../permission-policy";
import { testDouble } from "../../../testing/harness/test-double";
import type { RuntimeTool, RuntimeToolInvocation } from "../../runtime-contract";
import type { ApprovalRequest } from "../../types";
import { isDesktopCapabilityErrorThrow, type LocalToolRequest } from "../../types";
import { makeExecuteSelfToolHandler } from "./execute-self-tool";

type EvaluateFn = (request: ApprovalRequest) => PermissionDecision;

function fakePolicy(decision: PermissionDecision): PermissionPolicy {
  const evaluate = vi.fn<EvaluateFn>(() => decision);
  return testDouble<PermissionPolicy>({ evaluate });
}

type TestToolInvocation = RuntimeToolInvocation;

function fakeTool(
  name: string,
  handler: (args: unknown, invocation: TestToolInvocation) => Promise<string>,
): RuntimeTool {
  return {
    name,
    description: "",
    parameters: { type: "object", properties: {} },
    handler,
  };
}

const baseRequest: LocalToolRequest = {
  kind: "custom-tool",
  toolName: "recall",
  toolArgs: { query: "hello" },
  sessionId: "session-1",
};

describe("makeExecuteSelfToolHandler", () => {
  it("dispatches to a registered self-tool and returns its output", async () => {
    const handler = vi.fn<(args: unknown, invocation: TestToolInvocation) => Promise<string>>(
      async () => JSON.stringify({ memories: ["a", "b"] }),
    );
    const tools: RuntimeTool[] = [fakeTool("recall", handler)];
    const exec = makeExecuteSelfToolHandler({
      policy: fakePolicy("approve"),
      getSelfTools: () => tools,
    });

    const result = await exec(baseRequest);

    expect(result.success).toBe(true);
    expect(result.output).toBe(JSON.stringify({ memories: ["a", "b"] }));
    expect(handler).toHaveBeenCalledWith(
      { query: "hello" },
      expect.objectContaining({
        sessionId: "session-1",
        toolName: "recall",
        arguments: { query: "hello" },
      }),
    );
  });

  it("canonicalizes a legacy cloud-supplied self-tool name before dispatch", async () => {
    const handler = vi.fn<(args: unknown, invocation: TestToolInvocation) => Promise<string>>(
      async () => "ok",
    );
    const exec = makeExecuteSelfToolHandler({
      policy: fakePolicy("approve"),
      getSelfTools: () => [fakeTool("recall", handler)],
    });

    const result = await exec({ ...baseRequest, toolName: "marshal_recall" });

    expect(result).toEqual({ success: true, output: "ok" });
    expect(handler).toHaveBeenCalledWith(
      { query: "hello" },
      expect.objectContaining({ toolName: "recall" }),
    );
  });

  it("returns { success: false } when the tool name is unknown", async () => {
    const exec = makeExecuteSelfToolHandler({
      policy: fakePolicy("approve"),
      getSelfTools: () => [fakeTool("other", async () => "x")],
    });

    const result = await exec({ ...baseRequest, toolName: "does_not_exist" });

    expect(result.success).toBe(false);
    expect(result.output).toBeNull();
    expect(result.error).toContain("does_not_exist");
  });

  it("returns { success: false } when the registry is not yet wired", async () => {
    const exec = makeExecuteSelfToolHandler({
      policy: fakePolicy("approve"),
      getSelfTools: () => null,
    });

    const result = await exec(baseRequest);

    expect(result.success).toBe(false);
    expect(result.output).toBeNull();
    expect(result.error).toMatch(/not available/i);
  });

  it("captures handler errors as { success: false, error }", async () => {
    const tools: RuntimeTool[] = [
      fakeTool("recall", async () => {
        throw new Error("bang");
      }),
    ];
    const exec = makeExecuteSelfToolHandler({
      policy: fakePolicy("approve"),
      getSelfTools: () => tools,
    });

    const result = await exec(baseRequest);

    expect(result.success).toBe(false);
    expect(result.error).toBe("bang");
  });

  it("forwards toolArgs verbatim to the handler", async () => {
    const handler = vi.fn<(args: unknown, invocation: TestToolInvocation) => Promise<string>>(
      async () => "ok",
    );
    const tools: RuntimeTool[] = [fakeTool("recall", handler)];
    const exec = makeExecuteSelfToolHandler({
      policy: fakePolicy("approve"),
      getSelfTools: () => tools,
    });

    const args = { complex: { nested: [1, 2] }, n: 7 };
    await exec({ ...baseRequest, toolArgs: args });

    expect(handler).toHaveBeenCalledWith(
      args,
      expect.objectContaining({ arguments: args, toolName: "recall" }),
    );
  });

  it("passes AbortSignal through the self-tool invocation object", async () => {
    const controller = new AbortController();
    const handler = vi.fn<(args: unknown, invocation: TestToolInvocation) => Promise<string>>(
      async () => "ok",
    );
    const tools: RuntimeTool[] = [fakeTool("recall", handler)];
    const exec = makeExecuteSelfToolHandler({
      policy: fakePolicy("approve"),
      getSelfTools: () => tools,
    });

    await exec({ ...baseRequest, toolCallId: "tc-1" }, controller.signal);

    expect(handler).toHaveBeenCalledWith(
      { query: "hello" },
      expect.objectContaining({
        sessionId: "session-1",
        toolCallId: "tc-1",
        toolName: "recall",
        signal: controller.signal,
      }),
    );
  });

  it("throws DesktopCapabilityErrorThrow with code 'policy-deny' when policy denies", async () => {
    const handler = vi.fn<(args: unknown, invocation: TestToolInvocation) => Promise<string>>(
      async () => "should not run",
    );
    const tools: RuntimeTool[] = [fakeTool("recall", handler)];
    const exec = makeExecuteSelfToolHandler({
      policy: fakePolicy("deny"),
      getSelfTools: () => tools,
    });

    let caught: unknown;
    try {
      await exec(baseRequest);
    } catch (err) {
      caught = err;
    }

    if (!isDesktopCapabilityErrorThrow(caught))
      throw new Error("expected DesktopCapabilityErrorThrow");
    expect(caught.code).toBe("policy-deny");
    expect(caught.message).toMatch(/policy/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it("invokes the handler when defense-in-depth policy returns 'prompt' (cloud is the authoritative gate)", async () => {
    // Cloud-side gate is the authority — by the time we land here, the cloud
    // has already shown an approval card and the user has responded. Defense-
    // in-depth re-check enforces only the categorical "deny" floor.
    const handler = vi.fn<(args: unknown, invocation: TestToolInvocation) => Promise<string>>(
      async () => "ok",
    );
    const tools: RuntimeTool[] = [fakeTool("recall", handler)];
    const exec = makeExecuteSelfToolHandler({
      policy: fakePolicy("prompt"),
      getSelfTools: () => tools,
    });

    const result = await exec(baseRequest);

    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
