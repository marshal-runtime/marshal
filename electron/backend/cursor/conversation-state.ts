import type { RuntimeConversationState } from "../../../common/runtime-conversation-state";
import { appendUserContext, validateConversationState } from "../conversation-state";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** SDK checkpoint reads return protobuf messages; exclude root prompts and archived summaries. */
export function cursorConversationState(value: unknown): RuntimeConversationState {
  const native = object(value);
  const toJson = native?.toJson;
  const conversation = object(typeof toJson === "function" ? toJson.call(value) : value);
  const turns: unknown = conversation?.turns ?? [];
  if (!conversation || !Array.isArray(turns))
    throw new Error("Cursor returned an invalid native conversation checkpoint");
  const summary = object(conversation.summary)?.summary;
  const state: RuntimeConversationState = {
    version: 1,
    sourceRuntimeId: "cursor",
    messages: [],
    ...(typeof summary === "string" && summary.trim() ? { summary } : {}),
  };
  for (const entry of turns) {
    const turn = object(entry);
    const agent = object(turn?.agentConversationTurn);
    if (agent) {
      const text = object(agent.userMessage)?.text;
      if (typeof text === "string") appendUserContext(state, text);
      if (!Array.isArray(agent.steps)) continue;
      for (const item of agent.steps) {
        const step = object(item);
        const reply = object(step?.assistantMessage)?.text;
        if (typeof reply === "string" && reply)
          state.messages.push({ role: "assistant", content: reply });
        const tool = object(step?.toolCall);
        if (tool) state.messages.push({ role: "tool", content: JSON.stringify(tool) });
      }
    } else {
      const shell = object(turn?.shellConversationTurn);
      if (shell) state.messages.push({ role: "tool", content: JSON.stringify(shell) });
    }
  }
  return validateConversationState(state);
}
