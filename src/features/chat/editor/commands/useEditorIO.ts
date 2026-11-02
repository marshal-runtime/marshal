import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  CLEAR_HISTORY_COMMAND,
  type LexicalEditor,
} from "lexical";
import { useMemo } from "react";

import { PROGRAMMATIC_UPDATE_TAG } from "../contracts/programmatic-update-tag";
import { getPlainTextFromEditor } from "../support/editor-support";

export interface EditorIO {
  focus(): void;
  blur(): void;
  clear(): void;
  getPlainText(): string;
  setPlainText(text: string): void;
}

/** Core text I/O + focus management. Programmatic content swaps clear the
 * undo history so Cmd-Z cannot resurrect the previous draft, and tag the
 * editor.update() so ChangeRelayPlugin can filter them out — that prevents
 * the typewriter (and other in-flight programmatic flows) from seeing its
 * own writes as if they were a user keystroke. The updates also flush
 * discretely so they don't co-batch with untagged updates queued in the
 * same microtask: Lexical merges co-batched updates into a single commit
 * with the UNION of their tags, which would defeat the filter. */
export function useEditorIO(editor: LexicalEditor): EditorIO {
  return useMemo(
    () => ({
      focus: () => editor.focus(),
      blur: () => editor.blur(),
      clear() {
        editor.update(
          () => {
            const root = $getRoot();
            root.clear();
            const p = $createParagraphNode();
            root.append(p);
            p.select();
          },
          { tag: PROGRAMMATIC_UPDATE_TAG, discrete: true },
        );
        editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
      },
      getPlainText: () => getPlainTextFromEditor(editor),
      setPlainText(text: string) {
        editor.update(
          () => {
            const root = $getRoot();
            root.clear();
            const p = $createParagraphNode();
            if (text.length > 0) p.append($createTextNode(text));
            root.append(p);
            p.selectEnd();
          },
          { tag: PROGRAMMATIC_UPDATE_TAG, discrete: true },
        );
        editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
      },
    }),
    [editor],
  );
}
