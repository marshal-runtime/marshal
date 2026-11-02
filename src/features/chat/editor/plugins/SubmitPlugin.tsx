/**
 * SubmitPlugin: intercepts Enter at COMMAND_PRIORITY_HIGH so it runs BEFORE
 * PlainTextPlugin's KEY_ENTER_COMMAND handler (which otherwise inserts a line
 * break first). This keeps `getPlainText()` free of a trailing "\n" on submit.
 *
 * Behavior:
 *   Enter (no Shift, not in IME composition) -> call onEnter()
 *     - returns true  -> command consumed, no newline, caller handled it
 *     - returns false -> command falls through (PlainTextPlugin inserts a newline)
 *   Shift+Enter, or any Enter while composing (IME) -> not handled, line break inserted
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { COMMAND_PRIORITY_HIGH, KEY_ENTER_COMMAND } from "lexical";
import { useEffect, useEffectEvent } from "react";

interface SubmitPluginProps {
  onEnter: (modifiers: { steer: boolean }) => boolean;
}

export function SubmitPlugin({ onEnter }: SubmitPluginProps) {
  const [editor] = useLexicalComposerContext();
  // Use useEffectEvent so the command registration is stable across renders.
  // The picker also registers KEY_ENTER_COMMAND at the same priority; if this
  // effect re-ran on every render (because `onEnter` is recreated by the
  // parent each render), our listener would re-insert at the end of the
  // listener Set on every keystroke — racing with the picker for who handles
  // Enter. Stable registration keeps insertion order deterministic.
  const onEnterEvent = useEffectEvent((modifiers: { steer: boolean }) => onEnter(modifiers));

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (event === null) return false;
        if (event.shiftKey) return false;
        if (event.isComposing) return false;
        // Ctrl/Cmd+Enter requests a "steer" (interrupt the running turn).
        const handled = onEnterEvent({ steer: event.ctrlKey || event.metaKey });
        if (handled) {
          event.preventDefault();
        }
        return handled;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  return null;
}
