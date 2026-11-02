import { describe, expect, test, vi } from "vitest";

import type { GoalFence } from "../common/goal-contract";
import type { AgentMessageState } from "../common/marshal-ipc-contract";
import {
  parseRelayAccountId,
  parseRelayConversationId,
  parseRelayProviderId,
} from "../common/relay-contract";
import {
  type AgentMessageKind,
  type AgentMessageDeliveryResult,
  AgentMessageOutbox,
  type AgentMessageOutboxPersistence,
  buildGoalMessageIdempotencyKey,
  describeAgentMessageSendTime,
  type GoalMessageFenceValidation,
  type GoalMessageFenceValidator,
  type GoalMessageIdentity,
  goalFencesEqual,
  isAgentMessageDeliveryControlError,
  isAgentMessageInfraTimeoutError,
  isUnreadableEncryptedOutboxError,
} from "./agent-message-outbox";

class MemoryPersistence implements AgentMessageOutboxPersistence {
  content: string | null = null;

  async load(): Promise<string | null> {
    return this.content;
  }

  async save(content: string): Promise<void> {
    this.content = content;
  }
}

describe("AgentMessageOutbox", () => {
  test("persists relay origin metadata for scoped continuation publication", async () => {
    const persistence = new MemoryPersistence();
    const first = new AgentMessageOutbox({
      persistence,
      canDeliver: () => false,
      deliver: async () => ({ state: "processed" }),
    });
    await first.start();
    const accepted = await first.enqueue({
      source: "relay:example-chat:default:legacy-bot:request-1",
      target: "session-1",
      kind: "relay",
      content: "Continue the choice",
      relayOrigin: {
        providerId: parseRelayProviderId("example-chat"),
        accountId: parseRelayAccountId("default"),
        conversationId: parseRelayConversationId("legacy-bot"),
      },
    });
    await first.shutdown();

    const restarted = new AgentMessageOutbox({
      persistence,
      canDeliver: () => false,
      deliver: async () => ({ state: "processed" }),
    });
    await restarted.start({ pauseDispatch: true });

    expect(restarted.get(accepted.messageId)?.relayOrigin).toEqual({
      providerId: "example-chat",
      accountId: "default",
      conversationId: "legacy-bot",
    });
    await restarted.shutdown();
  });

  test("persists hidden relay progress control metadata across restart", async () => {
    const persistence = new MemoryPersistence();
    const first = new AgentMessageOutbox({
      persistence,
      deliver: async () => ({ state: "processed" }),
    });
    await first.start({ pauseDispatch: true });
    const accepted = await first.enqueue({
      source: "relay-progress",
      target: "session-a",
      kind: "relay",
      idempotencyKey: "relay-progress:session-a:1",
      content: "Consider a useful progress update.",
      internalControl: {
        kind: "relay-progress",
        exchangeId: "relay-progress:session-a:1",
        side: "request",
      },
    });
    first.stop();

    const restarted = new AgentMessageOutbox({
      persistence,
      deliver: async () => ({ state: "processed" }),
    });
    await restarted.start({ pauseDispatch: true });

    expect(restarted.get(accepted.messageId)?.internalControl).toEqual({
      kind: "relay-progress",
      exchangeId: "relay-progress:session-a:1",
      side: "request",
    });
  });

  test("cancels legacy automatic idle notices and preserves explicit parent messages", async () => {
    const persistence = new MemoryPersistence();
    const first = new AgentMessageOutbox({
      persistence,
      canDeliver: () => false,
      deliver: async () => ({ state: "processed" }),
    });
    await first.start();
    const idle = await first.enqueue({
      source: "child-a",
      target: "parent-a",
      kind: "parent",
      idempotencyKey: "subagent-idle:child-a:2026-07-25T08:00:00.000Z",
      content:
        'Message from subagent Worker (child-a):\n\nSubagent "Worker" (child-a) is idle and ready for follow-up.',
    });
    const multilineIdle = await first.enqueue({
      source: "child-b",
      target: "parent-a",
      kind: "parent",
      idempotencyKey: "subagent-idle:child-b:2026-07-25T08:00:00.000Z",
      content:
        'Message from subagent Multi\nLine (child-b):\n\nSubagent "Multi\nLine" (child-b) is idle and ready for follow-up.',
    });
    const explicit = await first.enqueue({
      source: "child-a",
      sourceLabel: "Worker",
      sourceSessionSource: "subagent",
      target: "parent-a",
      kind: "parent",
      content: "Message from subagent Worker (child-a):\n\nCompleted the requested review.",
    });
    const explicitSameSuffix = await first.enqueue({
      source: "child-a",
      target: "parent-a",
      kind: "parent",
      content:
        "Message from subagent Worker (child-a):\n\nMy conclusion is idle and ready for follow-up.",
    });
    const mismatchedEnvelope = await first.enqueue({
      source: "child-a",
      target: "parent-a",
      kind: "parent",
      content:
        'Message from subagent Worker (child-a):\n\nSubagent "Someone else" (child-b) is idle and ready for follow-up.',
    });
    const explicitExactText = await first.enqueue({
      source: "child-a",
      target: "parent-a",
      kind: "parent",
      content:
        'Message from subagent Worker (child-a):\n\nSubagent "Worker" (child-a) is idle and ready for follow-up.',
    });
    first.stop();

    const restarted = new AgentMessageOutbox({
      persistence,
      canDeliver: () => false,
      deliver: async () => ({ state: "processed" }),
    });
    await restarted.start();

    expect(restarted.get(idle.messageId)?.state).toBe("cancelled");
    expect(restarted.get(multilineIdle.messageId)?.state).toBe("cancelled");
    expect(restarted.get(explicit.messageId)?.state).toBe("pending");
    expect(restarted.get(explicit.messageId)).toMatchObject({
      sourceLabel: "Worker",
      sourceSessionSource: "subagent",
    });
    expect(restarted.get(explicitSameSuffix.messageId)?.state).toBe("pending");
    expect(restarted.get(mismatchedEnvelope.messageId)?.state).toBe("pending");
    expect(restarted.get(explicitExactText.messageId)?.state).toBe("pending");
    restarted.stop();
  });

  test("classifies only unrecoverable encrypted payload errors for quarantine", () => {
    expect(
      isUnreadableEncryptedOutboxError(
        new Error("Unsupported state or unable to authenticate data"),
      ),
    ).toBe(true);
    expect(
      isUnreadableEncryptedOutboxError(new Error("Encrypted file appears truncated or corrupt")),
    ).toBe(true);
    expect(isUnreadableEncryptedOutboxError(new Error("EBUSY: resource busy"))).toBe(false);
  });

  test("restart after a durable pause cannot replay unaccepted automatic prompts but preserves ordinary messages", async () => {
    const persistence = new MemoryPersistence();
    const first = new AgentMessageOutbox({
      persistence,
      canDeliver: () => false,
      deliver: async () => ({ state: "processed" }),
    });
    await first.start();
    const auto = await first.enqueue({
      source: "owner",
      target: "child",
      kind: "subagent",
      content: "old continuation",
      messageId: "runtime-continuation:crash-before-pause-callback",
    });
    const user = await first.enqueue({
      source: "owner",
      target: "child",
      kind: "subagent",
      content: "user instruction",
      messageId: "user-instruction",
    });
    await eventually(() => first.get(user.messageId)?.state === "pending");
    first.stop();
    const delivered: string[] = [];
    const restarted = new AgentMessageOutbox({
      persistence,
      deliver: async (message, context) => {
        await context.markBackendAccepted();
        delivered.push(message.messageId);
        return { state: "processed" };
      },
    });
    await restarted.start();
    await eventually(() => restarted.get(user.messageId)?.state === "processed");
    expect(restarted.get(auto.messageId)?.state).toBe("cancelled");
    expect(delivered).toEqual([user.messageId]);
    restarted.stop();
  });

  test("controller cancellation fences an owned lease before native dispatch", async () => {
    const gate = deferred<void>();
    const nativeDispatch = vi.fn<() => void>();
    const outbox = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      deliver: async (_message, context) => {
        await gate.promise;
        await context.markBackendAccepted();
        nativeDispatch();
        return { state: "processed" };
      },
    });
    await outbox.start();
    const accepted = await outbox.enqueue({
      source: "owner",
      target: "child",
      kind: "subagent",
      content: "automatic",
      messageId: "runtime-continuation:owned",
    });
    await eventually(() => outbox.get(accepted.messageId)?.state === "leased");
    await outbox.cancelBeforeBackendAcceptance(accepted.messageId, "wrong-owner", "child");
    expect(outbox.get(accepted.messageId)?.state).toBe("leased");
    await outbox.cancelBeforeBackendAcceptance(accepted.messageId, "owner", "child");
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(outbox.get(accepted.messageId)?.state).toBe("cancelled");
    expect(nativeDispatch).not.toHaveBeenCalled();
    outbox.stop();
  });

  test("new work on an idle target preempts another target's distant lease timer", async () => {
    vi.useFakeTimers();
    const busyResult = deferred<AgentMessageDeliveryResult>();
    const delivered: string[] = [];
    const outbox = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      maxConcurrentTargets: 2,
      leaseDurationMs: 600_000,
      deliver: async (message, context) => {
        delivered.push(message.target);
        await context.markBackendAccepted();
        return message.target === "busy-reconciler" ? busyResult.promise : { state: "processed" };
      },
    });
    try {
      await outbox.start();
      await outbox.enqueue({
        source: "operator",
        target: "busy-reconciler",
        kind: "parent",
        content: "work",
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(delivered).toEqual(["busy-reconciler"]);
      await outbox.enqueue({
        source: "operator",
        target: "idle-planner",
        kind: "parent",
        content: "checkpoint",
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(delivered).toEqual(["busy-reconciler", "idle-planner"]);
    } finally {
      outbox.stop();
      busyResult.resolve({ state: "processed" });
      vi.useRealTimers();
    }
  });

  test("a delivered prompt's running turn frees its global slot but keeps its target leased", async () => {
    const longTurn = deferred<AgentMessageDeliveryResult>();
    const deliveryGate = deferred<void>();
    const delivered: string[] = [];
    const outbox = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      maxConcurrentTargets: 1,
      deliver: async (message, context) => {
        delivered.push(message.content);
        await context.markBackendAccepted();
        if (message.content === "long child turn") {
          await deliveryGate.promise;
          await context.markBackendDelivered();
          return longTurn.promise;
        }
        await context.markBackendDelivered();
        return { state: "processed" };
      },
    });
    try {
      await outbox.start();
      const long = await outbox.enqueue({
        source: "orchestrator",
        target: "busy-child",
        kind: "subagent",
        content: "long child turn",
      });
      await eventually(() => outbox.get(long.messageId)?.state === "backend-accepted");
      const other = await outbox.enqueue({
        source: "orchestrator",
        target: "idle-child",
        kind: "subagent",
        content: "launch prompt",
      });
      const sameTarget = await outbox.enqueue({
        source: "orchestrator",
        target: "busy-child",
        kind: "subagent",
        content: "follow-up",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(outbox.get(other.messageId)?.state).toBe("pending");

      deliveryGate.resolve();
      await eventually(() => outbox.get(other.messageId)?.state === "processed");
      expect(outbox.get(long.messageId)?.state).toBe("backend-accepted");
      expect(outbox.get(sameTarget.messageId)?.state).toBe("pending");
      expect(delivered).toEqual(["long child turn", "launch prompt"]);

      longTurn.resolve({ state: "processed" });
      await eventually(() => outbox.get(sameTarget.messageId)?.state === "processed");
    } finally {
      outbox.stop();
      deliveryGate.resolve();
      longTurn.resolve({ state: "processed" });
    }
  });

  test("serializes 100 queued messages for one busy target without dropping any", async () => {
    const persistence = new MemoryPersistence();
    let parentBusy = true;
    const delivered: number[] = [];
    let active = 0;
    let maxActive = 0;
    const outbox = new AgentMessageOutbox({
      persistence,
      maxConcurrentTargets: 4,
      retryDelayMs: 5,
      canDeliver: () => !parentBusy,
      deliver: async (message, context) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await context.markBackendAccepted();
        delivered.push(message.sequence);
        active -= 1;
        return { state: "processed" };
      },
    });
    await outbox.start();

    const accepted = [];
    for (let index = 0; index < 100; index++) {
      accepted.push(
        // eslint-disable-next-line no-await-in-loop -- sequence assignment is part of the serialization contract under test
        await outbox.enqueue({
          source: `child-${index}`,
          target: "busy-parent",
          kind: "parent",
          content: `message-${index}`,
        }),
      );
    }

    expect(new Set(accepted.map((item) => item.messageId)).size).toBe(100);
    expect(outbox.list().every((message) => message.state === "pending")).toBe(true);
    parentBusy = false;
    await eventually(() => outbox.list().every((message) => message.state === "processed"));

    expect(maxActive).toBe(1);
    expect(delivered).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
    expect(outbox.list()).toHaveLength(100);
  });

  test("recovers pre-dispatch leases after restart and does not retry ambiguous sends", async () => {
    const persistence = new MemoryPersistence();
    const preDispatchGate = deferred<void>();
    const first = new AgentMessageOutbox({
      persistence,
      deliver: async () => {
        await preDispatchGate.promise;
        return { state: "processed" };
      },
    });
    await first.start();
    const accepted = await first.enqueue({
      source: "child",
      target: "parent",
      kind: "parent",
      content: "durable",
    });
    await eventually(() => first.get(accepted.messageId)?.state === "leased");
    first.stop();

    const delivered: string[] = [];
    const restarted = new AgentMessageOutbox({
      persistence,
      deliver: async (message, context) => {
        await context.markBackendAccepted();
        delivered.push(message.messageId);
        return { state: "processed" };
      },
    });
    await restarted.start();
    await eventually(() => restarted.get(accepted.messageId)?.state === "processed");
    expect(delivered).toEqual([accepted.messageId]);
    preDispatchGate.resolve();

    const ambiguousPersistence = new MemoryPersistence();
    const backendGate = deferred<void>();
    const ambiguous = new AgentMessageOutbox({
      persistence: ambiguousPersistence,
      deliver: async (_message, context) => {
        await context.markBackendAccepted();
        await backendGate.promise;
        return { state: "processed" };
      },
    });
    await ambiguous.start();
    const uncertain = await ambiguous.enqueue({
      source: "child",
      target: "parent",
      kind: "parent",
      content: "possibly delivered",
    });
    await eventually(() => ambiguous.get(uncertain.messageId)?.state === "backend-accepted");
    ambiguous.stop();

    let retried = false;
    const afterCrash = new AgentMessageOutbox({
      persistence: ambiguousPersistence,
      deliver: async () => {
        retried = true;
        return { state: "processed" };
      },
    });
    await afterCrash.start();
    expect(afterCrash.get(uncertain.messageId)?.state).toBe("delivery-unknown");
    expect(retried).toBe(false);
    backendGate.resolve();
  });

  test("caller timeout stops waiting but retains the message for delivery", async () => {
    const persistence = new MemoryPersistence();
    const busyGate = deferred<void>();
    const outbox = new AgentMessageOutbox({
      persistence,
      deliver: async (_message, context) => {
        await busyGate.promise;
        await context.markBackendAccepted();
        return { state: "processed" };
      },
    });
    await outbox.start();
    const accepted = await outbox.enqueue({
      source: "child",
      target: "parent",
      kind: "parent",
      content: "wait for me",
    });

    const timedOut = await outbox.waitForTerminal(accepted.messageId, 1);
    expect(timedOut.timedOut).toBe(true);
    expect(["accepted", "pending", "leased", "backend-accepted"]).toContain(timedOut.message.state);

    busyGate.resolve();
    const completed = await outbox.waitForTerminal(accepted.messageId, 5000);
    expect(completed).toMatchObject({ timedOut: false, message: { state: "processed" } });
  });

  test("returns the stable messageId for repeated idempotency keys", async () => {
    const fence = goalFence();
    const outbox = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      canDeliver: () => false,
      deliver: async () => ({ state: "processed" }),
      goalFenceValidator: {
        validate: (candidate) =>
          goalFencesEqual(candidate, fence) ? { status: "current" } : { status: "stale" },
      },
    });
    await outbox.start();

    const first = await outbox.enqueue({
      source: "child",
      target: "parent",
      kind: "goal-terminal",
      content: "done",
      ...goalTerminalMetadata(fence),
    });
    const duplicate = await outbox.enqueue({
      source: "child",
      target: "parent",
      kind: "goal-terminal",
      content: "duplicate",
      ...goalTerminalMetadata(fence),
    });

    expect(duplicate.messageId).toBe(first.messageId);
    expect(outbox.list()).toHaveLength(1);
    expect(outbox.list()[0].content).toBe("done");
    outbox.stop();
  });

  test("waits for durable backend acceptance and supports duplicate messages", async () => {
    const persistence = new MemoryPersistence();
    const acceptanceSaveStarted = deferred<void>();
    const allowAcceptanceSave = deferred<void>();
    const finishDelivery = deferred<void>();
    persistence.save = async (content) => {
      if (content.includes('"state":"backend-accepted"')) {
        acceptanceSaveStarted.resolve();
        await allowAcceptanceSave.promise;
      }
      persistence.content = content;
    };
    const outbox = new AgentMessageOutbox({
      persistence,
      deliver: async (_message, context) => {
        await context.markBackendAccepted();
        await finishDelivery.promise;
        return { state: "processed" };
      },
    });
    await outbox.start();
    const first = await outbox.enqueue({
      source: "child",
      target: "child",
      kind: "parent",
      idempotencyKey: "parent-message:child:1",
      content: "parent update",
    });
    const duplicate = await outbox.enqueue({
      source: "child",
      target: "child",
      kind: "parent",
      idempotencyKey: "parent-message:child:1",
      content: "duplicate",
    });
    expect(duplicate.messageId).toBe(first.messageId);

    let resolved = false;
    const waiting = outbox.waitForBackendAccepted(duplicate.messageId, 5_000).then((result) => {
      resolved = true;
      return result;
    });
    await acceptanceSaveStarted.promise;
    expect(resolved).toBe(false);

    allowAcceptanceSave.resolve();
    const acceptance = await waiting;
    expect(acceptance).toEqual({
      messageId: first.messageId,
      backendAcceptedAt: expect.any(String),
    });
    expect(JSON.parse(persistence.content ?? "")).toMatchObject({
      messages: [{ messageId: first.messageId, backendAcceptedAt: acceptance.backendAcceptedAt }],
    });
    await expect(outbox.waitForBackendAccepted(first.messageId, 0)).resolves.toEqual(acceptance);

    finishDelivery.resolve();
    await eventually(() => outbox.get(first.messageId)?.state === "processed");
  });

  test("waits for durable backend delivery separately from pre-dispatch acceptance", async () => {
    const persistence = new MemoryPersistence();
    const allowBackendSend = deferred<void>();
    const deliverySaveStarted = deferred<void>();
    const allowDeliverySave = deferred<void>();
    persistence.save = async (content) => {
      if (content.includes('"backendDeliveredAt"')) {
        deliverySaveStarted.resolve();
        await allowDeliverySave.promise;
      }
      persistence.content = content;
    };
    const outbox = new AgentMessageOutbox({
      persistence,
      deliver: async (_message, context) => {
        await context.markBackendAccepted();
        await allowBackendSend.promise;
        await context.markBackendDelivered();
        return { state: "processed" };
      },
    });
    await outbox.start();
    const accepted = await outbox.enqueue({
      source: "child",
      target: "child",
      kind: "parent",
      content: "parent update",
    });

    await expect(outbox.waitForBackendAccepted(accepted.messageId, 5_000)).resolves.toEqual({
      messageId: accepted.messageId,
      backendAcceptedAt: expect.any(String),
    });
    let deliveryResolved = false;
    const delivery = outbox.waitForBackendDelivered(accepted.messageId, 5_000).then((result) => {
      deliveryResolved = true;
      return result;
    });
    await Promise.resolve();
    expect(deliveryResolved).toBe(false);

    allowBackendSend.resolve();
    await deliverySaveStarted.promise;
    expect(deliveryResolved).toBe(false);
    allowDeliverySave.resolve();
    const delivered = await delivery;
    expect(delivered).toEqual({
      messageId: accepted.messageId,
      backendDeliveredAt: expect.any(String),
    });
    expect(JSON.parse(persistence.content ?? "")).toMatchObject({
      messages: [
        {
          messageId: accepted.messageId,
          backendDeliveredAt: delivered.backendDeliveredAt,
        },
      ],
    });
    await expect(outbox.waitForBackendDelivered(accepted.messageId, 0)).resolves.toEqual(delivered);
  });

  test("reports terminal failure and timeout while waiting for backend acceptance", async () => {
    const outbox = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      deliver: async (message) =>
        message.target === "failed"
          ? { state: "dead-letter", error: "target disappeared" }
          : await new Promise(() => {}),
    });
    await outbox.start();
    const failed = await outbox.enqueue({
      source: "child",
      target: "failed",
      kind: "parent",
      content: "cannot deliver",
    });
    await expect(outbox.waitForBackendAccepted(failed.messageId, 5_000)).rejects.toThrow(
      "reached dead-letter before backend acceptance: target disappeared",
    );

    const stalled = await outbox.enqueue({
      source: "child",
      target: "stalled",
      kind: "parent",
      content: "still queued",
    });
    await expect(outbox.waitForBackendAccepted(stalled.messageId, 1)).rejects.toThrow(
      "Timed out waiting for agent message backend acceptance",
    );
    await expect(outbox.waitForBackendDelivered(stalled.messageId, 1)).rejects.toThrow(
      "Timed out waiting for agent message backend delivery",
    );
    expect(outbox.get(stalled.messageId)).toBeDefined();
    outbox.stop();
  });

  test("classifies a backend-acceptance timeout as an infra error", async () => {
    const outbox = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      deliver: async () => await new Promise(() => {}),
    });
    await outbox.start();
    const stalled = await outbox.enqueue({
      source: "child",
      target: "stalled",
      kind: "parent",
      content: "still queued",
    });

    const error = await outbox
      .waitForBackendAccepted(stalled.messageId, 1)
      .catch((caught: unknown) => caught);
    expect(isAgentMessageInfraTimeoutError(error)).toBe(true);
    expect(error).toMatchObject({
      errorClass: "infra",
      stage: "backend-acceptance",
      messageId: stalled.messageId,
    });
    outbox.stop();
  });

  test("classifies a backend-delivery timeout as infra but does not retry it", async () => {
    const outbox = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      deliver: async (_message, context) => {
        await context.markBackendAccepted();
        return await new Promise(() => {});
      },
    });
    await outbox.start();
    const accepted = await outbox.enqueue({
      source: "child",
      target: "child",
      kind: "parent",
      content: "continuation",
    });
    await outbox.waitForBackendAccepted(accepted.messageId, 5_000);

    const startedAt = Date.now();
    const error = await outbox
      .waitForBackendDelivered(accepted.messageId, 5)
      .catch((caught: unknown) => caught);
    expect(isAgentMessageInfraTimeoutError(error)).toBe(true);
    expect(error).toMatchObject({ errorClass: "infra", stage: "backend-delivery" });
    // No retry/backoff schedule applies to delivery timeouts, so this must reject promptly.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    outbox.stop();
  });

  test("retries a stalled backend-acceptance wait and resolves once acceptance lands", async () => {
    const allowAccept = deferred<void>();
    const outbox = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      deliver: async (_message, context) => {
        await allowAccept.promise;
        await context.markBackendAccepted();
        return await new Promise(() => {});
      },
    });
    await outbox.start();
    const accepted = await outbox.enqueue({
      source: "child",
      target: "child",
      kind: "parent",
      content: "continuation",
    });

    const waiting = outbox.waitForBackendAcceptedWithRetry(accepted.messageId, 1, [5, 5, 5]);
    setTimeout(() => allowAccept.resolve(), 10);
    const result = await waiting;
    expect(result).toEqual({
      messageId: accepted.messageId,
      backendAcceptedAt: expect.any(String),
    });
    outbox.stop();
  });

  test("exhausts backend-acceptance retries and surfaces an infra-classified failure", async () => {
    const outbox = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      deliver: async () => await new Promise(() => {}),
    });
    await outbox.start();
    const stalled = await outbox.enqueue({
      source: "child",
      target: "stalled-forever",
      kind: "parent",
      content: "continuation",
    });

    const error = await outbox
      .waitForBackendAcceptedWithRetry(stalled.messageId, 1, [1, 1, 1])
      .catch((caught: unknown) => caught);
    expect(isAgentMessageInfraTimeoutError(error)).toBe(true);
    expect(error).toMatchObject({ errorClass: "infra", stage: "backend-acceptance" });
    outbox.stop();
  });

  test("does not retry a non-timeout backend-acceptance failure", async () => {
    const outbox = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      deliver: async () => ({ state: "dead-letter", error: "target disappeared" }),
    });
    await outbox.start();
    const failed = await outbox.enqueue({
      source: "child",
      target: "failed",
      kind: "parent",
      content: "cannot deliver",
    });

    const startedAt = Date.now();
    await expect(
      outbox.waitForBackendAcceptedWithRetry(failed.messageId, 5_000, [10_000, 30_000, 60_000]),
    ).rejects.toThrow("reached dead-letter before backend acceptance: target disappeared");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    outbox.stop();
  });

  test("a deferred head message cannot be overtaken for the same target", async () => {
    const persistence = new MemoryPersistence();
    let deferHead = true;
    const delivered: number[] = [];
    const outbox = new AgentMessageOutbox({
      persistence,
      retryDelayMs: 5,
      deliver: async (message, context) => {
        if (message.sequence === 1 && deferHead) {
          return { state: "pending", retryAfterMs: 5, attemptConsumed: false };
        }
        await context.markBackendAccepted();
        delivered.push(message.sequence);
        return { state: "processed" };
      },
    });
    await outbox.start();
    await outbox.enqueue({ source: "child-1", target: "parent", kind: "parent", content: "one" });
    await outbox.enqueue({ source: "child-2", target: "parent", kind: "parent", content: "two" });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(delivered).toEqual([]);

    deferHead = false;
    await eventually(() => outbox.list().every((message) => message.state === "processed"));
    expect(delivered).toEqual([1, 2]);
  });

  test("runtime reset retries pre-dispatch leases but quarantines backend-accepted sends", async () => {
    const persistence = new MemoryPersistence();
    const preDispatchGate = deferred<void>();
    const backendGate = deferred<void>();
    const outbox = new AgentMessageOutbox({
      persistence,
      maxConcurrentTargets: 2,
      deliver: async (message, context) => {
        if (message.target === "pre-dispatch") {
          await preDispatchGate.promise;
          return { state: "processed" };
        }
        await context.markBackendAccepted();
        await backendGate.promise;
        return { state: "processed" };
      },
    });
    await outbox.start();
    const retryable = await outbox.enqueue({
      source: "child-1",
      target: "pre-dispatch",
      kind: "parent",
      content: "retry me",
    });
    const ambiguous = await outbox.enqueue({
      source: "child-2",
      target: "backend-accepted",
      kind: "parent",
      content: "do not retry me",
    });
    await eventually(
      () =>
        outbox.get(retryable.messageId)?.state === "leased" &&
        outbox.get(ambiguous.messageId)?.state === "backend-accepted",
    );

    await outbox.recoverAfterRuntimeReset();

    expect(outbox.get(retryable.messageId)?.state).toBe("pending");
    expect(outbox.get(ambiguous.messageId)?.state).toBe("delivery-unknown");
    preDispatchGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(outbox.get(retryable.messageId)?.state).toBe("pending");

    outbox.resumeAfterRuntimeReset();
    await eventually(() => outbox.get(retryable.messageId)?.state === "processed");
    outbox.stop();
    backendGate.resolve();
  });

  test("classifies a late old-runtime delivery callback without reopening terminal work", async () => {
    const deliveryGate = deferred<void>();
    let callbackError: unknown;
    const outbox = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      deliver: async (_message, context) => {
        await context.markBackendAccepted();
        await deliveryGate.promise;
        try {
          await context.markBackendDelivered();
        } catch (error) {
          callbackError = error;
          throw error;
        }
        return { state: "processed" };
      },
    });
    await outbox.start();
    const accepted = await outbox.enqueue({
      source: "child",
      target: "parent",
      kind: "parent",
      content: "old runtime completion",
    });
    await eventually(() => outbox.get(accepted.messageId)?.state === "backend-accepted");

    await outbox.recoverAfterRuntimeReset();
    expect(outbox.get(accepted.messageId)?.state).toBe("delivery-unknown");

    deliveryGate.resolve();
    await eventually(() => callbackError !== undefined);

    expect(isAgentMessageDeliveryControlError(callbackError)).toBe(true);
    expect(outbox.get(accepted.messageId)?.state).toBe("delivery-unknown");
    expect(outbox.get(accepted.messageId)).not.toHaveProperty("backendDeliveredAt");
  });

  test("shutdown waits for an accepted message to finish persisting", async () => {
    const saveGate = deferred<void>();
    const saveStarted = deferred<void>();
    const persistence = new MemoryPersistence();
    persistence.save = async (content) => {
      saveStarted.resolve();
      await saveGate.promise;
      persistence.content = content;
    };
    const outbox = new AgentMessageOutbox({
      persistence,
      canDeliver: () => false,
      deliver: async () => ({ state: "processed" }),
    });
    await outbox.start();

    const enqueue = outbox.enqueue({
      source: "child",
      target: "parent",
      kind: "parent",
      content: "persist before exit",
    });
    await saveStarted.promise;
    const shutdown = outbox.shutdown();
    let shutdownFinished = false;
    void shutdown.then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);

    saveGate.resolve();
    const accepted = await enqueue;
    await shutdown;
    expect(JSON.parse(persistence.content ?? "")).toMatchObject({
      messages: [{ messageId: accepted.messageId, state: "accepted" }],
    });
  });

  test("prunes only terminal messages by age and count", async () => {
    const persistence = new MemoryPersistence();
    let now = Date.parse("2026-07-01T00:00:00.000Z");
    const outbox = new AgentMessageOutbox({
      persistence,
      now: () => now,
      maxTerminalMessages: 1,
      terminalRetentionMs: 1000,
      canDeliver: (message) => message.target !== "busy",
      deliver: async (_message, context) => {
        await context.markBackendAccepted();
        return { state: "processed" };
      },
    });
    await outbox.start();
    const unfinished = await outbox.enqueue({
      source: "child",
      target: "busy",
      kind: "parent",
      content: "keep me",
    });
    const firstTerminal = await outbox.enqueue({
      source: "child",
      target: "first",
      kind: "parent",
      content: "first",
    });
    await eventually(() => outbox.get(firstTerminal.messageId)?.state === "processed");

    now += 2000;
    const newestTerminal = await outbox.enqueue({
      source: "child",
      target: "second",
      kind: "parent",
      content: "second",
    });
    await eventually(() => outbox.get(newestTerminal.messageId)?.state === "processed");

    expect(outbox.get(firstTerminal.messageId)).toBeUndefined();
    expect(outbox.get(unfinished.messageId)?.state).toBe("pending");
    expect(outbox.get(newestTerminal.messageId)?.state).toBe("processed");
  });

  test("prunes expired terminal records during startup without new traffic", async () => {
    const persistence = new MemoryPersistence();
    const acceptedAt = "2026-06-01T00:00:00.000Z";
    persistence.content = JSON.stringify({
      version: 1,
      nextSequence: 3,
      messages: [
        persistedMessage({
          messageId: "finished",
          idempotencyKey: "finished",
          target: "done-target",
          sequence: 1,
          state: "processed",
          acceptedAt,
          updatedAt: acceptedAt,
          processedAt: acceptedAt,
        }),
        persistedMessage({
          messageId: "unfinished",
          idempotencyKey: "unfinished",
          target: "busy-target",
          sequence: 2,
          state: "pending",
          acceptedAt,
          updatedAt: acceptedAt,
        }),
      ],
    });
    const outbox = new AgentMessageOutbox({
      persistence,
      now: () => Date.parse("2026-07-01T00:00:00.000Z"),
      terminalRetentionMs: 1000,
      canDeliver: () => false,
      deliver: async () => ({ state: "processed" }),
    });

    await outbox.start();

    expect(outbox.get("finished")).toBeUndefined();
    expect(outbox.get("unfinished")?.state).toBe("pending");
    expect(JSON.parse(persistence.content ?? "").messages).toHaveLength(1);
  });

  test("retries a failed result write without repeating the backend side effect", async () => {
    const persistence = new MemoryPersistence();
    let failedResultWrite = false;
    persistence.save = async (content) => {
      if (!failedResultWrite && content.includes('"state":"processed"')) {
        failedResultWrite = true;
        throw new Error("transient write failure");
      }
      persistence.content = content;
    };
    let deliveries = 0;
    const outbox = new AgentMessageOutbox({
      persistence,
      retryDelayMs: 1,
      deliver: async (_message, context) => {
        deliveries += 1;
        await context.markBackendAccepted();
        return { state: "processed" };
      },
    });
    await outbox.start();
    const accepted = await outbox.enqueue({
      source: "child",
      target: "parent",
      kind: "parent",
      content: "exactly once side effect",
    });

    await eventually(() => outbox.get(accepted.messageId)?.state === "processed");

    expect(failedResultWrite).toBe(true);
    expect(deliveries).toBe(1);
    expect(JSON.parse(persistence.content ?? "")).toMatchObject({
      messages: [{ messageId: accepted.messageId, state: "processed" }],
    });
  });

  test("recovers an expired pre-dispatch lease without allowing the stale sender through", async () => {
    const firstDispatchGate = deferred<void>();
    let deliveryCalls = 0;
    let backendSideEffects = 0;
    const outbox = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      leaseDurationMs: 10,
      retryDelayMs: 1,
      deliver: async (_message, context) => {
        deliveryCalls += 1;
        if (deliveryCalls === 1) await firstDispatchGate.promise;
        await context.markBackendAccepted();
        backendSideEffects += 1;
        return { state: "processed" };
      },
    });
    await outbox.start();
    const accepted = await outbox.enqueue({
      source: "child",
      target: "parent",
      kind: "parent",
      content: "recover my lease",
    });

    await eventually(() => outbox.get(accepted.messageId)?.state === "processed");
    firstDispatchGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(deliveryCalls).toBe(2);
    expect(backendSideEffects).toBe(1);
    expect(outbox.get(accepted.messageId)?.state).toBe("processed");
  });

  test("terminalizes an expired backend-accepted lease as delivery-unknown", async () => {
    const deliveryGate = deferred<void>();
    const outbox = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      leaseDurationMs: 10,
      deliver: async (_message, context) => {
        await context.markBackendAccepted();
        await deliveryGate.promise;
        return { state: "processed" };
      },
    });
    await outbox.start();
    const accepted = await outbox.enqueue({
      source: "child",
      target: "parent",
      kind: "parent",
      content: "ambiguous after timeout",
    });

    await eventually(() => outbox.get(accepted.messageId)?.state === "delivery-unknown");
    deliveryGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(outbox.get(accepted.messageId)?.state).toBe("delivery-unknown");
  });

  test("stays paused until overlapping runtime resets have both resumed", async () => {
    let deliveries = 0;
    const outbox = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      deliver: async (_message, context) => {
        deliveries += 1;
        await context.markBackendAccepted();
        return { state: "processed" };
      },
    });
    await outbox.start();
    await outbox.recoverAfterRuntimeReset();
    await outbox.recoverAfterRuntimeReset();
    const accepted = await outbox.enqueue({
      source: "child",
      target: "parent",
      kind: "parent",
      content: "wait for both resets",
    });

    outbox.resumeAfterRuntimeReset();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deliveries).toBe(0);

    outbox.resumeAfterRuntimeReset();
    await eventually(() => outbox.get(accepted.messageId)?.state === "processed");
    expect(deliveries).toBe(1);
  });

  test("restores the startup pause after a runtime reset", async () => {
    let deliveries = 0;
    const outbox = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      deliver: async (_message, context) => {
        deliveries += 1;
        await context.markBackendAccepted();
        return { state: "processed" };
      },
    });
    await outbox.start({ pauseDispatch: true });
    await outbox.recoverAfterRuntimeReset();
    const accepted = await outbox.enqueue({
      source: "child",
      target: "parent",
      kind: "parent",
      content: "wait for startup readiness",
    });

    outbox.resumeAfterRuntimeReset();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deliveries).toBe(0);

    outbox.resumeAfterRuntimeReset();
    await eventually(() => outbox.get(accepted.messageId)?.state === "processed");
    expect(deliveries).toBe(1);
  });

  test("persists an exact defensive goal fence before restart delivery", async () => {
    const persistence = new MemoryPersistence();
    const fence = goalFence();
    const first = new AgentMessageOutbox({
      persistence,
      deliver: async () => ({ state: "processed" }),
      goalFenceValidator: currentFenceValidator(() => fence),
    });
    await first.start({ pauseDispatch: true });
    const inputFence = { ...fence };
    const accepted = await first.enqueue({
      source: "child",
      target: "parent",
      kind: "goal-terminal",
      content: "completed",
      ...goalTerminalMetadata(inputFence),
    });
    inputFence.epoch = 2;

    expect(JSON.parse(persistence.content ?? "")).toMatchObject({
      messages: [
        {
          messageId: accepted.messageId,
          goalFence: fence,
          goalId: fence.goalId,
          goalDeliveryKind: "terminal",
          goalTerminalKind: "completed",
          goalDeliverySequence: 1,
        },
      ],
    });
    const clone = first.get(accepted.messageId);
    if (!clone?.goalFence) throw new Error("Expected persisted goal fence");
    Object.assign(clone.goalFence, { epoch: 3 });
    expect(first.get(accepted.messageId)?.goalFence).toEqual(fence);
    await first.shutdown();

    const delivered: GoalFence[] = [];
    const restarted = new AgentMessageOutbox({
      persistence,
      goalFenceValidator: currentFenceValidator(() => fence),
      deliver: async (message, context) => {
        if (message.goalFence) delivered.push({ ...message.goalFence });
        await context.markBackendAccepted();
        return { state: "processed" };
      },
    });
    await restarted.start();
    await eventually(() => restarted.get(accepted.messageId)?.state === "processed");

    expect(delivered).toEqual([fence]);
  });

  test("cancels a stale epoch before delivery", async () => {
    const staleFence = goalFence();
    const currentFence = goalFence({ epoch: 2 });
    let deliveries = 0;
    const outbox = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      goalFenceValidator: currentFenceValidator(() => currentFence),
      deliver: async () => {
        deliveries += 1;
        return { state: "processed" };
      },
    });
    await outbox.start();

    const accepted = await outbox.enqueue({
      source: "child",
      target: "parent",
      kind: "goal-terminal",
      content: "stale terminal",
      ...goalTerminalMetadata(staleFence),
    });

    expect(accepted.state).toBe("cancelled");
    expect(outbox.get(accepted.messageId)).toMatchObject({
      state: "cancelled",
      goalFence: staleFence,
      lastError: expect.stringContaining("stale"),
    });
    expect(deliveries).toBe(0);
  });

  test("cancels a revoked fence without invoking delivery", async () => {
    let deliveries = 0;
    const outbox = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      goalFenceValidator: {
        validate: () => ({ status: "revoked", reason: "lifecycle_revoked" }),
      },
      deliver: async () => {
        deliveries += 1;
        return { state: "processed" };
      },
    });
    await outbox.start();

    const accepted = await outbox.enqueue({
      source: "child",
      target: "parent",
      kind: "goal-terminal",
      content: "revoked terminal",
      ...goalTerminalMetadata(goalFence()),
    });

    expect(accepted).toMatchObject({ state: "cancelled", goalFenceStatus: "revoked" });
    expect(outbox.get(accepted.messageId)?.lastError).toContain("lifecycle_revoked");
    expect(deliveries).toBe(0);
  });

  test("cancels when the goal fence changes during an awaited backend send", async () => {
    const firstFence = goalFence();
    let currentFence = firstFence;
    const sendGate = deferred<void>();
    const outbox = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      goalFenceValidator: currentFenceValidator(() => currentFence),
      deliver: async (_message, context) => {
        await context.markBackendAccepted();
        await sendGate.promise;
        return { state: "processed" };
      },
    });
    await outbox.start();
    const accepted = await outbox.enqueue({
      source: "child",
      target: "parent",
      kind: "goal-terminal",
      content: "terminal",
      ...goalTerminalMetadata(firstFence),
    });
    await eventually(() => outbox.get(accepted.messageId)?.state === "backend-accepted");

    currentFence = goalFence({ epoch: 2 });
    sendGate.resolve();
    await eventually(() => outbox.get(accepted.messageId)?.state === "delivery-unknown");

    const message = outbox.get(accepted.messageId);
    expect(message?.state).toBe("delivery-unknown");
    expect(message).not.toHaveProperty("backendAcceptedAt");
    expect(message).not.toHaveProperty("processedAt");
    expect(message).not.toHaveProperty("response");
  });

  test("revalidates a durable lease before invoking delivery", async () => {
    const persistence = new MemoryPersistence();
    const leaseSaveStarted = deferred<void>();
    const allowLeaseSave = deferred<void>();
    let gated = false;
    persistence.save = async (content) => {
      if (!gated && content.includes('"state":"leased"')) {
        gated = true;
        leaseSaveStarted.resolve();
        await allowLeaseSave.promise;
      }
      persistence.content = content;
    };
    const fence = goalFence();
    let currentFence = fence;
    let deliveries = 0;
    const outbox = new AgentMessageOutbox({
      persistence,
      goalFenceValidator: currentFenceValidator(() => currentFence),
      deliver: async () => {
        deliveries += 1;
        return { state: "processed" };
      },
    });
    await outbox.start();
    const accepted = await outbox.enqueue({
      source: "child",
      target: "parent",
      kind: "goal-terminal",
      content: "terminal",
      ...goalTerminalMetadata(fence),
    });
    await leaseSaveStarted.promise;

    currentFence = goalFence({ epoch: 2 });
    allowLeaseSave.resolve();
    await eventually(() => outbox.getDiagnostic(accepted.messageId)?.state === "cancelled");

    expect(deliveries).toBe(0);
    expect(await outbox.listCurrent({ goalFence: fence })).toEqual([]);
  });

  test("serializes cancel versus lease without delivering a cancelled record", async () => {
    const persistence = new MemoryPersistence();
    const leaseSaveStarted = deferred<void>();
    const allowLeaseSave = deferred<void>();
    const deliveryGate = deferred<void>();
    let gated = false;
    persistence.save = async (content) => {
      if (!gated && content.includes('"state":"leased"')) {
        gated = true;
        leaseSaveStarted.resolve();
        await allowLeaseSave.promise;
      }
      persistence.content = content;
    };
    const fence = goalFence();
    let deliveries = 0;
    const outbox = new AgentMessageOutbox({
      persistence,
      goalFenceValidator: currentFenceValidator(() => fence),
      deliver: async () => {
        deliveries += 1;
        await deliveryGate.promise;
        return { state: "processed" };
      },
    });
    await outbox.start();
    const accepted = await outbox.enqueue({
      source: "child",
      target: "parent",
      kind: "goal-terminal",
      content: "terminal",
      ...goalTerminalMetadata(fence),
    });
    await leaseSaveStarted.promise;

    const cancellation = outbox.cancel(accepted.messageId);
    allowLeaseSave.resolve();
    await expect(cancellation).rejects.toThrow(
      "Cannot cancel agent message after delivery started",
    );
    await eventually(() => deliveries === 1);

    outbox.stop();
    deliveryGate.resolve();

    const secondFence = { ...fence, epoch: 2 };
    const cancelledBeforeLease = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      canDeliver: () => false,
      goalFenceValidator: currentFenceValidator(() => secondFence),
      deliver: async () => {
        deliveries += 1;
        return { state: "processed" };
      },
    });
    await cancelledBeforeLease.start();
    const pending = await cancelledBeforeLease.enqueue({
      source: "child",
      target: "parent",
      kind: "goal-terminal",
      content: "cancel first",
      ...goalTerminalMetadata(secondFence),
    });
    await eventually(
      () => cancelledBeforeLease.getDiagnostic(pending.messageId)?.state === "pending",
    );
    await cancelledBeforeLease.cancel(pending.messageId);

    expect(cancelledBeforeLease.getDiagnostic(pending.messageId)?.state).toBe("cancelled");
    expect(deliveries).toBe(1);
  });

  test.each(["unknown", "stale"] as const)(
    "explicit cancel remains terminal when the validator is %s across restart",
    async (status) => {
      const persistence = new MemoryPersistence();
      const fence = goalFence();
      let fenceStatus: GoalMessageFenceValidation["status"] = "current";
      const validator: GoalMessageFenceValidator = {
        validate: () =>
          fenceStatus === "current" ? { status: "current" } : { status: fenceStatus },
      };
      const first = new AgentMessageOutbox({
        persistence,
        canDeliver: () => false,
        goalFenceValidator: validator,
        deliver: async () => ({ state: "processed" }),
      });
      await first.start();
      const accepted = await first.enqueue({
        source: "child",
        target: "parent",
        kind: "goal-terminal",
        content: "cancel me",
        ...goalTerminalMetadata(fence),
      });
      await eventually(() => first.getDiagnostic(accepted.messageId)?.state === "pending");

      fenceStatus = status;
      await first.cancel(accepted.messageId);
      expect(first.getDiagnostic(accepted.messageId)?.state).toBe("cancelled");
      await first.shutdown();

      const restarted = new AgentMessageOutbox({
        persistence,
        canDeliver: () => false,
        goalFenceValidator: validator,
        deliver: async () => ({ state: "processed" }),
      });
      await restarted.start();

      expect(restarted.getDiagnostic(accepted.messageId)?.state).toBe("cancelled");
    },
  );

  test.each([
    ["unknown", "pending"],
    ["stale", "cancelled"],
  ] as const)(
    "accepted-to-pending save revalidates %s before notify or dispatch",
    async (status, expectedState) => {
      const persistence = new MemoryPersistence();
      const promotionSaveStarted = deferred<void>();
      const allowPromotionSave = deferred<void>();
      let gated = false;
      persistence.save = async (content) => {
        if (!gated && content.includes('"state":"pending"')) {
          gated = true;
          promotionSaveStarted.resolve();
          await allowPromotionSave.promise;
        }
        persistence.content = content;
      };
      const fence = goalFence();
      let fenceStatus: GoalMessageFenceValidation["status"] = "current";
      let deliveries = 0;
      const outbox = new AgentMessageOutbox({
        persistence,
        canDeliver: () => false,
        goalFenceValidator: {
          validate: () =>
            fenceStatus === "current" ? { status: "current" } : { status: fenceStatus },
        },
        deliver: async () => {
          deliveries += 1;
          return { state: "processed" };
        },
      });
      await outbox.start();
      const accepted = await outbox.enqueue({
        source: "child",
        target: "parent",
        kind: "goal-terminal",
        content: "promote me",
        ...goalTerminalMetadata(fence),
      });
      await promotionSaveStarted.promise;

      fenceStatus = status;
      allowPromotionSave.resolve();
      await eventually(() => outbox.getDiagnostic(accepted.messageId)?.state === expectedState);

      expect(deliveries).toBe(0);
      let waited: Awaited<ReturnType<typeof outbox.waitForTerminal>> | undefined;
      let current: Awaited<ReturnType<typeof outbox.listCurrent>> | undefined;
      if (status === "unknown") {
        waited = await outbox.waitForTerminal(accepted.messageId, 1);
      } else {
        current = await outbox.listCurrent({ goalFence: fence });
      }
      expect(waited?.timedOut).toBe(status === "unknown" ? true : undefined);
      expect(waited?.message.state).toBe(status === "unknown" ? "pending" : undefined);
      expect(current).toEqual(status === "unknown" ? undefined : []);
    },
  );

  test("revalidates durable backend acceptance before resolving its waiter", async () => {
    const persistence = new MemoryPersistence();
    const acceptanceSaveStarted = deferred<void>();
    const allowAcceptanceSave = deferred<void>();
    let gated = false;
    persistence.save = async (content) => {
      if (!gated && content.includes('"state":"backend-accepted"')) {
        gated = true;
        acceptanceSaveStarted.resolve();
        await allowAcceptanceSave.promise;
      }
      persistence.content = content;
    };
    const fence = goalFence();
    let currentFence = fence;
    let externalActions = 0;
    const outbox = new AgentMessageOutbox({
      persistence,
      goalFenceValidator: currentFenceValidator(() => currentFence),
      deliver: async (_message, context) => {
        await context.markBackendAccepted();
        externalActions += 1;
        return { state: "processed" };
      },
    });
    await outbox.start();
    const accepted = await outbox.enqueue({
      source: "child",
      target: "parent",
      kind: "goal-terminal",
      content: "terminal",
      ...goalTerminalMetadata(fence),
    });
    const waiter = outbox.waitForBackendAccepted(accepted.messageId, 5_000);
    await acceptanceSaveStarted.promise;

    currentFence = goalFence({ epoch: 2 });
    allowAcceptanceSave.resolve();
    await expect(waiter).rejects.toThrow("before backend acceptance");

    expect(externalActions).toBe(0);
    const message = outbox.getDiagnostic(accepted.messageId);
    expect(message?.state).toBe("cancelled");
    expect(message).not.toHaveProperty("backendAcceptedAt");
  });

  test("revalidates durable backend delivery before resolving its waiter", async () => {
    const persistence = new MemoryPersistence();
    const deliverySaveStarted = deferred<void>();
    const allowDeliverySave = deferred<void>();
    let gated = false;
    persistence.save = async (content) => {
      if (!gated && content.includes('"backendDeliveredAt"')) {
        gated = true;
        deliverySaveStarted.resolve();
        await allowDeliverySave.promise;
      }
      persistence.content = content;
    };
    const fence = goalFence();
    let currentFence = fence;
    let externalActions = 0;
    const outbox = new AgentMessageOutbox({
      persistence,
      goalFenceValidator: currentFenceValidator(() => currentFence),
      deliver: async (_message, context) => {
        await context.markBackendAccepted();
        externalActions += 1;
        await context.markBackendDelivered();
        return { state: "processed" };
      },
    });
    await outbox.start();
    const accepted = await outbox.enqueue({
      source: "child",
      target: "parent",
      kind: "goal-terminal",
      content: "terminal",
      ...goalTerminalMetadata(fence),
    });
    const waiter = outbox.waitForBackendDelivered(accepted.messageId, 5_000);
    await deliverySaveStarted.promise;

    currentFence = goalFence({ epoch: 2 });
    allowDeliverySave.resolve();
    await expect(waiter).rejects.toThrow("before backend delivery");

    expect(externalActions).toBe(1);
    const message = outbox.getDiagnostic(accepted.messageId);
    expect(message?.state).toBe("delivery-unknown");
    expect(message).not.toHaveProperty("backendAcceptedAt");
    expect(message).not.toHaveProperty("backendDeliveredAt");
    expect(message).not.toHaveProperty("processedAt");
  });

  test("revalidates a durable processed result before notifying terminal waiters", async () => {
    const persistence = new MemoryPersistence();
    const resultSaveStarted = deferred<void>();
    const allowResultSave = deferred<void>();
    let gated = false;
    persistence.save = async (content) => {
      if (!gated && content.includes('"state":"processed"')) {
        gated = true;
        resultSaveStarted.resolve();
        await allowResultSave.promise;
      }
      persistence.content = content;
    };
    const fence = goalFence();
    let currentFence = fence;
    let externalActions = 0;
    const outbox = new AgentMessageOutbox({
      persistence,
      goalFenceValidator: currentFenceValidator(() => currentFence),
      deliver: async (_message, context) => {
        await context.markBackendAccepted();
        externalActions += 1;
        return { state: "processed", response: "success" };
      },
    });
    await outbox.start();
    const accepted = await outbox.enqueue({
      source: "child",
      target: "parent",
      kind: "goal-terminal",
      content: "terminal",
      ...goalTerminalMetadata(fence),
    });
    const waiter = outbox.waitForTerminal(accepted.messageId, 5_000);
    await resultSaveStarted.promise;

    currentFence = goalFence({ epoch: 2 });
    allowResultSave.resolve();
    const terminal = await waiter;

    expect(externalActions).toBe(1);
    expect(terminal.message.state).toBe("delivery-unknown");
    expect(terminal.message).not.toHaveProperty("processedAt");
    expect(terminal.message).not.toHaveProperty("response");
    expect(await outbox.getCurrent(accepted.messageId, fence)).toBeUndefined();
  });

  test("denies legacy unfenced goal terminal and review messages", async () => {
    const persistence = new MemoryPersistence();
    persistence.content = JSON.stringify({
      version: 1,
      nextSequence: 3,
      messages: [
        persistedMessage({
          kind: "goal-terminal",
          idempotencyKey: "legacy-goal-terminal",
        }),
        persistedMessage({
          messageId: "legacy-review",
          idempotencyKey: "legacy-review",
          kind: "review-comment",
          sequence: 2,
        }),
      ],
    });
    let deliveries = 0;
    const outbox = new AgentMessageOutbox({
      persistence,
      goalFenceValidator: currentFenceValidator(() => goalFence()),
      deliver: async () => {
        deliveries += 1;
        return { state: "processed" };
      },
    });

    await outbox.start();

    expect(outbox.get("message")).toMatchObject({
      state: "cancelled",
      lastError: expect.stringContaining("untrusted"),
    });
    expect(outbox.get("legacy-review")).toMatchObject({
      state: "cancelled",
      lastError: expect.stringContaining("untrusted"),
    });
    expect(deliveries).toBe(0);
    await expect(
      outbox.enqueue({
        source: "child",
        target: "parent",
        kind: "goal-terminal",
        content: "legacy runtime terminal",
      }),
    ).rejects.toThrow("no trusted goal fence");
    await expect(
      outbox.enqueue({
        source: "reviewer",
        target: "goal-session",
        kind: "review-comment",
        content: "legacy runtime review",
      }),
    ).rejects.toThrow("no trusted goal fence");
  });

  test("keeps non-goal enqueue and delivery behavior unchanged without a fence validator", async () => {
    const delivered: string[] = [];
    const outbox = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      deliver: async (message, context) => {
        await context.markBackendAccepted();
        delivered.push(message.content);
        return { state: "processed" };
      },
    });
    await outbox.start();

    const accepted = await outbox.enqueue({
      source: "child",
      target: "parent",
      kind: "parent",
      content: "ordinary message",
    });
    const subagent = await outbox.enqueue({
      source: "parent",
      target: "child",
      kind: "subagent",
      content: "ordinary subagent message",
    });
    await eventually(
      () =>
        outbox.get(accepted.messageId)?.state === "processed" &&
        outbox.get(subagent.messageId)?.state === "processed",
    );

    expect(delivered).toEqual(["ordinary message", "ordinary subagent message"]);
    expect(outbox.get(accepted.messageId)?.goalFence).toBeUndefined();
    expect(outbox.get(subagent.messageId)?.goalFence).toBeUndefined();
  });

  test("uses the fence, terminal kind, and sequence for duplicate prevention", async () => {
    const fence = goalFence();
    const outbox = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      canDeliver: () => false,
      goalFenceValidator: { validate: () => ({ status: "current" }) },
      deliver: async () => ({ state: "processed" }),
    });
    await outbox.start();
    const firstInput = {
      source: "child",
      target: "parent",
      kind: "goal-terminal" as const,
      content: "done",
      ...goalTerminalMetadata(fence),
    };

    const first = await outbox.enqueue(firstInput);
    const duplicate = await outbox.enqueue({ ...firstInput, content: "duplicate" });
    const revised = await outbox.enqueue({
      ...firstInput,
      content: "revised",
      ...goalTerminalMetadata(
        goalFence({
          epoch: 2,
        }),
      ),
    });
    const blocked = await outbox.enqueue({
      ...firstInput,
      content: "blocked",
      goalTerminalKind: "blocked",
    });
    const nextSequence = await outbox.enqueue({
      ...firstInput,
      content: "next terminal",
      goalDeliverySequence: 2,
    });

    expect(duplicate.messageId).toBe(first.messageId);
    expect(
      new Set([first.messageId, revised.messageId, blocked.messageId, nextSequence.messageId]).size,
    ).toBe(4);
    expect(outbox.get(first.messageId)?.idempotencyKey).toBe(
      buildGoalMessageIdempotencyKey(goalTerminalMetadata(fence)),
    );
  });

  test("goalId and epoch independently prevent idempotency collapse", async () => {
    const baseFence = goalFence();
    const differentGoalFence = goalFence({ goalId: "goal-2" });
    const differentEpochFence = goalFence({ epoch: 2 });
    const identities = [
      goalTerminalMetadata(baseFence),
      goalTerminalMetadata(differentGoalFence),
      goalTerminalMetadata(differentEpochFence),
    ];
    const keys = identities.map(buildGoalMessageIdempotencyKey);
    expect(new Set(keys).size).toBe(3);

    const outbox = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      canDeliver: () => false,
      goalFenceValidator: { validate: () => ({ status: "current" }) },
      deliver: async () => ({ state: "processed" }),
    });
    await outbox.start();
    const accepted = await Promise.all(
      identities.map((identity) =>
        outbox.enqueue({
          source: "child",
          target: "parent",
          kind: "goal-terminal",
          content: "terminal",
          ...identity,
        }),
      ),
    );

    expect(new Set(accepted.map((item) => item.messageId)).size).toBe(3);
    expect(outbox.listDiagnostic()).toHaveLength(3);
    expect(outbox.listDiagnostic().map((message) => message.idempotencyKey)).toEqual(keys);
  });

  test("serializes concurrent duplicate terminal enqueue to one durable record", async () => {
    const fence = goalFence();
    const outbox = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      canDeliver: () => false,
      goalFenceValidator: { validate: () => ({ status: "current" }) },
      deliver: async () => ({ state: "processed" }),
    });
    await outbox.start();
    const input = {
      source: "child",
      target: "parent",
      kind: "goal-terminal" as const,
      content: "done",
      ...goalTerminalMetadata(fence),
    };

    const accepted = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        outbox.enqueue({ ...input, content: `duplicate-${index}` }),
      ),
    );

    expect(new Set(accepted.map((item) => item.messageId)).size).toBe(1);
    expect(outbox.listDiagnostic({ goalFence: fence })).toHaveLength(1);
  });

  test("filters unfinished yield checks to the exact current fence", async () => {
    const currentFence = goalFence();
    const staleFence = goalFence({ epoch: 2 });
    const outbox = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      canDeliver: () => false,
      goalFenceValidator: currentFenceValidator(() => currentFence),
      deliver: async () => ({ state: "processed" }),
    });
    await outbox.start();
    await outbox.enqueue({
      source: "child",
      target: "parent",
      kind: "goal-terminal",
      content: "current",
      ...goalTerminalMetadata(currentFence),
    });
    await outbox.enqueue({
      source: "child",
      target: "parent",
      kind: "goal-terminal",
      content: "stale",
      ...goalTerminalMetadata(staleFence),
    });

    await eventually(
      () => outbox.listDiagnostic({ goalFence: currentFence })[0]?.state === "pending",
    );
    expect(await outbox.hasCurrentUnfinishedForTarget("parent", { goalFence: currentFence })).toBe(
      true,
    );
    expect(await outbox.hasCurrentUnfinishedForTarget("parent", { goalFence: staleFence })).toBe(
      false,
    );
    expect(await outbox.listCurrent({ goalFence: currentFence })).toHaveLength(1);
    expect(await outbox.listCurrent({ goalFence: staleFence })).toEqual([]);
    expect(outbox.listDiagnostic({ goalFence: staleFence })[0]?.state).toBe("cancelled");
  });

  test("defers an unknown fenced message without hot-looping and wakes after hydration", async () => {
    const persistence = new MemoryPersistence();
    const firstFence = goalFence();
    const secondFence = goalFence({ goalId: "goal-2" });
    const first = new AgentMessageOutbox({
      persistence,
      goalFenceValidator: { validate: () => ({ status: "current" }) },
      deliver: async () => ({ state: "processed" }),
    });

    await first.start({ pauseDispatch: true });
    const firstAccepted = await first.enqueue({
      source: "child",
      target: "parent-1",
      kind: "goal-terminal",
      content: "wait for first hydration",
      ...goalTerminalMetadata(firstFence),
    });
    const secondAccepted = await first.enqueue({
      source: "child",
      target: "parent-2",
      kind: "goal-terminal",
      content: "wait for second hydration",
      ...goalTerminalMetadata(secondFence),
    });
    await first.shutdown();

    const hydratedGoalIds = new Set<string>();
    const validationCounts = new Map<string, number>();
    const deliveries: string[] = [];
    const validate = vi.fn<GoalMessageFenceValidator["validate"]>((fence) => {
      validationCounts.set(fence.goalId, (validationCounts.get(fence.goalId) ?? 0) + 1);
      return hydratedGoalIds.has(fence.goalId) ? { status: "current" } : { status: "unknown" };
    });
    const restarted = new AgentMessageOutbox({
      persistence,
      goalFenceValidator: {
        validate,
      },
      deliver: async (message, context) => {
        deliveries.push(message.messageId);
        await context.markBackendAccepted();
        return { state: "processed" };
      },
    });
    await restarted.start();
    expect(restarted.get(firstAccepted.messageId)?.state).toBe("pending");
    expect(restarted.get(firstAccepted.messageId)?.retryAt).toBeUndefined();
    expect(restarted.get(secondAccepted.messageId)?.state).toBe("pending");
    expect(restarted.get(secondAccepted.messageId)?.retryAt).toBeUndefined();
    expect(deliveries).toEqual([]);
    const firstValidationCount = validationCounts.get(firstFence.goalId);
    const secondValidationCount = validationCounts.get(secondFence.goalId);
    for (let index = 0; index < 10; index += 1) restarted.resumeAfterRuntimeReset();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(validationCounts.get(firstFence.goalId)).toBe(firstValidationCount);
    expect(validationCounts.get(secondFence.goalId)).toBe(secondValidationCount);

    hydratedGoalIds.add(firstFence.goalId);
    await restarted.revalidateDeferredGoalMessages(firstFence.goalId);
    await eventually(() => restarted.get(firstAccepted.messageId)?.state === "processed");
    expect(restarted.get(secondAccepted.messageId)?.state).toBe("pending");
    expect(validationCounts.get(secondFence.goalId)).toBe(secondValidationCount);
    expect(deliveries).toEqual([firstAccepted.messageId]);

    hydratedGoalIds.add(secondFence.goalId);
    await restarted.revalidateDeferredGoalMessages(secondFence.goalId);
    await eventually(() => restarted.get(secondAccepted.messageId)?.state === "processed");
    expect(deliveries).toEqual([firstAccepted.messageId, secondAccepted.messageId]);
  });

  test("revalidates pending child and terminal goal messages after startup owner indexing", async () => {
    const persistence = new MemoryPersistence();
    const fence = goalFence();
    const first = new AgentMessageOutbox({
      persistence,
      goalFenceValidator: { validate: () => ({ status: "current" }) },
      deliver: async () => ({ state: "processed" }),
    });
    await first.start({ pauseDispatch: true });
    const child = await first.enqueue({
      source: "child",
      target: "parent",
      kind: "parent",
      content: "child handoff",
      goalFence: fence,
      goalId: fence.goalId,
      goalDeliveryKind: "child",
      goalDeliverySequence: 1,
    });
    const terminal = await first.enqueue({
      source: "child",
      target: "parent",
      kind: "goal-terminal",
      content: "child complete",
      ...goalTerminalMetadata(fence),
    });
    await first.shutdown();

    let ownerIndexed = false;
    const delivered: string[] = [];
    const restarted = new AgentMessageOutbox({
      persistence,
      goalFenceValidator: {
        validate: () =>
          ownerIndexed
            ? { status: "current" }
            : { status: "unknown", reason: "Goal owner is not loaded" },
      },
      deliver: async (message, context) => {
        delivered.push(message.messageId);
        await context.markBackendAccepted();
        return { state: "processed" };
      },
    });
    await restarted.start({ pauseDispatch: true });
    expect(restarted.get(child.messageId)?.retryAt).toBeUndefined();
    expect(restarted.get(terminal.messageId)?.retryAt).toBeUndefined();
    expect(delivered).toEqual([]);

    ownerIndexed = true;
    await restarted.revalidateDeferredGoalMessages(fence.goalId);
    restarted.resumeAfterRuntimeReset();
    await eventually(
      () =>
        restarted.get(child.messageId)?.state === "processed" &&
        restarted.get(terminal.messageId)?.state === "processed",
    );
    expect(delivered).toEqual([child.messageId, terminal.messageId]);
  });

  test("retries transient deferred goal revalidation persistence failures", async () => {
    vi.useFakeTimers();
    const persistence = new MemoryPersistence();
    const originalSave = persistence.save.bind(persistence);
    let failNextSave = false;
    persistence.save = async (content) => {
      if (failNextSave) {
        failNextSave = false;
        throw new Error("temporary persistence failure");
      }
      await originalSave(content);
    };
    const fence = goalFence();
    let ownerIndexed = false;
    const delivered: string[] = [];
    const outbox = new AgentMessageOutbox({
      persistence,
      retryDelayMs: 10,
      goalFenceValidator: {
        validate: () =>
          ownerIndexed
            ? { status: "current" }
            : { status: "unknown", reason: "Goal owner is not loaded" },
      },
      deliver: async (message) => {
        delivered.push(message.messageId);
        return { state: "processed" };
      },
    });
    await outbox.start({ pauseDispatch: true });
    const accepted = await outbox.enqueue({
      source: "child",
      target: "parent",
      kind: "goal-terminal",
      content: "child complete",
      ...goalTerminalMetadata(fence),
    });
    ownerIndexed = true;
    failNextSave = true;

    await expect(outbox.revalidateDeferredGoalMessages(fence.goalId)).rejects.toThrow(
      "temporary persistence failure",
    );
    expect(outbox.get(accepted.messageId)?.state).toBe("pending");

    await vi.advanceTimersByTimeAsync(10);
    outbox.resumeAfterRuntimeReset();
    await vi.runAllTimersAsync();

    expect(outbox.get(accepted.messageId)?.state).toBe("processed");
    expect(delivered).toEqual([accepted.messageId]);
    await outbox.shutdown();
    vi.useRealTimers();
  });

  test("rejects malformed, oversized, and privacy-unsafe goal metadata", async () => {
    const fence = goalFence();
    const outbox = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      goalFenceValidator: {
        validate: () => ({
          status: "stale",
          reason: "Objective text that must not enter persisted metadata",
        }),
      },
      deliver: async () => ({ state: "processed" }),
    });
    await outbox.start();
    const base = {
      source: "child",
      target: "parent",
      kind: "goal-terminal" as const,
      content: "terminal content may contain user-authored text",
      ...goalTerminalMetadata(fence),
    };
    const privacyUnsafeFence = { ...fence, objective: "private objective" };

    await expect(
      outbox.enqueue({
        ...base,
        goalFence: privacyUnsafeFence,
      }),
    ).rejects.toThrow("Unknown goal-message fence fields");
    await expect(
      outbox.enqueue({
        ...base,
        goalFence: goalFence({ goalId: "g".repeat(257) }),
        goalId: "g".repeat(257),
      }),
    ).rejects.toThrow("Invalid goal-message goalFence.goalId");
    await expect(
      outbox.enqueue({
        ...base,
        goalFence: goalFence({ epoch: 0 }),
      }),
    ).rejects.toThrow("Invalid goal-message fence epoch");
    const alternateContractField = ["contract", "Version"].join("");
    const alternateFenceNames = {
      goalId: fence.goalId,
      epoch: fence.epoch,
      [alternateContractField]: 1,
    };
    await expect(
      outbox.enqueue({
        ...base,
        goalFence: alternateFenceNames,
      }),
    ).rejects.toThrow("Unknown goal-message fence fields");
    await expect(
      outbox.enqueue({
        source: "reviewer",
        target: "goal-session",
        kind: "review-comment",
        content: "review result",
        goalId: fence.goalId,
        goalDeliveryKind: "reviewer",
        goalDeliverySequence: 1,
      }),
    ).rejects.toThrow("complete fenced delivery metadata");

    const rejected = await outbox.enqueue(base);
    expect(outbox.get(rejected.messageId)?.lastError).not.toContain("Objective text");
    expect(outbox.get(rejected.messageId)?.lastError?.length).toBeLessThanOrEqual(300);
  });

  test("rejects unknown versions and unknown or alternate persisted fields on reload", async () => {
    const fence = goalFence();
    const identity = goalTerminalMetadata(fence);
    const canonicalMessage = {
      ...basePersistedMessage(),
      kind: "goal-terminal" as const,
      idempotencyKey: buildGoalMessageIdempotencyKey(identity),
      ...identity,
    };
    const alternateContractField = ["contract", "Version"].join("");
    const cases = [
      {
        content: JSON.stringify({ version: 2, nextSequence: 1, messages: [] }),
        error: "Unsupported agent-message outbox version",
      },
      {
        content: JSON.stringify({
          version: 1,
          nextSequence: 2,
          messages: [{ ...canonicalMessage, unexpected: true }],
        }),
        error: "Unknown persisted agent message fields",
      },
      {
        content: JSON.stringify({
          version: 1,
          nextSequence: 2,
          messages: [
            {
              ...canonicalMessage,
              goalFence: { ...fence, [alternateContractField]: 1 },
            },
          ],
        }),
        error: "Unknown goal-message fence fields",
      },
    ];

    for (const item of cases) {
      const persistence = new MemoryPersistence();
      persistence.content = item.content;
      const outbox = new AgentMessageOutbox({
        persistence,
        goalFenceValidator: currentFenceValidator(() => fence),
        deliver: async () => ({ state: "processed" }),
      });

      // eslint-disable-next-line no-await-in-loop -- each persisted schema failure is isolated
      await expect(outbox.start()).rejects.toThrow(item.error);
    }
  });

  test("rejects unsafe persisted sequence integers", async () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    const cases = [
      {
        content: JSON.stringify({ version: 1, nextSequence: unsafe, messages: [] }),
        error: "Invalid agent-message outbox header",
      },
      {
        content: JSON.stringify({
          version: 1,
          nextSequence: 1,
          messages: [persistedMessage({ sequence: unsafe })],
        }),
        error: "Invalid persisted agent-message fields",
      },
    ];

    for (const item of cases) {
      const persistence = new MemoryPersistence();
      persistence.content = item.content;
      const outbox = new AgentMessageOutbox({
        persistence,
        deliver: async () => ({ state: "processed" }),
      });

      // eslint-disable-next-line no-await-in-loop -- each unsafe integer is validated independently
      await expect(outbox.start()).rejects.toThrow(item.error);
    }
  });

  test("allocates the final safe sequences once and preserves exhaustion across restart", async () => {
    const persistence = new MemoryPersistence();
    persistence.content = JSON.stringify({
      version: 1,
      nextSequence: Number.MAX_SAFE_INTEGER - 1,
      messages: [
        persistedMessage({
          messageId: "near-limit",
          idempotencyKey: "near-limit",
          sequence: Number.MAX_SAFE_INTEGER - 2,
        }),
      ],
    });
    const first = new AgentMessageOutbox({
      persistence,
      canDeliver: () => false,
      deliver: async () => ({ state: "processed" }),
    });
    await first.start();

    const penultimate = await first.enqueue({
      source: "child",
      target: "parent",
      kind: "parent",
      content: "penultimate",
    });
    const final = await first.enqueue({
      source: "child",
      target: "parent",
      kind: "parent",
      content: "final",
    });
    await expect(
      first.enqueue({
        source: "child",
        target: "parent",
        kind: "parent",
        content: "overflow",
      }),
    ).rejects.toThrow("sequence space is exhausted");

    expect(first.getDiagnostic(penultimate.messageId)?.sequence).toBe(Number.MAX_SAFE_INTEGER - 1);
    expect(first.getDiagnostic(final.messageId)?.sequence).toBe(Number.MAX_SAFE_INTEGER);
    expect(new Set(first.listDiagnostic().map((message) => message.sequence)).size).toBe(3);
    await first.shutdown();

    const restarted = new AgentMessageOutbox({
      persistence,
      canDeliver: () => false,
      deliver: async () => ({ state: "processed" }),
    });
    await restarted.start();
    await expect(
      restarted.enqueue({
        source: "child",
        target: "parent",
        kind: "parent",
        content: "restart overflow",
      }),
    ).rejects.toThrow("sequence space is exhausted");
    expect(new Set(restarted.listDiagnostic().map((message) => message.sequence)).size).toBe(3);
  });

  test("rejects duplicate persisted identities and sequences", async () => {
    const duplicateCases: Array<[string, Partial<ReturnType<typeof basePersistedMessage>>]> = [
      ["ID", { messageId: "first", idempotencyKey: "second-key", sequence: 2 }],
      ["idempotency key", { messageId: "second", idempotencyKey: "first-key", sequence: 2 }],
      ["sequence", { messageId: "second", idempotencyKey: "second-key", sequence: 1 }],
    ];
    for (const [label, duplicate] of duplicateCases) {
      const persistence = new MemoryPersistence();
      persistence.content = JSON.stringify({
        version: 1,
        nextSequence: 3,
        messages: [
          persistedMessage({ messageId: "first", idempotencyKey: "first-key", sequence: 1 }),
          persistedMessage(duplicate),
        ],
      });
      const outbox = new AgentMessageOutbox({
        persistence,
        deliver: async () => ({ state: "processed" }),
      });

      // eslint-disable-next-line no-await-in-loop -- each malformed store is validated independently
      await expect(outbox.start()).rejects.toThrow(`Duplicate agent-message ${label}`);
    }
  });

  test("rejects malformed persisted timestamps", async () => {
    const persistence = new MemoryPersistence();
    persistence.content = JSON.stringify({
      version: 1,
      nextSequence: 2,
      messages: [persistedMessage({ updatedAt: "not-a-date" })],
    });
    const outbox = new AgentMessageOutbox({
      persistence,
      deliver: async () => ({ state: "processed" }),
    });

    await expect(outbox.start()).rejects.toThrow(
      "Invalid persisted agent-message timestamp: updatedAt",
    );
  });
});

function persistedMessage(
  overrides: Partial<ReturnType<typeof basePersistedMessage>>,
): ReturnType<typeof basePersistedMessage> {
  return { ...basePersistedMessage(), ...overrides };
}

function basePersistedMessage() {
  return {
    messageId: "message",
    idempotencyKey: "message",
    source: "child",
    target: "parent",
    kind: "parent" as AgentMessageKind,
    deliveryMode: "queue" as const,
    priority: 0,
    sequence: 1,
    content: "content",
    attempts: 0,
    state: "pending" as AgentMessageState,
    acceptedAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    processedAt: undefined as string | undefined,
  };
}

function goalFence(overrides: Partial<GoalFence> = {}): GoalFence {
  return {
    goalId: "goal-1",
    epoch: 1,
    ...overrides,
  };
}

function goalTerminalMetadata(fence: GoalFence): GoalMessageIdentity {
  return {
    goalFence: fence,
    goalId: fence.goalId,
    goalDeliveryKind: "terminal",
    goalTerminalKind: "completed",
    goalDeliverySequence: 1,
  };
}

function currentFenceValidator(current: () => GoalFence): GoalMessageFenceValidator {
  return {
    validate: (candidate) =>
      goalFencesEqual(candidate, current())
        ? { status: "current" }
        : { status: "stale", reason: "fence_mismatch" },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function eventually(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      const messages = predicate.toString();
      throw new Error(`Condition did not become true: ${messages}`);
    }
    // eslint-disable-next-line no-await-in-loop -- bounded polling keeps timing-independent state-machine tests deterministic
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("subagent queue delivery", () => {
  function startOutbox(options?: { persistence?: MemoryPersistence; now?: () => number }) {
    const delivered: Array<{ messageId: string; content: string; acceptedAt: string }> = [];
    const releases: Array<() => void> = [];
    const results: AgentMessageDeliveryResult[] = [];
    const outbox = new AgentMessageOutbox({
      persistence: options?.persistence ?? new MemoryPersistence(),
      retryDelayMs: 1,
      ...(options?.now ? { now: options.now } : {}),
      deliver: async (message, context) => {
        delivered.push({
          messageId: message.messageId,
          content: message.content,
          acceptedAt: message.acceptedAt,
        });
        await context.markBackendAccepted();
        await context.markBackendDelivered();
        await new Promise<void>((resolve) => releases.push(resolve));
        return results.shift() ?? { state: "processed", response: "done" };
      },
    });
    return { outbox, delivered, releases, results };
  }

  const steer = (content: string, source = "parent") => ({
    source,
    target: "child",
    kind: "subagent" as const,
    content,
  });
  const interrupt = (content: string) => ({
    ...steer(content),
    deliveryMode: "interrupt" as const,
    priority: 100,
  });

  async function waitForDelivery(delivered: readonly unknown[], count: number): Promise<void> {
    await vi.waitFor(() => expect(delivered).toHaveLength(count));
  }

  test("an interrupt reaches a subagent whose current turn was started by the outbox", async () => {
    const { outbox, delivered, releases } = startOutbox();
    await outbox.start();
    await outbox.enqueue(steer("first"));
    await waitForDelivery(delivered, 1);

    await outbox.enqueue(interrupt("stop now"));

    await waitForDelivery(delivered, 2);
    expect(delivered[1].content).toContain("stop now");
    for (const release of releases) release();
    await outbox.shutdown();
  });

  test("a second interrupt preempts a turn started by the first", async () => {
    const { outbox, delivered, releases } = startOutbox();
    await outbox.start();
    await outbox.enqueue(steer("first"));
    await waitForDelivery(delivered, 1);
    await outbox.enqueue(interrupt("stop now"));
    await waitForDelivery(delivered, 2);

    await outbox.enqueue(interrupt("no, stop differently"));

    await waitForDelivery(delivered, 3);
    expect(delivered[2].content).toContain("no, stop differently");
    for (const release of releases) release();
    await outbox.shutdown();
  });

  test("an interrupting parent report still waits for the parent's outbox turn", async () => {
    const { outbox, delivered, releases } = startOutbox();
    await outbox.start();
    await outbox.enqueue({ ...steer("report one"), kind: "parent" });
    await waitForDelivery(delivered, 1);

    await outbox.enqueue({ ...steer("report two"), kind: "parent", deliveryMode: "interrupt" });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(delivered).toHaveLength(1);
    releases[0]();
    await waitForDelivery(delivered, 2);
    releases[1]();
    await outbox.shutdown();
  });

  test("delivers everything queued behind a turn together, oldest first, with send times", async () => {
    const { outbox, delivered, releases } = startOutbox();
    await outbox.start();
    await outbox.enqueue(steer("working"));
    await waitForDelivery(delivered, 1);
    const second = await outbox.enqueue({ ...steer("second"), sourceLabel: "Coordinator" });
    const third = await outbox.enqueue({ ...steer("third", "peer"), sourceLabel: "N4" });
    await vi.waitFor(() => expect(outbox.countQueuedForTarget("child")).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 5));

    const waitForThird = outbox.waitForTerminal(third.messageId, 2000);
    releases[0]();
    await waitForDelivery(delivered, 2);

    const batch = delivered[1];
    expect(batch.messageId).toBe(second.messageId);
    expect(batch.content.indexOf("second")).toBeLessThan(batch.content.indexOf("third"));
    expect(batch.content).toMatch(/Message 1 of 2 · from Coordinator · sent \d{2}:\d{2}/);
    expect(batch.content).toMatch(/Message 2 of 2 · from N4 · sent \d{2}:\d{2}/);
    expect(outbox.get(third.messageId)?.state).toBe("backend-accepted");

    releases[1]();
    const settled = await waitForThird;
    expect(settled.message.state).toBe("processed");
    expect(settled.message.response).toBe("done");
    expect(outbox.get(second.messageId)?.state).toBe("processed");
    await outbox.shutdown();
  });

  test("an interrupt carries the queued backlog with it, so nothing older arrives afterwards", async () => {
    const { outbox, delivered, releases } = startOutbox();
    await outbox.start();
    await outbox.enqueue(steer("working"));
    await waitForDelivery(delivered, 1);
    await outbox.enqueue(steer("old plan"));
    await vi.waitFor(() => expect(outbox.countQueuedForTarget("child")).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 5));

    await outbox.enqueue(interrupt("new plan"));
    await waitForDelivery(delivered, 2);

    expect(delivered[1].content.indexOf("old plan")).toBeLessThan(
      delivered[1].content.indexOf("new plan"),
    );
    expect(outbox.countQueuedForTarget("child")).toBe(0);
    for (const release of releases) release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(delivered).toHaveLength(2);
    await outbox.shutdown();
  });

  test("keeps messages with their own delivery proof out of a batch", async () => {
    const { outbox, delivered, releases } = startOutbox();
    await outbox.start();
    await outbox.enqueue(steer("working"));
    await waitForDelivery(delivered, 1);
    await outbox.enqueue(steer("one"));
    await outbox.enqueue({ ...steer("review"), kind: "review-feedback" });
    await outbox.enqueue(steer("two"));
    await vi.waitFor(() => expect(outbox.countQueuedForTarget("child")).toBe(3));
    await new Promise((resolve) => setTimeout(resolve, 5));

    releases[0]();
    await waitForDelivery(delivered, 2);
    expect(delivered[1].content).toBe("one");
    releases[1]();
    await waitForDelivery(delivered, 3);
    expect(delivered[2].content).toBe("review");
    releases[2]();
    await waitForDelivery(delivered, 4);
    expect(delivered[3].content).toBe("two");
    releases[3]();
    await outbox.shutdown();
  });

  test("an unknown delivery outcome applies to every message in the batch", async () => {
    const { outbox, delivered, releases, results } = startOutbox();
    await outbox.start();
    await outbox.enqueue(steer("working"));
    await waitForDelivery(delivered, 1);
    const second = await outbox.enqueue(steer("second"));
    const third = await outbox.enqueue(steer("third"));
    await vi.waitFor(() => expect(outbox.countQueuedForTarget("child")).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 5));
    results.push({ state: "processed" }, { state: "delivery-unknown", error: "lost" });

    const waitForThird = outbox.waitForTerminal(third.messageId, 2000);
    releases[0]();
    await waitForDelivery(delivered, 2);
    releases[1]();

    expect((await waitForThird).message.state).toBe("delivery-unknown");
    expect(outbox.get(second.messageId)?.lastError).toBe("lost");
    await outbox.shutdown();
  });

  test("a batch stays together across a restart and is not delivered twice", async () => {
    const persistence = new MemoryPersistence();
    const first = startOutbox({ persistence });
    await first.outbox.start();
    await first.outbox.enqueue(steer("working"));
    await waitForDelivery(first.delivered, 1);
    const second = await first.outbox.enqueue(steer("second"));
    const third = await first.outbox.enqueue(steer("third"));
    await vi.waitFor(() => expect(first.outbox.countQueuedForTarget("child")).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 5));
    first.releases[0]();
    await waitForDelivery(first.delivered, 2);
    await first.outbox.shutdown();

    const restarted = startOutbox({ persistence });
    await restarted.outbox.start();

    expect(restarted.outbox.get(second.messageId)?.coalescedMessageIds).toEqual([third.messageId]);
    expect(restarted.outbox.get(second.messageId)?.state).toBe("delivery-unknown");
    expect(restarted.outbox.get(third.messageId)?.state).toBe("delivery-unknown");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(restarted.delivered).toHaveLength(0);
    await restarted.outbox.shutdown();
  });

  test("replaceQueuedFromSource cancels only the sender's undelivered messages", async () => {
    const { outbox, delivered, releases } = startOutbox();
    await outbox.start();
    await outbox.enqueue(steer("working"));
    await waitForDelivery(delivered, 1);
    const stale = await outbox.enqueue(steer("stale plan"));
    const peer = await outbox.enqueue(steer("peer finding", "peer"));

    const replacement = await outbox.enqueue({
      ...steer("new plan"),
      replaceQueuedFromSource: true,
    });

    expect(replacement.replacedMessageIds).toEqual([stale.messageId]);
    expect(outbox.get(stale.messageId)?.state).toBe("cancelled");
    expect(outbox.get(peer.messageId)?.state).not.toBe("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 5));
    releases[0]();
    await waitForDelivery(delivered, 2);
    expect(delivered[1].content).toContain("peer finding");
    expect(delivered[1].content).toContain("new plan");
    expect(delivered[1].content).not.toContain("stale plan");
    releases[1]();
    await outbox.shutdown();
  });

  test("cancelQueuedFromSource reports what it could not cancel", async () => {
    const { outbox, delivered, releases } = startOutbox();
    await outbox.start();
    const running = await outbox.enqueue(steer("working"));
    await waitForDelivery(delivered, 1);
    const mine = await outbox.enqueue(steer("mine"));
    const theirs = await outbox.enqueue(steer("theirs", "peer"));

    const result = await outbox.cancelQueuedFromSource("child", "parent", [
      mine.messageId,
      theirs.messageId,
      running.messageId,
    ]);

    expect(result.cancelledMessageIds).toEqual([mine.messageId]);
    expect(result.notCancelledMessageIds).toEqual([theirs.messageId, running.messageId]);
    expect(outbox.get(theirs.messageId)?.state).not.toBe("cancelled");
    for (const release of releases) release();
    await outbox.shutdown();
  });

  test("announces terminal records and leaves goal-fenced work out of the queued count", async () => {
    const validator: GoalMessageFenceValidator = { validate: () => ({ status: "unknown" }) };
    const terminal: string[] = [];
    const outbox = new AgentMessageOutbox({
      persistence: new MemoryPersistence(),
      goalFenceValidator: validator,
      canDeliver: () => false,
      deliver: async () => ({ state: "processed" }),
    });
    outbox.addTerminalListener((message) => terminal.push(message.messageId));
    await outbox.start({ pauseDispatch: true });
    const plain = await outbox.enqueue(steer("plain"));
    const fence: GoalFence = { goalId: "goal-1", epoch: 1 };
    await outbox.enqueue({
      ...steer("fenced"),
      goalFence: fence,
      goalId: fence.goalId,
      goalDeliveryKind: "child",
      goalDeliverySequence: 1,
    });

    expect(outbox.countQueuedForTarget("child")).toBe(1);
    await outbox.cancelQueuedFromSource("child", "parent", [plain.messageId]);
    expect(terminal).toEqual([plain.messageId]);
    await outbox.shutdown();
  });

  test("describes how long a message waited", () => {
    const now = Date.parse("2026-11-01T09:46:00.000Z");
    expect(describeAgentMessageSendTime("2026-11-01T09:45:30.000Z", now)).toMatch(/just now$/);
    expect(describeAgentMessageSendTime("2026-11-01T07:13:00.000Z", now)).toMatch(/2h 33m ago$/);
    expect(describeAgentMessageSendTime("2026-10-20T07:13:00.000Z", now)).toMatch(/Oct/);
  });
});
