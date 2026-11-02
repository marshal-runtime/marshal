import path from "node:path";

import { type MessageToolCall, type SessionMessage } from "../common/marshal-ipc-contract";
import type { ISessionStore } from "./session-store";

export interface RuntimeTranscriptRequest {
  sessionId: string;
  uri: string;
  /** Byte offset in the public UTF-8 JSONL projection, not the encrypted file. */
  offset?: number;
}
export interface RuntimeTranscriptPage {
  uri: string;
  text: string;
  truncated: boolean;
  nextOffset?: number;
}
const PAGE_BYTES = 64 * 1024;

function publicTool(tool: MessageToolCall) {
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    input: tool.input,
    output: tool.output,
    success: tool.success,
    cancelled: tool.cancelled,
    error: tool.error,
  };
}
function publicMessage(message: SessionMessage): string {
  return (
    JSON.stringify({
      id: message.id,
      role: message.role,
      timestamp: message.timestamp,
      content: message.content,
      error: message.error,
      goalContinuation: message.goalContinuation,
      suppressedAgentStatusResponse: message.suppressedAgentStatusResponse,
      internalControl: message.internalControl && {
        kind: message.internalControl.kind,
        exchangeId: message.internalControl.exchangeId,
        side: message.internalControl.side,
      },
      toolCalls: message.toolCalls?.map(publicTool),
      contentBlocks: message.contentBlocks
        ?.filter((block) => block.type !== "reasoning")
        .map((block) =>
          block.type === "text"
            ? { type: "text", content: block.content }
            : block.type === "tools"
              ? { type: "tools", toolCalls: block.toolCalls.map(publicTool) }
              : undefined,
        ),
    }) + "\n"
  );
}

/** A bounded public projection, never a plaintext copy of the encrypted transcript. */
export async function readRuntimeTranscript(
  store: Pick<ISessionStore, "sessionsDir" | "iterateSessionMessageChunks">,
  request: RuntimeTranscriptRequest,
): Promise<RuntimeTranscriptPage> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(request.sessionId))
    throw new Error("Invalid transcript session ID.");
  const expected = path.join(store.sessionsDir, `${request.sessionId}.json`);
  if (!path.isAbsolute(request.uri) || request.uri !== expected)
    throw new Error("Transcript reference does not match the registered session path.");
  const offset = request.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new RangeError("Transcript offset must be a nonnegative safe integer.");
  if (!store.iterateSessionMessageChunks)
    throw new Error("This session store does not support paginated transcript reads.");
  const parts: Buffer[] = [];
  let retained = 0;
  let cursor = 0;
  outer: for await (const chunk of store.iterateSessionMessageChunks(request.sessionId)) {
    for (const message of chunk) {
      const line = Buffer.from(publicMessage(message), "utf8");
      const start = Math.max(0, offset - cursor);
      cursor += line.length;
      if (start >= line.length) continue;
      if (start > 0 && (line[start] & 0xc0) === 0x80)
        throw new RangeError("Transcript offset must be on a UTF-8 character boundary.");
      const portion = line.subarray(start, start + PAGE_BYTES + 4 - retained);
      parts.push(portion);
      retained += portion.length;
      if (retained > PAGE_BYTES) break outer;
    }
  }
  if (offset > cursor)
    throw new RangeError("Transcript offset exceeds the public transcript length.");
  const bytes = Buffer.concat(parts, retained);
  let end = Math.min(PAGE_BYTES, bytes.length);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  const truncated = end < bytes.length;
  return {
    uri: request.uri,
    text: bytes.subarray(0, end).toString("utf8"),
    truncated,
    ...(truncated ? { nextOffset: offset + end } : {}),
  };
}
