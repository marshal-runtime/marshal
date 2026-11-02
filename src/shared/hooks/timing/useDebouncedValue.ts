// Marshal-owned module.
import { useEffect, useState } from "react";

interface UseDebouncedValueOptions<T> {
  enabled?: boolean;
  /**
   * Value to return when `enabled` is `false`.
   *
   * Must be referentially stable across renders — `disabledValue` is in the
   * effect's dependency array (so updates remain reactive while disabled), so
   * passing an inline non-primitive (e.g. `[]` or `{}`) will reset the debounce
   * timer on every parent render and the debounced value will never settle.
   * Wrap computed non-primitives in `useMemo`. Primitive defaults like `""` or
   * `null` are always safe.
   */
  disabledValue?: T;
}

export function useDebouncedValue<T>(
  value: T,
  delayMs: number,
  options?: UseDebouncedValueOptions<T>,
): T {
  const enabled = options?.enabled ?? true;
  const disabledValue = options?.disabledValue ?? value;
  const [debouncedValue, setDebouncedValue] = useState(() => (enabled ? value : disabledValue));

  useEffect(() => {
    const nextValue = enabled ? value : disabledValue;
    const timer = setTimeout(() => setDebouncedValue(nextValue), enabled ? delayMs : 0);
    return () => clearTimeout(timer);
  }, [delayMs, disabledValue, enabled, value]);

  return debouncedValue;
}
