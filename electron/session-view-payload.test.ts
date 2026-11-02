import { describe, expect, it } from "vitest";

import { DEFAULT_SESSION_VIEW, type SessionMessage } from "../common/marshal-ipc-contract";
import {
  summarizeMessageToolCalls,
  summarizeToolCall,
  summarizeViewEventToolCalls,
} from "./session-view-payload";

const message: SessionMessage = {
  id: "message-1",
  role: "assistant",
  content: "Done",
  timestamp: "2026-07-12T00:00:00.000Z",
  toolCalls: [
    {
      id: "tool-1",
      name: "read_file",
      description: "Read a file",
      activityKind: "read",
      input: "large input",
      output: "large output",
      success: true,
    },
  ],
};

describe("session view payload summaries", () => {
  it("removes heavy tool details while preserving row metadata", () => {
    expect(summarizeMessageToolCalls(message).toolCalls).toEqual([
      {
        id: "tool-1",
        name: "read_file",
        description: "Read a file",
        activityKind: "read",
        success: true,
        detailsAvailable: true,
      },
    ]);
  });

  it("summarizes committed messages without mutating the source event", () => {
    const event = {
      type: "session:view" as const,
      view: DEFAULT_SESSION_VIEW,
      committedMessages: [message],
    };
    const summarized = summarizeViewEventToolCalls(event);

    expect(summarized.committedMessages[0].toolCalls?.[0].output).toBeUndefined();
    expect(event.committedMessages[0].toolCalls?.[0].output).toBe("large output");
  });

  it("removes heavy details from chronological tool blocks", () => {
    const summarized = summarizeMessageToolCalls({
      ...message,
      contentBlocks: [
        { id: "text-1", type: "text", content: "Working" },
        {
          id: "tools-1",
          type: "tools",
          toolCalls: message.toolCalls ?? [],
        },
      ],
    });

    const toolsBlock = summarized.contentBlocks?.find((block) => block.type === "tools");
    expect(toolsBlock).toMatchObject({
      type: "tools",
      toolCalls: [
        {
          id: "tool-1",
          description: "Read a file",
          detailsAvailable: true,
        },
      ],
    });
    if (toolsBlock?.type !== "tools") throw new Error("Expected tools block");
    expect(toolsBlock.toolCalls[0].input).toBeUndefined();
    expect(toolsBlock.toolCalls[0].output).toBeUndefined();
  });

  it("preserves a useful shell description while stripping the input", () => {
    const summarized = summarizeMessageToolCalls({
      ...message,
      toolCalls: [
        {
          name: "powershell",
          description: "Running powershell",
          input: JSON.stringify({ command: "git status", description: "List changes" }),
        },
      ],
    });

    expect(summarized.toolCalls?.[0]).toMatchObject({
      description: "List changes",
      detailsAvailable: true,
    });
    expect(summarized.toolCalls?.[0].input).toBeUndefined();
  });

  it("preserves cancellation outcome while omitting detailed error text", () => {
    expect(
      summarizeToolCall({
        id: "cancelled",
        name: "browser_click",
        description: "Clicking Submit",
        success: false,
        cancelled: true,
        error: "Operation cancelled",
      }),
    ).toEqual({
      id: "cancelled",
      name: "browser_click",
      description: "Clicking Submit",
      success: false,
      cancelled: true,
      detailsAvailable: true,
    });
  });
});
