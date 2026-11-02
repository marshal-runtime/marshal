import { type LexicalEditor } from "lexical";
import { useImperativeHandle, type Ref } from "react";

import { useChipCommands } from "../commands/useChipCommands";
import { useEditorIO } from "../commands/useEditorIO";
import { useSkillCommands } from "../commands/useSkillCommands";
import type { InputEditorHandle } from "../contracts/input-editor-handle";

export function useImperativeEditorHandle(
  imperativeRef: Ref<InputEditorHandle> | undefined,
  editor: LexicalEditor,
): void {
  const io = useEditorIO(editor);
  const chips = useChipCommands(editor);
  const skill = useSkillCommands(editor);

  useImperativeHandle(
    imperativeRef,
    () => ({
      ...io,
      ...chips,
      ...skill,
      ...(process.env.NODE_ENV !== "production" && {
        __test_with: (callback: (e: LexicalEditor) => void) => callback(editor),
      }),
    }),
    [editor, io, chips, skill],
  );
}
