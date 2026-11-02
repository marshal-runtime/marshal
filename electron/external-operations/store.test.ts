import { describe, expect, test } from "vitest";

import {
  ExternalOperationStore,
  MAX_EXTERNAL_OPERATION_RECORDS,
  type ExternalOperationPersistence,
} from "./store";
import type { ExternalOperationJson, StoredExternalOperationRecord } from "./types";

class MemoryPersistence implements ExternalOperationPersistence {
  constructor(public content: string | null = null) {}

  async load(): Promise<string | null> {
    return this.content;
  }

  async save(content: string): Promise<void> {
    this.content = content;
  }
}

describe("ExternalOperationStore bounds", () => {
  test("round-trips a canonical public record with internal durable state", async () => {
    const persistence = new MemoryPersistence();
    const store = new ExternalOperationStore(persistence);
    const record = makeRecord();

    await store.save([record]);
    await expect(store.load()).resolves.toEqual([
      expect.objectContaining({
        operationId: record.operationId,
        publicRecord: expect.objectContaining(record.publicRecord),
      }),
    ]);
  });

  test("compacts completed history before enforcing store bounds", async () => {
    const records = Array.from({ length: MAX_EXTERNAL_OPERATION_RECORDS + 1 }, (_, index) => ({
      ...makeRecord(index, true),
      ...(index === MAX_EXTERNAL_OPERATION_RECORDS
        ? {
            revision: 201,
            journal: Array.from({ length: 201 }, (_unused, eventIndex) => ({
              eventId: `event-${eventIndex}`,
              kind: "heartbeat",
              at: "2026-07-19T10:00:00.000Z",
            })),
          }
        : {}),
    }));
    const persistence = new MemoryPersistence(JSON.stringify({ version: 1, records }));
    const store = new ExternalOperationStore(persistence);

    await expect(store.load()).resolves.toHaveLength(MAX_EXTERNAL_OPERATION_RECORDS);

    expect(JSON.parse(persistence.content ?? "").records).toHaveLength(
      MAX_EXTERNAL_OPERATION_RECORDS,
    );
    expect(persistence.content).not.toContain('"journal"');
    expect(persistence.content).not.toContain('"revision"');
  });

  test("rejects future store versions", async () => {
    const persistence = new MemoryPersistence(
      JSON.stringify({
        version: 999,
        records: [],
      }),
    );
    await expect(new ExternalOperationStore(persistence).load()).rejects.toThrow(
      "Unsupported external-operation store version",
    );
  });

  test("rejects excessive JSON depth and strings", async () => {
    const deep = makeRecord();
    const deepReceipt: Record<string, ExternalOperationJson> = {};
    let cursor = deepReceipt;
    deep.receipt = deepReceipt;
    for (let index = 0; index < 10; index++) {
      const next: Record<string, ExternalOperationJson> = {};
      cursor.next = next;
      cursor = next;
    }
    await expect(new ExternalOperationStore(new MemoryPersistence()).save([deep])).rejects.toThrow(
      "JSON depth",
    );

    const long = makeRecord();
    long.lastError = "x".repeat(4_001);
    await expect(new ExternalOperationStore(new MemoryPersistence()).save([long])).rejects.toThrow(
      "string length",
    );
  });

  test("rejects public/stored identity mismatch", async () => {
    const record = makeRecord();
    const persistence = new MemoryPersistence(
      JSON.stringify({
        version: 1,
        records: [
          {
            ...record,
            publicRecord: {
              ...record.publicRecord,
              idempotencyKey: "different",
            },
          },
        ],
      }),
    );
    await expect(new ExternalOperationStore(persistence).load()).rejects.toThrow(
      "identity does not match",
    );
  });

  test("requires and cross-validates the minimal goal fence", async () => {
    const record = makeRecord();
    const persisted = JSON.parse(JSON.stringify(record));
    delete persisted.goalFence.epoch;
    await expect(
      new ExternalOperationStore(
        new MemoryPersistence(JSON.stringify({ version: 1, records: [persisted] })),
      ).load(),
    ).rejects.toThrow("epoch");

    const mismatched = JSON.parse(JSON.stringify(record));
    mismatched.publicRecord.fence.epoch += 1;
    await expect(
      new ExternalOperationStore(
        new MemoryPersistence(JSON.stringify({ version: 1, records: [mismatched] })),
      ).load(),
    ).rejects.toThrow("identity does not match");
  });

  test("rejects unredacted sensitive receipt fields", async () => {
    const record = makeRecord();
    record.receipt = {
      accessToken: "secret",
    };
    await expect(
      new ExternalOperationStore(new MemoryPersistence()).save([record]),
    ).rejects.toThrow("unredacted sensitive field");
  });
});

function makeRecord(index = 1, terminal = false): StoredExternalOperationRecord {
  const fence = {
    goalId: "goal-1",
    epoch: 2,
  };
  return {
    publicRecord: {
      operationId: `operation-${index}`,
      fence,
      idempotencyKey: `goal-1:operation-${index}`,
      kind: "background-tool",
      effect: "side-effect",
      requestedAt: "2026-07-19T10:00:00.000Z",
      status: terminal ? "succeeded" : "planned",
      attempt: 0,
      updatedAt: "2026-07-19T10:00:00.000Z",
    },
    operationId: `operation-${index}`,
    idempotencyKey: `goal-1:operation-${index}`,
    goalFence: fence,
    metadata: {},
    contract: {},
    provider: {
      kind: "host-tool",
      provider: "host",
      adapterId: "adapter",
    },
    identity: {},
    cancellationScope: "operation",
    actionSemantics: "non-idempotent",
    detached: true,
    state: terminal ? "succeeded" : "registered",
    watcher: {
      strategy: "host",
      intervalMs: 5_000,
      leaseDurationMs: 60_000,
    },
    retention: {},
    notification: {
      state: "not-required",
    },
    terminalEvent: terminal
      ? {
          eventId: `terminal-${index}`,
          idempotencyKey: `terminal-operation-${index}`,
          state: "succeeded",
          occurredAt: new Date(Date.parse("2026-07-19T10:00:00.000Z") + index).toISOString(),
        }
      : undefined,
    createdAt: "2026-07-19T10:00:00.000Z",
    updatedAt: "2026-07-19T10:00:00.000Z",
  };
}
