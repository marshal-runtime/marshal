// Marshal-owned test
import { describe, expect, it, vi } from "vitest";

import type { BackendEvent } from "./backend/types";
import type { CustomMcpServer } from "./ipc/types";
import { McpStatusManager } from "./mcp-status-manager";

/**
 * Minimal deps wiring — McpStatusManager calls these on internal state
 * mutations, but `connectPipeline` itself does not touch them. The stubs
 * are here so the constructor doesn't crash if a future refactor reaches
 * into deps from the setter paths.
 */
function makeDeps() {
  return {
    applyCustomServersToBackend: vi.fn<(servers: CustomMcpServer[]) => void>(),
    refreshActiveSessionForCustomServersChange: vi.fn<() => void>(),
    resolveOAuthExecutor: vi.fn<() => Promise<string>>().mockResolvedValue("test-executor"),
    callBackendInitiateOAuth: vi
      .fn<() => Promise<{ authorizationUrl?: string }>>()
      .mockResolvedValue({}),
    getMcpStore: vi.fn<() => undefined>().mockReturnValue(undefined),
  };
}

describe("McpStatusManager.connectPipeline", () => {
  it("installs both the disabled-MCP provider and the status callback in one call", () => {
    const mgr = new McpStatusManager(makeDeps());
    const disabledProvider = vi
      .fn<(sessionId: string) => Set<string>>()
      .mockReturnValue(new Set(["ExampleMcp"]));
    const statusCallback = vi.fn<(event: BackendEvent) => void>();

    mgr.connectPipeline({ disabledProvider, statusCallback });

    // Disabled provider wired: getDisabledMcps now consults it.
    expect(mgr.getDisabledMcps("any-session")).toEqual(new Set(["ExampleMcp"]));
    expect(disabledProvider).toHaveBeenCalledWith("any-session");

    // Status callback wired: an MCP backend event routes through it.
    const event: BackendEvent = {
      type: "mcp-server-status",
      serverName: "powerbi",
      status: "connected",
    };
    mgr.handleBackendEvent(event, {
      sessionId: "sess-1",
      log: { info: () => {}, warn: () => {} },
    });
    expect(statusCallback).toHaveBeenCalledWith(event);
  });

  it("overwrites prior pipeline wiring on a second call (last-write-wins)", () => {
    const mgr = new McpStatusManager(makeDeps());
    const firstProvider = vi
      .fn<(sessionId: string) => Set<string>>()
      .mockReturnValue(new Set(["ExampleMcp"]));
    const firstCallback = vi.fn<(event: BackendEvent) => void>();
    const secondProvider = vi
      .fn<(sessionId: string) => Set<string>>()
      .mockReturnValue(new Set(["Browser Control and Web Browsing"]));
    const secondCallback = vi.fn<(event: BackendEvent) => void>();

    mgr.connectPipeline({ disabledProvider: firstProvider, statusCallback: firstCallback });
    mgr.connectPipeline({ disabledProvider: secondProvider, statusCallback: secondCallback });

    // Second wiring wins on both sides — guards against an accidental
    // additive setter implementation (e.g. `statusListeners.add(callback)`)
    // that would let stale callbacks linger after a reconnect.
    expect(mgr.getDisabledMcps("sess-x")).toEqual(new Set(["Browser Control and Web Browsing"]));
    expect(firstProvider).not.toHaveBeenCalled();

    const event: BackendEvent = {
      type: "mcp-server-status",
      serverName: "powerbi",
      status: "failed",
    };
    mgr.handleBackendEvent(event, {
      sessionId: "sess-1",
      log: { info: () => {}, warn: () => {} },
    });
    expect(secondCallback).toHaveBeenCalledWith(event);
    expect(firstCallback).not.toHaveBeenCalled();
  });

  it("routes mcp-oauth-required through the wired statusCallback and stamps ctx.sessionId on the forwarded event", () => {
    // Regression-protection for the OAuth branch of the pipeline AND the
    // `sessionId` stamping in `handleBackendEvent`. The composition root
    // (main.ts) forks the callback on `event.type` to fire
    // `mcp:oauth-required` / `mcp:oauth-completed` IPC events at the
    // renderer; the OAuth-required IPC handler then uses that stamped
    // `sessionId` to pick the same session as the OAuth executor.
    // Without the stamping, the login RPC may land on a different session
    // whose `mcpServers` config does not contain `serverName`, and the SDK
    // rejects with "MCP server not found". This test pins both halves:
    // (a) the OAuth event-type branch is forwarded at all, and (b) the
    // forwarded event carries the ctx-supplied `sessionId`.
    const mgr = new McpStatusManager(makeDeps());
    const statusCallback = vi.fn<(event: BackendEvent) => void>();
    const logInfo = vi.fn<(msg: string) => void>();
    mgr.connectPipeline({
      disabledProvider: vi.fn<() => Set<string>>().mockReturnValue(new Set()),
      statusCallback,
    });

    // Build the event WITHOUT `sessionId` — the SDK payload doesn't carry
    // it; the per-session subscription closure is supposed to stamp it in.
    // If a future regression removes the stamping but keeps forwarding,
    // the assertion below catches it.
    const oauthRequired: BackendEvent = {
      type: "mcp-oauth-required",
      requestId: "req-1",
      serverName: "powerbi",
      serverUrl: "https://mcp.example.com/v1/mcp/powerbi",
    };
    mgr.handleBackendEvent(oauthRequired, {
      sessionId: "sess-1",
      log: { info: logInfo, warn: () => {} },
    });
    expect(statusCallback).toHaveBeenCalledWith({
      ...oauthRequired,
      sessionId: "sess-1",
    });
    // Sanity-check that we also log the "CLI will open browser" line —
    // useful for users diagnosing OAuth issues in the log file.
    expect(logInfo).toHaveBeenCalled();

    // And the matching completion event also routes — pinning both halves
    // of the OAuth flow so a partial regression (e.g. forwarding `required`
    // but dropping `completed`) shows up here.
    statusCallback.mockClear();
    const oauthCompleted: BackendEvent = {
      type: "mcp-oauth-completed",
      requestId: "req-1",
    };
    mgr.handleBackendEvent(oauthCompleted, {
      sessionId: "sess-1",
      log: { info: () => {}, warn: () => {} },
    });
    expect(statusCallback).toHaveBeenCalledWith(oauthCompleted);
  });
});
