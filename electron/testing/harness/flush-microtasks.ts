/**
 * Drain the microtask queue by chaining `process.nextTick` promises.
 * Replaces the `for (let i = 0; i < n; i++) await new Promise(r => process.nextTick(r))` pattern
 * that triggers `no-await-in-loop`.
 */
// Marshal ownership: relocated module identity.
export function flushMicrotasks(n = 20): Promise<void> {
  return Array.from({ length: n }).reduce(
    (p: Promise<void>) => p.then(() => new Promise<void>((r) => process.nextTick(r))),
    Promise.resolve(),
  );
}
