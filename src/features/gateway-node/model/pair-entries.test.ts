import type { NodeActivityEntry } from "@common/marshal-ipc-contract";
import { describe, expect, it } from "vitest";

import { pairEntries } from "./pair-entries";

let seq = 0;
function entry(
  overrides: Partial<NodeActivityEntry> & {
    direction: NodeActivityEntry["direction"];
    invocationId: string;
  },
): NodeActivityEntry {
  return {
    id: `id-${++seq}`,
    timestamp: Date.now(),
    command: "test/tool",
    status: overrides.direction === "inbound" ? "received" : "ok",
    durationMs: undefined,
    ...overrides,
  };
}

describe("pairEntries", () => {
  it("pairs an inbound + outbound by invocationId in arrival order", () => {
    const inbound = entry({ direction: "inbound", invocationId: "inv-1" });
    const outbound = entry({ direction: "outbound", invocationId: "inv-1" });
    const pairs = pairEntries([inbound, outbound]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].inbound).toBe(inbound);
    expect(pairs[0].outbound).toBe(outbound);
  });

  it("leaves outbound undefined while only inbound has arrived (in-flight row)", () => {
    const inbound = entry({ direction: "inbound", invocationId: "inv-2" });
    const pairs = pairEntries([inbound]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].inbound).toBe(inbound);
    expect(pairs[0].outbound).toBeUndefined();
  });

  it("outbound-first orphan does NOT populate inbound — leaves inbound undefined", () => {
    const outbound = entry({ direction: "outbound", invocationId: "inv-3" });
    const pairs = pairEntries([outbound]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].inbound).toBeUndefined();
    expect(pairs[0].outbound).toBe(outbound);
  });

  it("a second outbound for the same invocationId overwrites without adding a new row", () => {
    const inbound = entry({ invocationId: "x", direction: "inbound" });
    const out1 = entry({ invocationId: "x", direction: "outbound", durationMs: 5, status: "ok" });
    const out2 = entry({ invocationId: "x", direction: "outbound", durationMs: 9, status: "ok" });
    const pairs = pairEntries([inbound, out1, out2]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].outbound).toEqual(out2);
  });

  it("preserves arrival order across multiple invocationIds", () => {
    const a = entry({ direction: "inbound", invocationId: "inv-a" });
    const b = entry({ direction: "inbound", invocationId: "inv-b" });
    const c = entry({ direction: "inbound", invocationId: "inv-c" });
    const pairs = pairEntries([a, b, c]);
    expect(pairs.map((p) => p.invocationId)).toEqual(["inv-a", "inv-b", "inv-c"]);
  });
});
