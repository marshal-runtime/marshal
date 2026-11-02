import type {
  MessageToolCall,
  SessionMessage,
  SessionViewEvent,
} from "../common/marshal-ipc-contract";

export function summarizeToolCall(toolCall: MessageToolCall): MessageToolCall {
  const detailsAvailable = Boolean(toolCall.input || toolCall.output || toolCall.error);
  if (!detailsAvailable) return toolCall;
  return {
    id: toolCall.id,
    name: toolCall.name,
    description: toolCallDisplayDescription(toolCall),
    activityKind: toolCall.activityKind,
    success: toolCall.success,
    ...(toolCall.cancelled ? { cancelled: true } : {}),
    detailsAvailable: true,
  };
}

export function summarizeMessageToolCalls(message: SessionMessage): SessionMessage {
  const hasDetailedTopLevelTools = message.toolCalls?.some(
    (toolCall) => toolCall.input || toolCall.output || toolCall.error,
  );
  const hasDetailedBlockTools = message.contentBlocks?.some(
    (block) =>
      block.type === "tools" &&
      block.toolCalls.some((toolCall) => toolCall.input || toolCall.output || toolCall.error),
  );
  if (!hasDetailedTopLevelTools && !hasDetailedBlockTools) {
    return message;
  }
  return {
    ...message,
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map(summarizeToolCall) } : {}),
    ...(message.contentBlocks
      ? {
          contentBlocks: message.contentBlocks.map((block) =>
            block.type === "tools"
              ? { ...block, toolCalls: block.toolCalls.map(summarizeToolCall) }
              : block,
          ),
        }
      : {}),
  };
}

export function summarizeViewEventToolCalls(event: SessionViewEvent): SessionViewEvent {
  if (event.committedMessages.length === 0) return event;
  return {
    ...event,
    committedMessages: event.committedMessages.map(summarizeMessageToolCalls),
  };
}

function toolCallDisplayDescription(toolCall: MessageToolCall): string {
  if (!/^Running (?:powershell|pwsh|shell)$/i.test(toolCall.description) || !toolCall.input) {
    return toolCall.description;
  }
  try {
    // SF-4: persisted tool input is untrusted; fields are read only after runtime narrowing.
    const parsed: unknown = JSON.parse(toolCall.input);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return toolCall.description;
    const descriptionValue = Reflect.get(parsed, "description");
    const description = typeof descriptionValue === "string" ? descriptionValue.trim() : "";
    if (description) return description;
    const commandValue = Reflect.get(parsed, "command");
    const command =
      typeof commandValue === "string" ? commandValue.replace(/\s+/g, " ").trim() : "";
    return command
      ? `Running ${command.length > 80 ? `${command.slice(0, 77)}...` : command}`
      : toolCall.description;
  } catch {
    return toolCall.description;
  }
}
