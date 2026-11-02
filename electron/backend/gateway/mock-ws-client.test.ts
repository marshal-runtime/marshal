import { describe, expect, it, vi } from "vitest";

import { MockGatewayWsClient } from "./mock-ws-client";
import {
  DEFAULT_GATEWAY_TEST_CHAT_SCENARIO,
  type GatewayTestScenario,
} from "./testing/scenario-script";

describe("MockGatewayWsClient", () => {
  it("isConnected() returns false before connect() and true after", async () => {
    const client = new MockGatewayWsClient();
    expect(client.isConnected()).toBe(false);
    await client.connect();
    expect(client.isConnected()).toBe(true);
  });

  it("close() flips isConnected back to false and fires onStateChange", async () => {
    const client = new MockGatewayWsClient();
    const states: string[] = [];
    client.onStateChange((s) => states.push(s));
    await client.connect();
    client.close();
    expect(client.isConnected()).toBe(false);
    expect(states).toEqual(["connected", "disconnected"]);
  });

  it("sessions.list returns empty by default", async () => {
    const client = new MockGatewayWsClient();
    await client.connect();
    const res = await client.sessionsList();
    expect(res).toEqual({ sessions: [] });
  });

  it("chat.send returns a runId and emits scripted frames in order", async () => {
    vi.useFakeTimers();
    try {
      const client = new MockGatewayWsClient();
      await client.connect();
      const received: Array<{ name: string; payload: Record<string, unknown> }> = [];
      client.onEvent((name, payload) => received.push({ name, payload }));

      // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- request() returns unknown; chat.send always returns { runId: string } in this mock
      const sendResult = (await client.request("chat.send", {
        sessionKey: "k1",
        prompt: "hi",
      })) as {
        runId: string;
      };
      expect(typeof sendResult.runId).toBe("string");
      expect(sendResult.runId.length).toBeGreaterThan(0);

      expect(DEFAULT_GATEWAY_TEST_CHAT_SCENARIO.chatFrames?.map((frame) => frame.delay)).toEqual([
        80, 120, 100,
      ]);
      await vi.advanceTimersByTimeAsync(79);
      expect(received).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(received).toEqual([
        {
          name: "chat",
          payload: {
            runId: sendResult.runId,
            state: "delta",
            message: { content: [{ type: "text", text: "Hi! " }] },
          },
        },
      ]);

      await vi.advanceTimersByTimeAsync(119);
      expect(received).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(received).toEqual([
        {
          name: "chat",
          payload: {
            runId: sendResult.runId,
            state: "delta",
            message: { content: [{ type: "text", text: "Hi! " }] },
          },
        },
        {
          name: "chat",
          payload: {
            runId: sendResult.runId,
            state: "delta",
            message: {
              content: [{ type: "text", text: "Hi! This is the mock gateway." }],
            },
          },
        },
      ]);

      await vi.advanceTimersByTimeAsync(99);
      expect(received).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(1);
      expect(received).toEqual([
        {
          name: "chat",
          payload: {
            runId: sendResult.runId,
            state: "delta",
            message: { content: [{ type: "text", text: "Hi! " }] },
          },
        },
        {
          name: "chat",
          payload: {
            runId: sendResult.runId,
            state: "delta",
            message: {
              content: [{ type: "text", text: "Hi! This is the mock gateway." }],
            },
          },
        },
        {
          name: "chat",
          payload: {
            runId: sendResult.runId,
            state: "final",
            done: true,
            message: {
              content: [{ type: "text", text: "Hi! This is the mock gateway." }],
            },
          },
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("scenario rpc override wins over the default", async () => {
    const scenario: GatewayTestScenario = {
      rpcs: {
        "sessions.list": async () => ({ sessions: [{ sessionId: "preseeded" }] }),
      },
    };
    const client = new MockGatewayWsClient(scenario);
    await client.connect();
    const res = await client.sessionsList();
    expect(res.sessions).toHaveLength(1);
    expect(res.sessions[0]).toEqual({ sessionId: "preseeded" });
  });

  it("unknown RPC methods reject with not-supported", async () => {
    const client = new MockGatewayWsClient();
    await client.connect();
    await expect(client.request("totally.unknown", {})).rejects.toThrow(/not-supported/);
  });

  it("registerInboundHandler stores handler and returns unsubscribe", async () => {
    const client = new MockGatewayWsClient();
    await client.connect();
    const handler = vi.fn<(params: Record<string, unknown>) => Promise<{ ok: true }>>(async () => ({
      ok: true,
    }));
    const unreg = client.registerInboundHandler("desktop.foo", handler);
    expect(typeof unreg).toBe("function");
    unreg();
    client.registerInboundHandler("desktop.foo", handler);
  });

  it("registerInboundHandler throws when the same method is registered twice", async () => {
    const client = new MockGatewayWsClient();
    const handler = vi.fn<(params: Record<string, unknown>) => Promise<{ ok: true }>>(async () => ({
      ok: true,
    }));
    client.registerInboundHandler("desktop.bar", handler);
    expect(() => client.registerInboundHandler("desktop.bar", handler)).toThrow(
      /already registered/,
    );
  });
});
