export interface LegacySubagentReadinessEnvelope {
  sourceLabel: string;
  sourceSessionId: string;
}

export function parseLegacySubagentReadinessEnvelope(
  content: string,
): LegacySubagentReadinessEnvelope | null {
  const match =
    /^Message from subagent ([\s\S]+) \(([^)\r\n]+)\):\n\nSubagent "([\s\S]+)" \(([^)\r\n]+)\) is idle and ready for follow-up\.$/.exec(
      content.trim(),
    );
  if (!match || match[1] !== match[3] || match[2] !== match[4]) return null;
  return { sourceLabel: match[1], sourceSessionId: match[2] };
}

export function parseLegacySubagentReadinessDelivery(input: {
  content: string;
  idempotencyKey?: string;
  sourceSessionId?: string;
}): LegacySubagentReadinessEnvelope | null {
  const envelope = parseLegacySubagentReadinessEnvelope(input.content);
  if (
    !envelope ||
    input.sourceSessionId !== envelope.sourceSessionId ||
    !input.idempotencyKey?.startsWith(`subagent-idle:${envelope.sourceSessionId}:`)
  ) {
    return null;
  }
  return envelope;
}
