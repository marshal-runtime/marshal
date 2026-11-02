import { afterEach, expect, it, vi } from "vitest";

import {
  enqueueTelemetryWrite,
  flushPendingTelemetryWrites,
  MAX_PENDING_TELEMETRY_WRITES,
  resetTelemetryFinalization,
} from "./pending-writes";

afterEach(async () => {
  resetTelemetryFinalization();
  await flushPendingTelemetryWrites().catch(() => undefined);
});

it("drains writes added while a flush is in progress in submission order", async () => {
  let resolveFirst!: () => void;
  const order: string[] = [];
  enqueueTelemetryWrite(
    () =>
      new Promise<void>((resolve) => {
        resolveFirst = () => {
          order.push("first");
          resolve();
        };
      }),
  );

  const flushed = vi.fn<() => void>();
  const flush = flushPendingTelemetryWrites().then(flushed);
  enqueueTelemetryWrite(async () => {
    order.push("second");
  });
  resolveFirst();
  await Promise.resolve();
  expect(flushed).not.toHaveBeenCalled();

  await flush;
  expect(flushed).toHaveBeenCalledOnce();
  expect(order).toEqual(["first", "second"]);
});

it("bounds pending work and admits an important event by evicting best-effort work", async () => {
  let releaseActive!: () => void;
  const executed: number[] = [];
  enqueueTelemetryWrite(
    () =>
      new Promise<void>((resolve) => {
        releaseActive = resolve;
      }),
    { important: true },
  );
  for (let index = 0; index < MAX_PENDING_TELEMETRY_WRITES - 1; index++) {
    expect(
      enqueueTelemetryWrite(async () => {
        executed.push(index);
      }).accepted,
    ).toBe(true);
  }

  expect(enqueueTelemetryWrite(async () => {}).accepted).toBe(false);
  const important = enqueueTelemetryWrite(
    async () => {
      executed.push(MAX_PENDING_TELEMETRY_WRITES);
    },
    { important: true },
  );
  expect(important).toMatchObject({
    accepted: true,
    evictedBestEffort: true,
    pendingCount: MAX_PENDING_TELEMETRY_WRITES,
  });

  releaseActive();
  await flushPendingTelemetryWrites();
  expect(executed).toEqual([
    ...Array.from({ length: MAX_PENDING_TELEMETRY_WRITES - 2 }, (_, index) => index + 1),
    MAX_PENDING_TELEMETRY_WRITES,
  ]);
});

it("preserves FIFO order across multiple important events", async () => {
  let releaseActive!: () => void;
  const order: string[] = [];
  enqueueTelemetryWrite(
    () =>
      new Promise<void>((resolve) => {
        releaseActive = resolve;
      }),
    { important: true },
  );
  enqueueTelemetryWrite(
    async () => {
      order.push("important-1");
    },
    { important: true },
  );
  enqueueTelemetryWrite(
    async () => {
      order.push("important-2");
    },
    { important: true },
  );

  releaseActive();
  await flushPendingTelemetryWrites();
  expect(order).toEqual(["important-1", "important-2"]);
});

it("propagates the first failure after later queued writes have drained", async () => {
  const later = vi.fn<() => void>();
  enqueueTelemetryWrite(async () => {
    throw new Error("write failed");
  });
  enqueueTelemetryWrite(async () => {
    later();
  });

  await expect(flushPendingTelemetryWrites()).rejects.toThrow("write failed");
  expect(later).toHaveBeenCalledOnce();
});
