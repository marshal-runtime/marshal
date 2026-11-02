// Marshal-owned module.
import type { NodeActivityEntry } from "@common/marshal-ipc-contract";

export interface PairedInvocation {
  invocationId: string;
  command: string;
  inbound: NodeActivityEntry | undefined;
  outbound: NodeActivityEntry | undefined;
}

export function pairEntries(entries: ReadonlyArray<NodeActivityEntry>): PairedInvocation[] {
  const byId = new Map<string, PairedInvocation>();
  const order: string[] = [];
  for (const entry of entries) {
    const existing = byId.get(entry.invocationId);
    if (existing) {
      if (entry.direction === "outbound") existing.outbound = entry;
      // Two inbounds with the same id is malformed — keep the first.
      continue;
    }
    byId.set(entry.invocationId, {
      invocationId: entry.invocationId,
      command: entry.command,
      inbound: entry.direction === "inbound" ? entry : undefined,
      outbound: entry.direction === "outbound" ? entry : undefined,
    });
    order.push(entry.invocationId);
  }
  return order.map((id) => byId.get(id)).filter((p): p is PairedInvocation => p !== undefined);
}
