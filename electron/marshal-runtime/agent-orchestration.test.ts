import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentMessageApiResult,
  SessionMetadata,
  TurnEvent,
} from "../../common/marshal-ipc-contract";
import type { PersistedSession } from "../session-store";
import { testDouble } from "../testing/harness";
import {
  SessionManagerRuntimeAgentAdapter,
  type MarshalRuntimeAgentSessionPort,
} from "./agent-orchestration";
import type { MarshalRuntimeScope } from "./contracts";

const scope: MarshalRuntimeScope = {
  sessionId: "parent-1",
  workspaceName: "Engineering",
};
const timestamp = "2026-08-14T08:00:00.000Z";
const TASK = "Continue as the root planner";
const IDEMPOTENCY_KEY = "reuse-caller";

function metadata(id: string, overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return testDouble<SessionMetadata>({
    id,
    name: id,
    createdAt: timestamp,
    updatedAt: timestamp,
    hasUnread: false,
    isActive: false,
    source: "subagent",
    parentSessionId: scope.sessionId,
    workspaceName: scope.workspaceName,
    ...overrides,
  });
}

function persisted(id: string, overrides: Partial<PersistedSession> = {}): PersistedSession {
  return testDouble<PersistedSession>({
    ...metadata(id),
    messages: [],
    ...overrides,
  });
}

function sessionHarness() {
  const owner = persisted(scope.sessionId, { source: "user" });
  const sessions = new Map<string, PersistedSession>([[owner.id, owner]]);
  const indexed: SessionMetadata[] = [];
  const listeners = new Set<(sessionId: string, event: TurnEvent) => void>();
  let busy = false;
  const sendResult: AgentMessageApiResult = {
    success: true,
    accepted: true,
    messageId: "message-1",
    deliveryState: "accepted",
  };
  const port = {
    getSessionAsync: vi
      .fn<MarshalRuntimeAgentSessionPort["getSessionAsync"]>()
      .mockImplementation(async (id) => sessions.get(id) ?? null),
    listSubagentSessions: vi
      .fn<MarshalRuntimeAgentSessionPort["listSubagentSessions"]>()
      .mockImplementation(() => [...indexed]),
    isSessionBusy: vi
      .fn<MarshalRuntimeAgentSessionPort["isSessionBusy"]>()
      .mockImplementation(() => busy),
    createSubagentSession: vi
      .fn<MarshalRuntimeAgentSessionPort["createSubagentSession"]>()
      .mockRejectedValue(new Error("createSubagentSession should not run")),
    sendMessageToSubagent: vi
      .fn<MarshalRuntimeAgentSessionPort["sendMessageToSubagent"]>()
      .mockResolvedValue(sendResult),
    assignRuntimeAgentRole: vi
      .fn<MarshalRuntimeAgentSessionPort["assignRuntimeAgentRole"]>()
      .mockImplementation(async (sessionId, role) => {
        const session = sessions.get(sessionId);
        if (session) session.runtimeAgentRole = role;
      }),
    sendMessage: vi
      .fn<MarshalRuntimeAgentSessionPort["sendMessage"]>()
      .mockResolvedValue(undefined),
    waitForAgentMessageBackendAccepted: vi
      .fn<MarshalRuntimeAgentSessionPort["waitForAgentMessageBackendAccepted"]>()
      .mockResolvedValue(undefined),
    cancelTurn: vi.fn<MarshalRuntimeAgentSessionPort["cancelTurn"]>().mockResolvedValue(undefined),
    addEventListener: vi
      .fn<MarshalRuntimeAgentSessionPort["addEventListener"]>()
      .mockImplementation((listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
  } satisfies MarshalRuntimeAgentSessionPort;
  return {
    adapter: new SessionManagerRuntimeAgentAdapter(port),
    port,
    sessions,
    listeners,
    setBusy(value: boolean) {
      busy = value;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionManagerRuntimeAgentAdapter.launch", () => {
  describe("Sanity Tests", () => {
    it("adopts the caller session instead of launching a subagent", async () => {
      const { adapter, port } = sessionHarness();

      await expect(
        adapter.launch({
          scope,
          task: TASK,
          idempotencyKey: IDEMPOTENCY_KEY,
          sessionId: scope.sessionId,
          runtimeAgentRole: "swarm",
        }),
      ).resolves.toMatchObject({
        id: scope.sessionId,
        runtimeAgentRole: "swarm",
      });
      expect(port.createSubagentSession).not.toHaveBeenCalled();
      expect(port.assignRuntimeAgentRole).toHaveBeenCalledWith(scope.sessionId, "swarm");
      expect(port.sendMessage).toHaveBeenCalledWith(scope.sessionId, TASK);
      expect(port.sendMessageToSubagent).not.toHaveBeenCalled();
    });
  });

  describe("Error Handling", () => {
    it("rejects when the owner session is unavailable", async () => {
      const { adapter, port } = sessionHarness();
      port.getSessionAsync.mockResolvedValueOnce(null);

      await expect(
        adapter.launch({
          scope,
          task: TASK,
          idempotencyKey: IDEMPOTENCY_KEY,
          sessionId: scope.sessionId,
        }),
      ).rejects.toMatchObject({ code: "permission_denied" });
      expect(port.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe("Edge Cases", () => {
    it("cancels a busy caller session before sending the planner task", async () => {
      const { adapter, port, setBusy } = sessionHarness();
      setBusy(true);

      await adapter.launch({
        scope,
        task: TASK,
        idempotencyKey: IDEMPOTENCY_KEY,
        sessionId: scope.sessionId,
        runtimeAgentRole: "swarm",
      });

      expect(port.cancelTurn).toHaveBeenCalledWith(scope.sessionId);
      expect(port.sendMessage).toHaveBeenCalledWith(scope.sessionId, TASK);
    });
  });
});

describe("SessionManagerRuntimeAgentAdapter.get", () => {
  describe("Sanity Tests", () => {
    it("returns the caller session when the agent id is the owner", async () => {
      const { adapter } = sessionHarness();

      await expect(adapter.get(scope, scope.sessionId)).resolves.toMatchObject({
        id: scope.sessionId,
      });
    });
  });

  describe("Error Handling", () => {
    it("returns null for an unknown child", async () => {
      const { adapter } = sessionHarness();

      await expect(adapter.get(scope, "missing-agent")).resolves.toBeNull();
    });
  });

  describe("Edge Cases", () => {
    it("sends on the caller session without subagent delivery", async () => {
      const { adapter, port } = sessionHarness();

      await expect(
        adapter.send(scope, scope.sessionId, "continue", "queue"),
      ).resolves.toMatchObject({ accepted: true });
      expect(port.sendMessage).toHaveBeenCalledWith(scope.sessionId, "continue");
      expect(port.sendMessageToSubagent).not.toHaveBeenCalled();
    });
  });
});

describe("durable Runtime delegation launch", () => {
  it("rejects native agent launches that bypass a task controller", async () => {
    const { adapter, sessions, port } = sessionHarness();
    sessions.get(scope.sessionId)!.runtimeTaskController = "controller";
    await expect(
      adapter.launch({ scope, task: "bypass", idempotencyKey: "bypass" }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(port.createSubagentSession).not.toHaveBeenCalled();
  });
  it("reuses a persisted delegation session after adapter restart", async () => {
    const { adapter, port, sessions } = sessionHarness();
    const child = persisted("child", { runtimeDelegationId: "delegation-1" });
    sessions.set(child.id, child);
    port.listSubagentSessions.mockReturnValue([child]);
    await expect(
      adapter.launch({
        scope,
        task: "work",
        idempotencyKey: "retry",
        runtimeDelegationId: "delegation-1",
      }),
    ).resolves.toMatchObject({ id: "child" });
    expect(port.createSubagentSession).not.toHaveBeenCalled();
    expect(port.sendMessage).not.toHaveBeenCalled();
  });
});

describe("per-turn execution receipts", () => {
  it("keeps an in-flight wait pinned to its original execution when later messages arrive", async () => {
    const { adapter, port, sessions, listeners, setBusy } = sessionHarness();
    const oldReceipt = {
      executionId: "first",
      sessionId: scope.sessionId,
      transcriptRef: "/session.json",
      model: "actual",
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 4, costUsd: 0.01 },
    };
    const laterReceipt = {
      ...oldReceipt,
      executionId: "later",
      usage: { ...oldReceipt.usage, inputTokens: 999 },
    };
    let current = oldReceipt;
    Object.assign(port, {
      getRuntimeExecutionEvidence: (_id: string, executionId?: string) =>
        executionId === "first" ? oldReceipt : current,
    });
    const session = sessions.get(scope.sessionId)!;
    session.messages.push(
      testDouble({ id: "assistant", role: "assistant", content: "done", timestamp }),
    );
    setBusy(true);
    const pending = adapter.wait(scope, scope.sessionId);
    await vi.waitFor(() => expect(listeners.size).toBe(1));
    current = laterReceipt;
    setBusy(false);
    for (const listener of listeners) listener(scope.sessionId, { type: "turn:idle" });
    await expect(pending).resolves.toMatchObject({
      executionId: "first",
      usage: { inputTokens: 10 },
    });
  });
});

describe("waiting on a turn that failed before replying", () => {
  const FAILURE = "Codex isn't signed in or its sign-in expired.";

  function failedTurnMessages(): PersistedSession["messages"] {
    return [
      testDouble({ id: "task", role: "user", content: "overnight task", timestamp }),
      testDouble({ id: "failure", role: "assistant", content: FAILURE, error: true, timestamp }),
    ];
  }

  it("fails an idle wait with the persisted turn error instead of completing", async () => {
    const { adapter, sessions } = sessionHarness();
    sessions.get(scope.sessionId)!.messages.push(...failedTurnMessages());

    await expect(adapter.wait(scope, scope.sessionId)).rejects.toMatchObject({
      code: "operation_failed",
      message: FAILURE,
    });
  });

  it("fails a wait for a specific message whose reply is the turn error", async () => {
    const { adapter, sessions } = sessionHarness();
    sessions.get(scope.sessionId)!.messages.push(...failedTurnMessages());

    await expect(adapter.wait(scope, scope.sessionId, { messageId: "task" })).rejects.toMatchObject(
      { code: "operation_failed", message: FAILURE },
    );
  });

  it("fails an in-flight wait when the turn settles on an error entry", async () => {
    const { adapter, sessions, listeners, setBusy } = sessionHarness();
    const session = sessions.get(scope.sessionId)!;
    session.messages.push(failedTurnMessages()[0]);
    setBusy(true);
    const pending = adapter.wait(scope, scope.sessionId);
    await vi.waitFor(() => expect(listeners.size).toBe(1));

    session.messages.push(failedTurnMessages()[1]);
    setBusy(false);
    for (const listener of listeners) listener(scope.sessionId, { type: "turn:idle" });

    await expect(pending).rejects.toMatchObject({ code: "operation_failed", message: FAILURE });
  });
});
