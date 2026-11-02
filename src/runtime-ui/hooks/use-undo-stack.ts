import { useCallback, useRef } from "react";

const MAX_UNDO = 200;

export function useUndoStack(initial: string) {
  const stackRef = useRef([initial]);
  const indexRef = useRef(0);

  const reset = useCallback((value: string) => {
    stackRef.current = [value];
    indexRef.current = 0;
  }, []);

  const push = useCallback((value: string) => {
    const stack = stackRef.current;
    const idx = indexRef.current;
    if (stack[idx] === value) return;
    const nextStack = stack.slice(0, idx + 1);
    nextStack.push(value);
    if (nextStack.length > MAX_UNDO) nextStack.shift();
    stackRef.current = nextStack;
    indexRef.current = nextStack.length - 1;
  }, []);

  const undo = useCallback((): string | null => {
    if (indexRef.current > 0) {
      indexRef.current--;
      return stackRef.current[indexRef.current];
    }
    return null;
  }, []);

  const redo = useCallback((): string | null => {
    if (indexRef.current < stackRef.current.length - 1) {
      indexRef.current++;
      return stackRef.current[indexRef.current];
    }
    return null;
  }, []);

  return { push, undo, redo, reset };
}
