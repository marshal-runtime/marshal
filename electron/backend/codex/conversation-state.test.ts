import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readCodexConversationState } from "./conversation-state";

const message = (role: string, text: string) => ({
  type: "message",
  role,
  content: [{ type: "input_text", text }],
});

async function withRollout(records: unknown[], run: (file: string, home: string) => Promise<void>) {
  const home = await mkdtemp(path.join(tmpdir(), "marshal-context-"));
  const file = path.join(home, "rollout.jsonl");
  try {
    await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n"));
    await run(file, home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("Codex retained context", () => {
  it("exports the latest replacement checkpoint, removes provider prompts, and respects rollback", async () => {
    await withRollout(
      [
        { type: "response_item", payload: message("user", "old visible history") },
        { type: "compacted", payload: { message: "earlier summary" } },
        {
          type: "compacted",
          payload: {
            replacement_history: [
              message("developer", "Codex system prompt"),
              message("assistant", "Latest compacted summary"),
            ],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "<environment_context>\nsource runtime configuration\n</environment_context>",
              },
              {
                type: "input_text",
                text: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nsource repository prompt\n</INSTRUCTIONS>",
              },
            ],
          },
        },
        { type: "response_item", payload: message("user", "keep this") },
        {
          type: "response_item",
          payload: { type: "function_call_output", call_id: "t", output: "actual output" },
        },
        { type: "response_item", payload: message("user", "rolled back") },
        { type: "response_item", payload: message("assistant", "also rolled back") },
        { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } },
      ],
      async (file, home) => {
        const state = await readCodexConversationState(file, home);
        expect(state.messages.map((entry) => entry.role)).toEqual(["assistant", "user", "tool"]);
        expect(state.messages[0].content).toBe("Latest compacted summary");
        expect(JSON.stringify(state)).not.toMatch(
          /old visible|earlier summary|system prompt|rolled back|source runtime|source repository/,
        );
      },
    );
  });

  it("refuses opaque compaction state", async () => {
    await withRollout(
      [
        {
          type: "compacted",
          payload: { replacement_history: [{ type: "compaction", encrypted_content: "opaque" }] },
        },
      ],
      async (file, home) => {
        await expect(readCodexConversationState(file, home)).rejects.toThrow("encrypted");
      },
    );
  });

  it("ignores opaque checkpoints that a later readable compaction replaced", async () => {
    await withRollout(
      [
        {
          type: "compacted",
          payload: {
            replacement_history: [{ type: "compaction", encrypted_content: "old opaque state" }],
          },
        },
        {
          type: "compacted",
          payload: { replacement_history: [message("assistant", "latest readable checkpoint")] },
        },
        { type: "response_item", payload: message("user", "continue") },
      ],
      async (file, home) => {
        expect((await readCodexConversationState(file, home)).messages).toEqual([
          { role: "assistant", content: "latest readable checkpoint" },
          { role: "user", content: "continue" },
        ]);
      },
    );
  });

  it("refuses a rollout outside Marshal's Codex home", async () => {
    await withRollout([], async (file) => {
      const other = await mkdtemp(path.join(tmpdir(), "marshal-other-context-"));
      try {
        await expect(readCodexConversationState(file, other)).rejects.toThrow("outside");
      } finally {
        await rm(other, { recursive: true, force: true });
      }
    });
  });
});
