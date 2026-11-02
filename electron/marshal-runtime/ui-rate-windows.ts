import type { RuntimeUiInstance } from "../../common/runtime-ui";
import { failure } from "./ui-controller-support";

const SWEEP_THRESHOLD = 256;

/**
 * Budget bucket for an application's own bridge call. Reads have their own
 * bucket so a polling view can never starve its writes (user input).
 */
export type RuntimeUiApplicationCallKind = "read" | "write";

/** Sliding-window command budgets keyed by caller-chosen buckets. */
export class RuntimeUiRateWindows {
  private readonly windows = new Map<string, number[]>();

  constructor(
    private readonly clock: () => number,
    private readonly windowMs: number,
  ) {}

  consume(key: string, limit: number, message: string): void {
    const now = this.clock();
    const threshold = now - this.windowMs;
    const window = (this.windows.get(key) ?? []).filter((timestamp) => timestamp > threshold);
    if (window.length >= limit) {
      this.windows.set(key, window);
      throw failure("operation-failed", message);
    }
    window.push(now);
    this.windows.set(key, window);
    if (this.windows.size > SWEEP_THRESHOLD) this.sweep(threshold);
  }

  clear(): void {
    this.windows.clear();
  }

  private sweep(threshold: number): void {
    for (const [key, window] of this.windows) {
      if ((window.at(-1) ?? 0) <= threshold) this.windows.delete(key);
    }
  }
}

/**
 * A capability call is a read only when every manifest action targeting it is
 * declared `risk: "read"`; resource reads (no capability) are reads. Anything
 * undeclared (tools, render-plane calls) is budgeted as a write.
 */
export function applicationCallKind(
  instance: RuntimeUiInstance,
  capability: string | undefined,
): RuntimeUiApplicationCallKind {
  if (capability === undefined) return "read";
  if (instance.content.kind !== "application") return "write";
  const actions = instance.content.descriptor.actions.filter(
    (action) => action.target.kind === "capability" && action.target.capability === capability,
  );
  return actions.length > 0 && actions.every((action) => action.risk === "read") ? "read" : "write";
}
