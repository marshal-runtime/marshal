import { fireEvent, screen } from "@testing-library/react";
import { act } from "react";

export function getPromptEditor(): HTMLElement {
  return screen.getByRole("textbox", { name: "Message" });
}

export function promptEditorText(): string {
  return getPromptEditor().textContent ?? "";
}

export async function setPromptTextDOM(text: string): Promise<void> {
  getPromptEditor();
  const api = window.__chatInputTestApi;
  if (!api) {
    throw new Error(
      "ChatInput test API not found on window — is ChatInput mounted and is import.meta.env.MODE 'test'?",
    );
  }
  await act(async () => {
    api.setInput(text);
  });
}

export async function clearPromptTextDOM(): Promise<void> {
  await setPromptTextDOM("");
}

/**
 * Dispatches non-text keys handled by ChatInput itself.
 *
 * Load-bearing: this works because Lexical's editing commands (KEY_BACKSPACE_COMMAND,
 * KEY_DELETE_COMMAND, KEY_ENTER_COMMAND, etc.) are dispatched from a `keydown` listener
 * on the contenteditable. If a future Lexical major version moves to `beforeinput` for
 * these (mirroring its text-insertion path), every chip-removal / Enter / arrow test
 * here will silently no-op. Re-verify on Lexical bumps.
 */
export function pressInPromptEditor(
  key: string,
  init?: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean },
): void {
  const editor = getPromptEditor();
  editor.focus();
  fireEvent.keyDown(editor, { key, ...init });
}
