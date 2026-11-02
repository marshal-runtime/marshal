import { useCallback, useEffect, useRef, useState } from "react";

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
}

export interface SearchState {
  isOpen: boolean;
  query: string;
  options: SearchOptions;
  matchCount: number;
  currentMatch: number;
  regexError: string | null;
  matchLimitHit: boolean;
}

const HIGHLIGHT_CLASS = "md-search-highlight";
const ACTIVE_HIGHLIGHT_CLASS = "md-search-highlight-active";
const MAX_MATCHES = 10_000;
const SEARCH_DEBOUNCE_MS = 240;

const defaultOptions: SearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  useRegex: false,
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildSearchRegex(
  query: string,
  options: SearchOptions,
): { regex: RegExp; error: null } | { regex: null; error: string | null } {
  if (!query) return { regex: null, error: null };
  let pattern = options.useRegex ? query : escapeRegex(query);
  if (options.wholeWord) pattern = `\\b${pattern}\\b`;
  try {
    return { regex: new RegExp(pattern, options.caseSensitive ? "g" : "gi"), error: null };
  } catch (e) {
    return { regex: null, error: e instanceof Error ? e.message : "Invalid regex" };
  }
}

/**
 * Find in the markdown preview editor.
 * DOM-based <mark> highlighting inside previewRef.
 */
export function useFileSearch(previewRef: React.RefObject<HTMLDivElement | null>) {
  const [state, setState] = useState<SearchState>({
    isOpen: false,
    query: "",
    options: defaultOptions,
    matchCount: 0,
    currentMatch: -1,
    regexError: null,
    matchLimitHit: false,
  });

  const marksRef = useRef<HTMLElement[]>([]);
  const currentMatchRef = useRef(-1);
  const isHighlightingRef = useRef(false);
  const highlightGuardTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchDebounceTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const queryRef = useRef("");
  const optionsRef = useRef(defaultOptions);

  const clearHighlights = useCallback(() => {
    for (const mark of marksRef.current) {
      const parent = mark.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
      parent.normalize();
    }
    marksRef.current = [];
  }, []);

  function getTextNodes(root: Node): Text[] {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === "TEXTAREA" || tag === "SCRIPT" || tag === "STYLE")
          return NodeFilter.FILTER_REJECT;
        if (parent.classList.contains(HIGHLIGHT_CLASS)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()) {
      if (walker.currentNode instanceof Text) nodes.push(walker.currentNode);
    }
    return nodes;
  }

  const applyHighlights = useCallback(
    (query: string, options: SearchOptions, scrollToFirst = true) => {
      isHighlightingRef.current = true;
      clearHighlights();
      const container = previewRef.current;
      if (!container || !query) {
        isHighlightingRef.current = false;
        setState((s) => ({ ...s, matchCount: 0, currentMatch: -1, regexError: null }));
        return;
      }

      const result = buildSearchRegex(query, options);
      if (result.error !== null) {
        isHighlightingRef.current = false;
        setState((s) => ({ ...s, matchCount: 0, currentMatch: -1, regexError: result.error }));
        return;
      }
      if (!result.regex) {
        isHighlightingRef.current = false;
        setState((s) => ({ ...s, matchCount: 0, currentMatch: -1, regexError: null }));
        return;
      }

      const regex = result.regex;
      const marks: HTMLElement[] = [];
      let limitHit = false;

      for (const textNode of getTextNodes(container)) {
        if (marks.length >= MAX_MATCHES) {
          limitHit = true;
          break;
        }
        const text = textNode.textContent ?? "";
        const indices: Array<{ start: number; len: number }> = [];
        let m: RegExpExecArray | null;
        regex.lastIndex = 0;
        while ((m = regex.exec(text)) !== null) {
          if (m[0].length === 0) {
            regex.lastIndex++;
            continue;
          }
          indices.push({ start: m.index, len: m[0].length });
          if (marks.length + indices.length >= MAX_MATCHES) {
            limitHit = true;
            break;
          }
        }
        if (indices.length === 0) continue;

        const parent = textNode.parentNode!;
        const frag = document.createDocumentFragment();
        let lastIdx = 0;
        for (const { start, len } of indices) {
          if (start > lastIdx)
            frag.appendChild(document.createTextNode(text.slice(lastIdx, start)));
          const mark = document.createElement("mark");
          mark.className = HIGHLIGHT_CLASS;
          mark.textContent = text.slice(start, start + len);
          frag.appendChild(mark);
          marks.push(mark);
          lastIdx = start + len;
        }
        if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
        parent.replaceChild(frag, textNode);
      }

      marksRef.current = marks;
      let cur: number;
      if (currentMatchRef.current >= 0 && currentMatchRef.current < marks.length) {
        cur = currentMatchRef.current;
      } else {
        cur = marks.length > 0 ? 0 : -1;
      }
      currentMatchRef.current = cur;
      setState((s) => ({
        ...s,
        matchCount: marks.length,
        currentMatch: cur,
        regexError: null,
        matchLimitHit: limitHit,
      }));

      if (cur >= 0 && marks[cur]) {
        marks[cur].classList.add(ACTIVE_HIGHLIGHT_CLASS);
        if (scrollToFirst) {
          marks[cur].scrollIntoView({ block: "center" });
        }
      }

      clearTimeout(highlightGuardTimer.current);
      highlightGuardTimer.current = setTimeout(() => {
        isHighlightingRef.current = false;
      }, 250);
    },
    [previewRef, clearHighlights],
  );

  const goToMatch = useCallback((index: number) => {
    const marks = marksRef.current;
    if (marks.length === 0) return;
    for (const m of marks) m.classList.remove(ACTIVE_HIGHLIGHT_CLASS);
    const wrapped = ((index % marks.length) + marks.length) % marks.length;
    marks[wrapped].classList.add(ACTIVE_HIGHLIGHT_CLASS);
    marks[wrapped].scrollIntoView({ block: "center" });
    currentMatchRef.current = wrapped;
    setState((s) => ({ ...s, currentMatch: wrapped }));
  }, []);

  const nextMatch = useCallback(() => goToMatch(currentMatchRef.current + 1), [goToMatch]);
  const prevMatch = useCallback(() => goToMatch(currentMatchRef.current - 1), [goToMatch]);

  const open = useCallback(() => setState((s) => ({ ...s, isOpen: true })), []);

  const close = useCallback(() => {
    clearHighlights();
    clearTimeout(highlightGuardTimer.current);
    clearTimeout(searchDebounceTimer.current);
    isHighlightingRef.current = false;
    currentMatchRef.current = -1;
    queryRef.current = "";
    optionsRef.current = defaultOptions;
    setState((s) => ({
      ...s,
      isOpen: false,
      query: "",
      matchCount: 0,
      currentMatch: -1,
      regexError: null,
      matchLimitHit: false,
    }));
  }, [clearHighlights]);

  const setQuery = useCallback(
    (query: string) => {
      queryRef.current = query;
      setState((s) => ({ ...s, query }));
      clearTimeout(searchDebounceTimer.current);
      searchDebounceTimer.current = setTimeout(() => {
        applyHighlights(query, optionsRef.current);
      }, SEARCH_DEBOUNCE_MS);
    },
    [applyHighlights],
  );

  const toggleOption = useCallback(
    (option: keyof SearchOptions) => {
      const newOptions = { ...optionsRef.current, [option]: !optionsRef.current[option] };
      optionsRef.current = newOptions;
      setState((s) => ({ ...s, options: newOptions }));
      requestAnimationFrame(() => applyHighlights(queryRef.current, newOptions));
    },
    [applyHighlights],
  );

  // Re-apply when DOM changes (segment edits)
  useEffect(() => {
    if (!state.isOpen || !state.query) return undefined;
    const container = previewRef.current;
    if (!container) return undefined;
    const observer = new MutationObserver(() => {
      if (isHighlightingRef.current) return;
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(
        () => applyHighlights(queryRef.current, optionsRef.current, false),
        100,
      );
    });
    const timerRef = { current: undefined as ReturnType<typeof setTimeout> | undefined };
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      clearTimeout(timerRef.current);
    };
  }, [state.isOpen, state.query, state.options, previewRef, applyHighlights]);

  // Sync refs when state changes from external sources
  useEffect(() => {
    queryRef.current = state.query;
    optionsRef.current = state.options;
  }, [state.query, state.options]);

  useEffect(() => () => clearHighlights(), [clearHighlights]);

  return {
    state,
    open,
    close,
    setQuery,
    toggleOption,
    nextMatch,
    prevMatch,
  };
}
