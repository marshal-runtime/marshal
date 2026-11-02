import { describe, expect, it, vi } from "vitest";

import { testDouble } from "../../testing/harness";
import { GatewaySessionBackend } from "./session";
import type { IGatewayWsClient } from "./ws-client";

describe("GatewaySessionBackend lifecycle", () => {
  it("disconnects local routing without deleting the durable cloud session", async () => {
    const sessionsDelete = vi
      .fn<IGatewayWsClient["sessionsDelete"]>()
      .mockResolvedValue({ ok: true, key: "agent:main:key-1", deleted: true });
    const chatHistory = vi
      .fn<IGatewayWsClient["chatHistory"]>()
      .mockResolvedValue({ messages: [] });
    const client = testDouble<IGatewayWsClient>({
      onEvent: vi.fn<IGatewayWsClient["onEvent"]>(() => () => {}),
      sessionsCreate: vi
        .fn<IGatewayWsClient["sessionsCreate"]>()
        .mockResolvedValue({ key: "agent:main:key-1", sessionId: "cloud-1" }),
      sessionsList: vi.fn<IGatewayWsClient["sessionsList"]>().mockResolvedValue({
        sessions: [
          {
            key: "agent:main:key-1",
            sessionId: "cloud-1",
            label: "local-1",
          },
        ],
      }),
      sessionsDelete,
      chatHistory,
    });
    const backend = new GatewaySessionBackend();
    backend.attachClient(client);

    await backend.create({ sessionId: "local-1" });
    await backend.disconnect("local-1");

    await expect(backend.getHistory("local-1")).rejects.toThrow("no sessionKey");
    expect(sessionsDelete).not.toHaveBeenCalled();

    await expect(
      backend.resume("local-1", { sessionId: "local-1", backendId: "cloud-1" }),
    ).resolves.toEqual({ sessionId: "local-1", backendId: "cloud-1" });
    await backend.getHistory("local-1");
    expect(chatHistory).toHaveBeenCalledWith({
      sessionKey: "agent:main:key-1",
      limit: 200,
    });
  });

  it("refuses a host tool allowlist it cannot enforce", async () => {
    const sessionsCreate = vi.fn<IGatewayWsClient["sessionsCreate"]>();
    const backend = new GatewaySessionBackend();
    backend.attachClient(
      testDouble<IGatewayWsClient>({
        onEvent: vi.fn<IGatewayWsClient["onEvent"]>(() => () => {}),
        sessionsCreate,
      }),
    );

    await expect(
      backend.create({ sessionId: "local-1", allowedTools: ["runtimeInvoke"] }),
    ).rejects.toThrow("cannot enforce a host tool allowlist");
    await expect(
      backend.resume("local-1", { sessionId: "local-1", allowedTools: [] }),
    ).rejects.toThrow("cannot enforce a host tool allowlist");
    expect(sessionsCreate).not.toHaveBeenCalled();
  });
});
