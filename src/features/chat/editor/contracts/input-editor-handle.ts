import type { LexicalEditor } from "lexical";

import type { ChipCommands } from "../commands/useChipCommands";
import type { EditorIO } from "../commands/useEditorIO";
import type { SkillCommands } from "../commands/useSkillCommands";

export type InputEditorHandle = EditorIO &
  ChipCommands &
  SkillCommands & {
    /**
     * Test-only escape hatch. Runs the callback with the underlying LexicalEditor so unit
     * tests can drive Lexical-internal flows (set selection, inspect state) without reaching
     * into private fields. Stripped from production builds via the NODE_ENV guard in
     * marshal/useImperativeEditorHandle.ts.
     */
    __test_with?(callback: (editor: LexicalEditor) => void): void;
  };
