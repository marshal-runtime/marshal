import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $nodesOfType,
  type LexicalEditor,
} from "lexical";
import { useMemo } from "react";

import { $createContextChipNode, type ContextChipEntity } from "../nodes/context-chip";
import { ContextChipNode } from "../nodes/ContextChipNode";
import {
  getLastParagraph,
  isEditorFocused,
  stripTrailingPlainTextCharacters,
} from "../support/editor-support";

export interface ChipCommands {
  insertChipAtCaret(entity: ContextChipEntity, replaceCharsBeforeCaret?: number): void;
  removeChipById(chipId: string): void;
}

export function useChipCommands(editor: LexicalEditor): ChipCommands {
  return useMemo(
    () => ({
      insertChipAtCaret(entity, replaceCharsBeforeCaret = 0) {
        editor.update(() => {
          const sel = $getSelection();
          const chip = $createContextChipNode(entity);
          // If focus left the editor, append at the end instead of using the stale caret.
          if ($isRangeSelection(sel) && isEditorFocused(editor)) {
            if (replaceCharsBeforeCaret > 0) {
              for (let i = 0; i < replaceCharsBeforeCaret; i++) {
                sel.deleteCharacter(true);
              }
            }
            sel.insertNodes([chip, $createTextNode(" ")]);
            return;
          }
          const paragraph = getLastParagraph();
          if (!paragraph) {
            const root = $getRoot();
            const nextParagraph = $createParagraphNode();
            const trailingSpace = $createTextNode(" ");
            root.append(nextParagraph);
            nextParagraph.append(chip, trailingSpace);
            trailingSpace.selectEnd();
            return;
          }
          stripTrailingPlainTextCharacters(paragraph, replaceCharsBeforeCaret);
          const trailingSpace = $createTextNode(" ");
          paragraph.append(chip, trailingSpace);
          trailingSpace.selectEnd();
        });
      },
      removeChipById(chipId: string) {
        editor.update(() => {
          for (const chip of $nodesOfType(ContextChipNode)) {
            if (chip.getChipId() === chipId) {
              chip.remove();
              break;
            }
          }
        });
      },
    }),
    [editor],
  );
}
