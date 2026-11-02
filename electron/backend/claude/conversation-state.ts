import type { RuntimeConversationState } from "../../../common/runtime-conversation-state";
import { appendUserContext, contextText, validateConversationState } from "../conversation-state";
import type { ClaudeSdkFacade } from "./sdk-facade";

/** Reads the SDK-owned retained chain without launching a Claude query. */
export async function readClaudeConversationState(
  sdk: ClaudeSdkFacade,
  sessionId: string,
  cwd: string,
): Promise<RuntimeConversationState> {
  const persisted = await sdk.getSessionMessages(sessionId, {
    dir: cwd,
    includeSystemMessages: true,
  });
  const state: import("../../../common/runtime-conversation-state").RuntimeConversationState = {
    version: 1,
    sourceRuntimeId: "claude",
    messages: [],
  };
  if (persisted.length === 0)
    throw new Error(
      "Claude has not persisted its retained conversation context yet. Retry the runtime switch.",
    );
  const latestSummary = persisted.findLastIndex(
    (entry) => Reflect.get(entry, "isCompactSummary") === true,
  );
  for (const entry of persisted.slice(Math.max(0, latestSummary))) {
    if (entry.parent_tool_use_id || entry.type === "system") continue;
    const payload = entry.message;
    if (!payload || typeof payload !== "object") continue;
    const content = contextText(Reflect.get(payload, "content"));
    if (!content) continue;
    if (Reflect.get(entry, "isCompactSummary") === true) {
      state.summary = content;
      state.messages = [];
    } else if (entry.type === "user") appendUserContext(state, content);
    else state.messages.push({ role: "assistant", content });
  }
  return validateConversationState(state);
}
