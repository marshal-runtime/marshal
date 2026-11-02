import { useEffect, useRef } from "react";

export function useTimeout(callback: () => void, delay: number | null, key?: unknown) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedCallback = useRef(callback);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (typeof delay === "number") {
      const timeoutId = setTimeout(() => savedCallback.current(), delay);
      timeoutRef.current = timeoutId;
      return () => {
        clearTimeout(timeoutId);
      };
    }
    return undefined;
  }, [delay, key]);

  return timeoutRef;
}
