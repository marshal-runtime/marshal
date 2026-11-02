// Marshal-owned module.
/**
 * EditableStatePlugin: keeps Lexical's editable flag in sync with a `disabled`
 * prop so that when the SDK is not yet ready, the editor refuses input. The
 * matching `aria-disabled` attribute is set on <ContentEditable> separately
 * (assistive-tech signal); this plugin governs the actual no-input behavior.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useEffect } from "react";

interface EditableStatePluginProps {
  disabled: boolean;
}

export function EditableStatePlugin({ disabled }: EditableStatePluginProps) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  return null;
}
