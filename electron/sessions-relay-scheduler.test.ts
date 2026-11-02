import { createHash } from "node:crypto";

/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseRelayAccountId,
  parseRelayConversationId,
  parseRelayProviderId,
  type RelayAddress,
} from "../common/relay-contract";

const m = await vi.hoisted(async () => await import("./test-helpers/session-test-mocks"));
vi.mock("fs", m.fsFactory);
vi.mock("./session-archive", m.sessionArchiveFactory);
vi.mock("child_process", m.childProcessFactory);
vi.mock("electron", m.electronFactory);
vi.mock("@github/copilot-sdk", m.copilotSdkFactory);
vi.mock("./skills", m.skillsFactory);
vi.mock("./cli-path", m.cliPathFactory);
vi.mock("./safe-storage-file");

import * as fs from "fs";

import type { PersistedSession } from "./session-store";
import { SessionManager, type IGoalSessionsEngine, type IGoalSessionsManager } from "./sessions";
import { createTestBackend, SessionTestAccess, testDouble } from "./testing/harness";

const mockedFs = vi.mocked(fs);

beforeEach(() => {
  vi.clearAllMocks();
  mockedFs.existsSync.mockReturnValue(false);
  mockedFs.readdirSync.mockReturnValue([]);
});

describe("SessionManager relay turn scheduling", () => {
  it("allows only one same-session send while the first dispatch is active", async () => {
    const manager = new SessionManager("C:\\Marshal\\workspace", await createTestBackend());
    const access = new SessionTestAccess(manager);
    const gate = deferred<void>();
    let dispatches = 0;
    access.setPerformSendForTest(async () => {
      dispatches += 1;
      await gate.promise;
    });

    const first = manager.sendMessage("session-a", "first");
    await vi.waitFor(() => expect(dispatches).toBe(1));

    await expect(manager.sendMessage("session-a", "second")).rejects.toThrow(
      "Another message or turn is already active for this session",
    );
    expect(dispatches).toBe(1);

    gate.resolve(undefined);
    await first;
  });

  it("cancels and reconciles a busy turn before one interrupt dispatch", async () => {
    const manager = new SessionManager("C:\\Marshal\\workspace", await createTestBackend());
    const access = new SessionTestAccess(manager);
    const order: string[] = [];
    let busy = true;
    vi.spyOn(manager, "isSessionBusy").mockImplementation(() => busy);
    vi.spyOn(manager, "cancelTurn").mockImplementation(async () => {
      order.push("cancel");
      busy = false;
    });
    access.setDoSendAndCollectForTest(async () => {
      order.push("dispatch");
      return { kind: "ok", text: "done" };
    });

    await expect(
      manager.sendAndCollect("interrupt", 5_000, undefined, "session-a", undefined, {
        deliveryMode: "interrupt",
      }),
    ).resolves.toEqual({ kind: "ok", text: "done" });
    expect(order).toEqual(["cancel", "dispatch"]);
  });

  it("preempts an active collector before chaining the interrupt dispatch", async () => {
    const manager = new SessionManager("C:\\Marshal\\workspace", await createTestBackend());
    const access = new SessionTestAccess(manager);
    const firstSendStarted = deferred<void>();
    const releaseFirstSend = deferred<void>();
    const firstSendFinished = deferred<void>();
    const order: string[] = [];
    let busy = false;
    vi.spyOn(manager, "isSessionBusy").mockImplementation(() => busy);
    vi.spyOn(manager, "sendMessage").mockImplementation(async (sessionId, content) => {
      if (content === "active") {
        busy = true;
        firstSendStarted.resolve(undefined);
        await releaseFirstSend.promise;
        firstSendFinished.resolve(undefined);
        return;
      }
      order.push("interrupt-dispatch");
      manager.emitEvent(sessionId, { type: "turn:text-delta", delta: "redirected" });
      manager.emitEvent(sessionId, { type: "turn:idle" });
    });
    vi.spyOn(manager, "cancelTurn").mockImplementation(async (sessionId) => {
      order.push("cancel");
      access.interruptCollectionForTest(sessionId, "interrupted by corrective race test");
      busy = false;
    });

    const active = manager.sendAndCollect("active", 5_000, undefined, "session-a");
    await firstSendStarted.promise;
    const interrupt = manager.sendAndCollect("redirect", 5_000, undefined, "session-a", undefined, {
      deliveryMode: "interrupt",
    });

    await expect(active).rejects.toThrow("interrupted by corrective race test");
    await expect(interrupt).resolves.toEqual({ kind: "ok", text: "redirected" });
    expect(order).toEqual(["cancel", "interrupt-dispatch"]);

    releaseFirstSend.resolve(undefined);
    await firstSendFinished.promise;
  });

  it("activates a new interrupt origin only after the prior relay collector is reconciled", async () => {
    const manager = new SessionManager("C:\\Marshal\\workspace", await createTestBackend());
    const access = new SessionTestAccess(manager);
    const firstSendStarted = deferred<void>();
    const releaseFirstSend = deferred<void>();
    const firstOrigin = {
      providerId: parseRelayProviderId("example-chat"),
      accountId: parseRelayAccountId("default"),
      conversationId: parseRelayConversationId("first"),
    };
    const secondOrigin = {
      providerId: parseRelayProviderId("whatsapp-baileys"),
      accountId: parseRelayAccountId("default"),
      conversationId: parseRelayConversationId("second"),
    };
    let busy = false;
    let firstDispatchOrigin: RelayAddress | undefined;
    let cancellationOrigin: RelayAddress | undefined;
    let secondDispatchOrigin: RelayAddress | undefined;
    vi.spyOn(manager, "isSessionBusy").mockImplementation(() => busy);
    vi.spyOn(manager, "sendMessage").mockImplementation(
      async (sessionId, content, _attachments, options) => {
        await options?.onBackendDispatchStarting?.();
        if (content === "active") {
          busy = true;
          firstDispatchOrigin = manager.getActiveRelayPublicationOrigin(sessionId);
          firstSendStarted.resolve(undefined);
          await releaseFirstSend.promise;
          return;
        }
        secondDispatchOrigin = manager.getActiveRelayPublicationOrigin(sessionId);
        manager.emitEvent(sessionId, { type: "turn:text-delta", delta: "redirected" });
        manager.emitEvent(sessionId, { type: "turn:idle" });
      },
    );
    vi.spyOn(manager, "cancelTurn").mockImplementation(async (sessionId) => {
      cancellationOrigin = manager.getActiveRelayPublicationOrigin(sessionId);
      access.interruptCollectionForTest(sessionId, "interrupted by relay origin race test");
      busy = false;
    });

    const active = manager.sendAndCollect("active", 5_000, undefined, "session-a", undefined, {
      relayOrigin: firstOrigin,
    });
    await firstSendStarted.promise;
    const interrupt = manager.sendAndCollect("redirect", 5_000, undefined, "session-a", undefined, {
      deliveryMode: "interrupt",
      relayOrigin: secondOrigin,
    });

    await expect(active).rejects.toThrow("interrupted by relay origin race test");
    await expect(interrupt).resolves.toEqual({ kind: "ok", text: "redirected" });
    expect(firstDispatchOrigin).toEqual(firstOrigin);
    expect(cancellationOrigin).toEqual(firstOrigin);
    expect(secondDispatchOrigin).toEqual(secondOrigin);
    expect(manager.getActiveRelayPublicationOrigin("session-a")).toBeUndefined();

    releaseFirstSend.resolve(undefined);
  });

  it("forwards the stable control exchange identity to backend send", async () => {
    const backend = await createTestBackend();
    const send = vi.spyOn(backend.sessions, "send").mockResolvedValue(undefined);
    const manager = new SessionManager("C:\\Marshal\\workspace", backend);
    const parent = readinessParent();
    const access = wireReadinessStore(manager, parent);
    access.sessionHandles.set(parent.id, { sessionId: parent.id, backendId: "backend-parent" });

    await manager.sendMessage(parent.id, "resume orchestration", undefined, {
      clientMessageId: "subagent-readiness:parent-1:digest",
      internalControl: {
        kind: "subagent-readiness",
        exchangeId: "subagent-readiness:parent-1:digest",
        side: "request",
      },
    });

    expect(send).toHaveBeenCalledWith(
      parent.id,
      expect.objectContaining({ prompt: "resume orchestration" }),
      {
        localRunId: "subagent-readiness:parent-1:digest",
        idempotencyKey: "subagent-readiness:parent-1:digest",
      },
    );
    access.busyTracker.setIdle(parent.id);
  });

  it("scopes relay publication to the durable origin for the active turn", async () => {
    const manager = new SessionManager("C:\\Marshal\\workspace", await createTestBackend());
    const parent = readinessParent();
    wireReadinessStore(manager, parent);
    const relayOrigin = {
      providerId: parseRelayProviderId("example-chat"),
      accountId: parseRelayAccountId("default"),
      conversationId: parseRelayConversationId("legacy-bot"),
    };
    vi.spyOn(manager, "sendMessage").mockImplementation(
      async (sessionId, _content, _attachments, options) => {
        await options?.onBackendDispatchStarting?.();
        expect(manager.getActiveRelayPublicationOrigin(parent.id)).toEqual(relayOrigin);
        manager.emitEvent(sessionId, {
          type: "turn:message-committed",
          message: {
            id: "relay-origin-message",
            role: "user",
            content: "Continue the choice",
            timestamp: "2026-08-09T01:00:00.000Z",
          },
        });
        manager.emitEvent(sessionId, { type: "turn:text-delta", delta: "published" });
        manager.emitEvent(sessionId, { type: "turn:idle" });
        await options?.onBackendDelivered?.();
      },
    );

    await expect(
      manager.deliverAgentMessage(
        {
          messageId: "relay-origin-message",
          idempotencyKey: "relay-origin-message",
          source: "relay:example-chat:default:legacy-bot:message",
          target: parent.id,
          kind: "relay",
          deliveryMode: "interrupt",
          priority: 100,
          sequence: 1,
          content: "Continue the choice",
          relayOrigin,
          attempts: 1,
          state: "leased",
          acceptedAt: "2026-08-09T01:00:00.000Z",
          updatedAt: "2026-08-09T01:00:00.000Z",
        },
        {
          markBackendAccepted: async () => undefined,
          markBackendDelivered: async () => undefined,
        },
      ),
    ).resolves.toEqual({ state: "processed", response: "published" });
    expect(manager.getActiveRelayPublicationOrigin(parent.id)).toBeUndefined();
  });

  it("retains relay publication scope after collector timeout until backend idle", async () => {
    vi.useFakeTimers();
    const manager = new SessionManager("C:\\Marshal\\workspace", await createTestBackend());
    const relayOrigin = {
      providerId: parseRelayProviderId("example-chat"),
      accountId: parseRelayAccountId("default"),
      conversationId: parseRelayConversationId("legacy-bot"),
    };
    const dispatchStarted = deferred<void>();
    const releaseBackend = deferred<void>();
    vi.spyOn(manager, "sendMessage").mockImplementation(
      async (_sessionId, _content, _attachments, options) => {
        await options?.onBackendDispatchStarting?.();
        dispatchStarted.resolve(undefined);
        await releaseBackend.promise;
      },
    );

    const collecting = manager.sendAndCollect(
      "Run a silent long-lived tool",
      1_000,
      undefined,
      "session-timeout",
      undefined,
      { relayOrigin },
    );
    await dispatchStarted.promise;
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(collecting).resolves.toEqual({ kind: "timeout", text: "" });
    expect(manager.getActiveRelayPublicationOrigin("session-timeout")).toEqual(relayOrigin);
    manager.emitEvent("session-timeout", {
      type: "turn:tools-updated",
      toolCalls: [
        {
          id: "late-tool",
          name: "publishRelayMessage",
          description: "Publishing a late relay reply",
          running: true,
        },
      ],
    });
    expect(manager.getActiveRelayPublicationOrigin("session-timeout")).toEqual(relayOrigin);

    manager.emitEvent("session-timeout", { type: "turn:idle" });
    expect(manager.getActiveRelayPublicationOrigin("session-timeout")).toBeUndefined();
    releaseBackend.resolve(undefined);
    vi.useRealTimers();
  });

  it("consumes a claimed readiness wake after send failure and does not replay it after restart", async () => {
    vi.useFakeTimers();
    const parent = readinessParent();
    const first = new SessionManager("C:\\Marshal\\workspace", await createTestBackend());
    const firstAccess = wireReadinessStore(first, parent);
    firstAccess.pendingParentReadinessWakes.set(
      parent.id,
      new Map([
        [
          "readiness-1",
          {
            readinessMessageId: "readiness-1",
            childSessionId: "child-1",
          },
        ],
      ]),
    );
    vi.spyOn(first, "sendAndCollect").mockImplementation(
      async (_content, _timeout, _onEvent, _sessionId, _attachments, options) => {
        await options?.onBackendDispatchStarting?.();
        throw new Error("backend send failed before acceptance");
      },
    );

    await firstAccess.flushParentReadinessWake(parent.id);
    expect(parent.messages[0]?.agentMessage?.backendDeliveredAt).toBeDefined();
    expect(firstAccess.pendingParentReadinessWakes.has(parent.id)).toBe(false);
    vi.clearAllTimers();

    const restarted = new SessionManager("C:\\Marshal\\workspace", await createTestBackend());
    const restartedAccess = wireReadinessStore(restarted, parent);
    const restartedSend = vi.spyOn(restarted, "sendAndCollect");
    restarted.recoverParentReadinessWakesFromPersistence();
    await vi.runOnlyPendingTimersAsync();
    expect(restartedAccess.pendingParentReadinessWakes.has(parent.id)).toBe(false);
    expect(restartedSend).not.toHaveBeenCalled();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("retries a failed readiness acknowledgement without redispatching the delivered turn", async () => {
    vi.useFakeTimers();
    const parent = readinessParent();
    const manager = new SessionManager("C:\\Marshal\\workspace", await createTestBackend());
    const access = wireReadinessStore(manager, parent);
    access.pendingParentReadinessWakes.set(
      parent.id,
      new Map([
        [
          "readiness-1",
          {
            readinessMessageId: "readiness-1",
            childSessionId: "child-1",
          },
        ],
      ]),
    );
    let saves = 0;
    vi.mocked(access.store.saveSessionData).mockImplementation(() => {
      saves += 1;
      if (saves === 2) throw new Error("ack persistence failed");
    });
    let dispatches = 0;
    vi.spyOn(manager, "sendAndCollect").mockImplementation(
      async (_content, _timeout, _onEvent, _sessionId, _attachments, options) => {
        dispatches += 1;
        await options?.onBackendDispatchStarting?.();
        await options?.onBackendDelivered?.();
        return { kind: "no-response", text: "" };
      },
    );

    await access.flushParentReadinessWake(parent.id);
    expect(dispatches).toBe(1);
    expect(parent.messages[0]?.agentMessage?.backendDeliveredAt).toBeUndefined();
    expect(access.pendingParentReadinessWakes.has(parent.id)).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(dispatches).toBe(1);
    expect(parent.messages[0]?.agentMessage?.backendDeliveredAt).toBeDefined();
    expect(saves).toBe(3);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("reconciles a persisted readiness response without replaying backend execution", async () => {
    vi.useFakeTimers();
    const parent = readinessParent();
    const exchangeId = readinessExchangeId(parent.id, ["readiness-1"]);
    const readiness = parent.messages[0]?.agentMessage;
    if (!readiness) throw new Error("Expected persisted readiness metadata");
    readiness.backendAcceptedAt = "2026-08-08T12:00:01.000Z";
    readiness.readinessDispatchExchangeId = exchangeId;
    parent.messages.push(
      {
        id: exchangeId,
        role: "user",
        content: "hidden readiness request",
        timestamp: "2026-08-08T12:00:01.000Z",
        internalControl: { kind: "subagent-readiness", exchangeId, side: "request" },
      },
      {
        id: "assistant-readiness-result",
        role: "assistant",
        content: "Resumed orchestration",
        timestamp: "2026-08-08T12:00:02.000Z",
        internalControl: { kind: "subagent-readiness", exchangeId, side: "response" },
      },
    );
    const manager = new SessionManager("C:\\Marshal\\workspace", await createTestBackend());
    const access = wireReadinessStore(manager, parent);

    expect(() => manager.recoverParentReadinessWakesFromPersistence()).not.toThrow();

    expect(parent.messages[0]?.agentMessage?.backendDeliveredAt).toBe("2026-08-08T12:00:02.000Z");
    expect(access.pendingParentReadinessWakes.has(parent.id)).toBe(false);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("continues readiness startup recovery when stale-claim persistence fails", async () => {
    vi.useFakeTimers();
    const parent = readinessParent();
    const readiness = parent.messages[0]?.agentMessage;
    if (!readiness) throw new Error("Expected persisted readiness metadata");
    readiness.backendAcceptedAt = "2026-08-08T12:00:01.000Z";
    const manager = new SessionManager("C:\\Marshal\\workspace", await createTestBackend());
    const access = wireReadinessStore(manager, parent);
    vi.mocked(access.store.saveSessionData).mockImplementationOnce(() => {
      throw new Error("session persistence unavailable");
    });

    expect(() => manager.recoverParentReadinessWakesFromPersistence()).not.toThrow();

    expect(parent.messages[0]?.agentMessage?.backendAcceptedAt).toBe("2026-08-08T12:00:01.000Z");
    expect(access.pendingParentReadinessWakes.get(parent.id)?.has("readiness-1")).toBe(true);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("counts transitive child work as active relay progress work", async () => {
    const manager = new SessionManager("C:\\Marshal\\workspace", await createTestBackend());
    vi.spyOn(manager, "listSubagentSessions").mockImplementation((sessionId) => {
      if (sessionId === "parent") {
        return [
          {
            id: "child",
            name: "Child",
            createdAt: "2026-08-08T12:00:00.000Z",
            updatedAt: "2026-08-08T12:00:00.000Z",
            hasUnread: false,
            isActive: true,
            parentSessionId: "parent",
            source: "subagent",
          },
        ];
      }
      return [];
    });
    vi.spyOn(manager, "isSessionBusy").mockImplementation((sessionId) => sessionId === "child");

    expect(manager.isSessionOrDescendantBusy("parent")).toBe(true);
  });

  it("injects the persistent relay reminder only for sessions with active bindings", async () => {
    const manager = new SessionManager("C:\\Marshal\\workspace", await createTestBackend());
    manager.setRelaySessionContextProvider((sessionId) =>
      sessionId === "bound-session"
        ? '<marshal-system-reminder kind="active-relay-access-points">Use publishRelayMessage.</marshal-system-reminder>'
        : "",
    );

    const access = new SessionTestAccess(manager);
    expect(access.withRelaySessionContextForTest("bound-session", "User message")).toContain(
      "publishRelayMessage",
    );
    expect(access.withRelaySessionContextForTest("unbound-session", "User message")).toBe(
      "User message",
    );
  });
});

function deferred<Value>(): {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
} {
  let resolvePromise: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

const READINESS_CHILD_ID = "child-1";

function readinessChild(): PersistedSession {
  return testDouble<PersistedSession>({
    id: READINESS_CHILD_ID,
    name: "Child",
    createdAt: "2026-08-08T12:00:00.000Z",
    updatedAt: "2026-08-08T12:00:00.000Z",
    hasUnread: false,
    isActive: false,
    backendOrigin: "copilot",
    messages: [],
  });
}

function readinessParent(): PersistedSession {
  return testDouble<PersistedSession>({
    id: "parent-1",
    name: "Parent",
    backendOrigin: "copilot",
    createdAt: "2026-08-08T12:00:00.000Z",
    updatedAt: "2026-08-08T12:00:00.000Z",
    hasUnread: false,
    isActive: true,
    messages: [
      {
        id: "readiness-1",
        role: "system",
        content: 'Subagent "Child" is idle and ready for follow-up.',
        timestamp: "2026-08-08T12:00:00.000Z",
        agentMessage: {
          source: "child-1",
          sourceLabel: "Child",
          sourceSessionSource: "subagent",
          kind: "readiness",
          deliveryMode: "queue",
          sequence: 0,
          messageId: "readiness-1",
          idempotencyKey: "readiness-1",
          target: "parent-1",
          attempts: 0,
          state: "processed",
          acceptedAt: "2026-08-08T12:00:00.000Z",
          updatedAt: "2026-08-08T12:00:00.000Z",
          processedAt: "2026-08-08T12:00:00.000Z",
          readinessGeneration: "work-1",
          readinessWakeVersion: 1,
        },
      },
    ],
  });
}

function wireReadinessStore(manager: SessionManager, parent: PersistedSession): SessionTestAccess {
  manager.setGoalIntegration(
    testDouble<IGoalSessionsManager>({ getGoal: () => null }),
    testDouble<IGoalSessionsEngine>({
      start: vi.fn<(sessionId: string) => void>(),
      signalResumeTrigger: vi.fn<(sessionId: string) => void>(),
      isRunning: () => true,
    }),
  );
  const access = new SessionTestAccess(manager);
  const index = {
    sessions: [
      {
        id: parent.id,
        name: parent.name,
        createdAt: parent.createdAt,
        updatedAt: parent.updatedAt,
        hasUnread: false,
        isActive: true,
        backendOrigin: "copilot" as const,
      },
    ],
    activeSessionId: parent.id,
  };
  vi.spyOn(access.store, "loadIndex").mockReturnValue(index);
  vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) =>
    sessionId === parent.id ? parent : sessionId === READINESS_CHILD_ID ? readinessChild() : null,
  );
  vi.spyOn(access.store, "saveSessionData").mockImplementation(() => undefined);
  return access;
}

function readinessExchangeId(parentSessionId: string, readinessIds: readonly string[]): string {
  const digest = createHash("sha256")
    .update([...readinessIds].sort().join("\n"))
    .digest("hex")
    .slice(0, 20);
  return `subagent-readiness:${parentSessionId}:${digest}`;
}
