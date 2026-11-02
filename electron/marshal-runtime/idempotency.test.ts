import { describe, expect, it } from "vitest";

import type { MarshalRuntimeApiResult } from "./contracts";
import { RuntimeIdempotencyStore } from "./idempotency";

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise?.() };
}

describe("RuntimeIdempotencyStore", () => {
  it("honors a pre-aborted caller when post-start aborts are disabled", async () => {
    const controller = new AbortController();
    controller.abort();
    const store = new RuntimeIdempotencyStore();

    await expect(
      store.execute(
        {
          operation: "memory.store",
          identity: "session",
          idempotencyKey: "pre-aborted",
          payload: {},
          signal: controller.signal,
          abortAfterStart: false,
        },
        async () => ({ ok: true, value: "stored", receipts: [] }),
      ),
    ).rejects.toMatchObject({ code: "aborted" });
  });

  it("waits for an operation that cannot be cancelled after it starts", async () => {
    const controller = new AbortController();
    const release = deferred();
    const store = new RuntimeIdempotencyStore();
    const expected: MarshalRuntimeApiResult<string> = {
      ok: true,
      value: "stored",
      receipts: [],
    };
    const pending = store.execute(
      {
        operation: "memory.store",
        identity: "session",
        idempotencyKey: "commit",
        payload: {},
        signal: controller.signal,
        abortAfterStart: false,
      },
      async (signal) => {
        await release.promise;
        expect(signal.aborted).toBe(false);
        return expected;
      },
    );

    controller.abort();
    release.resolve();

    await expect(pending).resolves.toEqual(expected);
  });
});
