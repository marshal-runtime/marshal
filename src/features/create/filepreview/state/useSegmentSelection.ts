import { useCallback, useEffect, useEffectEvent, useState, type RefObject } from "react";

import type { Segment } from "../markdownParser";

// ── Types ──────────────────────────────────────────────────────
export interface SelectionRange {
  startSeg: number;
  endSeg: number;
}

interface UseSegmentSelectionParams {
  editorRef: RefObject<HTMLDivElement | null>;
  segments: Segment[];
  lines: string[];
}

// ── Hook ───────────────────────────────────────────────────────
export function useSegmentSelection({ editorRef, segments, lines }: UseSegmentSelectionParams) {
  const [selectionRange, setSelectionRange] = useState<SelectionRange | null>(null);

  // Map browser selection to segment indices
  const getSelectedSegRange = useCallback((): SelectionRange | null => {
    const editor = editorRef.current;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !editor?.contains(sel.anchorNode)) return null;
    const segEls = editor.querySelectorAll(".md-seg");
    let startSeg = -1;
    let endSeg = -1;
    for (let i = 0; i < segEls.length; i++) {
      // Use containsNode (allowPartial=true) — more reliable than compareBoundaryPoints
      // for selections created via collapse()+extend()
      if (sel.containsNode(segEls[i], true)) {
        if (startSeg === -1) startSeg = i;
        endSeg = i;
      }
    }
    if (startSeg < 0 || endSeg < 0 || startSeg >= segments.length) return null;
    return { startSeg, endSeg };
  }, [editorRef, segments]);

  // Track selection changes
  const handleSelectionChange = useEffectEvent(() => {
    setSelectionRange(getSelectedSegRange());
  });

  useEffect(() => {
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, []);

  const clearSelection = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setSelectionRange(null);
  }, []);

  // Get raw markdown text for the current selection in rendered mode
  const getSelectionMarkdown = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;

    const editor = editorRef.current;
    if (!editor) return null;

    const segEls = editor.querySelectorAll(".md-seg");
    let startSeg = -1;
    let endSeg = -1;
    for (let i = 0; i < segEls.length; i++) {
      if (sel.containsNode(segEls[i], true)) {
        if (startSeg === -1) startSeg = i;
        endSeg = i;
      }
    }

    if (startSeg >= 0 && endSeg >= 0 && startSeg < segments.length) {
      const firstSeg = segments[startSeg];
      const lastSeg = segments[Math.min(endSeg, segments.length - 1)];
      return lines.slice(firstSeg.start, lastSeg.end + 1).join("\n");
    }
    return null;
  }, [editorRef, segments, lines]);

  return {
    selectionRange,
    getSelectedSegRange,
    clearSelection,
    getSelectionMarkdown,
  };
}
