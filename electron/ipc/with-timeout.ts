export class OperationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationTimeoutError";
  }
}

/**
 * Races `operation` against a rejection timer.
 * Throws an Error if the operation does not settle within `ms` milliseconds.
 * The timer is cleared when the operation settles to avoid zombie timers.
 */
export function withTimeout<T>(ms: number, operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wrapped = operation.finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  const result = Promise.race([
    wrapped,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new OperationTimeoutError(`Operation timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]);
  // Suppress unhandled rejection from the orphaned operation if timeout wins
  wrapped.catch(() => {});
  return result;
}

/**
 * Like `withTimeout`, but the timer resets each time `heartbeat()` is called.
 * Useful for long-running operations that emit periodic progress (e.g. streaming).
 *
 * @param ms        Inactivity timeout — resets on every heartbeat
 * @param start     Callback that receives a `heartbeat` function and returns the operation promise
 */
export function withRollingTimeout<T>(
  ms: number,
  start: (heartbeat: () => void) => { promise: Promise<T>; cleanup?: () => void },
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  let settled = false;

  return new Promise<T>((resolve, reject) => {
    const fail = () => {
      if (settled) return;
      settled = true;
      ctx.cleanup?.();
      reject(new OperationTimeoutError(`Operation timed out after ${ms}ms of inactivity`));
    };

    const resetTimer = () => {
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(fail, ms);
    };

    const ctx = start(resetTimer);

    // Start initial timer only if start() didn't already call resetTimer().
    // setTimeout is a macrotask so fail() can safely reference ctx — it is
    // always assigned before any timer callback can fire.
    resetTimer();
    ctx.promise.then(
      (val) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          ctx.cleanup?.();
          resolve(val);
        }
      },
      (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          ctx.cleanup?.();
          reject(err);
        }
      },
    );
  });
}
