import type { McpServerInfo, McpsAPI } from "@common/marshal-ipc-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mcpOAuthStore } from "@/hooks/mcp-oauth-store";
import { installMockAPIs, renderHook, waitFor } from "@/test-utils";

import { useMcpAttention } from "./useMcpAttention";

function setServers(servers: McpServerInfo[]) {
  window.mcpsAPI.list = vi.fn<McpsAPI["list"]>().mockResolvedValue({ success: true, servers });
}

const ready = (overrides: Partial<McpServerInfo> = {}): McpServerInfo => ({
  key: "filesystem",
  name: "filesystem",
  builtin: true,
  status: "connected",
  tools: [
    { name: "read_file", description: "" },
    { name: "write_file", description: "" },
  ],
  ...overrides,
});

const needsAuth = (overrides: Partial<McpServerInfo> = {}): McpServerInfo => ({
  key: "power_bi",
  name: "Power BI",
  builtin: false,
  status: "needs-auth",
  requiresOAuth: true,
  config: { name: "Power BI", url: "https://mcp.powerbi.com/mcp", type: "http" },
  ...overrides,
});

const failed = (overrides: Partial<McpServerInfo> = {}): McpServerInfo => ({
  key: "broken",
  name: "broken",
  builtin: false,
  status: "failed",
  error: "Connection refused",
  config: { name: "broken", url: "https://nope.example/mcp", type: "http" },
  ...overrides,
});

const pending = (overrides: Partial<McpServerInfo> = {}): McpServerInfo => ({
  key: "playwright",
  name: "playwright",
  builtin: true,
  status: "pending",
  ...overrides,
});

describe("useMcpAttention", () => {
  beforeEach(() => {
    installMockAPIs();
    mcpOAuthStore.resetForTests();
  });

  it("returns null when there are no servers configured", async () => {
    setServers([]);
    const { result } = renderHook(() => useMcpAttention());
    // Initial render: data is undefined, hook returns null.
    expect(result.current).toBeNull();
    // After the empty list resolves it should still be null.
    await waitFor(() => {
      expect(result.current).toBeNull();
    });
  });

  it("filters out disabled and not_configured servers", async () => {
    setServers([
      { key: "a", name: "a", builtin: true, status: "disabled" },
      { key: "b", name: "b", builtin: true, status: "not_configured" },
    ]);
    const { result } = renderHook(() => useMcpAttention());
    await waitFor(() => {
      // Only filtered-out servers are present, so the card hides entirely.
      expect(result.current).toBeNull();
    });
  });

  it("classifies attention states from server.status (filters out ready and connecting)", async () => {
    setServers([ready(), needsAuth(), failed(), pending()]);
    const { result } = renderHook(() => useMcpAttention());
    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    const data = result.current!;
    // Only attention-worthy servers are surfaced. Ready and connecting are
    // filtered out because the card is an attention surface, not a roster.
    expect(data.items.map((i) => [i.name, i.state])).toEqual([
      ["Power BI", "needs-auth"],
      ["broken", "failed"],
    ]);
  });

  it("returns null when every server is connected", async () => {
    setServers([ready(), ready({ key: "a", name: "a", tools: [] })]);
    const { result } = renderHook(() => useMcpAttention());
    // Wait for the mcps:list query to fire instead of sleeping for a fixed
    // duration — a 50ms timeout is flake-prone on a loaded CI runner. By the
    // time waitFor resolves, the resolved-promise → React-Query → re-render
    // chain has settled, so the steady-state assertion below is meaningful.
    await waitFor(() => {
      expect(window.mcpsAPI.list).toHaveBeenCalled();
    });
    expect(result.current).toBeNull();
  });

  it("returns null when every server is connecting (cold start)", async () => {
    setServers([pending(), pending({ key: "a", name: "a" })]);
    const { result } = renderHook(() => useMcpAttention());
    await waitFor(() => {
      expect(window.mcpsAPI.list).toHaveBeenCalled();
    });
    expect(result.current).toBeNull();
  });

  it("returns null on a mix of ready and connecting (no attention required)", async () => {
    setServers([ready(), pending()]);
    const { result } = renderHook(() => useMcpAttention());
    await waitFor(() => {
      expect(window.mcpsAPI.list).toHaveBeenCalled();
    });
    expect(result.current).toBeNull();
  });

  it("OAuth UI state connecting on a needs-auth server suppresses the card", async () => {
    // While the user is mid-sign-in, the in-flight UI flow takes precedence
    // and the server is treated as `connecting` — not actionable, so the
    // attention card hides.
    setServers([needsAuth({ key: "power_bi", name: "Power BI" })]);
    mcpOAuthStore.setUiState("power_bi", { serverKey: "power_bi", state: "connecting" });
    const { result } = renderHook(() => useMcpAttention());
    await waitFor(() => {
      expect(window.mcpsAPI.list).toHaveBeenCalled();
    });
    expect(result.current).toBeNull();
  });

  it("OAuth UI state failed overrides server.status connected", async () => {
    setServers([ready({ key: "power_bi", name: "Power BI", status: "connected" })]);
    mcpOAuthStore.setUiState("power_bi", {
      serverKey: "power_bi",
      state: "failed",
      error: "boom",
    });
    const { result } = renderHook(() => useMcpAttention());
    await waitFor(() => {
      expect(result.current?.items[0]?.state).toBe("failed");
    });
  });

  it("includes a sign-in oauthAction for needs-auth servers", async () => {
    setServers([needsAuth()]);
    const { result } = renderHook(() => useMcpAttention());
    await waitFor(() => {
      const action = result.current?.items[0]?.oauthAction;
      expect(action?.reason).toBe("sign-in");
      expect(action?.label).toBe("Sign in");
      // The bug-2 (force-reauth) surface must stay closed on first sign-in —
      // forceReauth is only set when re-authenticating an already signed-in
      // server. Pin this so a future change to getMcpOAuthAction can't quietly
      // flip the heuristic and start dropping cached tokens on first sign-in.
      expect(action?.forceReauth).toBeUndefined();
    });
  });

  // Regression guard for the bug-2 surface raised in the Round-2 review:
  // a signed-in OAuth server (status: "connected" + requiresOAuth + alias)
  // must never reach the attention rail. The rail is an attention-only surface;
  // signed-in maintenance ("Re-authenticate" / "Log out") lives in the
  // Plugins detail dialog. If a future refactor removes the
  // `state !== "needs-auth" && state !== "failed"` filter, this test fails —
  // catching the regression before a "Re-authenticate" button with
  // forceReauth: true appears in the chat timeline.
  it("filters out signed-in OAuth servers (no Re-authenticate surface in the attention rail)", async () => {
    setServers([
      needsAuth({
        key: "power_bi",
        name: "Power BI",
        status: "connected",
        oauthAlias: "user@example.com",
      }),
    ]);
    const { result } = renderHook(() => useMcpAttention());
    await waitFor(() => {
      expect(window.mcpsAPI.list).toHaveBeenCalled();
    });
    expect(result.current).toBeNull();
  });

  it("treats undefined server.status as connecting (cold start) and hides the card", async () => {
    // Cold-start with no status reported yet is classified as connecting,
    // which is not actionable and therefore should not surface the card.
    setServers([{ key: "x", name: "x", builtin: true }]);
    const { result } = renderHook(() => useMcpAttention());
    await waitFor(() => {
      expect(window.mcpsAPI.list).toHaveBeenCalled();
    });
    expect(result.current).toBeNull();
  });
});
