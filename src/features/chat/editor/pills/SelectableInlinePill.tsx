/**
 * Wraps a decorator-node body with idiomatic Lexical click-to-select +
 * Backspace/Delete-to-remove behavior via useLexicalNodeSelection.
 *
 * Without this, clicking a chip and pressing Backspace appears to do nothing
 * because the keyboard plugin in editor/plugins/ChipKeyboardPlugin only
 * handles RangeSelection (caret-adjacent), not NodeSelection.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useLexicalNodeSelection } from "@lexical/react/useLexicalNodeSelection";
import { mergeRegister } from "@lexical/utils";
import {
  $getNodeByKey,
  $getSelection,
  $isNodeSelection,
  COMMAND_PRIORITY_LOW,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  type NodeKey,
} from "lexical";
import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import { subtleSelectionStyle } from "./SelectableInlinePill.styles";

interface InlinePillDecoratorProps {
  nodeKey: NodeKey;
  children: ReactNode;
  className?: string;
  /**
   * Class applied when the decorator node is selected (NodeSelection). If not
   * provided, falls back to the legacy outlined-pill style. Pass an empty
   * string to suppress selected styling.
   */
  selectedClassName?: string;
  selectionTreatment?: "subtle";
}

export function InlinePillDecorator({
  nodeKey,
  children,
  className,
  selectedClassName,
  selectionTreatment,
}: InlinePillDecoratorProps) {
  const [editor] = useLexicalComposerContext();
  const [isSelected, setSelected, clearSelected] = useLexicalNodeSelection(nodeKey);
  const ref = useRef<HTMLSpanElement | null>(null);
  const isSelectedRef = useRef(isSelected);
  useEffect(() => {
    isSelectedRef.current = isSelected;
  }, [isSelected]);

  useEffect(() => {
    const removeIfSelected = (event: KeyboardEvent | null): boolean => {
      if (!isSelectedRef.current || !$isNodeSelection($getSelection())) return false;
      event?.preventDefault();
      const node = $getNodeByKey(nodeKey);
      node?.remove();
      return true;
    };

    return mergeRegister(
      editor.registerCommand(KEY_BACKSPACE_COMMAND, removeIfSelected, COMMAND_PRIORITY_LOW),
      editor.registerCommand(KEY_DELETE_COMMAND, removeIfSelected, COMMAND_PRIORITY_LOW),
    );
  }, [editor, nodeKey]);

  const handleClick = (event: ReactMouseEvent) => {
    event.stopPropagation();
    if (!event.shiftKey) clearSelected();
    setSelected(!isSelectedRef.current);
  };

  const useLegacySelectionOutline = selectedClassName === undefined;
  const mergedClassName =
    isSelected && selectedClassName ? `${className ?? ""} ${selectedClassName}`.trim() : className;

  return (
    <span
      ref={ref}
      className={mergedClassName}
      contentEditable={false}
      onClick={handleClick}
      data-selected={isSelected ? "true" : undefined}
      style={
        isSelected && useLegacySelectionOutline
          ? { outline: "2px solid var(--accent)", outlineOffset: "1px", borderRadius: "0.5rem" }
          : isSelected && selectionTreatment === "subtle"
            ? subtleSelectionStyle
            : undefined
      }
    >
      {children}
    </span>
  );
}
