import { describe, it, expect, vi, beforeEach } from "vitest";

import type { CustomMcpServer } from "../../common/marshal-ipc-contract";

const { mockOpenExternal } = vi.hoisted(() => ({
  mockOpenExternal: vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock("electron", () => ({
  shell: { openExternal: mockOpenExternal },
}));

import { testDouble } from "../testing/harness";
import { normalizeMcpOAuthLoginHint, registerMcpOAuthHandlers } from "./mcp-oauth-ipc";

function makeIpcDeps(
  overrides: Partial<{
    customMcpServers: CustomMcpServer[];
    serverStatuses: Record<
      string,
      { serverName: string; status: "connected" | "failed" | "needs-auth" | "pending" }
    >;
  }> = {},
) {
  const servers = overrides.customMcpServers ?? [
    { name: "TestServer", url: "https://example.com/mcp" },
  ];
  const mcpStore = testDouble<import("../mcp-store").McpStore>({
    getCustomServers: vi.fn<() => CustomMcpServer[]>(() => servers),
    updateServerConfig: vi.fn<(name: string, update: Partial<CustomMcpServer>) => void>(),
  });
  const sessionManager = testDouble<import("../sessions").SessionManager>({
    getCurrentSessionId: vi.fn<() => string | null>().mockReturnValue("test-session-id"),
    mcpStatus: testDouble<import("../sessions").McpStatusLike>({
      initiateMcpOAuth: vi
        .fn<
          (
            serverName: string,
            options?: { forceReauth?: boolean },
          ) => Promise<{ authorizationUrl?: string }>
        >()
        .mockResolvedValue({}),
      signOutMcpOAuth: vi.fn<(serverName: string) => Promise<void>>().mockResolvedValue(undefined),
      waitForMcpServerConnection: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      getMcpServerStatuses: vi.fn<
        () => Record<
          string,
          { serverName: string; status: "connected" | "failed" | "needs-auth" | "pending" }
        >
      >(() => overrides.serverStatuses ?? {}),
      setCustomMcpServers: vi.fn<(servers: CustomMcpServer[]) => void>(),
    }),
    refreshCurrentSession: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  });
  const auditLogger = testDouble<import("../audit-log").AuditLogger>({
    logOAuth: vi.fn<(input: import("../audit-log").OAuthAuditLogInput) => void>(),
  });

  let capturedHandler:
    | ((
        _event: unknown,
        serverName: string,
        loginHint?: string,
        options?: { contextSessionId?: string; forceReauth?: boolean },
      ) => Promise<unknown>)
    | null = null;
  let capturedSignOutHandler: ((_event: unknown, serverName: string) => Promise<unknown>) | null =
    null;
  const ipcHandle = vi.fn<(channel: string, handler: unknown) => void>(
    (channel: string, handler: unknown) => {
      if (channel === "mcps:initiateOAuth") capturedHandler = handler as typeof capturedHandler; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrow from unknown
      if (channel === "mcps:signOut")
        capturedSignOutHandler = handler as typeof capturedSignOutHandler; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrow from unknown
    },
  );

  registerMcpOAuthHandlers(
    testDouble<Parameters<typeof registerMcpOAuthHandlers>[0]>({
      mcpStore,
      sessionManager,
      auditLogger,
      ipcHandle,
    }),
  );

  const invoke = (
    serverName: string,
    loginHint?: string,
    options?: { contextSessionId?: string; forceReauth?: boolean },
  ) => capturedHandler!({}, serverName, loginHint, options);
  const invokeSignOut = (serverName: string) => capturedSignOutHandler!({}, serverName);
  return { mcpStore, sessionManager, auditLogger, invoke, invokeSignOut };
}

describe("registerMcpOAuthHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when server is not found", async () => {
    const { invoke } = makeIpcDeps();
    const result = await invoke("NonExistent");
    expect(result).toEqual({ status: "error", message: "Server not found" });
  });

  it("returns error for command servers", async () => {
    const { invoke } = makeIpcDeps({
      customMcpServers: [{ name: "CommandServer", type: "command", command: "node" }],
    });
    const result = await invoke("CommandServer");
    expect(result).toEqual({
      status: "error",
      message: "Command-based servers do not use OAuth",
    });
  });

  it("returns error for invalid remote server URLs", async () => {
    const { invoke } = makeIpcDeps({
      customMcpServers: [{ name: "BadServer", url: "not-a-url" }],
    });
    const result = await invoke("BadServer");
    expect((result as { status: string }).status).toBe("error"); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrow from unknown
    expect((result as { message: string }).message).toMatch(/invalid server url/i); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrow from unknown
  });

  it("uses SDK MCP OAuth and opens the returned authorization URL", async () => {
    const { sessionManager, invoke } = makeIpcDeps();
    vi.mocked(sessionManager.mcpStatus.initiateMcpOAuth).mockResolvedValue({
      authorizationUrl: "https://login.example.com/authorize",
    });

    const result = await invoke("TestServer");

    expect(result).toEqual({ status: "success" });
    expect(sessionManager.mcpStatus.initiateMcpOAuth).toHaveBeenCalledWith("TestServer", {
      forceReauth: false,
    });
    expect(mockOpenExternal).toHaveBeenCalledWith("https://login.example.com/authorize");
    expect(sessionManager.mcpStatus.waitForMcpServerConnection).toHaveBeenCalledWith("TestServer");
    expect(sessionManager.refreshCurrentSession).toHaveBeenCalled();
  });

  it("accepts SDK-normalized server keys from chat MCP status events", async () => {
    const { sessionManager, invoke } = makeIpcDeps({
      customMcpServers: [{ name: "Power BI MCP", url: "https://example.com/mcp" }],
    });
    vi.mocked(sessionManager.mcpStatus.initiateMcpOAuth).mockResolvedValue({
      authorizationUrl: "https://login.example.com/authorize",
    });

    const result = await invoke("power_bi_mcp");

    expect(result).toEqual({ status: "success" });
    expect(sessionManager.mcpStatus.initiateMcpOAuth).toHaveBeenCalledWith("Power BI MCP", {
      forceReauth: false,
    });
    expect(sessionManager.mcpStatus.waitForMcpServerConnection).toHaveBeenCalledWith(
      "Power BI MCP",
    );
    expect(mockOpenExternal).toHaveBeenCalledWith("https://login.example.com/authorize");
  });

  it("succeeds without opening a browser when the SDK has a cached token", async () => {
    const { sessionManager, invoke } = makeIpcDeps();
    vi.mocked(sessionManager.mcpStatus.initiateMcpOAuth).mockResolvedValue({});

    const result = await invoke("TestServer");

    expect(result).toEqual({ status: "success" });
    expect(sessionManager.mcpStatus.initiateMcpOAuth).toHaveBeenCalledWith("TestServer", {
      forceReauth: false,
    });
    expect(mockOpenExternal).not.toHaveBeenCalled();
    expect(sessionManager.mcpStatus.waitForMcpServerConnection).toHaveBeenCalledWith("TestServer");
  });

  it("surfaces connection failures after opening the authorization URL", async () => {
    const { sessionManager, invoke } = makeIpcDeps();
    vi.mocked(sessionManager.mcpStatus.initiateMcpOAuth).mockResolvedValue({
      authorizationUrl: "https://login.example.com/authorize",
    });
    vi.mocked(sessionManager.mcpStatus.waitForMcpServerConnection).mockRejectedValue(
      new Error("Power BI failed to connect"),
    );

    const result = await invoke("TestServer");

    expect(result).toEqual({ status: "error", message: "Power BI failed to connect" });
    expect(mockOpenExternal).toHaveBeenCalledWith("https://login.example.com/authorize");
  });

  it("forces reauth and reports the trimmed alias when a login hint is provided", async () => {
    const { sessionManager, invoke } = makeIpcDeps();
    vi.mocked(sessionManager.mcpStatus.initiateMcpOAuth).mockResolvedValue({
      authorizationUrl: "https://login.example.com/authorize?client_id=abc",
    });

    const result = await invoke("TestServer", "  someone  ");

    expect(result).toEqual({ status: "success", oauthAlias: "someone" });
    expect(sessionManager.mcpStatus.initiateMcpOAuth).toHaveBeenCalledWith("TestServer", {
      forceReauth: true,
    });
    // The alias never leaks into the authorization URL.
    expect(mockOpenExternal).toHaveBeenCalledWith(
      "https://login.example.com/authorize?client_id=abc",
    );
  });

  it("persists the alias metadata after successful OAuth for stored custom servers", async () => {
    const servers: CustomMcpServer[] = [{ name: "TestServer", url: "https://example.com/mcp" }];
    const { mcpStore, sessionManager, invoke } = makeIpcDeps({
      customMcpServers: servers,
    });
    vi.mocked(mcpStore.getCustomServers).mockReturnValue(servers);
    vi.mocked(mcpStore.updateServerConfig).mockImplementation(
      (_name: string, update: Partial<CustomMcpServer>) => {
        Object.assign(servers[0], update);
      },
    );
    vi.mocked(sessionManager.mcpStatus.initiateMcpOAuth).mockResolvedValue({});

    const result = await invoke("TestServer", "someone@example.com");

    expect(result).toEqual({ status: "success", oauthAlias: "someone@example.com" });
    expect(mcpStore.updateServerConfig).toHaveBeenCalledWith("TestServer", {
      oauthAlias: "someone@example.com",
    });
    expect(sessionManager.mcpStatus.setCustomMcpServers).toHaveBeenCalledWith([
      { name: "TestServer", url: "https://example.com/mcp", oauthAlias: "someone@example.com" },
    ]);
    expect(sessionManager.refreshCurrentSession).toHaveBeenCalled();
  });

  it("rejects non-HTTPS authorization URLs and does not call openExternal", async () => {
    const { sessionManager, invoke } = makeIpcDeps();
    vi.mocked(sessionManager.mcpStatus.initiateMcpOAuth).mockResolvedValue({
      authorizationUrl: "http://malicious.example.com/authorize",
    });

    const result = await invoke("TestServer");

    expect(result).toEqual({
      status: "error",
      message: "OAuth authorization URL must use HTTPS.",
    });
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it("rejects malformed authorization URLs (URL constructor throws) and does not call openExternal", async () => {
    // Round-7 review follow-up: previously the catch branch in
    // validateAuthorizationUrl was untested. Pin the behavior — a
    // garbage SDK response must surface as a structured error and
    // never reach shell.openExternal.
    const { sessionManager, invoke, auditLogger } = makeIpcDeps();
    vi.mocked(sessionManager.mcpStatus.initiateMcpOAuth).mockResolvedValue({
      authorizationUrl: "not a url at all",
    });

    const result = await invoke("TestServer");

    expect(result).toEqual({
      status: "error",
      message: "Invalid OAuth authorization URL.",
    });
    expect(mockOpenExternal).not.toHaveBeenCalled();
    expect(auditLogger.logOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "mcp-oauth-failure",
        serverName: "TestServer",
        error: "Invalid OAuth authorization URL.",
      }),
    );
  });

  it("surfaces SDK OAuth errors", async () => {
    const { sessionManager, invoke } = makeIpcDeps();
    vi.mocked(sessionManager.mcpStatus.initiateMcpOAuth).mockRejectedValue(
      new Error("OAuth failed"),
    );

    const result = await invoke("TestServer");

    expect(result).toEqual({ status: "error", message: "OAuth failed" });
  });

  it("starts SDK OAuth for runtime MCP servers that only exist in SDK status", async () => {
    const { sessionManager, invoke } = makeIpcDeps({
      customMcpServers: [],
      serverStatuses: {
        "powerbi-remote": { serverName: "powerbi-remote", status: "needs-auth" },
      },
    });
    vi.mocked(sessionManager.mcpStatus.initiateMcpOAuth).mockResolvedValue({
      authorizationUrl: "https://login.example.com/authorize",
    });

    const result = await invoke("powerbi-remote");

    expect(result).toEqual({ status: "success" });
    expect(sessionManager.mcpStatus.initiateMcpOAuth).toHaveBeenCalledWith("powerbi-remote", {
      forceReauth: false,
    });
    expect(sessionManager.mcpStatus.waitForMcpServerConnection).toHaveBeenCalledWith(
      "powerbi-remote",
    );
    expect(sessionManager.refreshCurrentSession).toHaveBeenCalled();
    expect(mockOpenExternal).toHaveBeenCalledWith("https://login.example.com/authorize");
  });

  it("starts SDK OAuth for normalized runtime MCP display names", async () => {
    const { sessionManager, invoke } = makeIpcDeps({
      customMcpServers: [],
      serverStatuses: {
        power_bi_remote: { serverName: "Power BI Remote", status: "needs-auth" },
      },
    });
    vi.mocked(sessionManager.mcpStatus.initiateMcpOAuth).mockResolvedValue({});

    const result = await invoke("power_bi_remote");

    expect(result).toEqual({ status: "success" });
    expect(sessionManager.mcpStatus.initiateMcpOAuth).toHaveBeenCalledWith("Power BI Remote", {
      forceReauth: false,
    });
    expect(sessionManager.mcpStatus.waitForMcpServerConnection).toHaveBeenCalledWith(
      "Power BI Remote",
    );
  });

  it("does not persist alias metadata for runtime-only MCP servers even when loginHint is supplied", async () => {
    const { mcpStore, sessionManager, invoke } = makeIpcDeps({
      customMcpServers: [],
      serverStatuses: {
        "powerbi-remote": { serverName: "powerbi-remote", status: "needs-auth" },
      },
    });
    vi.mocked(sessionManager.mcpStatus.initiateMcpOAuth).mockResolvedValue({});

    const result = await invoke("powerbi-remote", "someone@example.com");

    expect(result).toEqual({ status: "success", oauthAlias: "someone@example.com" });
    // Runtime-only servers (no entry in mcpStore) must not trigger updateServerConfig:
    // the alias only exists for the lifetime of the SDK session, not in our persistent store.
    expect(mcpStore.updateServerConfig).not.toHaveBeenCalled();
    expect(sessionManager.mcpStatus.initiateMcpOAuth).toHaveBeenCalledWith("powerbi-remote", {
      forceReauth: true,
    });
  });

  it("threads contextSessionId through to sessionManager.mcpStatus.initiateMcpOAuth", async () => {
    // Chat-time prompts flow as: SDK emits mcp.oauth_required on session A →
    // SessionManager stamps sessionId on the IpcEvent → renderer dialog
    // captures it and sends it back here as contextSessionId. The handler
    // must propagate it so sessionManager.mcpStatus.initiateMcpOAuth picks session A
    // as the OAuth executor.
    const { sessionManager, invoke } = makeIpcDeps();
    vi.mocked(sessionManager.mcpStatus.initiateMcpOAuth).mockResolvedValue({});

    const result = await invoke("TestServer", undefined, { contextSessionId: "sess-origin" });

    expect(result).toEqual({ status: "success" });
    expect(sessionManager.mcpStatus.initiateMcpOAuth).toHaveBeenCalledWith("TestServer", {
      forceReauth: false,
      contextSessionId: "sess-origin",
    });
  });

  it("does not add contextSessionId to the options object when omitted", async () => {
    // Distinct from the previous test: when there is no contextSessionId we
    // pass only `{ forceReauth }`, no stray `contextSessionId: undefined`
    // key. Keeps the call shape unchanged for the user-initiated path so
    // downstream tests / consumers aren't broken by a phantom field.
    const { sessionManager, invoke } = makeIpcDeps();
    vi.mocked(sessionManager.mcpStatus.initiateMcpOAuth).mockResolvedValue({});

    await invoke("TestServer");

    expect(sessionManager.mcpStatus.initiateMcpOAuth).toHaveBeenCalledWith("TestServer", {
      forceReauth: false,
    });
  });

  it("respects explicit options.forceReauth=true even when loginHint is empty", async () => {
    // The default heuristic is `forceReauth = !!normalizedLoginHint`. The
    // user-initiated "Sign in" path on a signed-in-but-alias-unknown server
    // submits no alias (alias field is optional) and would otherwise let the
    // SDK silently reuse the cached token. The renderer passes
    // `options.forceReauth: true` to force a fresh OAuth flow regardless.
    const { sessionManager, invoke } = makeIpcDeps();
    vi.mocked(sessionManager.mcpStatus.initiateMcpOAuth).mockResolvedValue({});

    await invoke("TestServer", undefined, { forceReauth: true });

    expect(sessionManager.mcpStatus.initiateMcpOAuth).toHaveBeenCalledWith("TestServer", {
      forceReauth: true,
    });
  });

  it("respects explicit options.forceReauth=false even when loginHint is supplied", async () => {
    // Symmetric to the above: the explicit option must win in both
    // directions, so a caller can opt out of force-reauth even when a hint
    // is provided. (Not currently used by Marshal's renderer, but the
    // semantics need to match the documented contract on the IPC signature.)
    const { sessionManager, invoke } = makeIpcDeps();
    vi.mocked(sessionManager.mcpStatus.initiateMcpOAuth).mockResolvedValue({});

    await invoke("TestServer", "user@example.com", { forceReauth: false });

    expect(sessionManager.mcpStatus.initiateMcpOAuth).toHaveBeenCalledWith("TestServer", {
      forceReauth: false,
      // contextSessionId omitted because it wasn't in the options object.
    });
  });
});

describe("mcps:signOut handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns success and delegates to sessionManager.mcpStatus.signOutMcpOAuth", async () => {
    const { sessionManager, auditLogger, invokeSignOut } = makeIpcDeps({
      customMcpServers: [
        { name: "TestServer", url: "https://example.com/mcp", oauthAlias: "alice" },
      ],
    });

    const result = await invokeSignOut("TestServer");

    expect(result).toEqual({ status: "success" });
    expect(sessionManager.mcpStatus.signOutMcpOAuth).toHaveBeenCalledWith("TestServer");
    // Single terminal success event — `mcp-oauth-signout` is emitted only
    // after the SDK call succeeds. The atomic primitive (alias-clear +
    // setCustomMcpServers + token drop) is tested in sessions.flow.test.ts.
    expect(auditLogger.logOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ event: "mcp-oauth-signout", serverName: "TestServer" }),
    );
    expect(auditLogger.logOAuth).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "mcp-oauth-success" }),
    );
  });

  it("returns error and does NOT call the SDK for command-type servers", async () => {
    const { sessionManager, mcpStore, invokeSignOut, auditLogger } = makeIpcDeps({
      customMcpServers: [{ name: "CommandServer", type: "command", command: "node" }],
    });

    const result = await invokeSignOut("CommandServer");

    expect(result).toEqual({
      status: "error",
      message: "Command-based servers do not use OAuth",
    });
    expect(sessionManager.mcpStatus.signOutMcpOAuth).not.toHaveBeenCalled();
    expect(mcpStore.updateServerConfig).not.toHaveBeenCalled();
    expect(auditLogger.logOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ event: "mcp-oauth-failure" }),
    );
  });

  it("falls back to runtime status when the server isn't in the custom-server list (SDK-only)", async () => {
    const { sessionManager, invokeSignOut } = makeIpcDeps({
      customMcpServers: [],
      serverStatuses: {
        sdk_only: { serverName: "SdkOnly", status: "connected" },
      },
    });

    const result = await invokeSignOut("SdkOnly");

    expect(result).toEqual({ status: "success" });
    expect(sessionManager.mcpStatus.signOutMcpOAuth).toHaveBeenCalledWith("SdkOnly");
  });

  it("returns an error and audit-logs failure when the SDK sign-out throws", async () => {
    const { sessionManager, auditLogger, invokeSignOut } = makeIpcDeps({
      customMcpServers: [
        { name: "TestServer", url: "https://example.com/mcp", oauthAlias: "alice" },
      ],
    });
    vi.mocked(sessionManager.mcpStatus.signOutMcpOAuth).mockRejectedValue(new Error("SDK boom"));

    const result = await invokeSignOut("TestServer");

    expect(result).toEqual({ status: "error", message: "SDK boom" });
    expect(auditLogger.logOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ event: "mcp-oauth-failure", error: "SDK boom" }),
    );
    // Terminal signout event is not emitted on failure.
    expect(auditLogger.logOAuth).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "mcp-oauth-signout" }),
    );
  });
});

describe("normalizeMcpOAuthLoginHint", () => {
  it("returns the trimmed hint without adding a domain", () => {
    expect(normalizeMcpOAuthLoginHint("someone")).toBe("someone");
    expect(normalizeMcpOAuthLoginHint("  someone  ")).toBe("someone");
    expect(normalizeMcpOAuthLoginHint("\tsomeone@example.com\n")).toBe("someone@example.com");
  });

  it("returns undefined for empty / whitespace-only / undefined input", () => {
    expect(normalizeMcpOAuthLoginHint(undefined)).toBeUndefined();
    expect(normalizeMcpOAuthLoginHint("")).toBeUndefined();
    expect(normalizeMcpOAuthLoginHint("   ")).toBeUndefined();
    expect(normalizeMcpOAuthLoginHint("\t\n")).toBeUndefined();
  });
});
