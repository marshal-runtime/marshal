/** Portable model context, separate from the user-visible transcript and SDK IDs. */
export interface RuntimeConversationState {
  version: 1;
  sourceRuntimeId: string;
  summary?: string;
  messages: RuntimeContextMessage[];
}

export interface RuntimeContextMessage {
  role: "user" | "assistant" | "tool";
  content: string;
}
