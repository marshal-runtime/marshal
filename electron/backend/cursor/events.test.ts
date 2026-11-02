import type { InteractionUpdate, SDKMessage, ToolCallStartedUpdate } from "@cursor/sdk";
import { describe, expect, it } from "vitest";

import {
  CURSOR_DELTA_TEXT_DELTA,
  CURSOR_DELTA_THINKING_DELTA,
  CURSOR_DELTA_TOOL_CALL_COMPLETED,
  CURSOR_DELTA_TOOL_CALL_STARTED,
  CURSOR_RUN_STATUS_CANCELLED,
  CURSOR_RUN_STATUS_CREATING,
  CURSOR_RUN_STATUS_ERROR,
  CURSOR_RUN_STATUS_EXPIRED,
  CURSOR_RUN_STATUS_FINISHED,
  CURSOR_RUN_STATUS_RUNNING,
  CURSOR_STREAM_TOOL_STATUS_COMPLETED,
  CURSOR_STREAM_TOOL_STATUS_RUNNING,
  CURSOR_TOOL_CALL_FAILED_MESSAGE,
  CURSOR_TOOL_RESULT_ERROR,
  CURSOR_TOOL_RESULT_SUCCESS,
} from "./constants";
import { CursorEventTranslator } from "./events";

const AGENT_ID = "agent-1";
const RUN_ID = "run-1";
const MODEL_ID = "composer-2.5";
const MODEL_CALL_ID = "model-call-1";
const TOOL_CALL_ID = "tool-1";
const SHELL_TOOL_NAME = "shell";
const LS_COMMAND = "ls";

function shellStartedDelta(): ToolCallStartedUpdate {
  return {
    type: CURSOR_DELTA_TOOL_CALL_STARTED,
    modelCallId: MODEL_CALL_ID,
    callId: TOOL_CALL_ID,
    toolCall: { type: SHELL_TOOL_NAME, args: { command: LS_COMMAND } },
  };
}

describe("CursorEventTranslator", () => {
  describe("translate", () => {
    describe("Sanity Tests", () => {
      it("maps Cursor input and output token usage", () => {
        const translator = new CursorEventTranslator();
        const usage: SDKMessage = {
          type: "usage",
          agent_id: AGENT_ID,
          run_id: RUN_ID,
          usage: {
            inputTokens: 12_345,
            outputTokens: 678,
            cacheReadTokens: 100,
            cacheWriteTokens: 0,
            totalTokens: 13_123,
          },
        };

        expect(translator.translate(usage, MODEL_ID)).toEqual([
          expect.objectContaining({
            type: "assistant.usage",
            data: expect.objectContaining({
              model: MODEL_ID,
              inputTokens: 12_345,
              outputTokens: 678,
            }),
          }),
        ]);
      });

      it("maps assistant text and tool-call lifecycle", () => {
        const translator = new CursorEventTranslator();
        const assistant: SDKMessage = {
          type: "assistant",
          agent_id: AGENT_ID,
          run_id: RUN_ID,
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "hello" },
              {
                type: "tool_use",
                id: TOOL_CALL_ID,
                name: SHELL_TOOL_NAME,
                input: { command: LS_COMMAND },
              },
            ],
          },
        };
        const started: SDKMessage = {
          type: "tool_call",
          agent_id: AGENT_ID,
          run_id: RUN_ID,
          call_id: TOOL_CALL_ID,
          name: SHELL_TOOL_NAME,
          status: CURSOR_STREAM_TOOL_STATUS_COMPLETED,
          result: "ok",
        };

        expect(translator.translate(assistant, MODEL_ID).map((event) => event.type)).toEqual([
          "assistant.message_delta",
          "tool.execution_start",
        ]);
        expect(translator.translate(started, MODEL_ID)).toEqual([
          expect.objectContaining({
            type: "tool.execution_complete",
            data: expect.objectContaining({ toolCallId: TOOL_CALL_ID, success: true }),
          }),
        ]);
      });

      it("preserves text and tool order inside one assistant message", () => {
        const translator = new CursorEventTranslator();
        const assistant: SDKMessage = {
          type: "assistant",
          agent_id: AGENT_ID,
          run_id: RUN_ID,
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "before" },
              {
                type: "tool_use",
                id: TOOL_CALL_ID,
                name: SHELL_TOOL_NAME,
                input: { command: LS_COMMAND },
              },
              { type: "text", text: "after" },
            ],
          },
        };

        const translated = translator.translate(assistant, MODEL_ID);
        expect(translated.map((runtimeEvent) => runtimeEvent.type)).toEqual([
          "assistant.message_delta",
          "tool.execution_start",
          "assistant.message_delta",
        ]);
        const textEvents = translated.filter(
          (runtimeEvent) => runtimeEvent.type === "assistant.message_delta",
        );
        expect(textEvents.map((runtimeEvent) => runtimeEvent.data.deltaContent)).toEqual([
          "before",
          "after",
        ]);
        // Cursor's stream does not provide a stable logical-message identity.
        // Omitting a synthetic ID lets the turn accumulator merge adjacent
        // packets while the intervening tool remains a real block boundary.
        expect(textEvents[0].data.messageId).toBeUndefined();
        expect(textEvents[1].data.messageId).toBeUndefined();
      });
    });

    describe("Error Handling", () => {
      it("maps run errors onto session.error", () => {
        const translator = new CursorEventTranslator();
        const status: SDKMessage = {
          type: "status",
          agent_id: AGENT_ID,
          run_id: RUN_ID,
          status: CURSOR_RUN_STATUS_ERROR,
          message: "Invalid User API Key",
        };
        expect(translator.translate(status, MODEL_ID)).toEqual([
          expect.objectContaining({
            type: "session.error",
            data: { message: "Invalid User API Key", errorType: CURSOR_RUN_STATUS_ERROR },
          }),
        ]);
      });
    });

    describe("Edge Cases", () => {
      it("does not invent boundaries between adjacent assistant stream packets", () => {
        const translator = new CursorEventTranslator();
        const makeAssistant = (text: string): SDKMessage => ({
          type: "assistant",
          agent_id: AGENT_ID,
          run_id: RUN_ID,
          message: { role: "assistant", content: [{ type: "text", text }] },
        });
        const first = translator.translate(makeAssistant("one"), MODEL_ID)[0];
        const second = translator.translate(makeAssistant("two"), MODEL_ID)[0];

        expect(first?.type).toBe("assistant.message_delta");
        expect(second?.type).toBe("assistant.message_delta");
        if (
          first?.type !== "assistant.message_delta" ||
          second?.type !== "assistant.message_delta"
        ) {
          throw new Error("Expected assistant message deltas");
        }
        expect(first.data.messageId).toBeUndefined();
        expect(second.data.messageId).toBeUndefined();
      });

      it.each([
        CURSOR_RUN_STATUS_FINISHED,
        CURSOR_RUN_STATUS_CANCELLED,
        CURSOR_RUN_STATUS_RUNNING,
        CURSOR_RUN_STATUS_CREATING,
        CURSOR_RUN_STATUS_EXPIRED,
      ] as const)("does not surface lifecycle status %s", (status) => {
        const translator = new CursorEventTranslator();
        const message: SDKMessage = {
          type: "status",
          agent_id: AGENT_ID,
          run_id: RUN_ID,
          status,
        };
        expect(translator.translate(message, MODEL_ID)).toEqual([]);
      });

      it("dedupes a stream tool start that already arrived via onDelta", () => {
        const translator = new CursorEventTranslator();
        expect(translator.translateDelta(shellStartedDelta()).map((event) => event.type)).toEqual([
          "tool.execution_start",
        ]);
        const streamStart: SDKMessage = {
          type: "tool_call",
          agent_id: AGENT_ID,
          run_id: RUN_ID,
          call_id: TOOL_CALL_ID,
          name: SHELL_TOOL_NAME,
          status: CURSOR_STREAM_TOOL_STATUS_RUNNING,
          args: { command: LS_COMMAND },
        };
        expect(translator.translate(streamStart, MODEL_ID)).toEqual([]);
      });
    });
  });

  describe("translateDelta", () => {
    describe("Sanity Tests", () => {
      it("maps tool-call-started onto tool.execution_start", () => {
        const translator = new CursorEventTranslator();
        expect(translator.translateDelta(shellStartedDelta())).toEqual([
          expect.objectContaining({
            type: "tool.execution_start",
            data: expect.objectContaining({
              toolCallId: TOOL_CALL_ID,
              toolName: SHELL_TOOL_NAME,
              arguments: { command: LS_COMMAND },
            }),
          }),
        ]);
      });

      it("maps tool-call-completed onto tool.execution_complete", () => {
        const translator = new CursorEventTranslator();
        const completed: InteractionUpdate = {
          type: CURSOR_DELTA_TOOL_CALL_COMPLETED,
          modelCallId: MODEL_CALL_ID,
          callId: TOOL_CALL_ID,
          toolCall: {
            type: SHELL_TOOL_NAME,
            args: { command: LS_COMMAND },
            result: {
              status: CURSOR_TOOL_RESULT_SUCCESS,
              value: {
                exitCode: 0,
                signal: "",
                stdout: "ok",
                stderr: "",
                executionTime: 1,
              },
            },
          },
        };
        expect(translator.translateDelta(completed)).toEqual([
          expect.objectContaining({
            type: "tool.execution_complete",
            data: expect.objectContaining({
              toolCallId: TOOL_CALL_ID,
              success: true,
              result: expect.objectContaining({ stdout: "ok" }),
            }),
          }),
        ]);
      });
    });

    describe("Error Handling", () => {
      it("maps a failed tool-call-completed onto an error complete", () => {
        const translator = new CursorEventTranslator();
        const completed: InteractionUpdate = {
          type: CURSOR_DELTA_TOOL_CALL_COMPLETED,
          modelCallId: MODEL_CALL_ID,
          callId: TOOL_CALL_ID,
          toolCall: {
            type: SHELL_TOOL_NAME,
            args: { command: LS_COMMAND },
            result: { status: CURSOR_TOOL_RESULT_ERROR, error: "boom" },
          },
        };
        expect(translator.translateDelta(completed)).toEqual([
          expect.objectContaining({
            type: "tool.execution_complete",
            data: expect.objectContaining({
              toolCallId: TOOL_CALL_ID,
              success: false,
              error: "boom",
            }),
          }),
        ]);
      });
    });

    describe("Edge Cases", () => {
      it("ignores text and thinking deltas so streamed content is not duplicated", () => {
        const translator = new CursorEventTranslator();
        expect(translator.translateDelta({ type: CURSOR_DELTA_TEXT_DELTA, text: "hello" })).toEqual(
          [],
        );
        expect(
          translator.translateDelta({ type: CURSOR_DELTA_THINKING_DELTA, text: "considering" }),
        ).toEqual([]);
      });

      it("uses the fallback error when the failed result has no message", () => {
        const translator = new CursorEventTranslator();
        const completed: InteractionUpdate = {
          type: CURSOR_DELTA_TOOL_CALL_COMPLETED,
          modelCallId: MODEL_CALL_ID,
          callId: TOOL_CALL_ID,
          toolCall: {
            type: SHELL_TOOL_NAME,
            args: { command: LS_COMMAND },
            result: { status: CURSOR_TOOL_RESULT_ERROR },
          },
        };
        expect(translator.translateDelta(completed)).toEqual([
          expect.objectContaining({
            type: "tool.execution_complete",
            data: expect.objectContaining({
              error: CURSOR_TOOL_CALL_FAILED_MESSAGE,
              success: false,
            }),
          }),
        ]);
      });
    });
  });
});
