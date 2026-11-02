import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_LOW,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  type LexicalNode,
} from "lexical";
import { useEffect } from "react";

const removableInlinePillTypes = new Set(["context-chip", "skill-pill"]);

function isRemovableInlinePill(node: LexicalNode | null): node is LexicalNode {
  return node !== null && removableInlinePillTypes.has(node.getType());
}

export function InlinePillKeyboardPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const removeBackspace = editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event) => {
        const sel = $getSelection();
        if (!$isRangeSelection(sel) || !sel.isCollapsed()) return false;

        const anchor = sel.anchor;
        const node = anchor.getNode();
        let prev: LexicalNode | null = null;

        if ($isTextNode(node)) {
          if (anchor.offset !== 0) return false;
          prev = node.getPreviousSibling();
        } else if ($isElementNode(node)) {
          prev = node.getChildAtIndex(anchor.offset - 1);
        }

        if (!isRemovableInlinePill(prev)) return false;

        event?.preventDefault();
        prev.remove();
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );

    const removeDelete = editor.registerCommand(
      KEY_DELETE_COMMAND,
      (event) => {
        const sel = $getSelection();
        if (!$isRangeSelection(sel) || !sel.isCollapsed()) return false;

        const anchor = sel.anchor;
        const node = anchor.getNode();
        let next: LexicalNode | null = null;

        if ($isTextNode(node)) {
          if (anchor.offset !== node.getTextContentSize()) return false;
          next = node.getNextSibling();
        } else if ($isElementNode(node)) {
          next = node.getChildAtIndex(anchor.offset);
        }

        if (!isRemovableInlinePill(next)) return false;

        event?.preventDefault();
        next.remove();
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );

    return () => {
      removeBackspace();
      removeDelete();
    };
  }, [editor]);

  return null;
}
