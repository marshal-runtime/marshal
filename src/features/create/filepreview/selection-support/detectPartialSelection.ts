import type { Segment } from "../markdownParser";
import { rangeToMarkdownRange, type MarkdownRange } from "./rangeToMarkdownRange";

export interface PartialSelectionInfo {
  startSeg: number;
  endSeg: number;
  isPartial: boolean;
  mdRange: MarkdownRange | null;
  renderedText: string | null;
}

/**
 * Detect whether the current Selection is a partial selection within a single
 * rendered segment.
 *
 * Walks `.md-seg` elements in `editor` to find which segments the selection
 * overlaps, then uses AST-derived offsets (`rangeToMarkdownRange`) to determine
 * whether the selection covers only part of a segment.
 *
 * Returns `null` if the selection is collapsed or doesn't overlap any segment.
 */
export function detectPartialSelection(
  sel: Selection,
  editor: Element,
  segments: Segment[],
): PartialSelectionInfo | null {
  if (sel.isCollapsed) return null;

  const renderedText = sel.toString();
  const segEls = editor.querySelectorAll(".md-seg");
  let startSeg = -1;
  let endSeg = -1;

  for (let i = 0; i < segEls.length; i++) {
    if (sel.containsNode(segEls[i], true)) {
      if (startSeg === -1) startSeg = i;
      endSeg = i;
    }
  }

  if (startSeg < 0) return null;

  let isPartial = false;
  let mdRange: MarkdownRange | null = null;

  if (startSeg === endSeg) {
    const domRange = sel.getRangeAt(0);
    const computedRange = rangeToMarkdownRange(domRange, editor);
    if (computedRange) {
      const seg = segments[startSeg];
      if (seg?.mdStart != null && seg.mdEnd != null) {
        isPartial = computedRange.mdStart > seg.mdStart || computedRange.mdEnd < seg.mdEnd;
        if (isPartial) {
          mdRange = computedRange;
        }
      }
    }
  }

  return { startSeg, endSeg, isPartial, mdRange, renderedText };
}
