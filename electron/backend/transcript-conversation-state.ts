import {
  isHiddenInternalControlMessage,
  type SessionMessage,
} from "../../common/marshal-ipc-contract";
import type {
  RuntimeContextMessage,
  RuntimeConversationState,
} from "../../common/runtime-conversation-state";
import {
  MAX_HANDOFF_CONTEXT_CHARS,
  cleanContextUserText,
  validateConversationState,
} from "./conversation-state";

/** Why a handoff used Marshal's transcript. Generic codes only: never content. */
export type TranscriptHandoffReason =
  | "export-failed"
  | "export-unavailable"
  | "empty-export"
  | "runtime-mismatch"
  | "missing-native-id"
  | "stale-checkpoint";

const TOOL_FIELD_CHARS = 2_000;

type TranscriptSource = {
  messages: readonly SessionMessage[];
  contextSummary?: string;
  summaryUpToMessageId?: string;
};

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}… [truncated]` : text;
}

/** Messages that carried conversation for the model; failures and hidden plumbing do not. */
function isConversationMessage(message: SessionMessage): boolean {
  return (
    message.error !== true &&
    message.suppressedAgentStatusResponse !== true &&
    !isHiddenInternalControlMessage(message) &&
    message.content.trim().length + (message.toolCalls?.length ?? 0) > 0
  );
}

function toContextMessages(message: SessionMessage): RuntimeContextMessage[] {
  if (message.role === "user") {
    const content = cleanContextUserText(message.content);
    return content.trim() ? [{ role: "user", content }] : [];
  }
  if (message.role === "system") {
    // Host notices (agent messages, subagent readiness) reached the model as input.
    return message.content.trim()
      ? [{ role: "user", content: `[Marshal notice] ${message.content}` }]
      : [];
  }
  const records: RuntimeContextMessage[] = (message.toolCalls ?? []).map((call) => ({
    role: "tool",
    content: JSON.stringify({
      name: call.name,
      ...(call.input ? { input: clip(call.input, TOOL_FIELD_CHARS) } : {}),
      ...(call.output ? { output: clip(call.output, TOOL_FIELD_CHARS) } : {}),
      ...(call.error ? { error: clip(call.error, TOOL_FIELD_CHARS) } : {}),
      ...(call.cancelled ? { cancelled: true } : {}),
    }),
  }));
  if (message.content.trim()) records.push({ role: "assistant", content: message.content });
  return records;
}

function contextSize(messages: readonly RuntimeContextMessage[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

const TRANSCRIPT_NOTICE_PREFIX = "Marshal rebuilt this context from its own chat transcript";

function transcriptNotice(reason: TranscriptHandoffReason, sourceRuntimeId: string): string {
  return `${TRANSCRIPT_NOTICE_PREFIX} because the ${sourceRuntimeId} runtime's native context could not be used (reason: ${reason}). Tool entries summarize earlier actions and may be truncated.`;
}

/**
 * Portable context built from Marshal's persisted transcript. Always available, so a runtime
 * handoff never depends on what the source runtime can export.
 */
export function buildTranscriptConversationState(
  session: TranscriptSource,
  sourceRuntimeId: string,
  reason: TranscriptHandoffReason,
  options: { nativeSummary?: string } = {},
): RuntimeConversationState {
  const conversation = session.messages.filter(isConversationMessage);
  let messages = conversation.flatMap(toContextMessages);
  let summary = transcriptNotice(reason, sourceRuntimeId);
  if (options.nativeSummary) {
    summary += `\n\nSummary retained by the ${sourceRuntimeId} runtime:\n${options.nativeSummary}`;
  }
  // Prefer Marshal's own summary to dropping the oldest turns when the transcript is too large.
  const summaryIndex = session.summaryUpToMessageId
    ? conversation.findIndex((message) => message.id === session.summaryUpToMessageId)
    : -1;
  if (
    session.contextSummary &&
    summaryIndex >= 0 &&
    summary.length + contextSize(messages) > MAX_HANDOFF_CONTEXT_CHARS
  ) {
    summary += `\n\nEarlier conversation summary:\n${session.contextSummary}`;
    messages = conversation.slice(summaryIndex + 1).flatMap(toContextMessages);
  }
  return validateConversationState({ version: 1, sourceRuntimeId, summary, messages });
}

function sameUserTurn(stateContent: string, transcriptContent: string): boolean {
  const state = cleanContextUserText(stateContent).trim();
  const transcript = cleanContextUserText(transcriptContent).trim();
  if (!state || !transcript) return false;
  // Runtimes may prepend steering notes or append relay reminders to the visible text.
  return state === transcript || state.startsWith(transcript) || state.endsWith(transcript);
}

export interface TranscriptReconciliation {
  state: RuntimeConversationState;
  /** Set when transcript turns extended or replaced the given state. */
  repair?: "extended" | "rebuilt";
}

/**
 * Make sure retained context includes every conversational turn in the transcript. A saved
 * checkpoint can predate turns that ran elsewhere (another runtime, a failed checkpoint), and a
 * native session without a summary can lack older turns. Missing turns are added around the
 * turns both sides share; when none is shared, the transcript is used with any native summary.
 * A `fresh` export comes from the runtime that ran the latest turn, so its summary is trusted
 * to cover turns the text matching cannot place.
 */
export function reconcileWithTranscript(
  state: RuntimeConversationState,
  session: TranscriptSource,
  options: { fresh?: boolean } = {},
): TranscriptReconciliation {
  const conversation = session.messages.filter(isConversationMessage);
  const userTurns = conversation
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "user" && message.content.trim());
  if (!userTurns.length) return { state };
  const stateUsers = state.messages.filter((message) => message.role === "user");
  let messages = state.messages;
  let extended = false;
  if (!state.summary && stateUsers.length) {
    const first = userTurns.find(({ message }) =>
      sameUserTurn(stateUsers[0].content, message.content),
    );
    if (first && first.index > userTurns[0].index) {
      messages = [...conversation.slice(0, first.index).flatMap(toContextMessages), ...messages];
      extended = true;
    }
  }
  const latest = userTurns[userTurns.length - 1].message.content;
  if (!stateUsers.some((message) => sameUserTurn(message.content, latest))) {
    const lastStateUser = stateUsers[stateUsers.length - 1];
    const anchor = lastStateUser
      ? userTurns.findLast(({ message }) => sameUserTurn(lastStateUser.content, message.content))
      : undefined;
    if (anchor) {
      const next = userTurns.find(({ index }) => index > anchor.index);
      if (next) {
        messages = [...messages, ...conversation.slice(next.index).flatMap(toContextMessages)];
        extended = true;
      }
    } else if (!(options.fresh && state.summary)) {
      const nativeSummary = state.summary?.includes(TRANSCRIPT_NOTICE_PREFIX)
        ? undefined
        : state.summary;
      return {
        state: buildTranscriptConversationState(
          session,
          state.sourceRuntimeId,
          "stale-checkpoint",
          {
            nativeSummary,
          },
        ),
        repair: "rebuilt",
      };
    }
  }
  return extended
    ? { state: validateConversationState({ ...state, messages }), repair: "extended" }
    : { state };
}
