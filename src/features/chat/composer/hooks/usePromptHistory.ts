import { useState, useCallback, useRef, useEffect } from "react";

export const MAX_HISTORY = 50;

export type ArrowDirection = "up" | "down";

type NavigationState = {
  historyIndex: number;
  savedInput: string;
  navHistoryLength: number;
};

export function usePromptHistory(
  promptHistory: ReadonlyArray<string>,
  setInput: (value: string) => void,
) {
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [savedInput, setSavedInput] = useState("");
  const [navHistoryLength, setNavHistoryLength] = useState(0);

  const stateRef = useRef<NavigationState>({ historyIndex, savedInput, navHistoryLength });
  useEffect(() => {
    stateRef.current = { historyIndex, savedInput, navHistoryLength };
  }, [historyIndex, savedInput, navHistoryLength]);

  const promptHistoryRef = useRef(promptHistory);
  useEffect(() => {
    promptHistoryRef.current = promptHistory;
  }, [promptHistory]);

  const setInputRef = useRef(setInput);
  useEffect(() => {
    setInputRef.current = setInput;
  }, [setInput]);

  const resetNavigation = useCallback(() => {
    setHistoryIndex(-1);
    setSavedInput("");
    setNavHistoryLength(0);
  }, []);

  const handleArrowAtBoundary = useCallback(
    (direction: ArrowDirection, value: string): boolean => {
      const {
        historyIndex: currentHistoryIndex,
        savedInput: savedDraft,
        navHistoryLength: navigationHistoryLength,
      } = stateRef.current;
      const history = promptHistoryRef.current;
      const isStale = currentHistoryIndex !== -1 && history.length !== navigationHistoryLength;
      const effectiveIndex = isStale ? -1 : currentHistoryIndex;

      if (isStale) resetNavigation();

      if (direction === "up") {
        if (history.length === 0) return false;
        if (effectiveIndex === -1) {
          setSavedInput(value);
          const newIndex = history.length - 1;
          setHistoryIndex(newIndex);
          setNavHistoryLength(history.length);
          setInputRef.current(history[newIndex]);
        } else if (effectiveIndex > 0) {
          const newIndex = effectiveIndex - 1;
          setHistoryIndex(newIndex);
          setInputRef.current(history[newIndex]);
        }
        return true;
      }

      if (effectiveIndex === -1) return false;
      if (effectiveIndex === history.length - 1) {
        setHistoryIndex(-1);
        setInputRef.current(savedDraft);
      } else {
        const newIndex = effectiveIndex + 1;
        setHistoryIndex(newIndex);
        setInputRef.current(history[newIndex]);
      }
      return true;
    },
    [resetNavigation],
  );

  const handleEscape = useCallback((): boolean => {
    const { historyIndex: currentHistoryIndex, savedInput: savedDraft } = stateRef.current;
    if (currentHistoryIndex === -1) return false;
    setHistoryIndex(-1);
    setSavedInput("");
    setInputRef.current(savedDraft);
    return true;
  }, []);

  const clearHistory = useCallback(() => {
    setHistoryIndex(-1);
    setSavedInput("");
  }, []);

  return { handleArrowAtBoundary, handleEscape, clearHistory };
}
