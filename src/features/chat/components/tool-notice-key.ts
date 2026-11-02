interface ToolNoticeIdentity {
  sessionId?: string | null;
  toolId?: string;
  messageId?: string;
  toolCallIndex?: number;
  description: string;
  error?: string;
}

export function toolNoticeKey({
  sessionId,
  toolId,
  messageId,
  toolCallIndex,
  description,
  error,
}: ToolNoticeIdentity): string {
  const toolIdentity =
    toolId ?? `${messageId ?? "live"}:${toolCallIndex ?? 0}:${error ?? description}`;
  return `tool:${sessionId ?? "unknown-session"}:${toolIdentity}`;
}
