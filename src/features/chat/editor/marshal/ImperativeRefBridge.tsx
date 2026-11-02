/**
 * Inline bridge: lives inside `<LexicalComposer>` so it can grab the editor
 * via `useLexicalComposerContext()` and wire up the imperative API.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import type { Ref } from "react";

import type { InputEditorHandle } from "../contracts/input-editor-handle";
import { useImperativeEditorHandle } from "./useImperativeEditorHandle";

export function ImperativeRefBridge({
  imperativeRef,
}: {
  imperativeRef: Ref<InputEditorHandle> | undefined;
}) {
  const [editor] = useLexicalComposerContext();
  useImperativeEditorHandle(imperativeRef, editor);
  return null;
}
