import { describe, expect, it, vi } from "vitest";

import {
  McpBrokerCore,
  type McpBrokerUpstream,
  type McpBrokerUpstreamConfig,
  type McpBrokerUpstreamFactory,
} from "./mcp-broker-core";

const stdioConfig: McpBrokerUpstreamConfig = {
  command: "uvx",
  args: ["example-mcp"],
  env: { CLUSTER: "one" },
  workingDirectory: "C:/workspace",
  workspaceDir: "C:/workspace",
  identityKey: "tenant:user",
  configGeneration: 1,
};

function createFakeFactory() {
  const upstreams: McpBrokerUpstream[] = [];
  const factory = vi.fn<McpBrokerUpstreamFactory>(async (): Promise<McpBrokerUpstream> => {
    const upstream: McpBrokerUpstream = {
      listTools: vi.fn<McpBrokerUpstream["listTools"]>(async () => ({
        tools: [{ name: "query" }],
      })),
      callTool: vi.fn<McpBrokerUpstream["callTool"]>(async (name) => ({
        content: [{ type: "text", text: name }],
      })),
      close: vi.fn<McpBrokerUpstream["close"]>(async () => undefined),
    };
    upstreams.push(upstream);
    return upstream;
  });
  return { factory, upstreams };
}

describe("McpBrokerCore", () => {
  it("lazily starts one isolated upstream per session capability", async () => {
    const { factory } = createFakeFactory();
    const broker = new McpBrokerCore({ createUpstream: factory });
    const capabilities = Array.from({ length: 3 }, (_, index) =>
      broker.createCapability({
        sessionId: `session-${index}`,
        serverKey: "example",
        config: stdioConfig,
        isEnabled: () => true,
      }),
    );

    expect(factory).not.toHaveBeenCalled();
    await Promise.all(capabilities.map((capability) => capability.listTools()));
    expect(factory).toHaveBeenCalledTimes(3);
    expect(broker.upstreamCount).toBe(3);
    await broker.dispose();
  });

  it("keeps unknown stdio and Playwright capabilities isolated", async () => {
    const { factory } = createFakeFactory();
    const broker = new McpBrokerCore({ createUpstream: factory });
    const unknown = ["one", "two"].map((sessionId) =>
      broker.createCapability({
        sessionId,
        serverKey: "custom",
        config: { ...stdioConfig, args: ["custom.js"] },
        isEnabled: () => true,
      }),
    );
    const playwright = ["one", "two"].map((sessionId) =>
      broker.createCapability({
        sessionId,
        serverKey: "playwright",
        config: { ...stdioConfig, args: ["playwright.js"] },
        isEnabled: () => true,
      }),
    );

    await Promise.all([...unknown, ...playwright].map((capability) => capability.listTools()));
    expect(factory).toHaveBeenCalledTimes(4);
    await broker.dispose();
  });

  it("retries a transient upstream connection failure", async () => {
    const { factory, upstreams } = createFakeFactory();
    factory.mockRejectedValueOnce(new Error("transient connect failure"));
    const broker = new McpBrokerCore({ createUpstream: factory });
    const capability = broker.createCapability({
      sessionId: "one",
      serverKey: "example",
      config: stdioConfig,
      isEnabled: () => true,
    });

    await expect(capability.listTools()).rejects.toThrow("transient connect failure");
    await expect(capability.listTools()).resolves.toEqual({ tools: [{ name: "query" }] });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(upstreams).toHaveLength(1);
    await broker.dispose();
  });

  it("denies a revoked or dynamically disabled capability before starting upstream", async () => {
    const { factory } = createFakeFactory();
    let enabled = true;
    const broker = new McpBrokerCore({ createUpstream: factory });
    const capability = broker.createCapability({
      sessionId: "one",
      serverKey: "example",
      config: stdioConfig,
      isEnabled: () => enabled,
    });

    enabled = false;
    await expect(capability.listTools()).rejects.toThrow(/revoked/);
    expect(factory).not.toHaveBeenCalled();
    await capability.revoke();
    await expect(capability.listTools()).rejects.toThrow(/revoked/);
    await broker.dispose();
  });

  it("rejects upstream results that exceed the configured output cap", async () => {
    const factory = vi.fn<McpBrokerUpstreamFactory>(async () => ({
      listTools: vi.fn<McpBrokerUpstream["listTools"]>(async () => ({
        value: "x".repeat(128),
      })),
      callTool: vi.fn<McpBrokerUpstream["callTool"]>(async () => ({})),
      close: vi.fn<McpBrokerUpstream["close"]>(async () => undefined),
    }));
    const broker = new McpBrokerCore({ createUpstream: factory, maxOutputBytes: 32 });
    const capability = broker.createCapability({
      sessionId: "one",
      serverKey: "example",
      config: stdioConfig,
      isEnabled: () => true,
    });
    await expect(capability.listTools()).rejects.toThrow(/exceeded 32 bytes/);
    await broker.dispose();
  });

  it("isolates cancellation to one call and releases upstream concurrency", async () => {
    let first = true;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const close = vi.fn<McpBrokerUpstream["close"]>(async () => undefined);
    const factory = vi.fn<McpBrokerUpstreamFactory>(
      async (): Promise<McpBrokerUpstream> => ({
        listTools: vi.fn<McpBrokerUpstream["listTools"]>(async () => ({ tools: [] })),
        callTool: vi.fn<McpBrokerUpstream["callTool"]>(async (_name, _args, signal) => {
          if (!first) return { content: [{ type: "text", text: "second" }] };
          first = false;
          markStarted();
          return new Promise((_, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
        }),
        close,
      }),
    );
    const broker = new McpBrokerCore({
      createUpstream: factory,
      maxConcurrencyPerUpstream: 1,
    });
    const capability = broker.createCapability({
      sessionId: "one",
      serverKey: "example",
      config: stdioConfig,
      isEnabled: () => true,
    });
    const controller = new AbortController();
    const cancelled = capability.callTool("query", {}, controller.signal);
    const succeeding = capability.callTool("query", {});
    await started;
    controller.abort();

    await expect(cancelled).rejects.toThrow(/abort/i);
    await expect(succeeding).resolves.toEqual({
      content: [{ type: "text", text: "second" }],
    });
    expect(close).not.toHaveBeenCalled();
    await broker.dispose();
  });

  it("does not create an upstream when no capabilities are registered", async () => {
    const { factory } = createFakeFactory();
    const broker = new McpBrokerCore({ createUpstream: factory });
    expect(broker.upstreamCount).toBe(0);
    expect(factory).not.toHaveBeenCalled();
    await broker.dispose();
  });

  it("aborts an in-flight upstream connection during broker disposal", async () => {
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const factory = vi.fn<McpBrokerUpstreamFactory>(
      async (_config, signal): Promise<McpBrokerUpstream> => {
        markStarted();
        return await new Promise<McpBrokerUpstream>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    );
    const broker = new McpBrokerCore({ createUpstream: factory });
    const capability = broker.createCapability({
      sessionId: "one",
      serverKey: "example",
      config: stdioConfig,
      isEnabled: () => true,
    });
    const invocation = capability.listTools();
    await started;

    await broker.dispose();
    await expect(invocation).rejects.toThrow(/abort/i);
  });

  it("revokes promptly while an upstream connection is still pending", async () => {
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let resolveUpstream: (upstream: McpBrokerUpstream) => void = () => undefined;
    const close = vi.fn<McpBrokerUpstream["close"]>(async () => undefined);
    const factory = vi.fn<McpBrokerUpstreamFactory>(async () => {
      markStarted();
      return await new Promise<McpBrokerUpstream>((resolve) => {
        resolveUpstream = resolve;
      });
    });
    const broker = new McpBrokerCore({ createUpstream: factory });
    const capability = broker.createCapability({
      sessionId: "one",
      serverKey: "example",
      config: stdioConfig,
      isEnabled: () => true,
    });
    const invocation = capability.listTools();
    await started;

    await expect(capability.revoke()).resolves.toBeUndefined();
    resolveUpstream({
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({}),
      close,
    });

    await expect(invocation).rejects.toThrow(/abort/i);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    await broker.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
