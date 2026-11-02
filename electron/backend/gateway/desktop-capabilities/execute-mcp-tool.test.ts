import { describe, expect, it, vi } from "vitest";

import { isDesktopCapabilityErrorThrow, type LocalToolRequest } from "../../types";
import type { McpRuntime } from "./execute-mcp-tool";
import { makeExecuteMcpToolHandler } from "./execute-mcp-tool";

const baseRequest: LocalToolRequest = {
  kind: "mcp",
  toolName: "read_file",
  serverName: "filesystem",
  toolArgs: { path: "/tmp/x" },
  sessionId: "session-1",
};

function fakeRuntime(opts: {
  callTool?: McpRuntime["callTool"];
  hasServer?: McpRuntime["hasServer"];
}): McpRuntime {
  return {
    callTool: opts.callTool ?? (async () => ({})),
    hasServer: opts.hasServer ?? (() => true),
  };
}

describe("makeExecuteMcpToolHandler", () => {
  it("returns a structured error when no MCP runtime is wired", async () => {
    const handler = makeExecuteMcpToolHandler({ mcpRuntime: null });

    const result = await handler(baseRequest);

    expect(result.success).toBe(false);
    expect(result.output).toBeNull();
    expect(result.error).toMatch(/MCP runtime/);
  });

  it("returns success: false when serverName is missing", async () => {
    const runtime = fakeRuntime({});
    const handler = makeExecuteMcpToolHandler({ mcpRuntime: runtime });

    const result = await handler({ ...baseRequest, serverName: undefined });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/serverName/);
  });

  it("throws DesktopCapabilityErrorThrow with code 'not-supported' when the runtime doesn't know the server", async () => {
    const runtime = fakeRuntime({ hasServer: () => false });
    const handler = makeExecuteMcpToolHandler({ mcpRuntime: runtime });

    let caught: unknown;
    try {
      await handler(baseRequest);
    } catch (err) {
      caught = err;
    }

    if (!isDesktopCapabilityErrorThrow(caught))
      throw new Error("expected DesktopCapabilityErrorThrow");
    expect(caught.code).toBe("not-supported");
    expect(caught.message).toMatch(/MCP server not registered/);
  });

  it("forwards serverName/toolName/args into the runtime and returns its output", async () => {
    const callTool = vi.fn<McpRuntime["callTool"]>(async () => ({ contents: "abc" }));
    const runtime = fakeRuntime({ callTool });
    const handler = makeExecuteMcpToolHandler({ mcpRuntime: runtime });

    const result = await handler(baseRequest);

    expect(result.success).toBe(true);
    expect(result.output).toEqual({ contents: "abc" });
    expect(callTool).toHaveBeenCalledWith({
      serverName: "filesystem",
      toolName: "read_file",
      args: { path: "/tmp/x" },
    });
  });

  it("passes AbortSignal through to runtimes that support abort", async () => {
    const controller = new AbortController();
    const callTool = vi.fn<McpRuntime["callTool"]>(async () => ({ contents: "abc" }));
    const runtime = fakeRuntime({ callTool });
    runtime.supportsAbortSignal = true;
    const handler = makeExecuteMcpToolHandler({ mcpRuntime: runtime });

    const result = await handler(baseRequest, controller.signal);

    expect(result.success).toBe(true);
    expect(callTool).toHaveBeenCalledWith({
      serverName: "filesystem",
      toolName: "read_file",
      args: { path: "/tmp/x" },
      signal: controller.signal,
    });
  });

  it("captures runtime errors as { success: false, error }", async () => {
    const runtime = fakeRuntime({
      callTool: async () => {
        throw new Error("transport closed");
      },
    });
    const handler = makeExecuteMcpToolHandler({ mcpRuntime: runtime });

    const result = await handler(baseRequest);

    expect(result.success).toBe(false);
    expect(result.error).toBe("transport closed");
  });
});
