import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalCommand,
} from "lexical";
import { mergeRegister } from "@lexical/utils";
import { useEffect, useEffectEvent } from "react";

type PickerKey = "Enter" | "Tab" | "Escape" | "ArrowUp" | "ArrowDown";

interface PickerKeyPluginProps {
  onPickerKeyIntercept?: (key: PickerKey) => boolean;
}

export function PickerKeyPlugin({ onPickerKeyIntercept }: PickerKeyPluginProps) {
  const [editor] = useLexicalComposerContext();
  const onInterceptEvent = useEffectEvent((key: PickerKey) => onPickerKeyIntercept?.(key) ?? false);

  useEffect(() => {
    const register = <T extends Event>(
      command: LexicalCommand<T>,
      key: PickerKey,
    ) =>
      editor.registerCommand<T>(
        command,
        (event) => {
          if (!onInterceptEvent(key)) return false;
          event?.preventDefault();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      );

    return mergeRegister(
      register<KeyboardEvent>(KEY_ENTER_COMMAND, "Enter"),
      register<KeyboardEvent>(KEY_TAB_COMMAND, "Tab"),
      register<KeyboardEvent>(KEY_ESCAPE_COMMAND, "Escape"),
      register<KeyboardEvent>(KEY_ARROW_UP_COMMAND, "ArrowUp"),
      register<KeyboardEvent>(KEY_ARROW_DOWN_COMMAND, "ArrowDown"),
    );
  }, [editor]);

  return null;
}
