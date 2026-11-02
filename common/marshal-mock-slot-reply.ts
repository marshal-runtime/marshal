import type { MockStep, mockEvent as MockEventBuilder } from "./marshal-mock-scenarios";

export const SLOT_REPLY_TEXT = [
  "Here is the view you asked for:\n\n",
  "<!--ui:reply-->\n\n",
  "It sits inside this reply.",
];

/**
 * A turn that opens a view before replying: one tool call long enough for a
 * test to open a slot card, then a reply that streams its `<!--ui:reply-->`
 * marker between two paragraphs.
 */
export function buildSlotReplyScenario(event: typeof MockEventBuilder): MockStep[] {
  const messageId = "m-slot-reply";
  return [
    {
      type: "event",
      delay: 200,
      event: event("tool.execution_start", {
        toolCallId: "slot-reply-show",
        toolName: "runtimeShowUi",
        mcpToolName: "runtimeShowUi",
        arguments: { slot: "reply", placement: "card" },
      }),
    },
    {
      type: "event",
      delay: 8_000,
      event: event("tool.execution_complete", { toolCallId: "slot-reply-show", success: true }),
    },
    ...SLOT_REPLY_TEXT.map(
      (deltaContent): MockStep => ({
        type: "event",
        delay: 1_500,
        event: event("assistant.message_delta", { messageId, deltaContent }),
      }),
    ),
    {
      type: "event",
      delay: 1_000,
      event: event("assistant.message", { messageId, content: SLOT_REPLY_TEXT.join("") }),
    },
    { type: "event", delay: 100, event: event("session.idle", {}) },
  ];
}
