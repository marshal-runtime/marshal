import { describe, expect, it } from "vitest";

import { StoredSessionSchema, StoredSessionHeaderSchema } from "./session-schema";
const BASE = {
  id: "chat",
  name: "Chat",
  createdAt: "",
  updatedAt: "",
  hasUnread: false,
  isActive: false,
};

describe("retained runtime context persistence", () => {
  it("preserves an undelivered handoff in both legacy files and chunk headers", () => {
    const context = {
      version: 1,
      sourceRuntimeId: "cursor",
      summary: "latest compaction",
      messages: [{ role: "user", content: "recent request" }],
    };
    const fields = {
      ...BASE,
      runtimeId: "claude",
      runtimeConversationState: context,
      pendingRuntimeHandoff: true,
    };
    expect(StoredSessionSchema.parse({ ...fields, messages: [] }).runtimeConversationState).toEqual(
      context,
    );
    const header = StoredSessionHeaderSchema.parse({
      ...fields,
      storageFormat: "chunked-v1",
      chunkCount: 0,
      messageCount: 0,
    });
    expect(header.runtimeConversationState).toEqual(context);
    expect(header.pendingRuntimeHandoff).toBe(true);
  });
});
