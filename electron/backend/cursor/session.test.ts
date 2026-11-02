import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ConversationStep, InteractionUpdate, Run, SDKAgent, SDKMessage } from "@cursor/sdk";
import { describe, expect, it, vi } from "vitest";

import {
  CURSOR_DELTA_TOOL_CALL_COMPLETED,
  CURSOR_DELTA_TOOL_CALL_STARTED,
  CURSOR_TOOL_RESULT_SUCCESS,
} from "./constants";
import { CursorRuntimeSession } from "./session";

const GPT_MODEL_ID = "gpt-5.4";
const REASONING_PARAM_ID = "reasoning";
const TOOL_CALL_ID = "tool-1";
const MODEL_CALL_ID = "model-call-1";
const SHELL_TOOL_NAME = "shell";
const LS_COMMAND = "ls";

function resolveWithReasoningParam(paramId: string) {
  return (id: string, effort?: string) => ({
    id,
    ...(effort ? { params: [{ id: paramId, value: effort }] } : {}),
  });
}

function agentWithMessages(
  messages: SDKMessage[],
  deltas: InteractionUpdate[] = [],
  steps: ConversationStep[] = [],
): SDKAgent {
  return {
    agentId: "agent-1",
    model: { id: "composer-2.5" },
    send: vi.fn<SDKAgent["send"]>(async (_prompt, options) => {
      await Promise.all(deltas.map((update) => Promise.resolve(options?.onDelta?.({ update }))));
      await Promise.all(steps.map((step) => Promise.resolve(options?.onStep?.({ step }))));
      const run: Run = {
        id: "run-1",
        agentId: "agent-1",
        status: "finished",
        supports: vi.fn<Run["supports"]>(() => true),
        unsupportedReason: vi.fn<Run["unsupportedReason"]>(() => undefined),
        stream: async function* () {
          for (const message of messages) yield message;
        },
        conversation: vi.fn<Run["conversation"]>(async () => []),
        wait: async () => ({ id: "run-1", status: "finished" as const }),
        cancel: vi.fn<Run["cancel"]>(async () => undefined),
        onDidChangeStatus: vi.fn<Run["onDidChangeStatus"]>(() => () => undefined),
      };
      return run;
    }),
    close: vi.fn<SDKAgent["close"]>(),
    reload: vi.fn<SDKAgent["reload"]>(async () => undefined),
    [Symbol.asyncDispose]: vi.fn<SDKAgent[typeof Symbol.asyncDispose]>(async () => undefined),
    listArtifacts: vi.fn<SDKAgent["listArtifacts"]>(async () => []),
    downloadArtifact: vi.fn<SDKAgent["downloadArtifact"]>(),
    getUsage: vi.fn<SDKAgent["getUsage"]>(),
  } satisfies SDKAgent;
}

describe("CursorRuntimeSession", () => {
  it("keeps the prompt and retained context ready for retry when SDK startup rejects", async () => {
    const agent = agentWithMessages([]);
    vi.mocked(agent.send).mockRejectedValueOnce(new Error("startup rejected"));
    const session = new CursorRuntimeSession(agent, {
      systemMessage: { content: "Marshal prompt" },
    });
    await expect(session.sendAndWait({ prompt: "failed request" })).rejects.toThrow(
      "startup rejected",
    );
    expect((await session.exportConversationState()).messages).toEqual([]);
    await session.sendAndWait({ prompt: "retry" });
    expect(vi.mocked(agent.send).mock.calls[1][0]).toContain("Marshal prompt");
    expect((await session.exportConversationState()).messages).toEqual([
      { role: "user", content: "retry" },
    ]);
  });

  it("persists the latest native summary and following steps without the injected system prompt", async () => {
    const { testDouble } = await import("../../testing/harness/test-double");
    const agent = agentWithMessages(
      [],
      [{ type: "summary", summary: "Latest retained decisions" }],
      [
        testDouble<ConversationStep>({
          type: "assistantMessage",
          message: { text: "next step completed" },
        }),
      ],
    );
    const session = new CursorRuntimeSession(agent, {
      systemMessage: { content: "source Marshal prompt" },
      conversationState: {
        version: 1,
        sourceRuntimeId: "cursor",
        summary: "obsolete summary",
        messages: [{ role: "user", content: "obsolete user turn" }],
      },
    });
    await session.sendAndWait({ prompt: "continue" });
    const state = await session.exportConversationState();
    expect(state).toEqual({
      version: 1,
      sourceRuntimeId: "cursor",
      summary: "Latest retained decisions",
      messages: [
        { role: "user", content: "continue" },
        { role: "assistant", content: "next step completed" },
      ],
    });
    expect(JSON.stringify(state)).not.toMatch(/source Marshal prompt|obsolete/);
    const restored = new CursorRuntimeSession(agentWithMessages([]), { conversationState: state });
    await restored.sendAndWait({ prompt: "resume" });
    expect((await restored.exportConversationState()).messages).toEqual([
      ...state.messages,
      { role: "user", content: "resume" },
    ]);
  });

  it("allows a legacy session to continue but requires a readable summary before exporting", async () => {
    const deltas: InteractionUpdate[] = [];
    const session = new CursorRuntimeSession(
      agentWithMessages([], deltas),
      {},
      undefined,
      async () => {
        throw new Error("missing checkpoint");
      },
    );
    await session.sendAndWait({ prompt: "keep working natively" });
    await expect(session.exportConversationState()).rejects.toThrow("missing checkpoint");
    deltas.push({ type: "summary", summary: "Readable legacy context" });
    await session.rpc.history?.compact?.();
    await expect(session.exportConversationState()).resolves.toMatchObject({
      summary: "Readable legacy context",
      messages: [],
    });
  });

  it("automatically compacts legacy context only when a handoff requests it", async () => {
    const agent = agentWithMessages(
      [],
      [{ type: "summary", summary: "Retained legacy decisions" }],
    );
    const session = new CursorRuntimeSession(agent, {}, undefined, async () => {
      throw new Error("missing checkpoint");
    });
    await expect(session.exportConversationState()).rejects.toThrow("missing checkpoint");
    expect(agent.send).not.toHaveBeenCalled();
    await expect(session.exportConversationState({ allowCompaction: true })).resolves.toEqual({
      version: 1,
      sourceRuntimeId: "cursor",
      summary: "Retained legacy decisions",
      messages: [],
    });
    await session.exportConversationState({ allowCompaction: true });
    expect(agent.send).toHaveBeenCalledTimes(1);
    expect(vi.mocked(agent.send).mock.calls[0][0]).toBe("/summarize");
  });

  it("keeps legacy transfers blocked when automatic compaction exposes no summary, then retries", async () => {
    const deltas: InteractionUpdate[] = [];
    const agent = agentWithMessages([], deltas);
    const session = new CursorRuntimeSession(agent, {}, undefined, async () => {
      throw new Error("missing checkpoint");
    });
    await expect(session.exportConversationState({ allowCompaction: true })).rejects.toThrow(
      "readable compaction checkpoint",
    );
    await expect(session.exportConversationState()).rejects.toThrow("missing checkpoint");
    deltas.push({ type: "summary", summary: "Recovered decisions" });
    await expect(session.exportConversationState({ allowCompaction: true })).resolves.toMatchObject(
      {
        summary: "Recovered decisions",
      },
    );
  });

  it("exports saved checkpoints without compacting during a handoff", async () => {
    const agent = agentWithMessages([]);
    const state = {
      version: 1 as const,
      sourceRuntimeId: "cursor",
      messages: [{ role: "user" as const, content: "Keep this decision" }],
    };
    const session = new CursorRuntimeSession(agent, { conversationState: state });
    await expect(session.exportConversationState({ allowCompaction: true })).resolves.toEqual(
      state,
    );
    expect(agent.send).not.toHaveBeenCalled();
  });

  it("rejects handoff while Cursor is responding without starting compaction", async () => {
    const { agent, finish } = runningAgent();
    const session = new CursorRuntimeSession(agent, {}, undefined, async () => {
      throw new Error("missing checkpoint");
    });
    await session.send({ prompt: "ongoing work" });
    await expect(session.exportConversationState({ allowCompaction: true })).rejects.toThrow(
      "current Cursor response",
    );
    expect(agent.send).toHaveBeenCalledTimes(1);
    finish();
    await session.abort();
  });

  it("does not save a summary when the native compaction run fails", async () => {
    const agent = agentWithMessages([], [{ type: "summary", summary: "Unconfirmed summary" }]);
    const send = vi.mocked(agent.send).getMockImplementation()!;
    vi.mocked(agent.send).mockImplementationOnce(async (prompt, options) => {
      const run = await send(prompt, options);
      run.wait = async () => ({ id: run.id, status: "error" as const });
      return run;
    });
    const session = new CursorRuntimeSession(agent, {}, undefined, async () => {
      throw new Error("missing checkpoint");
    });
    const events: string[] = [];
    session.on((event) => events.push(event.type));
    await expect(session.exportConversationState({ allowCompaction: true })).rejects.toThrow(
      "Cursor session compaction failed",
    );
    await expect(session.exportConversationState()).rejects.toThrow("missing checkpoint");
    expect(events).not.toContain("session.context_checkpoint");
  });

  it("recovers a resumed agent's active-run collision once using SDK force-send", async () => {
    const agent = agentWithMessages([], [{ type: "summary", summary: "Recovered checkpoint" }]);
    vi.mocked(agent.send).mockRejectedValueOnce(new Error("Agent agent-1 already has active run"));
    const session = new CursorRuntimeSession(agent, {}, undefined, async () => {
      throw new Error("missing checkpoint");
    });
    await expect(session.exportConversationState({ allowCompaction: true })).resolves.toMatchObject(
      {
        summary: "Recovered checkpoint",
      },
    );
    expect(agent.send).toHaveBeenCalledTimes(2);
    expect(vi.mocked(agent.send).mock.calls[1]).toEqual([
      "/summarize",
      expect.objectContaining({ local: { force: true } }),
    ]);
  });

  it.each(["already has active run", "network unavailable"])(
    "bounds recovery for %s",
    async (message) => {
      const agent = agentWithMessages([]);
      vi.mocked(agent.send).mockRejectedValue(new Error(message));
      const session = new CursorRuntimeSession(agent, {}, undefined, async () => {
        throw new Error("missing checkpoint");
      });
      await expect(session.exportConversationState({ allowCompaction: true })).rejects.toThrow(
        message,
      );
      expect(agent.send).toHaveBeenCalledTimes(message === "already has active run" ? 2 : 1);
      await session.disconnect();
    },
  );

  function runningAgent() {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let status: Run["status"] = "running";
    const run: Run = {
      id: "running-1",
      agentId: "agent-1",
      get status() {
        return status;
      },
      supports: () => true,
      unsupportedReason: () => undefined,
      stream: async function* () {
        await done;
        yield* [];
      },
      conversation: async () => [],
      wait: async () => {
        await done;
        return { id: "running-1", status: status === "cancelled" ? "cancelled" : "finished" };
      },
      cancel: vi.fn<Run["cancel"]>(async () => {
        status = "cancelled";
        finish();
      }),
      steer: vi.fn<NonNullable<Run["steer"]>>(async () => "complete_delivered" as const),
      onDidChangeStatus: () => () => undefined,
    };
    const agent = agentWithMessages([]);
    vi.mocked(agent.send).mockResolvedValueOnce(run);
    return {
      agent,
      run,
      finish: () => {
        status = "finished";
        finish();
      },
    };
  }

  it("disconnect cancels a native running turn before disposing the agent", async () => {
    const { agent, run } = runningAgent();
    const session = new CursorRuntimeSession(agent, {});
    await session.send({ prompt: "work" });
    await session.disconnect();
    expect(run.status).toBe("cancelled");
    expect(run.cancel).toHaveBeenCalledOnce();
    expect(agent[Symbol.asyncDispose]).toHaveBeenCalledOnce();
    expect(vi.mocked(run.cancel).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(agent[Symbol.asyncDispose]).mock.invocationCallOrder[0],
    );
  });

  it("cancels the native run when its message stream fails", async () => {
    const { agent, run } = runningAgent();
    run.stream = async function* () {
      yield* [];
      throw new Error("broken stream");
    };
    const session = new CursorRuntimeSession(agent, {});
    await expect(session.sendAndWait({ prompt: "work" })).rejects.toThrow("broken stream");
    expect(run.cancel).toHaveBeenCalledOnce();
    expect(run.status).toBe("cancelled");
    await session.disconnect();
  });

  it("acknowledges startup and cancels the running SDK turn", async () => {
    const { agent, run } = runningAgent();
    const session = new CursorRuntimeSession(agent, { model: "composer-2.5" });
    await expect(session.send({ prompt: "work" })).resolves.toBe(run.id);
    await session.abort();
    expect(run.cancel).toHaveBeenCalledOnce();
    expect(run.status).toBe("cancelled");
    await expect(session.sendAndWait({ prompt: "next" })).resolves.toBeUndefined();
  });

  it("cancels a run whose SDK startup was still pending", async () => {
    const { agent, run } = runningAgent();
    let resolveStart!: (run: Run) => void;
    vi.mocked(agent.send)
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise<Run>((resolve) => {
            resolveStart = resolve;
          }),
      );
    const session = new CursorRuntimeSession(agent, { model: "composer-2.5" });
    const sending = session.send({ prompt: "work" });
    const rejected = sending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalledOnce());
    const cancelling = session.abort();
    resolveStart(run);
    await cancelling;
    expect(await rejected).toMatchObject({ message: "Cursor turn cancelled during startup" });
    expect(run.cancel).toHaveBeenCalledOnce();
  });

  it("steers a running turn without cancelling or sending twice", async () => {
    const { agent, run } = runningAgent();
    const session = new CursorRuntimeSession(agent, { model: "composer-2.5" });
    await session.send({ prompt: "work" });
    await expect(session.send({ prompt: "change direction" })).resolves.toBe(run.id);
    expect(run.steer).toHaveBeenCalledWith("change direction");
    expect(agent.send).toHaveBeenCalledOnce();
    expect(run.cancel).not.toHaveBeenCalled();
    await vi.mocked(agent.send).mock.calls[0][1]?.onDelta?.({
      update: { type: "summary", summary: "Latest compacted work" },
    });
    expect((await session.exportConversationState()).messages).toEqual([
      { role: "user", content: "work" },
      { role: "user", content: "change direction" },
    ]);
    await session.abort();
  });

  it("propagates a steering failure while retaining the original cancellation target", async () => {
    const { agent, run } = runningAgent();
    vi.mocked(run.steer!).mockRejectedValue(new Error("steer rejected"));
    const session = new CursorRuntimeSession(agent, { model: "composer-2.5" });
    await session.send({ prompt: "work" });
    await expect(session.send({ prompt: "correction" })).rejects.toThrow("steer rejected");
    expect(agent.send).toHaveBeenCalledOnce();
    expect(run.cancel).not.toHaveBeenCalled();
    await session.abort();
    expect(run.cancel).toHaveBeenCalledOnce();
  });

  it("does not start a cancelled turn after a pending prompt hook finishes", async () => {
    const agent = agentWithMessages([]);
    let releaseHook!: () => void;
    const hook = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const session = new CursorRuntimeSession(agent, {
      model: "composer-2.5",
      systemMessage: { content: "Marshal instructions", mode: "append" },
      hooks: {
        onUserPromptSubmitted: async () => {
          await hook;
        },
      },
    });
    const sending = session.send({ prompt: "work" }).catch((error: unknown) => error);
    const cancelling = session.abort();
    releaseHook();
    await cancelling;
    expect(await sending).toBeInstanceOf(Error);
    expect(agent.send).not.toHaveBeenCalled();
    await session.sendAndWait({ prompt: "next" });
    expect(vi.mocked(agent.send).mock.calls[0]?.[0]).toContain("Marshal instructions");
  });

  it("delivers rejected steering once as a follow-up after the original run", async () => {
    const { agent, run, finish } = runningAgent();
    vi.mocked(run.steer!).mockResolvedValue("revert_to_followup");
    const session = new CursorRuntimeSession(agent, { model: "composer-2.5" });
    await session.send({ prompt: "work" });
    const steering = session.send({ prompt: "follow-up" });
    await vi.waitFor(() => expect(run.steer).toHaveBeenCalledOnce());
    expect(agent.send).toHaveBeenCalledOnce();
    finish();
    await steering;
    expect(agent.send).toHaveBeenCalledTimes(2);
    expect(vi.mocked(agent.send).mock.calls[1]?.[0]).toBe("follow-up");
  });

  it("injects append-mode Marshal instructions into the first Cursor turn only", async () => {
    const agent = agentWithMessages([]);
    const session = new CursorRuntimeSession(agent, {
      model: "composer-2.5",
      systemMessage: { content: "# Marshal\n\nUpdated instructions.", mode: "append" },
    });

    await session.sendAndWait({ prompt: "first request" });
    await session.sendAndWait({ prompt: "follow-up" });

    expect(agent.send).toHaveBeenNthCalledWith(
      1,
      "<marshal-instructions>\n# Marshal\n\nUpdated instructions.\n</marshal-instructions>\n\n<user-request>\nfirst request\n</user-request>",
      expect.any(Object),
    );
    expect(vi.mocked(agent.send).mock.calls[0]?.[0]).not.toContain(
      "# Cursor SDK native tool operation",
    );
    expect(agent.send).toHaveBeenNthCalledWith(2, "follow-up", expect.any(Object));
  });

  it("injects replace-mode instructions into the first Cursor turn, like append mode", async () => {
    const agent = agentWithMessages([]);
    const session = new CursorRuntimeSession(agent, {
      model: "composer-2.5",
      systemMessage: { content: "Launch replacement", mode: "replace" },
    });

    await session.sendAndWait({ prompt: "user request" });

    expect(agent.send).toHaveBeenCalledWith(
      "<marshal-instructions>\nLaunch replacement\n</marshal-instructions>\n\n<user-request>\nuser request\n</user-request>",
      expect.any(Object),
    );
  });

  it("sends attached images through the Cursor SDK user-message shape", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "marshal-cursor-image-"));
    const imagePath = path.join(cwd, "clipboard.png");
    await writeFile(
      imagePath,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
    );
    try {
      const agent = agentWithMessages([]);
      const session = new CursorRuntimeSession(agent, {
        model: "composer-2.5",
        workingDirectory: cwd,
      });

      await session.sendAndWait({
        prompt: "describe this image",
        attachments: [{ type: "file", path: imagePath, displayName: "clipboard.png" }],
      });

      expect(agent.send).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("describe this image"),
          images: [
            {
              data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString(
                "base64",
              ),
              mimeType: "image/png",
            },
          ],
        }),
        expect.any(Object),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("compacts Cursor history with its native summarize command", async () => {
    const agent = agentWithMessages([], [{ type: "summary", summary: "Retained history" }]);
    const session = new CursorRuntimeSession(agent, { model: "composer-2.5" });

    await session.rpc.history?.compact?.();

    expect(agent.send).toHaveBeenCalledWith("/summarize", {
      model: { id: "composer-2.5" },
      onDelta: expect.any(Function),
    });
  });

  it("reports an unconfirmed compaction instead of claiming a transferable checkpoint", async () => {
    const session = new CursorRuntimeSession(agentWithMessages([]), {});
    await expect(session.rpc.history?.compact?.()).rejects.toThrow(
      "readable compaction checkpoint",
    );
    await session.abort();
  });

  it("streams assistant text then emits a completed message", async () => {
    const session = new CursorRuntimeSession(
      agentWithMessages([
        {
          type: "assistant",
          agent_id: "agent-1",
          run_id: "run-1",
          message: { role: "assistant", content: [{ type: "text", text: "hello world" }] },
        },
      ]),
      { model: "composer-2.5" },
    );
    const types: string[] = [];
    session.on((event) => types.push(event.type));
    await session.sendAndWait({ prompt: "hi" });
    expect(types).toEqual([
      "assistant.message_delta",
      "session.context_checkpoint",
      "assistant.message",
      "session.idle",
    ]);
  });

  it("does not idle twice when the stream also reports FINISHED", async () => {
    const session = new CursorRuntimeSession(
      agentWithMessages([
        {
          type: "assistant",
          agent_id: "agent-1",
          run_id: "run-1",
          message: { role: "assistant", content: [{ type: "text", text: "hello world" }] },
        },
        {
          type: "status",
          agent_id: "agent-1",
          run_id: "run-1",
          status: "FINISHED",
        },
      ]),
      { model: "composer-2.5" },
    );
    const types: string[] = [];
    session.on((event) => types.push(event.type));
    await session.sendAndWait({ prompt: "hi" });
    expect(types).toEqual([
      "assistant.message_delta",
      "session.context_checkpoint",
      "assistant.message",
      "session.idle",
    ]);
  });

  it("sends catalog reasoning params on each turn", async () => {
    const reasoningEffort = "high" as const;
    const agent = agentWithMessages([
      {
        type: "assistant",
        agent_id: "agent-1",
        run_id: "run-1",
        message: { role: "assistant", content: [{ type: "text", text: "hello world" }] },
      },
    ]);
    const session = new CursorRuntimeSession(
      agent,
      { model: GPT_MODEL_ID, reasoningEffort },
      resolveWithReasoningParam(REASONING_PARAM_ID),
    );
    await session.sendAndWait({ prompt: "hi" });
    expect(agent.send).toHaveBeenCalledWith("hi", {
      model: { id: GPT_MODEL_ID, params: [{ id: REASONING_PARAM_ID, value: reasoningEffort }] },
      onDelta: expect.any(Function),
      onStep: expect.any(Function),
    });
  });

  it("applies setModel reasoning effort on the next send", async () => {
    const nextEffort = "low" as const;
    const agent = agentWithMessages([
      {
        type: "assistant",
        agent_id: "agent-1",
        run_id: "run-1",
        message: { role: "assistant", content: [{ type: "text", text: "hello world" }] },
      },
    ]);
    const session = new CursorRuntimeSession(
      agent,
      { model: GPT_MODEL_ID, reasoningEffort: "high" },
      resolveWithReasoningParam(REASONING_PARAM_ID),
    );
    await session.setModel(GPT_MODEL_ID, { reasoningEffort: nextEffort });
    await session.sendAndWait({ prompt: "hi" });
    expect(agent.send).toHaveBeenCalledWith("hi", {
      model: { id: GPT_MODEL_ID, params: [{ id: REASONING_PARAM_ID, value: nextEffort }] },
      onDelta: expect.any(Function),
      onStep: expect.any(Function),
    });
  });

  it("emits tool activity from onDelta when the stream has no tool_call", async () => {
    const session = new CursorRuntimeSession(
      agentWithMessages(
        [],
        [
          {
            type: CURSOR_DELTA_TOOL_CALL_STARTED,
            modelCallId: MODEL_CALL_ID,
            callId: TOOL_CALL_ID,
            toolCall: { type: SHELL_TOOL_NAME, args: { command: LS_COMMAND } },
          },
          {
            type: CURSOR_DELTA_TOOL_CALL_COMPLETED,
            modelCallId: MODEL_CALL_ID,
            callId: TOOL_CALL_ID,
            toolCall: {
              type: SHELL_TOOL_NAME,
              args: { command: LS_COMMAND },
              result: {
                status: CURSOR_TOOL_RESULT_SUCCESS,
                value: { exitCode: 0, signal: "", stdout: "ok", stderr: "", executionTime: 1 },
              },
            },
          },
        ],
      ),
      { model: "composer-2.5" },
    );
    const types: string[] = [];
    session.on((event) => types.push(event.type));
    await session.sendAndWait({ prompt: "hi" });
    expect(types).toEqual([
      "tool.execution_start",
      "tool.execution_complete",
      "session.context_checkpoint",
      "session.idle",
    ]);
  });
});
