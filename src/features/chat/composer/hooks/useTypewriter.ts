import { useCallback, useEffect, useRef } from "react";

export interface UseTypewriterOptions {
  floor?: number;
  cap?: number;
  msPerChar?: number;
  base?: number;
}

export interface UseTypewriterReturn {
  startTyping: (text: string) => void;
  cancel: () => void;
}

const easeInOutSine = (progress: number) => (1 - Math.cos(progress * Math.PI)) / 2;

export function useTypewriter(
  setter: (text: string) => void,
  opts: UseTypewriterOptions = {},
): UseTypewriterReturn {
  const { floor = 450, cap = 1400, msPerChar = 4, base = 400 } = opts;
  const setterRef = useRef(setter);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    setterRef.current = setter;
  }, [setter]);

  const cancel = useCallback(() => {
    if (rafRef.current === null) return;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  const startTyping = useCallback(
    (text: string) => {
      cancel();
      const setInput = setterRef.current;
      if (!text) {
        setInput("");
        return;
      }
      if (
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ) {
        setInput(text);
        return;
      }

      const duration = Math.min(cap, Math.max(floor, base + text.length * msPerChar));
      let lastChars = 1;
      setInput(text.slice(0, lastChars));
      const start = performance.now();
      const step = (now: number) => {
        const progress = Math.min(1, (now - start) / duration);
        const chars = Math.round(easeInOutSine(progress) * text.length);
        if (chars > lastChars) {
          lastChars = chars;
          setInput(text.slice(0, chars));
        }
        if (progress < 1) {
          rafRef.current = requestAnimationFrame(step);
        } else {
          rafRef.current = null;
          if (lastChars < text.length) setInput(text);
        }
      };
      rafRef.current = requestAnimationFrame(step);
    },
    [base, cap, cancel, floor, msPerChar],
  );

  useEffect(() => cancel, [cancel]);

  return { startTyping, cancel };
}
