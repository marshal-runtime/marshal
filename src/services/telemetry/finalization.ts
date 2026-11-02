import { beginTelemetryFinalization, flushPendingTelemetryWrites } from "./pending-writes";

interface Finalizer {
  priority: number;
  callback: () => void;
}

const finalizers = new Set<Finalizer>();

export function registerTelemetryFinalizer(priority: number, callback: () => void): () => void {
  const finalizer = { priority, callback };
  finalizers.add(finalizer);
  return () => finalizers.delete(finalizer);
}

export function finalizeTelemetrySync(): void {
  for (const finalizer of [...finalizers].sort((a, b) => b.priority - a.priority)) {
    finalizer.callback();
  }
}

export async function finalizeTelemetry(): Promise<void> {
  finalizeTelemetrySync();
  beginTelemetryFinalization();
  await flushPendingTelemetryWrites();
}
