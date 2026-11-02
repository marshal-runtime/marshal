/**
 * Temporarily override `process.platform` for the duration of a test callback.
 *
 * Use case: the host shell mode (`getShellMode()` in `shell-syntax-permission-utils.ts`)
 * and other branches across the codebase (`platform-security.ts`, build script
 * detection, etc.) read `process.platform`. Tests that assert behavior for one
 * specific platform should pin it explicitly so they're stable regardless of
 * CI host OS.
 *
 * Both sync and async callbacks are supported via overloads — the async form
 * awaits the callback's promise before restoring `process.platform`, so
 * platform-sensitive code that runs inside a `Promise` chain still sees the
 * pinned value. Passing an async function to the sync signature would skip
 * that await and restore early; the overload makes the right shape the only
 * shape the type-checker accepts.
 *
 * Exception-safe in both branches — `process.platform` is restored even if
 * the callback throws or rejects.
 */
export function withPlatform(platform: NodeJS.Platform, fn: () => void): void;
export function withPlatform(platform: NodeJS.Platform, fn: () => Promise<void>): Promise<void>;
export function withPlatform(
  platform: NodeJS.Platform,
  fn: () => void | Promise<void>,
): void | Promise<void> {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  const restore = () => {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  };
  try {
    const ret = fn();
    if (ret instanceof Promise) {
      return ret.finally(restore);
    }
    restore();
  } catch (err) {
    restore();
    throw err;
  }
}
