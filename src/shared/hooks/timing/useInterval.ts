import { useEffect, useRef } from "react";

export function useInterval(callback: () => void, delay: number | null) {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (typeof delay === "number") {
      const intervalId = setInterval(() => callbackRef.current(), delay);
      return () => clearInterval(intervalId);
    }
    return undefined;
  }, [delay]);
}
