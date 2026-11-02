import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  RefObject,
} from "react";
import { useCallback, useEffect, useRef, useState } from "react";

export type ResizablePanelMode = "normal" | "expanded" | "collapsed";
export type ResizablePanelAxis = "horizontal" | "vertical";

interface UseResizablePanelOptions {
  storageKey: string;
  legacyStorageKeys?: readonly string[];
  axis: ResizablePanelAxis;
  defaultSize: number;
  minSize: number;
  maxSize: number;
  expandedSize: number;
  initialMode?: ResizablePanelMode;
  growDirection?: "positive" | "negative";
  keyboardStep?: number;
  collapseThreshold?: number;
}

export interface ResizablePanelController {
  axis: ResizablePanelAxis;
  mode: ResizablePanelMode;
  size: number;
  normalSize: number;
  minSize: number;
  maxSize: number;
  canExpand: boolean;
  isCollapsed: boolean;
  isExpanded: boolean;
  collapse: () => void;
  expand: () => void;
  restore: () => void;
  handleMouseDown: (event: ReactMouseEvent<HTMLElement>) => void;
  handleKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}

function clampSize(value: number, min: number, max: number): number {
  const safeMax = Math.max(0, max);
  const safeMin = Math.min(Math.max(0, min), safeMax);
  return Math.min(safeMax, Math.max(safeMin, value));
}

function parsePersistedSize(raw: string | null): number | null {
  if (raw === null) return null;
  const stored = Number(raw);
  return Number.isFinite(stored) && stored > 0 ? stored : null;
}

function readPersistedSize(
  storageKey: string,
  legacyStorageKeys: readonly string[],
  fallback: number,
): number {
  try {
    const currentRaw = window.localStorage.getItem(storageKey);
    const current = parsePersistedSize(currentRaw);
    if (current !== null) {
      for (const legacyKey of legacyStorageKeys) {
        try {
          window.localStorage.removeItem(legacyKey);
        } catch {
          // The current value is still usable when legacy cleanup is blocked.
        }
      }
      return current;
    }
    if (currentRaw !== null) window.localStorage.removeItem(storageKey);

    for (const legacyKey of legacyStorageKeys) {
      const legacyRaw = window.localStorage.getItem(legacyKey);
      const legacy = parsePersistedSize(legacyRaw);
      if (legacy === null) {
        if (legacyRaw !== null) window.localStorage.removeItem(legacyKey);
        continue;
      }
      try {
        window.localStorage.setItem(storageKey, String(legacy));
        window.localStorage.removeItem(legacyKey);
      } catch {
        // The legacy value still restores this session when migration is blocked.
      }
      return legacy;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function persistSize(storageKey: string, size: number): void {
  try {
    window.localStorage.setItem(storageKey, String(Math.round(size)));
  } catch {
    // Sizing still works for the current session when storage is unavailable.
  }
}

export function useResizablePanel({
  storageKey,
  legacyStorageKeys = [],
  axis,
  defaultSize,
  minSize,
  maxSize,
  expandedSize,
  initialMode = "normal",
  growDirection = "positive",
  keyboardStep = 16,
  collapseThreshold,
}: UseResizablePanelOptions): ResizablePanelController {
  const [preferredSize, setPreferredSize] = useState(() =>
    readPersistedSize(storageKey, legacyStorageKeys, defaultSize),
  );
  const [dragSize, setDragSize] = useState<number | null>(null);
  const [mode, setMode] = useState<ResizablePanelMode>(initialMode);
  const dragSizeRef = useRef<number | null>(null);
  const moveRef = useRef<((event: MouseEvent) => void) | null>(null);
  const upRef = useRef<(() => void) | null>(null);

  const safeMaxSize = Math.max(0, maxSize);
  const safeMinSize = Math.min(Math.max(0, minSize), safeMaxSize);
  const normalSize = clampSize(dragSize ?? preferredSize, safeMinSize, safeMaxSize);
  const safeExpandedSize = Math.max(0, expandedSize);
  const size = mode === "collapsed" ? 0 : mode === "expanded" ? safeExpandedSize : normalSize;

  const commitSize = useCallback(
    (nextSize: number) => {
      const next = clampSize(nextSize, safeMinSize, safeMaxSize);
      setPreferredSize(next);
      persistSize(storageKey, next);
    },
    [safeMaxSize, safeMinSize, storageKey],
  );

  const cleanupDrag = useCallback(() => {
    if (moveRef.current) document.removeEventListener("mousemove", moveRef.current);
    if (upRef.current) document.removeEventListener("mouseup", upRef.current);
    moveRef.current = null;
    upRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  useEffect(() => cleanupDrag, [cleanupDrag]);

  const collapse = useCallback(() => {
    setDragSize(null);
    dragSizeRef.current = null;
    setMode("collapsed");
  }, []);
  const expand = useCallback(() => {
    setDragSize(null);
    dragSizeRef.current = null;
    setMode("expanded");
  }, []);
  const restore = useCallback(() => {
    setDragSize(null);
    dragSizeRef.current = null;
    setMode("normal");
  }, []);

  const handleMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (mode !== "normal") return;
      event.preventDefault();
      cleanupDrag();
      const startCoordinate = axis === "horizontal" ? event.clientX : event.clientY;
      const startSize = normalSize;
      const cursor = axis === "horizontal" ? "col-resize" : "row-resize";
      const lowerBound = collapseThreshold == null ? safeMinSize : 0;

      const onMove = (moveEvent: MouseEvent) => {
        const coordinate = axis === "horizontal" ? moveEvent.clientX : moveEvent.clientY;
        const coordinateDelta = coordinate - startCoordinate;
        const sizeDelta = growDirection === "negative" ? -coordinateDelta : coordinateDelta;
        const next = clampSize(startSize + sizeDelta, lowerBound, safeMaxSize);
        dragSizeRef.current = next;
        setDragSize(next);
      };
      const onUp = () => {
        const next = dragSizeRef.current ?? startSize;
        cleanupDrag();
        dragSizeRef.current = null;
        setDragSize(null);
        if (collapseThreshold != null && next <= collapseThreshold) {
          setMode("collapsed");
          return;
        }
        commitSize(next);
      };

      moveRef.current = onMove;
      upRef.current = onUp;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = cursor;
      document.body.style.userSelect = "none";
    },
    [
      axis,
      cleanupDrag,
      collapseThreshold,
      commitSize,
      growDirection,
      mode,
      normalSize,
      safeMaxSize,
      safeMinSize,
    ],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (mode !== "normal") return;
      const step = keyboardStep * (event.shiftKey ? 4 : 1);
      let next: number | null = null;

      if (event.key === "Home") next = safeMinSize;
      else if (event.key === "End") next = safeMaxSize;
      else if (axis === "horizontal" && event.key === "ArrowLeft") {
        next = normalSize + (growDirection === "negative" ? step : -step);
      } else if (axis === "horizontal" && event.key === "ArrowRight") {
        next = normalSize + (growDirection === "negative" ? -step : step);
      } else if (axis === "vertical" && event.key === "ArrowUp") {
        next = normalSize + (growDirection === "negative" ? step : -step);
      } else if (axis === "vertical" && event.key === "ArrowDown") {
        next = normalSize + (growDirection === "negative" ? -step : step);
      }

      if (next == null) return;
      event.preventDefault();
      commitSize(next);
    },
    [axis, commitSize, growDirection, keyboardStep, mode, normalSize, safeMaxSize, safeMinSize],
  );

  return {
    axis,
    mode,
    size,
    normalSize,
    minSize: safeMinSize,
    maxSize: safeMaxSize,
    canExpand: safeExpandedSize > normalSize,
    isCollapsed: mode === "collapsed",
    isExpanded: mode === "expanded",
    collapse,
    expand,
    restore,
    handleMouseDown,
    handleKeyDown,
  };
}

export function useElementSize<T extends HTMLElement>(
  ref: RefObject<T | null>,
): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}

export function useViewportSize(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({
    width: typeof window === "undefined" ? 0 : window.innerWidth,
    height: typeof window === "undefined" ? 0 : window.innerHeight,
  }));

  useEffect(() => {
    const update = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return size;
}
