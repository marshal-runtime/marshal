import { act } from "react";
import type { RefObject } from "react";

import type { ChatInputRef } from "../components/ChatInput";

export async function setPromptText(
  ref: RefObject<ChatInputRef | null>,
  text: string,
): Promise<void> {
  if (!ref.current) throw new Error("ChatInputRef is not attached");
  await act(async () => {
    ref.current!.setInput(text);
  });
}

export async function clearPromptText(ref: RefObject<ChatInputRef | null>): Promise<void> {
  await setPromptText(ref, "");
}
