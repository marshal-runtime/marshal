interface PendingToolInvocation {
  toolCallId: string;
  signal?: AbortSignal;
}

const MAX_PENDING_INVOCATIONS_PER_TOOL = 100;

export class ClaudeToolInvocationRegistry {
  private readonly pending = new Map<string, PendingToolInvocation[]>();

  record(toolName: string, toolCallId: string, signal?: AbortSignal): void {
    const queue = this.pending.get(toolName) ?? [];
    const existing = queue.find((entry) => entry.toolCallId === toolCallId);
    if (existing) {
      if (signal) existing.signal = signal;
      return;
    }
    if (queue.length >= MAX_PENDING_INVOCATIONS_PER_TOOL) queue.shift();
    queue.push({ toolCallId, signal });
    this.pending.set(toolName, queue);
  }

  discard(toolName: string, toolCallId: string): void {
    const queue = this.pending.get(toolName);
    if (!queue) return;
    const index = queue.findIndex((entry) => entry.toolCallId === toolCallId);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.pending.delete(toolName);
  }

  take(toolName: string): PendingToolInvocation | undefined {
    const queue = this.pending.get(toolName);
    const invocation = queue?.shift();
    if (queue?.length === 0) this.pending.delete(toolName);
    return invocation;
  }

  clear(): void {
    this.pending.clear();
  }
}
