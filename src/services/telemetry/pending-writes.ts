export const MAX_PENDING_TELEMETRY_WRITES = 128;

type PendingTelemetryWrite = {
  write: () => Promise<void>;
  important: boolean;
};

export interface TelemetryWriteEnqueueResult {
  accepted: boolean;
  evictedBestEffort: boolean;
  pendingCount: number;
}

const queuedWrites: PendingTelemetryWrite[] = [];
let activeWrite: PendingTelemetryWrite | null = null;
let drainPromise: Promise<void> | null = null;
let finalizing = false;

export function resetTelemetryFinalization(): void {
  finalizing = false;
}

export function beginTelemetryFinalization(): void {
  finalizing = true;
}

export function isTelemetryFinalizing(): boolean {
  return finalizing;
}

function pendingCount(): number {
  return queuedWrites.length + (activeWrite ? 1 : 0);
}

export function enqueueTelemetryWrite(
  write: () => Promise<void>,
  options: { important?: boolean } = {},
): TelemetryWriteEnqueueResult {
  if (finalizing) {
    return { accepted: false, evictedBestEffort: false, pendingCount: pendingCount() };
  }

  const important = options.important ?? false;
  let evictedBestEffort = false;
  if (pendingCount() >= MAX_PENDING_TELEMETRY_WRITES) {
    if (!important) {
      return { accepted: false, evictedBestEffort, pendingCount: pendingCount() };
    }
    const evictionIndex = queuedWrites.findIndex((entry) => !entry.important);
    if (evictionIndex < 0) {
      return { accepted: false, evictedBestEffort, pendingCount: pendingCount() };
    }
    queuedWrites.splice(evictionIndex, 1);
    evictedBestEffort = true;
  }

  queuedWrites.push({ write, important });
  ensureDrain();
  return { accepted: true, evictedBestEffort, pendingCount: pendingCount() };
}

function ensureDrain(): void {
  if (drainPromise) return;
  const running = drainTelemetryWrites();
  drainPromise = running;
  void running.then(
    () => finishDrain(running),
    () => finishDrain(running),
  );
}

function finishDrain(running: Promise<void>): void {
  if (drainPromise !== running) return;
  drainPromise = null;
  if (queuedWrites.length > 0) ensureDrain();
}

async function drainTelemetryWrites(): Promise<void> {
  let firstError: unknown;
  while (queuedWrites.length > 0) {
    const next = queuedWrites.shift();
    if (!next) continue;
    activeWrite = next;
    try {
      // eslint-disable-next-line no-await-in-loop -- a single renderer writer preserves event order
      await next.write();
    } catch (error) {
      firstError ??= error;
    } finally {
      activeWrite = null;
    }
  }
  if (firstError !== undefined) throw firstError;
}

export async function flushPendingTelemetryWrites(): Promise<void> {
  let firstError: unknown;
  for (;;) {
    const running = drainPromise;
    if (!running) {
      if (queuedWrites.length > 0) {
        ensureDrain();
        continue;
      }
      if (firstError !== undefined) throw firstError;
      return;
    }
    try {
      // eslint-disable-next-line no-await-in-loop -- finalization must follow drain replacements until the queue is empty
      await running;
    } catch (error) {
      firstError ??= error;
    }
  }
}
