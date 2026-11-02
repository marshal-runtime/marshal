import { describe, expect, test, vi } from "vitest";

import type { ExternalOperationRequest } from "../../common/external-operation-contract";
import { createProviderReceiptAdapter } from "./adapters";
import { ExternalOperationReconciler } from "./reconciler";
import { ExternalOperationRegistry } from "./registry";
import { ExternalOperationStore, type ExternalOperationPersistence } from "./store";

class MemoryPersistence implements ExternalOperationPersistence {
  content: string | null = null;
  async load() {
    return this.content;
  }
  async save(content: string) {
    this.content = content;
  }
}

describe("ExternalOperationReconciler shutdown", () => {
  test("sets the stopping fence before draining and never resubscribes", async () => {
    const subscribe = vi.fn<() => () => void>(() => vi.fn<() => void>());
    const adapter = createProviderReceiptAdapter({
      adapterId: "provider",
      providerKinds: ["provider"],
      supportedCancellationScopes: ["operation"],
      resolve: () => ({
        inspect: async () => ({ state: "running" }),
        cancel: async (scope) => ({ accepted: true, scope }),
        subscribe,
      }),
    });
    const registry = new ExternalOperationRegistry({
      store: new ExternalOperationStore(new MemoryPersistence()),
      adapters: [adapter],
    });
    await registry.start();
    const request: ExternalOperationRequest = {
      operationId: "operation-1",
      fence: {
        goalId: "goal-1",
        epoch: 1,
      },
      idempotencyKey: "goal-1:operation-1",
      kind: "provider-task",
      effect: "side-effect",
      requestedAt: "2026-07-19T10:00:00.000Z",
    };
    await registry.register({
      request,
      provider: {
        kind: "provider",
        provider: "remote",
        adapterId: "provider",
      },
      cancellationScope: "operation",
      actionSemantics: "non-idempotent",
      watcher: { strategy: "push" },
    });
    const identity = {
      operationId: request.operationId,
      fence: request.fence,
      idempotencyKey: request.idempotencyKey,
    };
    const claim = await registry.claimDispatch({ identity, claimedBy: "worker" });
    await registry.attach({
      identity,
      claimToken: claim.claim.claimToken,
      receipt: { externalReference: "remote-1" },
    });

    const reconciler = new ExternalOperationReconciler(registry, {
      intervalMs: 60_000,
    });
    await reconciler.start();
    const beforeShutdown = subscribe.mock.calls.length;
    await reconciler.shutdown();
    await reconciler.reconcileNow(true);

    expect(subscribe.mock.calls.length).toBe(beforeShutdown);
  });
});
