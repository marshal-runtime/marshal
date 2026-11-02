// marshal-owned renderer test
import { describe, expect, it } from "vitest";

import { renderHook } from "../../../test-utils";
import type { Message } from "../components/ChatMessage";
import { useTimeline } from "./useTimeline";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1",
    role: "assistant",
    content: "Hello",
    timestamp: new Date("2026-04-19T09:38:57.243Z"),
    ...overrides,
  };
}

describe("useTimeline", () => {
  it("keeps assistant messages with inline questions even when content is empty", () => {
    const questionMessage = makeMessage({
      content: "",
      question: {
        question: "What should I do next?",
        answers: [{ title: "Retry" }, { title: "Stop" }],
      },
    });

    const { result } = renderHook(() => useTimeline([questionMessage], []));

    expect(result.current.runs).toHaveLength(1);
    expect(result.current.runs[0]).toMatchObject({
      role: "assistant",
      items: [{ kind: "message", data: questionMessage }],
    });
  });

  it("keeps interrupted assistant activity when no final text was emitted", () => {
    const interruptedMessage = makeMessage({
      content: "",
      reasoning: { text: "Inspecting the failing path.", durationSeconds: 2 },
      toolCalls: [
        {
          id: "read-1",
          name: "read_file",
          description: "Reading the failing file",
          success: false,
          cancelled: true,
        },
      ],
    });

    const { result } = renderHook(() => useTimeline([interruptedMessage], []));

    expect(result.current.runs).toMatchObject([
      {
        role: "assistant",
        items: [{ kind: "message", data: interruptedMessage }],
      },
    ]);
  });

  it("still suppresses truly blank assistant messages with no renderable content", () => {
    const blankMessage = makeMessage({ content: "   " });

    const { result } = renderHook(() => useTimeline([blankMessage], []));

    expect(result.current.timeline).toEqual([]);
    expect(result.current.runs).toEqual([]);
  });
});
