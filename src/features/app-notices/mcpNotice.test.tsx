import type { McpServerInfo, McpsAPI } from "@common/marshal-ipc-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mcpOAuthStore } from "@/hooks/mcp-oauth-store";
import { installMockAPIs, renderHook, waitFor } from "@/test-utils";

import { useMcpNotices } from "./mcpNotice";

function setServers(servers: McpServerInfo[]) {
  window.mcpsAPI.list = vi.fn<McpsAPI["list"]>().mockResolvedValue({ success: true, servers });
}

describe("useMcpNotices", () => {
  beforeEach(() => {
    installMockAPIs();
    mcpOAuthStore.resetForTests();
  });

  it("maps each actionable MCP server to an app-status notice", async () => {
    setServers([
      {
        key: "power_bi",
        name: "Power BI",
        builtin: false,
        status: "needs-auth",
        requiresOAuth: true,
        config: { name: "Power BI", url: "https://mcp.powerbi.com/mcp", type: "http" },
      },
      {
        key: "broken",
        name: "Broken server",
        builtin: false,
        status: "failed",
        error: "Connection refused",
        requiresOAuth: true,
        config: { name: "Broken server", url: "https://example.com/mcp", type: "http" },
      },
    ]);

    const { result } = renderHook(() => useMcpNotices());
    await waitFor(() => expect(result.current).toHaveLength(2));

    expect(result.current).toEqual([
      expect.objectContaining({
        id: "mcp:power_bi",
        source: "mcp",
        severity: "action",
        title: "Power BI needs sign-in",
      }),
      expect.objectContaining({
        id: "mcp:broken_server",
        source: "mcp",
        severity: "danger",
        title: "Broken server failed to connect",
      }),
    ]);
  });

  it("opens the existing OAuth flow from the notice action", async () => {
    setServers([
      {
        key: "power_bi",
        name: "Power BI",
        builtin: false,
        status: "needs-auth",
        requiresOAuth: true,
        config: { name: "Power BI", url: "https://mcp.powerbi.com/mcp", type: "http" },
      },
    ]);
    const open = vi.spyOn(mcpOAuthStore, "open");
    const { result } = renderHook(() => useMcpNotices());
    await waitFor(() => expect(result.current).toHaveLength(1));

    await result.current[0].actions?.[0]?.onAction();
    expect(open).toHaveBeenCalledWith({
      serverName: "Power BI",
      defaultLoginHint: undefined,
      reason: "sign-in",
      forceReauth: undefined,
    });
  });
});
