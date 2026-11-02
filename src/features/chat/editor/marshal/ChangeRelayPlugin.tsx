import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, HISTORY_MERGE_TAG } from "lexical";
import { useEffect } from "react";

import { $collectChips } from "../nodes/context-chip";
import { PROGRAMMATIC_UPDATE_TAG } from "../contracts/programmatic-update-tag";
import type { ChipDescriptor } from "../contracts/chip-descriptor";

interface ChangeRelayPluginProps {
  onChange: (text: string) => void;
  onChipsChange: (chips: ChipDescriptor[]) => void;
}

/** Forwards real (user-driven) editor state changes out as plain text +
 * chips. Updates tagged PROGRAMMATIC_UPDATE_TAG (typewriter drip, draft
 * restore, prompt-history nav) are filtered so handlers like
 * cancelTypewriter() don't see them as user keystrokes.
 *
 * Also mirrors @lexical/react's OnChangePlugin defaults:
 *  - skip selection-only changes (no dirty nodes) so clicks/arrow keys don't
 *    re-fire onChange (which would cancel an in-flight typewriter drip)
 *  - skip HISTORY_MERGE_TAG updates (history coalescing isn't a user edit)
 *  - skip the synthetic initial commit from an empty prevEditorState. */
export function ChangeRelayPlugin({ onChange, onChipsChange }: ChangeRelayPluginProps) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerUpdateListener((update) => {
      const { editorState, prevEditorState, dirtyElements, dirtyLeaves, tags } = update;
      if (
        tags.has(PROGRAMMATIC_UPDATE_TAG) ||
        tags.has(HISTORY_MERGE_TAG) ||
        (dirtyElements.size === 0 && dirtyLeaves.size === 0) ||
        prevEditorState.isEmpty()
      ) {
        return;
      }
      editorState.read(() => {
        onChange($getRoot().getTextContent());
        onChipsChange($collectChips());
      });
    });
  }, [editor, onChange, onChipsChange]);

  return null;
}
