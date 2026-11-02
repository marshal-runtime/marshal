import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NodeActivityEntry } from "../../../../common/marshal-ipc-contract";
import { registerGatewayNodeActivityHandlers } from "./activity-ipc";
import type { GatewayNodeActivityRecord } from "./activity-journal";
import { GatewayNodeActivityJournal } from "./activity-journal";

function makeRecord(overrides: Partial<GatewayNodeActivityRecord> = {}): GatewayNodeActivityRecord {
  return {
    direction: "inbound",
    command: "mcp.fs.read",
    invocationId: "test-id",
    status: "received",
    ...overrides,
  };
}

describe("registerGatewayNodeActivityHandlers", () => {
  let log: GatewayNodeActivityJournal;
  let broadcast: ReturnType<typeof vi.fn<(channel: string, payload: unknown) => void>>;
  let handlers: Map<string, (...args: unknown[]) => unknown>;

  beforeEach(() => {
    log = new GatewayNodeActivityJournal();
    broadcast = vi.fn<(channel: string, payload: unknown) => void>();
    handlers = new Map();
  });

  function makeIpcHandle() {
    return (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    };
  }

  it("broadcasts each push on the activity log to the renderer channel", () => {
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only: partial mock conforming to interface
    registerGatewayNodeActivityHandlers({
      ipcHandle: makeIpcHandle(),
      broadcast,
      log,
    } as unknown as Parameters<typeof registerGatewayNodeActivityHandlers>[0]);
    const record = makeRecord();
    const entry = log.push(record);
    expect(broadcast).toHaveBeenCalledWith("gatewayNode:activity", entry);
  });

  it("registers a getActivity handler that returns the snapshot", async () => {
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only: partial mock conforming to interface
    registerGatewayNodeActivityHandlers({
      ipcHandle: makeIpcHandle(),
      broadcast,
      log,
    } as unknown as Parameters<typeof registerGatewayNodeActivityHandlers>[0]);
    const entry = log.push(makeRecord({ invocationId: "a" }));

    const handler = handlers.get("gatewayNode:getActivity");
    expect(handler).toBeDefined();
    const res = await handler!();
    expect(res).toMatchObject({ success: true, entries: [{ invocationId: "a" }] });
    const entries = (res as { entries: NodeActivityEntry[] }).entries; // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- test: accessing typed response payload
    expect(entries[0]).toBe(entry);
  });

  it("returns an unsubscribe fn that detaches the broadcast subscriber", () => {
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only: partial mock conforming to interface
    const unsub = registerGatewayNodeActivityHandlers({
      ipcHandle: makeIpcHandle(),
      broadcast,
      log,
    } as unknown as Parameters<typeof registerGatewayNodeActivityHandlers>[0]);
    log.push(makeRecord({ invocationId: "before" }));
    expect(broadcast).toHaveBeenCalledTimes(1);
    unsub();
    log.push(makeRecord({ invocationId: "after-unsub" }));
    expect(broadcast).toHaveBeenCalledTimes(1);
  });
});
