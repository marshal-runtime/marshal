import { describe, it, expect, vi, beforeEach } from "vitest";

import type { CustomMcpServer } from "../../../common/marshal-ipc-contract";

const mockConnect = vi.fn<(transport: unknown) => Promise<void>>();
const mockCallTool = vi.fn<(args: unknown) => Promise<unknown>>();
const mockClose = vi.fn<() => Promise<void>>();
const mockListTools = vi.fn<() => Promise<{ tools: Array<Record<string, unknown>> }>>();
const stdioCtorCalls: Array<{ command: string; args: string[] }> = [];
const httpCtorCalls: Array<{ url: string; headers?: Record<string, string> }> = [];
const sseCtorCalls: Array<{ url: string; headers?: Record<string, string> }> = [];

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    constructor(public readonly info: { name: string; version: string }) {}
    connect = (transport: unknown): Promise<void> => mockConnect(transport);
    callTool = (params: unknown): Promise<unknown> => mockCallTool(params);
    close = (): Promise<void> => mockClose();
    listTools = (): Promise<{ tools: Array<Record<string, unknown>> }> => mockListTools();
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  getDefaultEnvironment: () => ({ PATH: "mock-path" }),
  // oxlint-disable-next-line @typescript-eslint/no-extraneous-class -- mock constructor capturing call args
  StdioClientTransport: class MockStdio {
    constructor(opts: { command: string; args?: string[] }) {
      stdioCtorCalls.push({ command: opts.command, args: opts.args ?? [] });
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  // oxlint-disable-next-line @typescript-eslint/no-extraneous-class -- mock constructor capturing call args
  StreamableHTTPClientTransport: class MockHttp {
    constructor(url: URL, opts?: { requestInit?: { headers?: Record<string, string> } }) {
      httpCtorCalls.push({ url: url.toString(), headers: opts?.requestInit?.headers });
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  // oxlint-disable-next-line @typescript-eslint/no-extraneous-class -- mock constructor capturing call args
  SSEClientTransport: class MockSse {
    constructor(url: URL, opts?: { requestInit?: { headers?: Record<string, string> } }) {
      sseCtorCalls.push({ url: url.toString(), headers: opts?.requestInit?.headers });
    }
  },
}));

beforeEach(() => {
  mockConnect.mockReset().mockResolvedValue(undefined);
  mockCallTool.mockReset().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
  mockClose.mockReset().mockResolvedValue(undefined);
  mockListTools.mockReset().mockResolvedValue({ tools: [] });
  stdioCtorCalls.length = 0;
  httpCtorCalls.length = 0;
  sseCtorCalls.length = 0;
});

const stdioServer: CustomMcpServer = {
  name: "AutoDev",
  type: "command",
  command: "node",
  args: ["server.js"],
  exposeAsGatewayNodeCommand: true,
};
const httpServer: CustomMcpServer = {
  name: "RemoteHttp",
  url: "http://localhost:3000/mcp",
  type: "http",
  accessToken: "abc",
  exposeAsGatewayNodeCommand: true,
};
const sseServer: CustomMcpServer = {
  name: "RemoteSse",
  url: "http://localhost:3001/sse",
  type: "sse",
  exposeAsGatewayNodeCommand: true,
};
const retargetedServer: CustomMcpServer = {
  name: "Retargeted",
  url: "https://attacker.example.com/mcp",
  type: "http",
  accessToken: "legit-token",
  accessTokenOrigin: "https://legitimate.example.com",
  exposeAsGatewayNodeCommand: true,
};
const matchingOriginServer: CustomMcpServer = {
  name: "SafeServer",
  url: "https://safe.example.com/mcp",
  type: "http",
  accessToken: "legit-token",
  accessTokenOrigin: "https://safe.example.com",
  exposeAsGatewayNodeCommand: true,
};

describe("GatewayNodeMcpRuntime.hasServer", () => {
  it("returns true for opted-in servers and false otherwise", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => [stdioServer] });
    expect(runtime.hasServer("AutoDev")).toBe(true);
    expect(runtime.hasServer("Other")).toBe(false);
  });

  it("re-reads getServers on every call so a Settings flip takes effect immediately", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    const servers: CustomMcpServer[] = [stdioServer];
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => servers });
    expect(runtime.hasServer("AutoDev")).toBe(true);
    servers.length = 0;
    expect(runtime.hasServer("AutoDev")).toBe(false);
  });
});

describe("GatewayNodeMcpRuntime.callTool — transport selection", () => {
  it("opens a stdio transport for command-type servers and forwards the tool call", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => [stdioServer] });
    const result = await runtime.callTool({
      serverName: "AutoDev",
      toolName: "ping",
      args: { x: 1 },
    });
    expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(stdioCtorCalls).toEqual([{ command: "node", args: ["server.js"] }]);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    // Transport is forwarded: the transport passed to connect() must be a
    // stdio instance (constructor recorded one call) not null.
    expect(mockConnect.mock.calls[0][0]).not.toBeNull();
    expect(httpCtorCalls).toHaveLength(0);
    expect(mockCallTool).toHaveBeenCalledWith({ name: "ping", arguments: { x: 1 } });
  });

  it("opens a streamable-HTTP transport for url-type servers and includes the bearer header", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => [httpServer] });
    await runtime.callTool({ serverName: "RemoteHttp", toolName: "get", args: {} });
    expect(httpCtorCalls).toEqual([
      { url: "http://localhost:3000/mcp", headers: { Authorization: "Bearer abc" } },
    ]);
    expect(sseCtorCalls).toHaveLength(0);
    expect(stdioCtorCalls).toHaveLength(0);
    expect(mockConnect.mock.calls[0][0]).not.toBeNull();
  });

  it("opens an SSE transport when type=sse", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => [sseServer] });
    await runtime.callTool({ serverName: "RemoteSse", toolName: "stream", args: {} });
    expect(sseCtorCalls).toEqual([{ url: "http://localhost:3001/sse", headers: {} }]);
    expect(httpCtorCalls).toHaveLength(0);
    expect(mockConnect.mock.calls[0][0]).not.toBeNull();
  });

  it("normalizes non-object args to {} so the MCP server doesn't see undefined", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => [stdioServer] });
    await runtime.callTool({ serverName: "AutoDev", toolName: "noop", args: undefined });
    expect(mockCallTool).toHaveBeenCalledWith({ name: "noop", arguments: {} });
  });

  it("drops the bearer token when accessTokenOrigin does not match URL origin", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => [retargetedServer] });
    await runtime.callTool({ serverName: "Retargeted", toolName: "get", args: {} });
    expect(httpCtorCalls).toHaveLength(1);
    // Headers must be empty — token must not be forwarded to the attacker endpoint
    expect(httpCtorCalls[0].headers).toEqual({});
  });

  it("includes the bearer token when accessTokenOrigin matches URL origin", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => [matchingOriginServer] });
    await runtime.callTool({ serverName: "SafeServer", toolName: "get", args: {} });
    expect(httpCtorCalls).toHaveLength(1);
    expect(httpCtorCalls[0].headers).toEqual({ Authorization: "Bearer legit-token" });
  });
});

describe("GatewayNodeMcpRuntime.callTool — caching and lifecycle", () => {
  it("reuses the cached client across consecutive calls to the same server", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => [stdioServer] });
    await runtime.callTool({ serverName: "AutoDev", toolName: "a", args: {} });
    await runtime.callTool({ serverName: "AutoDev", toolName: "b", args: {} });
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(stdioCtorCalls).toHaveLength(1);
    expect(mockCallTool).toHaveBeenCalledTimes(2);
  });

  it("reconnects when a same-name server URL or token changes", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    const servers: CustomMcpServer[] = [{ ...httpServer }];
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => servers });
    await runtime.callTool({ serverName: "RemoteHttp", toolName: "a", args: {} });
    servers[0] = {
      ...httpServer,
      url: "https://changed.example/mcp",
      accessToken: "replacement-token",
    };

    await runtime.callTool({ serverName: "RemoteHttp", toolName: "b", args: {} });

    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(httpCtorCalls).toEqual([
      { url: "http://localhost:3000/mcp", headers: { Authorization: "Bearer abc" } },
      {
        url: "https://changed.example/mcp",
        headers: { Authorization: "Bearer replacement-token" },
      },
    ]);
  });

  it("dedupes concurrent first-call invocations against the same server", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    let resolveConnect: () => void = () => undefined;
    mockConnect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        }),
    );
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => [stdioServer] });
    const a = runtime.callTool({ serverName: "AutoDev", toolName: "a", args: {} });
    const b = runtime.callTool({ serverName: "AutoDev", toolName: "b", args: {} });
    resolveConnect();
    await Promise.all([a, b]);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(stdioCtorCalls).toHaveLength(1);
  });

  it("does not cache an old connection that resolves after the server config changes", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    let resolveOldConnect: () => void = () => undefined;
    mockConnect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveOldConnect = resolve;
        }),
    );
    const servers: CustomMcpServer[] = [{ ...httpServer }];
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => servers });
    const oldCall = runtime.callTool({ serverName: "RemoteHttp", toolName: "old", args: {} });
    servers[0] = { ...httpServer, url: "https://changed.example/mcp" };
    const newCall = runtime.callTool({ serverName: "RemoteHttp", toolName: "new", args: {} });

    await expect(newCall).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
    resolveOldConnect();
    await expect(oldCall).rejects.toThrow(/configuration changed during connect/i);
    expect(mockClose).toHaveBeenCalledTimes(1);
    await runtime.callTool({ serverName: "RemoteHttp", toolName: "again", args: {} });
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  it("drops the cached client and reconnects on the next call when callTool throws", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    mockCallTool.mockRejectedValueOnce(new Error("server crashed"));
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => [stdioServer] });
    await expect(
      runtime.callTool({ serverName: "AutoDev", toolName: "a", args: {} }),
    ).rejects.toThrow("server crashed");
    expect(mockClose).toHaveBeenCalledTimes(1);
    await runtime.callTool({ serverName: "AutoDev", toolName: "b", args: {} });
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  it("rejects callTool for a server not in the opted-in list", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => [] });
    await expect(
      runtime.callTool({ serverName: "Missing", toolName: "x", args: {} }),
    ).rejects.toThrow(/not opted into gateway-node exposure/);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("dispose closes every cached client and clears the cache", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    const runtime = new GatewayNodeMcpRuntime({
      getServers: () => [stdioServer, httpServer],
    });
    await runtime.callTool({ serverName: "AutoDev", toolName: "a", args: {} });
    await runtime.callTool({ serverName: "RemoteHttp", toolName: "b", args: {} });
    await runtime.dispose();
    expect(mockClose).toHaveBeenCalledTimes(2);
  });

  it("calls after dispose throw rather than re-connecting", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => [stdioServer] });
    await runtime.callTool({ serverName: "AutoDev", toolName: "a", args: {} });
    await runtime.dispose();
    await expect(
      runtime.callTool({ serverName: "AutoDev", toolName: "b", args: {} }),
    ).rejects.toThrow(/disposed/i);
  });

  it("a getOrConnect in flight when dispose runs closes the freshly-connected client", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    const gate: { resolve: () => void } = { resolve: () => undefined };
    mockConnect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          gate.resolve = resolve;
        }),
    );
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => [stdioServer] });
    const inFlight = runtime.callTool({ serverName: "AutoDev", toolName: "a", args: {} });
    await runtime.dispose();
    gate.resolve();
    await expect(inFlight).rejects.toThrow(/disposed/i);
    expect(mockClose).toHaveBeenCalled();
  });

  it("a getOrConnect in flight when reset runs closes the stale client", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    const gate: { resolve: () => void } = { resolve: () => undefined };
    mockConnect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          gate.resolve = resolve;
        }),
    );
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => [stdioServer] });
    const inFlight = runtime.callTool({ serverName: "AutoDev", toolName: "a", args: {} });
    await runtime.reset();
    gate.resolve();

    await expect(inFlight).rejects.toThrow(/reset during connect/i);
    expect(mockClose).toHaveBeenCalledTimes(1);
    await runtime.callTool({ serverName: "AutoDev", toolName: "b", args: {} });
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });
});

describe("GatewayNodeMcpRuntime.preconnectAll — eager connect + listTools", () => {
  it("connects every opted-in server and feeds discovered tools into onToolsDiscovered", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    mockListTools
      .mockResolvedValueOnce({
        tools: [
          { name: "ping", description: "pings", inputSchema: { type: "object" } },
          { name: "echo", description: "" },
        ],
      })
      .mockResolvedValueOnce({ tools: [{ name: "fetch", description: "" }] });
    const onToolsDiscovered = vi.fn<(name: string, tools: unknown[]) => void>();
    const runtime = new GatewayNodeMcpRuntime({
      getServers: () => [stdioServer, httpServer],
      onToolsDiscovered,
    });
    await runtime.preconnectAll();
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(mockListTools).toHaveBeenCalledTimes(2);
    expect(onToolsDiscovered).toHaveBeenCalledTimes(2);
    // Tools land with a normalized shape: name + description + optional inputSchema.
    expect(onToolsDiscovered).toHaveBeenCalledWith("AutoDev", [
      { name: "ping", description: "pings", inputSchema: { type: "object" } },
      { name: "echo", description: "" },
    ]);
    expect(onToolsDiscovered).toHaveBeenCalledWith("RemoteHttp", [
      { name: "fetch", description: "" },
    ]);
  });

  it("transitions status pending → connected on success and exposes it via getStatuses", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => [stdioServer] });
    await runtime.preconnectAll();
    const statuses = runtime.getStatuses();
    expect(statuses.get("AutoDev")).toEqual({ status: "connected" });
  });

  it("records status: failed when connect itself rejects (no listTools attempted)", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    mockConnect.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => [httpServer] });
    await runtime.preconnectAll();
    const statuses = runtime.getStatuses();
    expect(statuses.get("RemoteHttp")).toEqual({
      status: "failed",
      error: "ECONNREFUSED",
    });
    expect(mockListTools).not.toHaveBeenCalled();
  });

  it("records status: failed when listTools rejects (connection succeeded)", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    mockListTools.mockRejectedValueOnce(new Error("server not initialized"));
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => [stdioServer] });
    await runtime.preconnectAll();
    const statuses = runtime.getStatuses();
    expect(statuses.get("AutoDev")?.status).toBe("failed");
    expect(statuses.get("AutoDev")?.error).toMatch(/Tool discovery failed/);
  });

  it("isolates per-server failures — one failure doesn't block other servers", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    mockConnect
      .mockRejectedValueOnce(new Error("first server down"))
      .mockResolvedValueOnce(undefined);
    mockListTools.mockResolvedValueOnce({ tools: [{ name: "ok-tool", description: "" }] });
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => [stdioServer, httpServer] });
    await runtime.preconnectAll();
    const statuses = runtime.getStatuses();
    expect(statuses.get("AutoDev")?.status).toBe("failed");
    expect(statuses.get("RemoteHttp")).toEqual({ status: "connected" });
  });

  it("fires onStatusChange listeners on every status transition", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => [stdioServer] });
    const listener = vi.fn<() => void>();
    runtime.onStatusChange(listener);
    await runtime.preconnectAll();
    // Two transitions per server: pending → connected.
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("noop when no opted-in servers are present", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => [] });
    await runtime.preconnectAll();
    expect(mockConnect).not.toHaveBeenCalled();
    expect(runtime.getStatuses().size).toBe(0);
  });
});

describe("GatewayNodeMcpRuntime — lazy connect status + reset", () => {
  it("flips status to connected on the lazy callTool path so servers added after sign-in still update the UI", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => [stdioServer] });
    expect(runtime.getStatuses().has("AutoDev")).toBe(false);
    await runtime.callTool({ serverName: "AutoDev", toolName: "a", args: {} });
    expect(runtime.getStatuses().get("AutoDev")).toEqual({ status: "connected" });
  });

  it("reset closes all clients and clears the status map but leaves the runtime usable", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => [stdioServer] });
    await runtime.callTool({ serverName: "AutoDev", toolName: "a", args: {} });
    expect(runtime.getStatuses().size).toBe(1);
    await runtime.reset();
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(runtime.getStatuses().size).toBe(0);
    // Subsequent callTool reconnects from scratch.
    await runtime.callTool({ serverName: "AutoDev", toolName: "b", args: {} });
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(runtime.getStatuses().get("AutoDev")).toEqual({ status: "connected" });
  });

  it("reset fires onStatusChange so the renderer can refresh its mcps:list view", async () => {
    const { GatewayNodeMcpRuntime } = await import("./node-mcp-runtime");
    const runtime = new GatewayNodeMcpRuntime({ getServers: () => [stdioServer] });
    await runtime.callTool({ serverName: "AutoDev", toolName: "a", args: {} });
    const listener = vi.fn<() => void>();
    runtime.onStatusChange(listener);
    await runtime.reset();
    expect(listener).toHaveBeenCalled();
  });
});
