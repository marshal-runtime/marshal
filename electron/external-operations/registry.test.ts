import { describe, expect, test } from "vitest";

import type {
  ExternalOperationIdentity,
  ExternalOperationRequest,
} from "../../common/external-operation-contract";
import { ExternalOperationRegistry } from "./registry";
import { ExternalOperationStore, type ExternalOperationPersistence } from "./store";
import type { ExternalOperationAdapter } from "./types";
import type { ExternalOperationNotificationOutbox } from "./types";

class MemoryPersistence implements ExternalOperationPersistence {
  content: string | null = null;
  fail = false;
  saveCount = 0;
  failOnSaveNumber: number | null = null;

  async load(): Promise<string | null> {
    return this.content;
  }

  async save(content: string): Promise<void> {
    this.saveCount += 1;
    if (this.fail) throw new Error("persistence unavailable");
    if (this.failOnSaveNumber === this.saveCount) {
      throw new Error("injected persistence crash");
    }
    this.content = content;
  }
}

class DeduplicatingOutbox implements ExternalOperationNotificationOutbox {
  calls = 0;
  readonly messages = new Map<string, string>();
  beforeAccept?: () => void;

  async enqueue(input: {
    idempotencyKey: string;
  }): Promise<{ accepted: true; messageId: string; state: string }> {
    this.calls += 1;
    this.beforeAccept?.();
    const messageId =
      this.messages.get(input.idempotencyKey) ?? `message-${this.messages.size + 1}`;
    this.messages.set(input.idempotencyKey, messageId);
    return { accepted: true, messageId, state: "accepted" };
  }
}

describe("ExternalOperationRegistry remediation", () => {
  test("does not accept registration before durable persistence", async () => {
    const persistence = new MemoryPersistence();
    persistence.fail = true;
    const registry = createRegistry(persistence);
    await registry.start();

    await expect(registry.register(registration())).rejects.toThrow("persistence unavailable");
    expect(registry.list()).toEqual([]);
  });

  test("returns created/existing and rejects fenced idempotency collisions", async () => {
    const registry = createRegistry();
    await registry.start();
    const input = registration();

    await expect(registry.register(input)).resolves.toMatchObject({
      disposition: "created",
    });
    await expect(registry.register(input)).resolves.toMatchObject({
      disposition: "existing",
    });
    await expect(
      registry.register({
        ...input,
        request: {
          ...input.request,
          kind: "different-kind",
        },
      }),
    ).rejects.toThrow("idempotency conflict");
    await expect(
      registry.register({
        ...input,
        request: {
          ...input.request,
          fence: {
            ...input.request.fence,
            epoch: input.request.fence.epoch + 1,
          },
        },
      }),
    ).rejects.toThrow("idempotency conflict");
  });

  test("atomically grants one dispatch claim and requires its token for attach", async () => {
    const registry = createRegistry();
    await registry.start();
    const input = registration();
    await registry.register(input);
    const identity = identityOf(input.request);

    const claims = await Promise.allSettled([
      registry.claimDispatch({ identity, claimedBy: "worker-a" }),
      registry.claimDispatch({ identity, claimedBy: "worker-b" }),
    ]);
    expect(claims.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((result) => result.status === "rejected")).toHaveLength(1);
    const claim = claims.find(
      (
        result,
      ): result is PromiseFulfilledResult<Awaited<ReturnType<typeof registry.claimDispatch>>> =>
        result.status === "fulfilled",
    )!.value.claim;

    await expect(
      registry.attach({
        identity,
        claimToken: "stale-token",
        receipt: { externalReference: "provider-1" },
      }),
    ).rejects.toThrow("claim mismatch");
    await expect(
      registry.attach({
        identity,
        claimToken: claim.claimToken,
        receipt: { externalReference: "provider-1" },
      }),
    ).resolves.toMatchObject({
      state: "running",
      publicRecord: {
        status: "running",
        attempt: 1,
      },
    });
  });

  test("forbids success before receipt attachment and accepts claimant completion", async () => {
    const registry = createRegistry();
    await registry.start();
    const input = registration();
    await registry.register(input);
    const identity = identityOf(input.request);
    const claim = await registry.claimDispatch({ identity, claimedBy: "worker-a" });

    await expect(
      registry.complete({
        identity,
        claimToken: claim.claim.claimToken,
        result: "not launched",
      }),
    ).rejects.toThrow("before dispatch");
    await registry.attach({
      identity,
      claimToken: claim.claim.claimToken,
      receipt: { externalReference: "provider-1" },
    });
    const completed = await registry.complete({
      identity,
      claimToken: claim.claim.claimToken,
      result: "customer secret output",
    });
    expect(completed).toMatchObject({
      state: "succeeded",
      publicRecord: {
        status: "succeeded",
      },
      terminalEvent: {
        result: {
          type: "text",
          length: 22,
        },
      },
    });
    expect(JSON.stringify(completed)).not.toContain("customer secret output");
  });

  test("rejects every mutation with a stale goal epoch", async () => {
    const registry = createRegistry();
    await registry.start();
    const input = registration();
    await registry.register(input);
    const stale = {
      ...identityOf(input.request),
      fence: {
        ...input.request.fence,
        epoch: input.request.fence.epoch + 1,
      },
    };

    await expect(registry.claimDispatch({ identity: stale, claimedBy: "worker" })).rejects.toThrow(
      "identity conflict",
    );
    await expect(
      registry.attach({
        identity: stale,
        claimToken: "claim",
        receipt: { externalReference: "provider" },
      }),
    ).rejects.toThrow("identity conflict");
    await expect(registry.heartbeat({ identity: stale })).rejects.toThrow("identity conflict");
    await expect(registry.adopt({ identity: stale, ownerId: "runtime" })).rejects.toThrow(
      "identity conflict",
    );
    await expect(
      registry.fail({ identity: stale, error: "failed", preDispatch: true }),
    ).rejects.toThrow("identity conflict");
    await expect(registry.complete({ identity: stale, claimToken: "claim" })).rejects.toThrow(
      "identity conflict",
    );
    await expect(registry.cancel({ identity: stale })).rejects.toThrow("identity conflict");
  });

  test("owns cancellation by request token and ignores stale provider results", async () => {
    let cancelCalls = 0;
    const adapter: ExternalOperationAdapter = {
      ...cancellationAdapter(),
      cancel: async (_context, scope) => {
        cancelCalls += 1;
        return { accepted: true, scope };
      },
    };
    const registry = createRegistry(undefined, [adapter]);
    await registry.start();
    const input = registration();
    await registry.register(input);
    const identity = identityOf(input.request);
    const claim = await registry.claimDispatch({ identity, claimedBy: "worker" });
    await registry.attach({
      identity,
      claimToken: claim.claim.claimToken,
      receipt: { externalReference: "provider-1" },
    });

    const [cancelling] = await Promise.all([
      registry.cancel({
        identity,
        cancellationRequestId: "cancel-1",
        scope: "operation",
      }),
      registry.cancel({
        identity,
        cancellationRequestId: "cancel-1",
        scope: "operation",
      }),
    ]);
    expect(cancelling.cancellation).toMatchObject({
      requestId: "cancel-1",
      state: "accepted",
    });
    expect(cancelCalls).toBe(1);
    await expect(
      registry.cancel({
        identity,
        cancellationRequestId: "cancel-2",
      }),
    ).rejects.toThrow("already owned");

    await registry.recordCancellationProviderResult({
      identity,
      cancellationRequestId: "stale-result",
      accepted: true,
      observation: { state: "cancelled" },
    });
    expect(registry.inspect(identity.operationId)?.state).toBe("cancelling");
    await registry.recordCancellationProviderResult({
      identity,
      cancellationRequestId: "cancel-1",
      accepted: true,
      observation: { state: "cancelled" },
    });
    expect(registry.inspect(identity.operationId)?.state).toBe("cancelled");
  });

  test("ignores cancellation results from a stale goal epoch", async () => {
    const registry = createRegistry();
    await registry.start();
    const input = registration();
    await registry.register(input);
    const identity = identityOf(input.request);

    const result = await registry.recordCancellationProviderResult({
      identity: {
        ...identity,
        fence: {
          ...identity.fence,
          epoch: identity.fence.epoch + 1,
        },
      },
      cancellationRequestId: "old-cancellation",
      accepted: true,
    });
    expect(result.state).toBe("registered");
  });

  test("redelivers a persisted requested cancellation after restart", async () => {
    const persistence = new MemoryPersistence();
    let cancelCalls = 0;
    const adapter: ExternalOperationAdapter = {
      ...cancellationAdapter(),
      cancel: async (_context, scope) => {
        cancelCalls += 1;
        return { accepted: true, scope };
      },
    };
    const first = createRegistry(persistence, [adapter]);
    await first.start();
    const input = registration();
    await first.register(input);
    const identity = identityOf(input.request);
    const claim = await first.claimDispatch({ identity, claimedBy: "worker" });
    await first.attach({
      identity,
      claimToken: claim.claim.claimToken,
      receipt: { externalReference: "provider-1" },
    });
    persistence.failOnSaveNumber = persistence.saveCount + 2;

    await expect(
      first.cancel({
        identity,
        cancellationRequestId: "cancel-restart",
      }),
    ).rejects.toThrow("injected persistence crash");
    expect(JSON.parse(persistence.content ?? "").records[0]).toMatchObject({
      state: "cancelling",
      cancellation: {
        requestId: "cancel-restart",
        state: "requested",
      },
    });
    persistence.failOnSaveNumber = null;

    const restarted = createRegistry(persistence, [adapter]);
    await restarted.start();
    const redelivered = await restarted.cancel({
      identity,
      cancellationRequestId: "cancel-restart",
    });
    expect(redelivered.cancellation).toMatchObject({
      requestId: "cancel-restart",
      state: "accepted",
    });
    expect(cancelCalls).toBe(2);
  });

  test("persists terminal state before outbox enqueue and retries acceptance idempotently", async () => {
    const persistence = new MemoryPersistence();
    const outbox = new DeduplicatingOutbox();
    outbox.beforeAccept = () => {
      const persisted = JSON.parse(persistence.content ?? "");
      expect(persisted.records[0]).toMatchObject({
        state: "succeeded",
        terminalEvent: expect.objectContaining({ state: "succeeded" }),
        notification: { state: "pending" },
      });
    };
    const first = createRegistry(persistence, [], undefined, outbox);
    await first.start();
    const input = {
      ...registration(),
      terminalNotification: {
        target: "parent",
        content: "Operation completed",
      },
    };
    await first.register(input);
    const identity = identityOf(input.request);
    const claim = await first.claimDispatch({ identity, claimedBy: "worker" });
    await first.attach({
      identity,
      claimToken: claim.claim.claimToken,
      receipt: { externalReference: "provider-1" },
    });
    persistence.failOnSaveNumber = persistence.saveCount + 2;
    const terminal = await first.complete({
      identity,
      claimToken: claim.claim.claimToken,
      result: "done",
    });
    expect(terminal.notification).toMatchObject({
      state: "pending",
      lastError: expect.any(String),
    });
    expect(outbox.messages.size).toBe(1);

    persistence.failOnSaveNumber = null;
    const restarted = createRegistry(persistence, [], undefined, outbox);
    await restarted.start();
    expect(restarted.inspect(identity.operationId)?.notification).toMatchObject({
      state: "accepted",
      messageId: "message-1",
    });
    expect(outbox.calls).toBe(2);
    expect(outbox.messages.size).toBe(1);
  });

  test("reconciles an unresolved non-idempotent receipt to unknown without rerun", async () => {
    let resolverCalls = 0;
    const adapter: ExternalOperationAdapter = {
      adapterId: "test-adapter",
      providerKinds: new Set(["host-tool"]),
      inspect: async () => {
        resolverCalls += 1;
        return {
          state: "unknown",
          reason: "Receipt cannot be resolved; action was not rerun",
        };
      },
      cancel: async (_context, scope) => ({ accepted: false, scope }),
    };
    const registry = createRegistry(undefined, [adapter]);
    await registry.start();
    const input = registration();
    await registry.register(input);
    const identity = identityOf(input.request);
    const claim = await registry.claimDispatch({ identity, claimedBy: "worker" });
    await registry.attach({
      identity,
      claimToken: claim.claim.claimToken,
      receipt: { externalReference: "lost-provider-handle" },
    });

    const reconciled = await registry.reconcile(identity.operationId);
    expect(resolverCalls).toBe(1);
    expect(reconciled).toMatchObject({
      actionSemantics: "non-idempotent",
      state: "unknown",
      lastError: expect.stringContaining("not rerun"),
    });
  });

  test("rejects over-depth and over-length metadata", async () => {
    const registry = createRegistry();
    await registry.start();
    await expect(
      registry.register({
        ...registration(),
        metadata: {
          values: {
            description: "x".repeat(5_000),
          },
        },
      }),
    ).rejects.toThrow("metadata.values.description exceeds 4000 characters");
  });

  test("redacts sensitive metadata fields before persistence", async () => {
    const registry = createRegistry();
    await registry.start();
    await registry.register({
      ...registration(),
      metadata: {
        values: {
          accessToken: "customer-secret-token",
          safeId: "provider-1",
        },
      },
    });
    const stored = registry.list()[0];
    expect(stored.metadata.values).toEqual({
      accessToken: "[redacted]",
      safeId: "provider-1",
    });
    expect(JSON.stringify(stored)).not.toContain("customer-secret-token");
  });

  test("applies state-specific terminal retention", async () => {
    const now = Date.parse("2026-07-19T10:00:00.000Z");
    const registry = createRegistry(undefined, [], () => now);
    await registry.start();
    const failedInput = registration("failed-operation");
    const cancelledInput = registration("cancelled-operation");
    await registry.register(failedInput);
    await registry.register(cancelledInput);
    await registry.fail({
      identity: identityOf(failedInput.request),
      error: "pre-dispatch failure",
      preDispatch: true,
    });
    await registry.cancel({
      identity: identityOf(cancelledInput.request),
      cancellationRequestId: "cancel-pre-dispatch",
    });

    expect(Date.parse(registry.inspect("failed-operation")!.retention.retainUntil!) - now).toBe(
      14 * 24 * 60 * 60_000,
    );
    expect(Date.parse(registry.inspect("cancelled-operation")!.retention.retainUntil!) - now).toBe(
      3 * 24 * 60 * 60_000,
    );
  });
});

function createRegistry(
  persistence = new MemoryPersistence(),
  adapters: ExternalOperationAdapter[] = [],
  now?: () => number,
  notificationOutbox?: ExternalOperationNotificationOutbox,
): ExternalOperationRegistry {
  let nextId = 0;
  return new ExternalOperationRegistry({
    store: new ExternalOperationStore(persistence),
    adapters,
    createId: () => `id-${++nextId}`,
    now,
    notificationOutbox,
  });
}

function registration(operationId = "operation-1") {
  const request: ExternalOperationRequest = {
    operationId,
    fence: {
      goalId: "goal-1",
      epoch: 2,
    },
    idempotencyKey: `goal-1:${operationId}`,
    kind: "background-tool",
    effect: "side-effect",
    requestedAt: "2026-07-19T10:00:00.000Z",
    inputFingerprint: "input-1",
  };
  return {
    request,
    provider: {
      kind: "host-tool" as const,
      provider: "host",
      adapterId: "test-adapter",
    },
    cancellationScope: "operation" as const,
    actionSemantics: "non-idempotent" as const,
  };
}

function identityOf(request: ExternalOperationRequest): ExternalOperationIdentity {
  return {
    operationId: request.operationId,
    fence: request.fence,
    idempotencyKey: request.idempotencyKey,
    assignmentId: request.assignmentId,
  };
}

function cancellationAdapter(): ExternalOperationAdapter {
  return {
    adapterId: "test-adapter",
    providerKinds: new Set(["host-tool"]),
    inspect: async () => ({ state: "running" }),
    cancel: async (_context, scope) => ({ accepted: true, scope }),
  };
}
