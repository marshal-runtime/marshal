import { describe, it, expect, vi } from "vitest";

import type { NodeActivityEntry } from "../../../../common/marshal-ipc-contract";
import { GATEWAY_NODE_ACTIVITY_CAPACITY, GatewayNodeActivityJournal } from "./activity-journal";

describe("GatewayNodeActivityJournal", () => {
  it("appends entries and surfaces them via getAll() in chronological order", () => {
    const log = new GatewayNodeActivityJournal();
    log.push({
      direction: "inbound",
      command: "mcp.fs.read_file",
      invocationId: "inv-1",
      status: "received",
    });
    log.push({
      direction: "outbound",
      command: "mcp.fs.read_file",
      invocationId: "inv-1",
      status: "ok",
      durationMs: 42,
      resultPreview: "(file contents)",
    });
    const entries = log.getAll();
    expect(entries).toHaveLength(2);
    expect(entries[0].direction).toBe("inbound");
    expect(entries[1].direction).toBe("outbound");
    expect(entries[1].durationMs).toBe(42);
  });

  it("fills in id and timestamp for each push (producer doesn't supply them)", () => {
    const log = new GatewayNodeActivityJournal();
    const before = Date.now();
    const entry = log.push({
      direction: "inbound",
      command: "mcp.fs.list_directory",
      invocationId: "inv-x",
      status: "received",
    });
    expect(typeof entry.id).toBe("string");
    expect(entry.id.length).toBeGreaterThan(0);
    expect(entry.timestamp).toBeGreaterThanOrEqual(before);
  });

  it("trims oldest entries when over capacity", () => {
    const log = new GatewayNodeActivityJournal();
    for (let i = 0; i < GATEWAY_NODE_ACTIVITY_CAPACITY + 10; i++) {
      log.push({
        direction: "inbound",
        command: `mcp.fs.tool-${i}`,
        invocationId: `inv-${i}`,
        status: "received",
      });
    }
    const entries = log.getAll();
    expect(entries).toHaveLength(GATEWAY_NODE_ACTIVITY_CAPACITY);
    expect(entries[0].command).toBe("mcp.fs.tool-10");
    expect(entries.at(-1)?.command).toBe(`mcp.fs.tool-${GATEWAY_NODE_ACTIVITY_CAPACITY + 10 - 1}`);
  });

  it("truncates long paramsPreview / resultPreview to keep RAM bounded", () => {
    const log = new GatewayNodeActivityJournal();
    const huge = "x".repeat(5000);
    const entry = log.push({
      direction: "outbound",
      command: "mcp.fs.read_file",
      invocationId: "inv-big",
      status: "ok",
      resultPreview: huge,
    });
    expect((entry.resultPreview ?? "").length).toBeLessThanOrEqual(241); // 240 + "…"
    expect((entry.resultPreview ?? "").endsWith("…")).toBe(true);
  });

  it("notifies subscribers synchronously on each push", () => {
    const log = new GatewayNodeActivityJournal();
    const sub = vi.fn<(entry: NodeActivityEntry) => void>();
    const unsub = log.subscribe(sub);
    log.push({
      direction: "inbound",
      command: "mcp.fs.read_file",
      invocationId: "inv-1",
      status: "received",
    });
    expect(sub).toHaveBeenCalledTimes(1);
    expect(sub.mock.calls[0]?.[0]).toMatchObject({
      direction: "inbound",
      command: "mcp.fs.read_file",
    });

    unsub();
    log.push({
      direction: "outbound",
      command: "mcp.fs.read_file",
      invocationId: "inv-1",
      status: "ok",
    });
    expect(sub).toHaveBeenCalledTimes(1);
  });

  it("doesn't break when a subscriber throws — others still fire", () => {
    const log = new GatewayNodeActivityJournal();
    const ok = vi.fn<(entry: NodeActivityEntry) => void>();
    log.subscribe(() => {
      throw new Error("subscriber boom");
    });
    log.subscribe(ok);
    expect(() =>
      log.push({
        direction: "inbound",
        command: "mcp.fs.read_file",
        invocationId: "inv-1",
        status: "received",
      }),
    ).not.toThrow();
    expect(ok).toHaveBeenCalled();
  });

  it("clear() empties the buffer", () => {
    const log = new GatewayNodeActivityJournal();
    log.push({
      direction: "inbound",
      command: "mcp.fs.read_file",
      invocationId: "inv-1",
      status: "received",
    });
    expect(log.getAll()).toHaveLength(1);
    log.clear();
    expect(log.getAll()).toHaveLength(0);
  });

  it("getAll() returns a defensive copy — mutating it doesn't affect the log", () => {
    const log = new GatewayNodeActivityJournal();
    log.push({
      direction: "inbound",
      command: "mcp.fs.read_file",
      invocationId: "inv-1",
      status: "received",
    });
    const copy = log.getAll();
    copy.push({
      id: "fake",
      timestamp: 0,
      direction: "outbound",
      command: "fake",
      invocationId: "fake",
      status: "ok",
    });
    expect(log.getAll()).toHaveLength(1);
  });
});
