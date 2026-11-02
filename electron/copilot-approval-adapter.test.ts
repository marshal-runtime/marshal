import os from "node:os";
import path from "node:path";

import { describe, it, expect, vi } from "vitest";

import type { PermissionAction } from "../common/marshal-constants";
import {
  ApprovalBroker,
  type ApprovalListener,
  type BrokerRequest,
  type PromptResult,
} from "./approval-broker";
import type { IApprovalBroker, ICommandClassifier, IPermissionPolicy } from "./backend/ports";
import type { ApprovalDecision, ApprovalRequest } from "./backend/types";
import { createApprovalCallbackAdapter } from "./copilot-approval-adapter";
import { PermissionCardManager } from "./permission-card-manager";
import type { CommandClassification } from "./permission-classification-contracts";
import { PermissionPolicy, type PolicyEvaluation } from "./permission-policy";
import { makeRequest, testDouble } from "./policy-rules/test-helpers";
import type { SessionManager } from "./sessions";
import type { SettingsManager } from "./settings-manager";

vi.mock("./permissions", () => ({
  formatPermissionDialog: vi
    .fn<() => Promise<{ title: string; message: string; detail: string }>>()
    .mockResolvedValue({
      title: "Test Title",
      // Return the generic shell message so classifyForPermission tests can trigger
      message: "Marshal wants to run a terminal command",
      detail: "test detail",
    }),
  truncateMiddle: vi.fn<(s: string) => string>((s: string) => s),
}));

function createAdapter(
  opts: {
    policyDecision?: "approve" | "deny" | "prompt";
    canShowUI?: boolean;
    promptResult?: PromptResult;
    evaluateDetailed?: PolicyEvaluation;
    interactiveAccepted?: boolean;
  } = {},
) {
  const {
    policyDecision = "prompt",
    canShowUI = true,
    promptResult,
    evaluateDetailed,
    interactiveAccepted = true,
  } = opts;

  const mockPolicy = {
    evaluate: vi
      .fn<(r: ApprovalRequest) => "approve" | "deny" | "prompt">()
      .mockReturnValue(policyDecision),
    recordInteractiveOutcome: vi
      .fn<(r: ApprovalRequest, a: PermissionAction, decision: ApprovalDecision) => boolean>()
      .mockReturnValue(interactiveAccepted),
    logInfraFailure: vi.fn<(r: ApprovalRequest, source: string) => void>(),
    // Only present when a test opts in, so the fallback-to-evaluate() path stays
    // exercised by the existing tests (production PermissionPolicy always has it).
    ...(evaluateDetailed
      ? {
          evaluateDetailed: vi
            .fn<(r: ApprovalRequest) => PolicyEvaluation>()
            .mockReturnValue(evaluateDetailed),
        }
      : {}),
  };

  const mockBroker = {
    requestPrompt: vi
      .fn<(r: BrokerRequest) => Promise<PromptResult>>()
      .mockResolvedValue(promptResult ?? { outcome: "resolved", action: "allow" }),
    resolve: vi.fn<(id: string, action: PermissionAction) => boolean>().mockReturnValue(true),
    hasPending: vi.fn<(id: string) => boolean>().mockReturnValue(true),
    reportClassification: vi.fn<(id: string, classification: CommandClassification) => void>(),
    subscribe: vi
      .fn<(listener: Partial<ApprovalListener>) => () => void>()
      .mockReturnValue(() => {}),
    clearSession: vi.fn<(sessionId: string) => void>(),
    drainAll: vi.fn<(action?: PermissionAction) => void>(),
  };

  const mockSessionManager = {
    classifyForPermission: vi
      .fn<(command: string) => Promise<CommandClassification>>()
      .mockResolvedValue({
        explanation: "",
        category: "unknown",
        suggestedPattern: null,
        patternRationale: null,
        source: "fallback",
        guardrailRuleId: null,
      }),
  };

  const adapter = createApprovalCallbackAdapter({
    broker: testDouble<IApprovalBroker>(mockBroker),
    policy: testDouble<IPermissionPolicy>(mockPolicy),
    classifier: testDouble<ICommandClassifier>(mockSessionManager),
    canShowUI: () => canShowUI,
  });

  return { adapter, mockPolicy, mockBroker, mockSessionManager };
}

describe("createApprovalCallbackAdapter", () => {
  it("returns approved when policy evaluates to approve", async () => {
    const { adapter, mockBroker } = createAdapter({ policyDecision: "approve" });
    const result = await adapter(makeRequest({ id: "r1", sessionId: "session-A" }));

    expect(result).toBe("approved");
    expect(mockBroker.requestPrompt).not.toHaveBeenCalled();
  });

  it("returns denied-by-rules when policy evaluates to deny", async () => {
    const { adapter, mockBroker } = createAdapter({ policyDecision: "deny" });
    const result = await adapter(makeRequest({ id: "r1", sessionId: "session-A" }));

    expect(result).toBe("denied-by-rules");
    expect(mockBroker.requestPrompt).not.toHaveBeenCalled();
  });

  it("returns denied-by-policy-with-feedback when evaluateDetailed supplies a deny reason", async () => {
    const { adapter, mockBroker } = createAdapter({
      evaluateDetailed: {
        decision: "deny",
        denyReason: "Blocked by security policy. Do not retry.",
      },
    });
    const result = await adapter(makeRequest({ id: "r1", sessionId: "session-A" }));

    expect(result).toEqual({
      kind: "denied-by-policy-with-feedback",
      feedback: "Blocked by security policy. Do not retry.",
    });
    // Hard policy denies must not surface an approval card.
    expect(mockBroker.requestPrompt).not.toHaveBeenCalled();
  });

  it("falls back to denied-by-rules when a detailed deny has no reason", async () => {
    const { adapter } = createAdapter({
      evaluateDetailed: { decision: "deny" },
    });
    const result = await adapter(makeRequest({ id: "r1", sessionId: "session-A" }));

    expect(result).toBe("denied-by-rules");
  });

  it("approves via evaluateDetailed without prompting", async () => {
    const { adapter, mockBroker } = createAdapter({
      evaluateDetailed: { decision: "approve" },
    });
    const result = await adapter(makeRequest({ id: "r1", sessionId: "session-A" }));

    expect(result).toBe("approved");
    expect(mockBroker.requestPrompt).not.toHaveBeenCalled();
  });

  it("does not emit a permission-card event for allow-all session-state writes", async () => {
    const mockWindow = {
      isDestroyed: vi.fn<() => boolean>().mockReturnValue(false),
      flashFrame: vi.fn<(flag: boolean) => void>(),
      webContents: { send: vi.fn<(channel: string, ...args: unknown[]) => void>() },
    };
    const broker = new ApprovalBroker();
    const manager = new PermissionCardManager({
      getWindow: () => testDouble<import("electron").BrowserWindow>(mockWindow),
      sessionManager: testDouble<SessionManager>({
        getPermissionPromptSessionId: (id: string) => id,
        getWorkspaceRootForSession: () => undefined,
        savePermissionCards: vi.fn<SessionManager["savePermissionCards"]>(),
      }),
    });
    manager.connectBroker(broker);
    const policy = new PermissionPolicy({
      settingsManager: testDouble<SettingsManager>({
        get: () => ({
          autoApprove: { global: false, perServer: {} },
          permissions: {
            autoApproveReadOnly: false,
            allow: [],
            tools: {},
            servers: { filesystem: { enabled: true, autoApprove: false } },
          },
        }),
        update: vi.fn<SettingsManager["update"]>(),
      }),
      getPermissionMode: () => "allow-all",
      workspaceDir: path.join(os.homedir(), ".marshal", "marshal-worktrees", "repo"),
    });
    manager.connectPolicy(policy);
    const classifier = testDouble<ICommandClassifier>({
      classifyForPermission: vi.fn<ICommandClassifier["classifyForPermission"]>(),
    });
    const adapter = createApprovalCallbackAdapter({
      broker,
      policy,
      classifier,
      canShowUI: () => true,
    });

    const reproPath = path.join(
      os.homedir(),
      ".marshal",
      "session-state",
      "ea8155de-1b0a-46a6-91de-7ceaa1e9f710",
      "files",
      "phase0-final-cleanup-artifact-index.rev6.review.json",
    );

    const result = await adapter(
      makeRequest({
        id: "call_y5kv1QItXhwESSQUEa7syB1Y",
        sessionId: "session-A",
        kind: "write",
        toolCallId: "call_y5kv1QItXhwESSQUEa7syB1Y",
        path: reproPath,
        diff: null,
        intention: "Create immutable Rev6 artifact",
        origin: "sdk",
        browserToolName: undefined,
      }),
    );

    expect(result).toBe("approved");
    expect(mockWindow.webContents.send).not.toHaveBeenCalledWith(
      "permissions:cards-changed",
      expect.anything(),
    );
  });

  it("no-window denial stays denied-by-rules even when evaluateDetailed is available", async () => {
    // The no-window gate is a genuine no-approver situation and must keep the
    // user-not-available semantics (denied-by-rules), not a policy feedback.
    const { adapter, mockPolicy } = createAdapter({
      canShowUI: false,
      evaluateDetailed: { decision: "deny", denyReason: "should not be used" },
    });
    const request = makeRequest({ id: "r1", sessionId: "session-A" });
    const result = await adapter(request);

    expect(result).toBe("denied-by-rules");
    expect(mockPolicy.logInfraFailure).toHaveBeenCalledWith(request, "no-window");
  });

  it("denies with no-window when canShowUI returns false", async () => {
    const { adapter, mockPolicy, mockBroker } = createAdapter({ canShowUI: false });
    const request = makeRequest({ id: "r1", sessionId: "session-A" });
    const result = await adapter(request);

    expect(result).toBe("denied-by-rules");
    expect(mockPolicy.logInfraFailure).toHaveBeenCalledWith(request, "no-window");
    expect(mockPolicy.evaluate).not.toHaveBeenCalled();
    expect(mockBroker.requestPrompt).not.toHaveBeenCalled();
  });

  it("calls broker.requestPrompt when policy returns prompt", async () => {
    const { adapter, mockBroker } = createAdapter({
      policyDecision: "prompt",
      promptResult: { outcome: "resolved", action: "allow" },
    });

    await adapter(makeRequest({ id: "r1", sessionId: "session-A" }));
    expect(mockBroker.requestPrompt).toHaveBeenCalledOnce();
  });

  it("returns approved for allow action", async () => {
    const { adapter } = createAdapter({
      promptResult: { outcome: "resolved", action: "allow" },
    });
    expect(await adapter(makeRequest({ id: "r1", sessionId: "session-A" }))).toBe("approved");
  });

  it("denies an approval when the scoped workspace disappears while the card is open", async () => {
    const { adapter } = createAdapter({
      promptResult: { outcome: "resolved", action: "allow" },
      interactiveAccepted: false,
    });
    expect(await adapter(makeRequest({ id: "r1", sessionId: "session-A" }))).toBe(
      "denied-by-rules",
    );
  });

  it("returns approved for allow-session action", async () => {
    const { adapter } = createAdapter({
      promptResult: { outcome: "resolved", action: "allow-session" },
    });
    expect(await adapter(makeRequest({ id: "r1", sessionId: "session-A" }))).toBe("approved");
  });

  it("keeps allow-session SDK result one-time so Marshal can audit scoped repeats", async () => {
    const { adapter } = createAdapter({
      promptResult: { outcome: "resolved", action: "allow-session" },
    });
    const request = makeRequest({
      id: "r1",
      sessionId: "session-A",
      kind: "shell",
      command: "git status",
      commandIdentifiers: ["git"],
    });

    expect(await adapter(request)).toBe("approved");
  });

  it("returns approved for always-allow action", async () => {
    const { adapter } = createAdapter({
      promptResult: { outcome: "resolved", action: "always-allow" },
    });
    expect(await adapter(makeRequest({ id: "r1", sessionId: "session-A" }))).toBe("approved");
  });

  it("returns approved for legacy allow-type action", async () => {
    const { adapter } = createAdapter({
      promptResult: { outcome: "resolved", action: "allow-type" },
    });
    expect(await adapter(makeRequest({ id: "r1", sessionId: "session-A" }))).toBe("approved");
  });

  it("returns approved for legacy allow-all action", async () => {
    const { adapter } = createAdapter({
      promptResult: { outcome: "resolved", action: "allow-all" },
    });
    expect(await adapter(makeRequest({ id: "r1", sessionId: "session-A" }))).toBe("approved");
  });

  it("returns denied-interactively-by-user for deny action", async () => {
    const { adapter } = createAdapter({
      promptResult: { outcome: "resolved", action: "deny" },
    });
    expect(await adapter(makeRequest({ id: "r1", sessionId: "session-A" }))).toBe(
      "denied-interactively-by-user",
    );
  });

  it("calls recordInteractiveOutcome on resolved prompt", async () => {
    const { adapter, mockPolicy } = createAdapter({
      promptResult: { outcome: "resolved", action: "always-allow" },
    });
    const request = makeRequest({ id: "r1", sessionId: "session-A" });

    await adapter(request);

    expect(mockPolicy.recordInteractiveOutcome).toHaveBeenCalledWith(
      request,
      "always-allow",
      "approved",
    );
  });

  it("does NOT call recordInteractiveOutcome when the broker resolves silently (burst defuser)", async () => {
    // Burst defuser path: PermissionCardManager's defuseBurst uses
    // broker.resolveSilent() to settle siblings without writing a misleading
    // user-interactive audit row. The dedicated policy-burst-defuser row is
    // emitted separately via PermissionPolicy.recordAutoResolvedSibling.
    const { adapter, mockPolicy } = createAdapter({
      promptResult: { outcome: "resolved", action: "allow", silent: true },
    });
    const request = makeRequest({ id: "r1", sessionId: "session-A" });

    const result = await adapter(request);

    expect(result).toBe("approved");
    expect(mockPolicy.recordInteractiveOutcome).not.toHaveBeenCalled();
  });

  it("calls logInfraFailure on timeout", async () => {
    const { adapter, mockPolicy } = createAdapter({
      promptResult: { outcome: "timed-out" },
    });
    const request = makeRequest({ id: "r1", sessionId: "session-A" });

    const result = await adapter(request);

    expect(result).toBe("denied-by-rules");
    expect(mockPolicy.logInfraFailure).toHaveBeenCalledWith(request, "timeout");
    expect(mockPolicy.recordInteractiveOutcome).not.toHaveBeenCalled();
  });

  it("passes lean BrokerRequest with identity fields", async () => {
    const { adapter, mockBroker } = createAdapter({
      promptResult: { outcome: "resolved", action: "allow" },
    });
    await adapter(makeRequest({ id: "r1", sessionId: "session-A" }));

    const brokerRequest = mockBroker.requestPrompt.mock.calls[0][0];
    expect(brokerRequest.requestId).toMatch(/^perm-/);
    expect(brokerRequest.sessionId).toBe("session-A");
    expect(brokerRequest.permissionRequest.id).toBe("r1");
    // No presentation fields — formatting is the card manager's job
    expect(brokerRequest).not.toHaveProperty("title");
    expect(brokerRequest).not.toHaveProperty("buttons");
  });

  it("does not pass classification on the initial BrokerRequest (async arrival)", async () => {
    const { adapter, mockBroker, mockSessionManager } = createAdapter({
      promptResult: { outcome: "resolved", action: "allow" },
    });
    mockSessionManager.classifyForPermission.mockResolvedValue({
      explanation: "Downloads dependencies from npm",
      category: "unknown",
      suggestedPattern: null,
      patternRationale: null,
      source: "fallback",
      guardrailRuleId: null,
    });

    await adapter(
      makeRequest({ id: "r1", sessionId: "session-A", kind: "shell", command: "npm install" }),
    );

    const brokerRequest = mockBroker.requestPrompt.mock.calls[0][0];
    // Card must render synchronously — classifier arrives separately via
    // broker.reportClassification so the card doesn't block on LLM latency.
    expect(brokerRequest.classification).toBeUndefined();
  });

  it("reports LLM classification to the broker after the card is shown", async () => {
    const { adapter, mockBroker, mockSessionManager } = createAdapter({
      promptResult: { outcome: "resolved", action: "allow" },
    });
    const classification: CommandClassification = {
      explanation: "Downloads dependencies from npm",
      category: "writes",
      suggestedPattern: "npm install *",
      patternRationale: "install cmd",
      source: "llm",
      guardrailRuleId: null,
    };
    mockSessionManager.classifyForPermission.mockResolvedValue(classification);
    mockBroker.hasPending.mockReturnValue(true);

    await adapter(
      makeRequest({ id: "r1", sessionId: "session-A", kind: "shell", command: "npm install" }),
    );
    // Adapter resolves as soon as the broker Promise does — the background
    // classifier IIFE may still be in-flight. Yield to the event loop so the
    // await chain in the IIFE completes before we assert.
    await new Promise((r) => setTimeout(r, 0));

    expect(mockBroker.reportClassification).toHaveBeenCalledWith(
      expect.stringMatching(/^perm-/),
      classification,
    );
  });

  it("does not await the classifier before requesting the card", async () => {
    const { adapter, mockBroker, mockSessionManager } = createAdapter();
    mockSessionManager.classifyForPermission.mockReturnValue(new Promise(() => {}));
    mockBroker.requestPrompt.mockReturnValue(new Promise(() => {}));

    void adapter(
      makeRequest({ id: "r1", sessionId: "session-A", kind: "shell", command: "npm install" }),
    );
    await Promise.resolve();

    expect(mockBroker.requestPrompt).toHaveBeenCalledOnce();
  });

  it("does not call reportClassification when the card resolved first", async () => {
    const { adapter, mockBroker, mockSessionManager } = createAdapter({
      promptResult: { outcome: "resolved", action: "deny" },
    });
    mockSessionManager.classifyForPermission.mockResolvedValue({
      explanation: "",
      category: "writes",
      suggestedPattern: "npm install *",
      patternRationale: null,
      source: "llm",
      guardrailRuleId: null,
    });
    // Card already gone by the time the classifier resolves.
    mockBroker.hasPending.mockReturnValue(false);

    await adapter(
      makeRequest({ id: "r1", sessionId: "session-A", kind: "shell", command: "npm install" }),
    );

    expect(mockBroker.reportClassification).not.toHaveBeenCalled();
  });

  it("does not pass classification when request has no command text", async () => {
    const { adapter, mockBroker, mockSessionManager } = createAdapter({
      promptResult: { outcome: "resolved", action: "allow" },
    });

    // Empty command means no command text — classifier should not be called
    await adapter(makeRequest({ id: "r1", sessionId: "session-A", kind: "shell", command: "" }));

    const brokerRequest = mockBroker.requestPrompt.mock.calls[0][0];
    expect(brokerRequest.classification).toBeUndefined();
    // Empty command → classifier is never called, so reportClassification stays silent
    expect(mockBroker.reportClassification).not.toHaveBeenCalled();
    expect(mockSessionManager.classifyForPermission).not.toHaveBeenCalled();
  });

  it("does not call classifyForPermission for non-shell requests", async () => {
    const { adapter, mockSessionManager } = createAdapter({
      promptResult: { outcome: "resolved", action: "allow" },
    });

    await adapter(makeRequest({ id: "r1", sessionId: "session-A", kind: "write" }));

    expect(mockSessionManager.classifyForPermission).not.toHaveBeenCalled();
  });

  it("does not call recordInteractiveOutcome when policy auto-approves", async () => {
    const { adapter, mockPolicy } = createAdapter({ policyDecision: "approve" });
    await adapter(makeRequest({ id: "r1", sessionId: "session-A" }));
    expect(mockPolicy.recordInteractiveOutcome).not.toHaveBeenCalled();
  });

  it("does not call recordInteractiveOutcome when policy auto-denies", async () => {
    const { adapter, mockPolicy } = createAdapter({ policyDecision: "deny" });
    await adapter(makeRequest({ id: "r1", sessionId: "session-A" }));
    expect(mockPolicy.recordInteractiveOutcome).not.toHaveBeenCalled();
  });

  it("does not set approvalPattern when guardrails reject the heuristic (e.g. rm)", async () => {
    const { adapter } = createAdapter({
      promptResult: { outcome: "resolved", action: "allow" },
    });
    const request = makeRequest({
      id: "r1",
      sessionId: "session-A",
      command: "rm file.txt",
    });
    await adapter(request);
    // `rm` is a DENY_BINARY — guardrails null the pattern; primary stays undefined.
    expect(request.approvalPattern).toBeUndefined();
  });

  it("sets approvalPattern synchronously from heuristic + guardrails", async () => {
    const { adapter, mockBroker } = createAdapter();
    // Broker never resolves — we observe the pattern as set by the sync
    // heuristic pass BEFORE any classifier result could arrive.
    mockBroker.requestPrompt.mockReturnValue(new Promise(() => {}));
    const request = makeRequest({
      id: "r1",
      sessionId: "session-A",
      command: "git log --oneline",
    });
    void adapter(request);
    await Promise.resolve();

    // `git log --oneline` → heuristic "git log --oneline" (no wildcards, no
    // guardrail hits) — stored as-is for the primary Always-allow action.
    expect(request.approvalPattern).toBe("git log --oneline");
  });
});
