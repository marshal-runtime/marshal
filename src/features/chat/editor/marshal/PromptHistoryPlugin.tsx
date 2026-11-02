/**
 * Owns ArrowUp / ArrowDown for prompt-history navigation.
 *
 * Replaces the old React onKeyDown + getCaretPosition() approach: the plugin
 * combines Lexical selection state with DOM caret geometry and only forwards
 * the event to the host when the caret sits on the first/last visual row. The
 * host returns true to suppress Lexical's default arrow handling (line navigation).
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getAdjacentSiblingOrParentSiblingCaret, mergeRegister } from "@lexical/utils";
import {
  $getRoot,
  $getSelection,
  $getSiblingCaret,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  type CaretDirection,
  type NodeCaret,
} from "lexical";
import { useEffect, useEffectEvent } from "react";

import { $isContextChipNode } from "../nodes/context-chip";

export type ArrowDirection = "up" | "down";

interface PromptHistoryPluginProps {
  /**
   * Called when the user presses ArrowUp/Down at a visual row boundary. Return
   * true to consume the event (suppress default caret movement); false to fall through.
   */
  onArrowAtBoundary: (direction: ArrowDirection, value: string) => boolean;
}

// Subpixel rendering tolerance for visual-row boundary detection. Browsers
// can return caret-vs-line top values that differ by fractions of a pixel
// even when the caret is actually on the line (font metrics, transforms,
// device-pixel-ratio rounding). 2px covers the common cases without bleeding
// into the next visual line at typical font sizes (16-20px line-height).
// If you see ArrowUp incorrectly recall history near a line boundary, raise
// this; if it incorrectly skips history at the true top, lower it.
const VISUAL_LINE_TOLERANCE_PX = 2;

function rangeRects(range: Range): DOMRect[] {
  return Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
}

function rangeRect(range: Range): DOMRect | null {
  const rects = rangeRects(range);
  if (rects.length > 0) return rects[0];

  const rect = range.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0 ? rect : null;
}

function adjacentTextRect(range: Range): DOMRect | null {
  const { startContainer, startOffset } = range;
  if (startContainer.nodeType !== Node.TEXT_NODE) return null;

  const textLength = startContainer.textContent?.length ?? 0;
  if (textLength === 0) return null;

  const probe = range.cloneRange();
  if (startOffset < textLength) {
    probe.setStart(startContainer, startOffset);
    probe.setEnd(startContainer, startOffset + 1);
  } else {
    probe.setStart(startContainer, startOffset - 1);
    probe.setEnd(startContainer, startOffset);
  }

  return rangeRect(probe);
}

function caretRect(range: Range): DOMRect | null {
  return rangeRect(range) ?? adjacentTextRect(range);
}

function contentLineRects(rootElement: HTMLElement): DOMRect[] {
  const range = document.createRange();
  range.selectNodeContents(rootElement);
  return rangeRects(range);
}

function caretIsOnVisualBoundary(
  direction: ArrowDirection,
  rootElement: HTMLElement | null,
): boolean | null {
  if (!rootElement) return null;

  const domSelection = window.getSelection();
  if (!domSelection || domSelection.rangeCount === 0) return null;

  const range = domSelection.getRangeAt(0);
  if (!range.collapsed) return false;
  if (range.startContainer !== rootElement && !rootElement.contains(range.startContainer))
    return false;

  const currentCaretRect = caretRect(range);
  const lineRects = contentLineRects(rootElement);
  if (!currentCaretRect || lineRects.length === 0) return null;

  if (direction === "up") {
    return currentCaretRect.top <= lineRects[0].top + VISUAL_LINE_TOLERANCE_PX;
  }

  return (
    currentCaretRect.bottom >= lineRects[lineRects.length - 1].bottom - VISUAL_LINE_TOLERANCE_PX
  );
}

function $caretIsAtBoundary(direction: ArrowDirection, rootElement: HTMLElement | null): boolean {
  const selection = $getSelection();
  const text = $getRoot().getTextContent();
  // Empty editor: ArrowUp/Down should always recall history. Without this,
  // a focused-but-empty input would never trigger history because there's
  // no caret rect for caretIsOnVisualBoundary to compare against.
  if (text.length === 0) return true;
  if (selection === null) return false;
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;

  const visualBoundary = caretIsOnVisualBoundary(direction, rootElement);
  if (visualBoundary !== null) return visualBoundary;

  // Geometry is unavailable in some test DOMs; keep the old model-only fallback.
  if (!text.includes("\n")) return true;

  const focusNode = selection.focus.getNode();
  const focusOffset = selection.focus.offset;
  if (direction === "up" && focusOffset !== 0) return false;
  if (direction === "down" && focusOffset !== focusNode.getTextContentSize()) return false;

  // Walk siblings (and out through ancestor boundaries) in the arrow direction
  // until we find any non-empty content. `$getAdjacentSiblingOrParentSiblingCaret`
  // is the canonical helper for "step to the next caret position, jumping out
  // of the parent when no more siblings remain".
  const caretDirection: CaretDirection = direction === "up" ? "previous" : "next";
  let caret: NodeCaret | null = $getSiblingCaret(focusNode, caretDirection);
  while (caret) {
    const node = caret.getNodeAtCaret();
    if (node && (node.getTextContentSize() > 0 || $isContextChipNode(node))) return false;
    const next: [NodeCaret, number] | null = $getAdjacentSiblingOrParentSiblingCaret(caret);
    caret = next ? next[0] : null;
  }
  return true;
}

export function PromptHistoryPlugin({ onArrowAtBoundary }: PromptHistoryPluginProps) {
  const [editor] = useLexicalComposerContext();
  const onBoundary = useEffectEvent(onArrowAtBoundary);

  useEffect(() => {
    function handle(direction: ArrowDirection, event: KeyboardEvent | null): boolean {
      // IME composition: never navigate history mid-composition.
      if (event?.isComposing) return false;
      // Modified arrows are native/editor text-navigation shortcuts (selection,
      // paragraph/document movement, etc.) and should not recall prompt history.
      if (event && (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey)) return false;

      const rootElement = editor.getRootElement();
      const value = editor.getEditorState().read(() => {
        if (!$caretIsAtBoundary(direction, rootElement)) return null;
        return $getRoot().getTextContent();
      });
      if (value === null) return false;

      const handled = onBoundary(direction, value);
      if (handled) event?.preventDefault();
      return handled;
    }

    return mergeRegister(
      editor.registerCommand(
        KEY_ARROW_UP_COMMAND,
        (event) => handle("up", event),
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        KEY_ARROW_DOWN_COMMAND,
        (event) => handle("down", event),
        COMMAND_PRIORITY_LOW,
      ),
    );
  }, [editor]);

  return null;
}
