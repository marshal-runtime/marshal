import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import type { RuntimeConversationState } from "../../../common/runtime-conversation-state";
import { appendUserContext, contextText, validateConversationState } from "../conversation-state";
import { isRecord } from "./protocol";

export function appendCodexContext(state: RuntimeConversationState, item: unknown): void {
  if (!isRecord(item)) return;
  if (item.type === "compaction" || item.type === "encrypted_compaction") {
    throw new Error("Codex's retained compaction state is encrypted and cannot be exported.");
  }
  if (item.type === "message" && (item.role === "user" || item.role === "assistant")) {
    const blocks: unknown = item.content;
    const content = contextText(
      item.role === "user" && Array.isArray(blocks)
        ? blocks.filter((block: unknown) => {
            if (!isRecord(block) || typeof block.text !== "string") return true;
            const text = block.text.trim();
            return !(
              /^<environment_context>[\s\S]*<\/environment_context>$/.test(text) ||
              /^# AGENTS\.md instructions for [^\n]+\n[\s\S]*<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>$/.test(
                text,
              )
            );
          })
        : blocks,
    );
    if (content) {
      if (item.role === "user") appendUserContext(state, content);
      else state.messages.push({ role: "assistant", content });
    }
  } else if (
    [
      "function_call",
      "function_call_output",
      "custom_tool_call",
      "custom_tool_call_output",
      "web_search_call",
    ].includes(String(item.type))
  ) {
    state.messages.push({ role: "tool", content: JSON.stringify(item) });
  }
}

/** Replay the model-context checkpoints, not the UI's all-history projection. */
export async function readCodexConversationState(
  rolloutPath: string,
  codexHome: string,
): Promise<RuntimeConversationState> {
  const [file, home] = await Promise.all([realpath(rolloutPath), realpath(codexHome)]);
  const relative = path.relative(home, file);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("Codex returned a context file outside Marshal's runtime storage");
  }
  const state: RuntimeConversationState = { version: 1, sourceRuntimeId: "codex", messages: [] };
  let retainedError: Error | undefined;
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const record: unknown = JSON.parse(line) as unknown;
      if (!isRecord(record) || !isRecord(record.payload)) continue;
      if (record.type === "compacted") {
        state.messages = [];
        state.summary = undefined;
        retainedError = undefined;
        try {
          if (Array.isArray(record.payload.replacement_history)) {
            for (const item of record.payload.replacement_history) appendCodexContext(state, item);
          } else if (typeof record.payload.message === "string" && record.payload.message) {
            state.summary = record.payload.message;
          } else {
            throw new Error("Codex did not expose a portable compaction checkpoint");
          }
        } catch (error) {
          retainedError = error instanceof Error ? error : new Error(String(error));
        }
      } else if (record.type === "response_item" && !retainedError) {
        try {
          appendCodexContext(state, record.payload);
        } catch (error) {
          retainedError = error instanceof Error ? error : new Error(String(error));
        }
      } else if (record.type === "event_msg" && record.payload.type === "thread_rolled_back") {
        let remaining = Number(record.payload.num_turns);
        while (remaining > 0) {
          const index = state.messages.findLastIndex((message) => message.role === "user");
          if (index < 0) break;
          state.messages.splice(index);
          remaining -= 1;
        }
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  if (retainedError) throw retainedError;
  return validateConversationState(state);
}
