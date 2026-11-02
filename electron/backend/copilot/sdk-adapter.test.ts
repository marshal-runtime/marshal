import type {
  CopilotClient,
  CopilotSession,
  SessionConfig,
  SessionEvent,
  Tool,
} from "@github/copilot-sdk";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeSessionEvent } from "../../../common/runtime-events";
import { testDouble } from "../../testing/harness/test-double";
import { CopilotSdkClientAdapter, toCopilotSessionConfig } from "./sdk-adapter";

function sdkSession(
  on: CopilotSession["on"] = vi.fn<CopilotSession["on"]>(() => () => {}),
  getEvents: CopilotSession["getEvents"] = vi.fn<CopilotSession["getEvents"]>(async () => []),
): CopilotSession {
  return testDouble<CopilotSession>({
    sessionId: "sdk-session",
    rpc: {},
    on,
    send: vi.fn<CopilotSession["send"]>(async () => "message-id"),
    sendAndWait: vi.fn<CopilotSession["sendAndWait"]>(async () => undefined),
    disconnect: vi.fn<CopilotSession["disconnect"]>(async () => undefined),
    abort: vi.fn<CopilotSession["abort"]>(async () => undefined),
    setModel: vi.fn<CopilotSession["setModel"]>(async () => undefined),
    getEvents,
  });
}

describe("CopilotSdkClientAdapter", () => {
  it("keeps host handoff metadata out of the native SDK configuration", () => {
    const config = toCopilotSessionConfig({
      conversationState: {
        version: 1,
        sourceRuntimeId: "cursor",
        messages: [{ role: "user", content: "retained history" }],
      },
      model: "test-model",
    });
    expect(config.model).toBe("test-model");
    expect(config).not.toHaveProperty("conversationState");
  });

  it("maps neutral tools, MCP config, and permission results into SDK session config", async () => {
    let captured: SessionConfig | undefined;
    const createSession = vi.fn<CopilotClient["createSession"]>(async (config) => {
      captured = config;
      return sdkSession();
    });
    const client = testDouble<CopilotClient>({ createSession });
    const adapter = new CopilotSdkClientAdapter(client);
    const handler = vi.fn<(args: unknown) => Promise<string>>(async () => "ok");

    await adapter.createSession({
      model: "test-model",
      mcpServers: {
        local: { type: "local", command: "node", args: ["server.js"], tools: ["*"] },
      },
      tools: [
        {
          name: "host_tool",
          description: "Host tool",
          parameters: { type: "object", properties: {} },
          handler,
        },
      ],
      onPermissionRequest: () => ({ kind: "reject", feedback: "blocked" }),
    });

    expect(captured?.mcpServers).toEqual({
      local: { type: "local", command: "node", args: ["server.js"], tools: ["*"] },
    });
    const tool = captured?.tools?.[0] as Tool | undefined;
    await tool?.handler?.(
      {},
      testDouble({
        sessionId: "s1",
        toolCallId: "tc1",
        toolName: "host_tool",
        arguments: {},
      }),
    );
    expect(handler).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        sessionId: "s1",
        toolCallId: "tc1",
        toolName: "host_tool",
      }),
    );
    await expect(
      captured?.onPermissionRequest?.(
        testDouble({ kind: "custom-tool", toolCallId: "tc1", toolName: "host_tool" }),
        { sessionId: "s1" },
      ),
    ).resolves.toEqual({ kind: "reject", feedback: "blocked" });
  });

  it("maps SDK events to neutral events and preserves unknown event payloads", async () => {
    let sdkHandler: ((event: SessionEvent) => void) | undefined;
    const on = vi.fn<CopilotSession["on"]>((handler: Parameters<CopilotSession["on"]>[0]) => {
      if (typeof handler === "function") sdkHandler = handler;
      return () => {};
    });
    const createSession = vi.fn<CopilotClient["createSession"]>(async () => sdkSession(on));
    const adapter = new CopilotSdkClientAdapter(testDouble<CopilotClient>({ createSession }));
    const session = await adapter.createSession({});
    const events: RuntimeSessionEvent[] = [];
    session.on((event) => events.push(event));

    sdkHandler?.(
      testDouble<SessionEvent>({
        id: "e1",
        timestamp: "2026-07-31T12:00:00.000Z",
        parentId: null,
        type: "assistant.message_delta",
        data: { messageId: "m1", deltaContent: "hello" },
      }),
    );
    sdkHandler?.(
      testDouble<SessionEvent>({
        id: "e2",
        timestamp: "2026-07-31T12:00:01.000Z",
        parentId: null,
        type: "future.event",
        data: { value: 7 },
      }),
    );

    expect(events[0]).toMatchObject({
      type: "assistant.message_delta",
      data: { deltaContent: "hello" },
    });
    expect(events[1]).toEqual({
      id: "e2",
      timestamp: "2026-07-31T12:00:01.000Z",
      parentId: null,
      type: "runtime.unknown",
      data: { runtimeType: "future.event", payload: { value: 7 } },
    });
  });

  it("reconciles late final assistant content before idle exactly once", async () => {
    const plan = {
      children: Array.from({ length: 9 }, (_, index) => ({
        taskId: `child-${index + 1}`,
        role: "worker",
        objective: `Complete child ${index + 1}`,
        dependencies: [],
        resourceId: "marshal-program",
      })),
      output: null,
    };
    const finalContent = JSON.stringify(plan);
    const partialContent = finalContent.slice(0, -1);
    expect(parseJson(partialContent)).toBeUndefined();
    const timestamp = "2026-08-20T10:00:00.000Z";
    const userMessage = testDouble<SessionEvent>({
      id: "user-event",
      timestamp,
      parentId: null,
      type: "user.message",
      data: { content: "Plan the swarm" },
    });
    const finalAssistantMessage = testDouble<SessionEvent>({
      id: "assistant-event",
      timestamp,
      parentId: "user-event",
      type: "assistant.message",
      data: { messageId: "assistant-message", content: finalContent },
    });
    const idle = testDouble<SessionEvent>({
      id: "idle-event",
      timestamp,
      parentId: "assistant-event",
      type: "session.idle",
      data: {},
    });
    let sdkHandler: ((event: SessionEvent) => void) | undefined;
    const on = vi.fn<CopilotSession["on"]>((handler: Parameters<CopilotSession["on"]>[0]) => {
      if (typeof handler === "function") sdkHandler = handler;
      return () => {};
    });
    let resolveHistory: ((events: SessionEvent[]) => void) | undefined;
    const history = new Promise<SessionEvent[]>((resolve) => {
      resolveHistory = resolve;
    });
    const getEvents = vi.fn<CopilotSession["getEvents"]>(() => history);
    const createSession = vi.fn<CopilotClient["createSession"]>(async () =>
      sdkSession(on, getEvents),
    );
    const adapter = new CopilotSdkClientAdapter(testDouble<CopilotClient>({ createSession }));
    const session = await adapter.createSession({});
    const events: RuntimeSessionEvent[] = [];
    session.on((event) => events.push(event));

    sdkHandler?.(
      testDouble<SessionEvent>({
        id: "delta-event",
        timestamp,
        parentId: "user-event",
        type: "assistant.message_delta",
        data: {
          messageId: "assistant-message",
          deltaContent: partialContent,
        },
      }),
    );
    sdkHandler?.(idle);

    expect(events.map((event) => event.type)).toEqual(["assistant.message_delta"]);
    resolveHistory?.([userMessage, finalAssistantMessage, idle]);
    await Promise.resolve();

    expect(events.map((event) => event.type)).toEqual([
      "assistant.message_delta",
      "assistant.message",
      "session.idle",
    ]);

    sdkHandler?.(finalAssistantMessage);
    const accepted = events
      .filter(
        (event): event is Extract<RuntimeSessionEvent, { type: "assistant.message" }> =>
          event.type === "assistant.message",
      )
      .map((event) => parseJson(event.data.content))
      .filter((result) => result !== undefined);
    expect(accepted).toEqual([plan]);
    expect(getEvents).toHaveBeenCalledTimes(1);
  });

  it("suppresses a reconciled turn A callback delayed until after turn B", async () => {
    const turnAPlan = {
      children: Array.from({ length: 9 }, (_, index) => ({
        taskId: `child-${index + 1}`,
        role: "worker",
        objective: `Complete child ${index + 1}`,
        dependencies: [],
        resourceId: "marshal-program",
      })),
      output: null,
    };
    const turnAContent = JSON.stringify(turnAPlan);
    const turnBContent = "Turn B complete";
    const timestamp = "2026-08-20T10:00:00.000Z";
    const turnAUser = testDouble<SessionEvent>({
      id: "turn-a-user",
      timestamp,
      parentId: null,
      type: "user.message",
      data: { content: "Plan the swarm" },
    });
    const turnAFinal = testDouble<SessionEvent>({
      id: "turn-a-assistant",
      timestamp,
      parentId: "turn-a-user",
      type: "assistant.message",
      data: { messageId: "turn-a-message", content: turnAContent },
    });
    const turnAIdle = testDouble<SessionEvent>({
      id: "turn-a-idle",
      timestamp,
      parentId: "turn-a-assistant",
      type: "session.idle",
      data: {},
    });
    const turnBFinal = testDouble<SessionEvent>({
      id: "turn-b-assistant",
      timestamp,
      parentId: "turn-b-user",
      type: "assistant.message",
      data: { messageId: "turn-b-message", content: turnBContent },
    });
    let sdkHandler: ((event: SessionEvent) => void) | undefined;
    const on = vi.fn<CopilotSession["on"]>((handler: Parameters<CopilotSession["on"]>[0]) => {
      if (typeof handler === "function") sdkHandler = handler;
      return () => {};
    });
    const getEvents = vi.fn<CopilotSession["getEvents"]>(async () => [
      turnAUser,
      turnAFinal,
      turnAIdle,
    ]);
    const createSession = vi.fn<CopilotClient["createSession"]>(async () =>
      sdkSession(on, getEvents),
    );
    const adapter = new CopilotSdkClientAdapter(testDouble<CopilotClient>({ createSession }));
    const session = await adapter.createSession({});
    const events: RuntimeSessionEvent[] = [];
    session.on((event) => events.push(event));

    sdkHandler?.(turnAIdle);
    await Promise.resolve();
    sdkHandler?.(turnBFinal);
    sdkHandler?.(turnAFinal);

    const assistantMessages = events.filter(
      (event): event is Extract<RuntimeSessionEvent, { type: "assistant.message" }> =>
        event.type === "assistant.message",
    );
    expect(assistantMessages.map((event) => event.data.content)).toEqual([
      turnAContent,
      turnBContent,
    ]);
    expect(
      assistantMessages.filter((event) => parseJson(event.data.content) !== undefined),
    ).toEqual([expect.objectContaining({ id: "turn-a-assistant" })]);

    sdkHandler?.(
      testDouble<SessionEvent>({
        ...turnBFinal,
        data: { messageId: "turn-b-message", content: "Turn B corrected" },
      }),
    );
    expect(
      events
        .filter((event) => event.type === "assistant.message")
        .map((event) => event.data.content),
    ).toEqual([turnAContent, turnBContent, "Turn B corrected"]);
  });

  function parseJson(source: string): unknown {
    try {
      return JSON.parse(source) as unknown;
    } catch {
      return undefined;
    }
  }

  it("passes runtime attachments through to the SDK session", async () => {
    const send = vi.fn<CopilotSession["send"]>(async () => "message-id");
    const createSession = vi.fn<CopilotClient["createSession"]>(async () =>
      testDouble<CopilotSession>({
        sessionId: "sdk-session",
        rpc: {},
        on: vi.fn<CopilotSession["on"]>(() => () => {}),
        send,
        sendAndWait: vi.fn<CopilotSession["sendAndWait"]>(async () => undefined),
        disconnect: vi.fn<CopilotSession["disconnect"]>(async () => undefined),
        abort: vi.fn<CopilotSession["abort"]>(async () => undefined),
        setModel: vi.fn<CopilotSession["setModel"]>(async () => undefined),
        getEvents: vi.fn<CopilotSession["getEvents"]>(async () => []),
      }),
    );
    const adapter = new CopilotSdkClientAdapter(testDouble<CopilotClient>({ createSession }));
    const session = await adapter.createSession({});
    const options = {
      prompt: "inspect",
      attachments: [
        { type: "file" as const, path: "C:\\repo\\image.png", displayName: "image.png" },
      ],
    };

    await session.send(options);

    expect(send).toHaveBeenCalledWith(options);
  });

  it("maps SDK history events through the neutral session contract", async () => {
    const getEvents = vi.fn<CopilotSession["getEvents"]>(async () => [
      testDouble<SessionEvent>({
        id: "history-1",
        timestamp: "2026-07-31T12:00:00.000Z",
        parentId: null,
        type: "assistant.message",
        data: { messageId: "m1", content: "history" },
      }),
    ]);
    const createHistorySession = vi.fn<CopilotClient["createSession"]>(async () =>
      sdkSession(undefined, getEvents),
    );
    const historyAdapter = new CopilotSdkClientAdapter(
      testDouble<CopilotClient>({ createSession: createHistorySession }),
    );
    const historySession = await historyAdapter.createSession({});

    await expect(historySession.getMessages()).resolves.toEqual([
      {
        id: "history-1",
        timestamp: "2026-07-31T12:00:00.000Z",
        parentId: null,
        type: "assistant.message",
        data: { messageId: "m1", content: "history" },
      },
    ]);
  });
});
