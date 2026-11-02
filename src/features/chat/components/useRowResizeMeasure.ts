import { useCallback, useEffect, useRef } from "react";

/**
 * Ref for virtualized timeline rows that re-measures a row whenever its size
 * changes. The virtualizer's own observer is only created once its scroll
 * element's window is known, so rows mounted before that are never watched
 * and would keep a stale height when content (e.g. a conversation card) is
 * added to them later.
 */
export function useRowResizeMeasure(
  measure: (node: Element | null) => void,
): (node: HTMLElement | null) => (() => void) | undefined {
  const observerRef = useRef<ResizeObserver | null>(null);
  useEffect(() => () => observerRef.current?.disconnect(), []);
  return useCallback(
    (node: HTMLElement | null) => {
      measure(node);
      if (!node) return undefined;
      observerRef.current ??= new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.target.isConnected) measure(entry.target);
        }
      });
      const observer = observerRef.current;
      observer.observe(node);
      return () => observer.unobserve(node);
    },
    [measure],
  );
}
