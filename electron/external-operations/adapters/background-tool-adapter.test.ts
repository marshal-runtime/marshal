import { describe, expect, test, vi } from "vitest";

import type {
  BackgroundToolDispatchClaim,
  BackgroundToolDispatchClaimRequest,
} from "../../backend/ports";
import { ExternalOperationRegistry } from "../registry";
import { ExternalOperationStore, type ExternalOperationPersistence } from "../store";
import { BackgroundToolInvocationRegistryAdapter } from "./background-tool-adapter";

const REGISTRY_NOW_MS = 1_000_000;

class MemoryPersistence implements ExternalOperationPersistence {
  content: string | null = null;
  fail = false;
  gate: Promise<void> | null = null;

  async load(): Promise<string | null> {
    return this.content;
  }

  async save(content: string): Promise<void> {
    if (this.fail) throw new Error("persistence unavailable");
    if (this.gate) await this.gate;
    this.content = content;
  }
}

describe("BackgroundToolInvocationRegistryAdapter frozen async port", () => {
  test("does not return a claim before its durable write", async () => {
    const persistence = new MemoryPersistence();
    const gate = deferred<void>();
    persistence.gate = gate.promise;
    const registry = createRegistry(persistence);
    const manager = createManager(registry);
    await registry.start();

    let resolved = false;
    const claiming = manager.claimBackgroundToolDispatch(claimRequest()).then((value) => {
      resolved = true;
      return value;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(manager.listRunningTools()).toEqual([]);
    expect(manager.inspectRunningTool("session-1:call-1")).toMatchObject({
      success: false,
    });

    persistence.gate = null;
    gate.resolve();
    await expect(claiming).resolves.toMatchObject({ kind: "claimed" });
  });

  test("does not expose a claim when claim persistence fails", async () => {
    const persistence = new MemoryPersistence();
    const registry = createRegistry(persistence);
    const manager = createManager(registry);
    await registry.start();
    persistence.fail = true;

    await expect(manager.claimBackgroundToolDispatch(claimRequest())).rejects.toThrow(
      "persistence unavailable",
    );
    expect(registry.list()).toEqual([]);
  });

  test("durably claims before registration and returns exact result envelopes", async () => {
    const persistence = new MemoryPersistence();
    const registry = createRegistry(persistence);
    const manager = createManager(registry);
    await registry.start();

    const claimResult = await manager.claimBackgroundToolDispatch(claimRequest());
    expect(claimResult).toMatchObject({
      kind: "claimed",
      claim: {
        ownerSessionId: "session-1",
        toolCallId: "call-1",
        cancellationToken: {
          ownerSessionId: "session-1",
        },
      },
    });
    if (claimResult.kind !== "claimed") throw new Error("expected claim");

    const gate = deferred<void>();
    persistence.gate = gate.promise;
    let resolved = false;
    const registration = manager
      .beginBackgroundToolInvocation(start(claimResult.claim))
      .then((value) => {
        resolved = true;
        return value;
      });
    await Promise.resolve();
    expect(resolved).toBe(false);

    persistence.gate = null;
    gate.resolve();
    await expect(registration).resolves.toMatchObject({
      handle: "session-1:call-1",
      claim: claimResult.claim,
      invocation: {
        status: "running",
      },
    });
    expect(registry.list()[0]).toMatchObject({
      state: "running",
      receipt: {
        claimId: claimResult.claim.claimId,
        cancellationId: claimResult.claim.cancellationToken.tokenId,
      },
    });
  });

  test("returns dispatch conflicts and rejects registration without its claim", async () => {
    const registry = createRegistry();
    const manager = createManager(registry);
    await registry.start();
    const first = await manager.claimBackgroundToolDispatch(claimRequest());
    expect(first.kind).toBe("claimed");
    await expect(manager.claimBackgroundToolDispatch(claimRequest())).resolves.toEqual(first);
    const conflict = await manager.claimBackgroundToolDispatch({
      ...claimRequest(),
      ownerSessionId: "other-owner",
    });

    expect(conflict).toMatchObject({
      kind: "conflict",
      reason: "owner-mismatch",
    });

    await expect(
      manager.beginBackgroundToolInvocation(
        start({
          claimId: "missing",
          ownerSessionId: "session-1",
          toolCallId: "call-1",
          claimedAtMs: 1,
          cancellationToken: {
            tokenId: "missing-cancel",
            ownerSessionId: "session-1",
            claimId: "missing",
            issuedAtMs: 1,
          },
        }),
      ),
    ).rejects.toThrow("claim is invalid or stale");
  });

  test("registers from a durable claim after adapter restart", async () => {
    const persistence = new MemoryPersistence();
    const firstRegistry = createRegistry(persistence);
    const firstManager = createManager(firstRegistry);
    await firstRegistry.start();
    const claimed = await firstManager.claimBackgroundToolDispatch(claimRequest());
    if (claimed.kind !== "claimed") throw new Error("expected claim");
    await firstRegistry.shutdown();

    const restartedRegistry = createRegistry(persistence);
    const restartedManager = createManager(restartedRegistry);
    await restartedRegistry.start();
    await expect(
      restartedManager.beginBackgroundToolInvocation(start(claimed.claim)),
    ).resolves.toMatchObject({
      claim: claimed.claim,
      invocation: {
        status: "running",
      },
    });
  });

  test("rejects registration persistence failure without public visibility", async () => {
    const persistence = new MemoryPersistence();
    const registry = createRegistry(persistence);
    const manager = createManager(registry);
    await registry.start();
    const claimed = await manager.claimBackgroundToolDispatch(claimRequest());
    if (claimed.kind !== "claimed") throw new Error("expected claim");
    persistence.fail = true;

    await expect(manager.beginBackgroundToolInvocation(start(claimed.claim))).rejects.toThrow(
      "persistence unavailable",
    );
    expect(manager.listRunningTools()).toEqual([]);
    expect(manager.inspectRunningTool("session-1:call-1")).toMatchObject({
      success: false,
    });
  });

  test("checkpoint failure rejects and marks registered compatibility failed", async () => {
    const persistence = new MemoryPersistence();
    const registry = createRegistry(persistence);
    const manager = createManager(registry);
    await registry.start();
    const registration = await claimAndBegin(manager);
    persistence.fail = true;

    await expect(manager.checkpoint()).rejects.toThrow("persistence unavailable");
    expect(manager.inspectRunningTool(registration.handle)).toMatchObject({
      tool: {
        status: "failed",
        error: "Durable external-operation persistence failed",
      },
    });
  });

  test("requires explicit exact process owner and timestamp and awaits attachment", async () => {
    const registry = createRegistry();
    const manager = createManager(registry);
    await registry.start();
    const registration = await claimAndBegin(manager);
    const cancel = vi.fn<() => void>();

    await expect(
      manager.attachBackgroundToolProcess(registration.handle, {
        ownerSessionId: "exact-owner",
        rootPid: 42,
        spawnedAtMs: 1_000,
        cancellationScope: "process-tree",
        cancel,
      }),
    ).resolves.toMatchObject({
      process: {
        rootPid: 42,
        spawnedAtMs: 1_000,
        cancellationScope: "process-tree",
      },
    });
    const second = await claimAndBegin(manager, {
      ...claimRequest(),
      toolCallId: "call-2",
      idempotencyKey: "claim-2",
    });
    await expect(
      manager.attachBackgroundToolProcess(second.handle, {
        ownerSessionId: "",
        rootPid: 43,
        spawnedAtMs: 1_001,
        cancellationScope: "process-group",
        cancel,
      }),
    ).rejects.toThrow("owner");
  });

  test("issues and validates cancellation tokens", async () => {
    const registry = createRegistry();
    const manager = createManager(registry);
    await registry.start();
    const cancel = vi.fn<() => void>();
    const registration = await claimAndBegin(manager, claimRequest(), {
      cancel,
      cancellationScope: "tool",
    });

    await expect(
      manager.requestBackgroundToolCancellation({
        token: {
          ...registration.claim.cancellationToken,
          tokenId: "stale",
        },
        handle: registration.handle,
        requestedAtMs: 1_002_000,
      }),
    ).resolves.toMatchObject({
      success: false,
      error: "Cancellation request token is invalid or stale",
    });
    await expect(
      manager.requestBackgroundToolCancellation({
        token: registration.claim.cancellationToken,
        handle: registration.handle,
        requestedAtMs: 1_002_000,
      }),
    ).resolves.toMatchObject({
      success: true,
      status: "cancelled",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("restores rejected cancellation as cancelling and non-live", async () => {
    const persistence = new MemoryPersistence();
    const firstRegistry = createRegistry(persistence);
    const firstManager = createManager(firstRegistry);
    await firstRegistry.start();
    const registration = await claimAndBegin(firstManager, claimRequest(), {
      cancel: () => {
        throw new Error("provider rejected cancellation");
      },
      cancellationScope: "tool",
    });
    await expect(
      firstManager.requestBackgroundToolCancellation({
        token: registration.claim.cancellationToken,
        handle: registration.handle,
        requestedAtMs: 1_002_000,
      }),
    ).resolves.toMatchObject({ success: false });
    await firstRegistry.shutdown();

    const restartedRegistry = createRegistry(persistence);
    const restartedManager = createManager(restartedRegistry);
    await restartedRegistry.start();
    expect(restartedManager.inspectRunningTool(registration.handle)).toMatchObject({
      tool: {
        status: "cancelling",
        cancellable: false,
        cancellationScope: "tool",
      },
    });
  });

  test("inspect keeps the full in-memory result after the durable record compacts it", async () => {
    const registry = createRegistry();
    const manager = createManager(registry);
    await registry.start();
    const registration = await claimAndBegin(manager);
    const fullText = `${"x".repeat(9_000)}END-MARKER`;

    await manager.completeBackgroundToolInvocation(registration.handle, {
      success: true,
      result: fullText,
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const inspected = manager.inspectRunningTool(registration.handle);
      expect(inspected).toMatchObject({
        success: true,
        tool: { status: "completed", resultTruncated: true },
      });
      if (!inspected.success || !inspected.tool) throw new Error("expected inspected tool");
      expect(inspected.tool.result).toBe(fullText);
      expect(inspected.tool.outputPreview).toBe(fullText.slice(0, 4_000));
    }
  });

  test("inspect previews an object result instead of an opaque placeholder", async () => {
    const registry = createRegistry();
    const manager = createManager(registry);
    await registry.start();
    const registration = await claimAndBegin(manager);

    await manager.completeBackgroundToolInvocation(registration.handle, {
      success: true,
      result: { output: "hit list", success: true },
    });

    const inspected = manager.inspectRunningTool(registration.handle);
    if (!inspected.success || !inspected.tool) throw new Error("expected inspected tool");
    expect(inspected.tool.result).toEqual({ output: "hit list", success: true });
    expect(inspected.tool.outputPreview).toContain("hit list");
  });

  test("persists terminal completion before returning and restores unknown non-live", async () => {
    const persistence = new MemoryPersistence();
    const firstRegistry = createRegistry(persistence);
    const firstManager = createManager(firstRegistry);
    await firstRegistry.start();
    const registration = await claimAndBegin(firstManager);

    await expect(
      firstManager.completeBackgroundToolInvocation(registration.handle, {
        success: true,
        result: "done",
      }),
    ).resolves.toMatchObject({
      status: "completed",
    });
    expect(firstRegistry.list()[0].state).toBe("succeeded");

    const activeRequest = {
      ...claimRequest(),
      toolCallId: "call-2",
      idempotencyKey: "claim-2",
    };
    const active = await claimAndBegin(firstManager, activeRequest);
    await firstManager.detachBackgroundToolInvocation(active.handle);
    await firstRegistry.shutdown();

    const restartedRegistry = createRegistry(persistence);
    const restartedManager = createManager(restartedRegistry);
    await restartedRegistry.start();
    expect(restartedManager.inspectRunningTool(active.handle)).toMatchObject({
      success: true,
      tool: {
        status: "unknown",
        cancellable: false,
      },
    });
  });
});

function createRegistry(
  persistence: ExternalOperationPersistence = new MemoryPersistence(),
): ExternalOperationRegistry {
  let nextId = 0;
  return new ExternalOperationRegistry({
    store: new ExternalOperationStore(persistence),
    now: () => REGISTRY_NOW_MS,
    createId: () => `id-${++nextId}`,
  });
}

function createManager(
  registry: ExternalOperationRegistry,
): BackgroundToolInvocationRegistryAdapter {
  return new BackgroundToolInvocationRegistryAdapter({
    registry,
    resolveGoalFence: () => ({
      goalId: "goal-1",
      epoch: 2,
    }),
    now: () => 1_001_000,
  });
}

function claimRequest(): BackgroundToolDispatchClaimRequest {
  return {
    ownerSessionId: "session-1",
    toolCallId: "call-1",
    toolName: "long-tool",
    requestedAtMs: 1_000_000,
    idempotencyKey: "claim-1",
  };
}

function start(
  claim: BackgroundToolDispatchClaim,
  overrides: Partial<
    Parameters<BackgroundToolInvocationRegistryAdapter["beginBackgroundToolInvocation"]>[0]
  > = {},
) {
  return {
    claim,
    sessionId: claim.ownerSessionId,
    toolCallId: claim.toolCallId,
    toolName: "long-tool",
    startedAtMs: 1_000_100,
    ...overrides,
  };
}

async function claimAndBegin(
  manager: BackgroundToolInvocationRegistryAdapter,
  request = claimRequest(),
  overrides: Partial<
    Parameters<BackgroundToolInvocationRegistryAdapter["beginBackgroundToolInvocation"]>[0]
  > = {},
) {
  const claimed = await manager.claimBackgroundToolDispatch(request);
  if (claimed.kind !== "claimed") throw new Error(`claim conflict: ${claimed.reason}`);
  return await manager.beginBackgroundToolInvocation(start(claimed.claim, overrides));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
