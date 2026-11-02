import { describe, expect, it, vi } from "vitest";

import type { PermissionAction } from "../../../../common/marshal-constants";
import type { ApprovalBroker, BrokerRequest, PromptResult } from "../../../approval-broker";
import type { PermissionDecision, PermissionPolicy } from "../../../permission-policy";
import { testDouble } from "../../../testing/harness/test-double";
import type { ApprovalRequest } from "../../types";
import type { ApprovalCardRequest } from "../../types";
import { makeShowApprovalCardHandler } from "./show-approval-card";

type RequestPromptFn = (request: BrokerRequest) => Promise<PromptResult>;
type RecordOutcomeFn = (
  request: ApprovalRequest,
  action: PermissionAction,
  sdkResult: string,
) => boolean;
type EvaluateFn = (request: ApprovalRequest) => PermissionDecision;

function makeFakes(opts: {
  result?: PromptResult;
  resultPromise?: Promise<PromptResult>;
  policyDecision?: PermissionDecision;
  interactiveAccepted?: boolean;
}) {
  const requestPrompt = vi.fn<RequestPromptFn>(async () =>
    opts.resultPromise ? await opts.resultPromise : opts.result!,
  );
  const evaluate = vi.fn<EvaluateFn>(() => opts.policyDecision ?? "prompt");
  const recordInteractiveOutcome = vi.fn<RecordOutcomeFn>(() => opts.interactiveAccepted ?? true);
  const broker = testDouble<ApprovalBroker>({ requestPrompt });
  const policy = testDouble<PermissionPolicy>({ evaluate, recordInteractiveOutcome });
  return { broker, policy, evaluate, requestPrompt, recordInteractiveOutcome };
}

const baseRequest: ApprovalCardRequest = {
  requestId: "perm-1",
  sessionId: "session-1",
  kind: "shell",
  toolName: "shell",
  toolArgs: { command: "ls" },
};

const LEGACY_ALIAS_TOOL_NAME = "marshal_list_skills";
const CANONICAL_TOOL_NAME = "listSkills";

describe("makeShowApprovalCardHandler", () => {
  it("returns approve without showing a card when local policy approves", async () => {
    const { broker, policy, evaluate, requestPrompt, recordInteractiveOutcome } = makeFakes({
      policyDecision: "approve",
    });
    const handler = makeShowApprovalCardHandler({ broker, policy });

    const result = await handler(baseRequest);

    expect(result).toEqual({ action: "approve" });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(requestPrompt).not.toHaveBeenCalled();
    expect(recordInteractiveOutcome).not.toHaveBeenCalled();
  });

  it("returns deny without showing a card when local policy denies", async () => {
    const { broker, policy, requestPrompt, recordInteractiveOutcome } = makeFakes({
      policyDecision: "deny",
    });
    const handler = makeShowApprovalCardHandler({ broker, policy });

    const result = await handler(baseRequest);

    expect(result).toEqual({ action: "deny" });
    expect(requestPrompt).not.toHaveBeenCalled();
    expect(recordInteractiveOutcome).not.toHaveBeenCalled();
  });

  it("returns { action: 'approve' } for the simple 'allow' (allow-once) outcome", async () => {
    const { broker, policy, recordInteractiveOutcome } = makeFakes({
      result: { outcome: "resolved", action: "allow" },
    });
    const handler = makeShowApprovalCardHandler({ broker, policy });

    const result = await handler(baseRequest);

    expect(result).toEqual({ action: "approve" });
    expect(recordInteractiveOutcome).toHaveBeenCalledTimes(1);
    expect(recordInteractiveOutcome.mock.calls[0][1]).toBe("allow");
  });

  it("denies an approval when the scoped workspace disappears while the card is open", async () => {
    const { broker, policy } = makeFakes({
      result: { outcome: "resolved", action: "allow" },
      interactiveAccepted: false,
    });

    await expect(makeShowApprovalCardHandler({ broker, policy })(baseRequest)).resolves.toEqual({
      action: "deny",
    });
  });

  it("returns { action: 'approve', rememberFor: 'session' } for allow-session", async () => {
    const { broker, policy, recordInteractiveOutcome } = makeFakes({
      result: { outcome: "resolved", action: "allow-session" },
    });
    const handler = makeShowApprovalCardHandler({ broker, policy });

    const result = await handler(baseRequest);

    expect(result).toEqual({ action: "approve", rememberFor: "session" });
    expect(recordInteractiveOutcome).toHaveBeenCalledTimes(1);
    expect(recordInteractiveOutcome.mock.calls[0][1]).toBe("allow-session");
  });

  it("returns { action: 'approve' } (no rememberFor) for the legacy 'allow-type' enum value", async () => {
    // `allow-type` is a legacy PermissionAction kept for compatibility — the
    // handler treats it as a single-shot approve (no remember). Pinning so a
    // future enum-cleanup PR doesn't accidentally drop the mapping.
    const { broker, policy, recordInteractiveOutcome } = makeFakes({
      result: { outcome: "resolved", action: "allow-type" },
    });
    const handler = makeShowApprovalCardHandler({ broker, policy });

    const result = await handler(baseRequest);

    expect(result).toEqual({ action: "approve" });
    expect(recordInteractiveOutcome).toHaveBeenCalledTimes(1);
    expect(recordInteractiveOutcome.mock.calls[0][1]).toBe("allow-type");
  });

  it("returns { action: 'approve' } (no rememberFor) for the legacy 'allow-all' enum value", async () => {
    // Same legacy-mapping rationale as `allow-type`.
    const { broker, policy, recordInteractiveOutcome } = makeFakes({
      result: { outcome: "resolved", action: "allow-all" },
    });
    const handler = makeShowApprovalCardHandler({ broker, policy });

    const result = await handler(baseRequest);

    expect(result).toEqual({ action: "approve" });
    expect(recordInteractiveOutcome).toHaveBeenCalledTimes(1);
    expect(recordInteractiveOutcome.mock.calls[0][1]).toBe("allow-all");
  });

  it("returns { action: 'approve', rememberFor: 'always' } for always-allow", async () => {
    const { broker, policy, recordInteractiveOutcome } = makeFakes({
      result: { outcome: "resolved", action: "always-allow" },
    });
    const handler = makeShowApprovalCardHandler({ broker, policy });

    const result = await handler(baseRequest);

    expect(result).toEqual({ action: "approve", rememberFor: "always" });
    expect(recordInteractiveOutcome).toHaveBeenCalledTimes(1);
    expect(recordInteractiveOutcome.mock.calls[0][1]).toBe("always-allow");
  });

  it("returns { action: 'deny' } and records the outcome for an explicit deny", async () => {
    const { broker, policy, recordInteractiveOutcome } = makeFakes({
      result: { outcome: "resolved", action: "deny" },
    });
    const handler = makeShowApprovalCardHandler({ broker, policy });

    const result = await handler(baseRequest);

    expect(result).toEqual({ action: "deny" });
    expect(recordInteractiveOutcome).toHaveBeenCalledTimes(1);
    expect(recordInteractiveOutcome.mock.calls[0][1]).toBe("deny");
  });

  it("returns { action: 'deny' } on timeout and does NOT call recordInteractiveOutcome", async () => {
    const { broker, policy, recordInteractiveOutcome } = makeFakes({
      result: { outcome: "timed-out" },
    });
    const handler = makeShowApprovalCardHandler({ broker, policy });

    const result = await handler(baseRequest);

    expect(result).toEqual({ action: "deny" });
    expect(recordInteractiveOutcome).not.toHaveBeenCalled();
  });

  it("constructs a BrokerRequest carrying requestId, sessionId, and a populated ApprovalRequest", async () => {
    const { broker, policy, requestPrompt } = makeFakes({
      result: { outcome: "resolved", action: "allow" },
    });
    const handler = makeShowApprovalCardHandler({ broker, policy });

    await handler(baseRequest);

    const arg = requestPrompt.mock.calls[0][0];
    expect(arg.requestId).toBe("perm-1");
    expect(arg.sessionId).toBe("session-1");
    expect(arg.permissionRequest.sessionId).toBe("session-1");
    expect(arg.permissionRequest.kind).toBe("shell");
    expect(arg.permissionRequest.id).toBe("perm-1");
    // Normalized shape: fields are top-level — narrow by kind to access them
    const pr = arg.permissionRequest;
    if (pr.kind !== "shell") throw new Error(`expected shell, got ${pr.kind}`);
    expect(pr.command).toBe("shell"); // toolName maps to command for shell kind
  });

  it("canonicalizes a legacy host alias before policy and broker handling", async () => {
    const { broker, policy, evaluate, requestPrompt } = makeFakes({
      result: { outcome: "resolved", action: "allow" },
    });
    const handler = makeShowApprovalCardHandler({ broker, policy });

    await handler({
      ...baseRequest,
      kind: "custom-tool",
      toolName: LEGACY_ALIAS_TOOL_NAME,
    });

    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "custom-tool", toolName: CANONICAL_TOOL_NAME }),
    );
    expect(requestPrompt.mock.calls[0][0].permissionRequest).toEqual(
      expect.objectContaining({ kind: "custom-tool", toolName: CANONICAL_TOOL_NAME }),
    );
  });

  it("concurrent calls with different requestIds resolve independently", async () => {
    let resolveA: (r: PromptResult) => void;
    let resolveB: (r: PromptResult) => void;
    const promiseA = new Promise<PromptResult>((res) => {
      resolveA = res;
    });
    const promiseB = new Promise<PromptResult>((res) => {
      resolveB = res;
    });

    const requestPrompt = vi.fn<RequestPromptFn>(async (req) => {
      if (req.requestId === "perm-A") return await promiseA;
      return await promiseB;
    });
    const recordInteractiveOutcome = vi.fn<RecordOutcomeFn>(() => true);
    const evaluate = vi.fn<EvaluateFn>(() => "prompt");
    const broker = testDouble<ApprovalBroker>({ requestPrompt });
    const policy = testDouble<PermissionPolicy>({ evaluate, recordInteractiveOutcome });

    const handler = makeShowApprovalCardHandler({ broker, policy });

    const promiseAResult = handler({ ...baseRequest, requestId: "perm-A" });
    const promiseBResult = handler({ ...baseRequest, requestId: "perm-B" });

    // Resolve B first
    resolveB!({ outcome: "resolved", action: "deny" });
    await expect(promiseBResult).resolves.toEqual({ action: "deny" });

    resolveA!({ outcome: "resolved", action: "allow-session" });
    await expect(promiseAResult).resolves.toEqual({
      action: "approve",
      rememberFor: "session",
    });
  });

  it("passes 'sdkResult' as 'approved' for approve outcomes and 'denied-interactively-by-user' for deny", async () => {
    const { broker, policy, recordInteractiveOutcome } = makeFakes({
      result: { outcome: "resolved", action: "allow" },
    });
    const handler = makeShowApprovalCardHandler({ broker, policy });

    await handler(baseRequest);
    expect(recordInteractiveOutcome.mock.calls[0][2]).toBe("approved");

    const denyFakes = makeFakes({
      result: { outcome: "resolved", action: "deny" },
    });
    const denyHandler = makeShowApprovalCardHandler({
      broker: denyFakes.broker,
      policy: denyFakes.policy,
    });

    await denyHandler(baseRequest);
    expect(denyFakes.recordInteractiveOutcome.mock.calls[0][2]).toBe(
      "denied-interactively-by-user",
    );
  });

  it("throws for kind not handled by buildApprovalApprovalRequest", async () => {
    const { broker, policy } = makeFakes({ result: { outcome: "resolved", action: "allow" } });
    const handler = makeShowApprovalCardHandler({ broker, policy });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- intentional out-of-union value for exhaustiveness test
    const req = {
      requestId: "r1",
      sessionId: "s1",
      kind: "write",
      toolName: "edit_file",
    } as unknown as ApprovalCardRequest;
    await expect(handler(req)).rejects.toThrow(/unhandled kind "write"/);
  });
});
