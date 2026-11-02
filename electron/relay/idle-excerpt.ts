import { isUserVisibleSessionMessage } from "../../common/marshal-ipc-contract";
import type { Message, PersistedSession } from "../session-store";

const RELAY_IDLE_LAST_MESSAGE_MAX_CHARS = 1200;

function truncateRelayIdleExcerpt(text: string): string {
  if (text.length <= RELAY_IDLE_LAST_MESSAGE_MAX_CHARS) return text;
  return `${text.slice(0, RELAY_IDLE_LAST_MESSAGE_MAX_CHARS).trimEnd()}\n[truncated]`;
}

function getRelayIdleMessageText(message: Message): string {
  const content = message.content.trim();
  const question = message.question?.question.trim() ?? "";
  if (!question || content.includes(question)) return content;
  return [content, `Question: ${question}`].filter(Boolean).join("\n\n");
}

export function getRelayIdleLastMessageExcerpt(sessionData: PersistedSession): string | null {
  const reversedMessages = [...sessionData.messages].reverse();
  const isVisible = (message: Message): boolean =>
    isUserVisibleSessionMessage(message) && Boolean(getRelayIdleMessageText(message));
  const message =
    reversedMessages.find((candidate) => candidate.role === "assistant" && isVisible(candidate)) ??
    reversedMessages.find((candidate) => candidate.role !== "system" && isVisible(candidate));
  if (!message) return null;
  return truncateRelayIdleExcerpt(getRelayIdleMessageText(message));
}
