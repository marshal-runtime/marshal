import type { ReasoningEffort, TurnLlmUsageEvent } from "../../common/marshal-ipc-contract";
import type { PersistedSession } from "../session-store";

export interface SessionExecutionUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly costUsd?: number;
}

/** A turn receipt contains references and counters, never copied conversation text. */
export interface SessionExecutionEvidence {
  readonly executionId: string;
  readonly sessionId: string;
  readonly transcriptRef: string;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly usage?: SessionExecutionUsage;
  readonly usageByModel?: readonly {
    readonly model?: string;
    readonly usage: SessionExecutionUsage;
  }[];
  readonly callIds?: readonly string[];
}

export function sessionExecutionId(session: PersistedSession): string {
  const message = session.messages.findLast((candidate) => candidate.role === "user");
  return `${session.id}:${message?.id ?? "initial"}`;
}

export function recordSessionExecutionUsage(
  session: PersistedSession,
  event: TurnLlmUsageEvent,
  transcriptRef: string,
  reasoningEffort?: ReasoningEffort,
): void {
  const executionId = session.runtimeActiveExecutionId ?? sessionExecutionId(session);
  const executions = session.runtimeExecutions ?? [];
  const previous = executions.find((execution) => execution.executionId === executionId);
  const providerCallId = event.apiCallId ?? event.providerCallId;
  const model = event.model?.trim() || undefined;
  // A provider result can report several model buckets (including auxiliary
  // models). Replays deduplicate each bucket, not the entire result UUID.
  const callId = providerCallId ? JSON.stringify([providerCallId, model ?? null]) : undefined;
  if (
    callId &&
    (previous?.callIds?.includes(callId) ||
      (providerCallId && previous?.callIds?.includes(providerCallId)))
  )
    return;
  const resolvedReasoningEffort = previous?.reasoningEffort ?? reasoningEffort;
  const modelBuckets = previous?.usageByModel ?? [];
  const priorModel = modelBuckets.find((bucket) => bucket.model === model);
  const usageByModel = [
    ...modelBuckets.filter((bucket) => bucket.model !== model),
    { ...(model ? { model } : {}), usage: addUsage(priorModel?.usage, event) },
  ];
  const next: SessionExecutionEvidence = {
    executionId,
    sessionId: session.id,
    transcriptRef,
    // Keep the session's execution model separate from helper-model spend.
    model: session.model ?? (usageByModel.length === 1 ? model : undefined),
    ...(resolvedReasoningEffort ? { reasoningEffort: resolvedReasoningEffort } : {}),
    usage: addUsage(previous?.usage, event),
    usageByModel,
    ...(callId
      ? { callIds: [...(previous?.callIds ?? []), callId] }
      : previous?.callIds
        ? { callIds: previous.callIds }
        : {}),
  };
  session.runtimeExecutions = [
    ...executions.filter((entry) => entry.executionId !== executionId),
    next,
  ];
}

function addUsage(
  previous: SessionExecutionUsage | undefined,
  event: TurnLlmUsageEvent,
): SessionExecutionUsage {
  const values = {
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cachedInputTokens: event.cacheReadTokens,
    costUsd: event.cost,
  };
  const total: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    costUsd?: number;
  } = {};
  for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "costUsd"] as const) {
    if (
      event.usageAvailability?.[key] === false ||
      (previous !== undefined && previous[key] === undefined)
    )
      continue;
    total[key] = (previous?.[key] ?? 0) + values[key];
  }
  return total;
}
