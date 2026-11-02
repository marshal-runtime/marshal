import { useCallback, useEffect, useState } from "react";

/**
 * Returns a callback ref and a boolean indicating whether the element's
 * content overflows its visible bounds (e.g. due to `line-clamp`,
 * `truncate`, or fixed height).
 *
 * Uses a callback ref so the ResizeObserver is re-attached whenever the
 * underlying DOM element changes (e.g. after a parent re-mount).
 */
export function useIsOverflowing(): [(node: HTMLElement | null) => void, boolean] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  const ref = useCallback((node: HTMLElement | null) => setElement(node), []);

  useEffect(() => {
    if (!element) return undefined;

    const updateOverflowing = () =>
      setOverflowing(
        element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth,
      );

    updateOverflowing();

    const resizeObserver = new ResizeObserver(updateOverflowing);
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, [element]);

  return [ref, overflowing];
}
