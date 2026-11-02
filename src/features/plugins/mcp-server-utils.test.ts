// Marshal-owned module.
import type { McpServerInfo } from "@common/marshal-ipc-contract";
import { describe, expect, it } from "vitest";

import type { McpOAuthUiState } from "@/hooks/mcp-oauth-store";

import {
  getMcpOAuthAction,
  getMcpOAuthSecondaryAction,
  getMcpServerDescription,
  getMcpServerDetails,
  getMcpServerStatusLabel,
  isMcpOAuthCapable,
  isMcpServerSignedIn,
} from "./mcp-server-utils";

// Minimal HTTP-server factory — every test composes from this and overrides
// just the fields it cares about, so the test bodies stay focused on the
// branch under test.
function httpServer(overrides: Partial<McpServerInfo> = {}): McpServerInfo {
  return {
    key: "powerbi_remote",
    name: "powerbi-remote",
    builtin: false,
    status: "connected",
    requiresOAuth: true,
    config: {
      name: "powerbi-remote",
      url: "https://mcp.example.com/v1/mcp/powerbi",
      type: "http",
    },
    ...overrides,
  };
}

function stdioServer(overrides: Partial<McpServerInfo> = {}): McpServerInfo {
  return {
    key: "filesystem",
    name: "filesystem",
    builtin: false,
    status: "connected",
    requiresOAuth: false,
    config: {
      name: "filesystem",
      type: "command",
      command: "node",
      args: ["server.js"],
    },
    ...overrides,
  };
}

describe("isMcpOAuthCapable", () => {
  it("returns false for stdio servers", () => {
    expect(isMcpOAuthCapable(stdioServer())).toBe(false);
  });

  it("returns false for HTTP servers with a manual bearer token", () => {
    const server = httpServer({
      config: {
        name: "with-token",
        url: "https://example.com",
        type: "http",
        accessToken: "static-bearer-token",
      },
      requiresOAuth: false,
    });
    expect(isMcpOAuthCapable(server)).toBe(false);
  });

  it("returns true for HTTP servers marked requiresOAuth", () => {
    expect(isMcpOAuthCapable(httpServer({ requiresOAuth: true }))).toBe(true);
  });

  it("returns true for HTTP servers in needs-auth even if requiresOAuth is unset", () => {
    // The SDK can land a remote MCP in needs-auth without us pre-flagging
    // requiresOAuth — the runtime discovered the WWW-Authenticate challenge.
    // We must still treat it as OAuth-capable, otherwise the detail dialog
    // hides the sign-in action.
    expect(isMcpOAuthCapable(httpServer({ status: "needs-auth", requiresOAuth: undefined }))).toBe(
      true,
    );
  });
});

describe("isMcpServerSignedIn", () => {
  it("treats uiState=connected as signed in even when server.status is stale", () => {
    // OAuth store updates land before the next mcps:list refresh, so we have
    // to trust uiState=connected over a stale server.status snapshot.
    const server = httpServer({ status: "needs-auth" });
    const uiState: McpOAuthUiState = { serverKey: "powerbi-remote", state: "connected" };
    expect(isMcpServerSignedIn(server, uiState)).toBe(true);
  });

  it("treats server.status=connected as signed in", () => {
    expect(isMcpServerSignedIn(httpServer({ status: "connected" }))).toBe(true);
  });

  it("returns true when only an alias is present on an OAuth server in a non-failure state", () => {
    // OAuth servers can carry an alias before the runtime emits "connected"
    // (e.g. the token is cached and the connect attempt hasn't fired yet).
    // We display them as signed-in so the user doesn't see "Sign in" on a
    // server that already remembers their account.
    expect(
      isMcpServerSignedIn(httpServer({ status: "disabled", oauthAlias: "alice@example.com" })),
    ).toBe(true);
  });

  it("returns false when the server is in a failure-shaped state even if an alias is cached", () => {
    // needs-auth/failed/pending mean the token isn't currently usable — the
    // UI must surface "Sign in"/"Retry" rather than masking the failure with
    // a stale alias.
    expect(
      isMcpServerSignedIn(httpServer({ status: "needs-auth", oauthAlias: "alice@example.com" })),
    ).toBe(false);
    expect(
      isMcpServerSignedIn(httpServer({ status: "failed", oauthAlias: "alice@example.com" })),
    ).toBe(false);
    expect(
      isMcpServerSignedIn(httpServer({ status: "pending", oauthAlias: "alice@example.com" })),
    ).toBe(false);
  });
});

describe("getMcpServerStatusLabel", () => {
  it("mirrors uiState.state=connecting over server.status", () => {
    const server = httpServer({ status: "connected", oauthAlias: "alice@example.com" });
    const uiState: McpOAuthUiState = { serverKey: "powerbi-remote", state: "connecting" };
    expect(getMcpServerStatusLabel(server, uiState)).toBe("Connecting");
  });

  it("renders 'Signed in as <alias>' when the alias is known", () => {
    const server = httpServer({ oauthAlias: "alice@example.com" });
    expect(getMcpServerStatusLabel(server)).toBe("Signed in as alice@example.com");
  });

  it("renders 'Signed in (account unknown)' when an OAuth server has no alias", () => {
    // Edge case: SDK reuses a cached token for a freshly-recreated remote
    // MCP, so server.status=connected without our config carrying an alias.
    const server = httpServer();
    expect(getMcpServerStatusLabel(server)).toBe("Signed in (account unknown)");
  });

  it("appends the error text when includeError defaults to true", () => {
    const server = httpServer({ status: "failed", error: "Connection refused" });
    expect(getMcpServerStatusLabel(server)).toBe("Failed · Connection refused");
  });

  it("omits the error text when includeError=false", () => {
    // The detail dialog renders Status and Error on separate rows, so it
    // passes includeError:false to avoid duplicating the error string.
    const server = httpServer({ status: "failed", error: "Connection refused" });
    expect(getMcpServerStatusLabel(server, undefined, { includeError: false })).toBe("Failed");
  });
});

describe("getMcpOAuthAction", () => {
  it("returns null for non-OAuth-capable servers", () => {
    expect(getMcpOAuthAction(stdioServer())).toBeNull();
  });

  it("returns 'Connecting...' (disabled) while uiState=connecting", () => {
    const action = getMcpOAuthAction(httpServer({ status: "needs-auth" }), {
      serverKey: "powerbi-remote",
      state: "connecting",
    });
    expect(action).toMatchObject({ label: "Connecting...", disabled: true, reason: "sign-in" });
  });

  it("returns 'Re-authenticate' (forceReauth=true) for signed-in servers", () => {
    // forceReauth is critical: the SDK silently reuses cached tokens
    // otherwise, defeating the user's intent to switch accounts.
    const action = getMcpOAuthAction(httpServer({ oauthAlias: "alice@example.com" }));
    expect(action).toMatchObject({
      label: "Re-authenticate",
      reason: "switch",
      forceReauth: true,
    });
  });

  it("disables the primary action while a sign-out IPC is in flight", () => {
    // Without this, the user could fire a Re-authenticate during sign-out
    // and race the token-deletion + alias-clear.
    const action = getMcpOAuthAction(
      httpServer({ oauthAlias: "alice@example.com" }),
      undefined,
      true,
    );
    expect(action?.disabled).toBe(true);
  });

  it("returns 'Retry sign in' for failed servers", () => {
    expect(getMcpOAuthAction(httpServer({ status: "failed" }))?.label).toBe("Retry sign in");
  });

  it("returns 'Sign in' for needs-auth servers", () => {
    expect(getMcpOAuthAction(httpServer({ status: "needs-auth" }))?.label).toBe("Sign in");
  });

  it("returns 'Sign in' (not 'Connect') for OAuth-capable servers without an SDK status yet", () => {
    // Plugin-contributed MCPs reliably land here on cold start
    // (requiresOAuth=true, status=undefined before the SDK emits a status
    // event). Before the fix the fallback returned {label: "Connect",
    // reason: "connect"}, which no surface in the app handled and pushed
    // a dead "Connect" CTA to the user. Regression-pin for that fix.
    expect(getMcpOAuthAction(httpServer({ status: undefined }))).toEqual({
      label: "Sign in",
      reason: "sign-in",
    });
  });
});

describe("getMcpOAuthSecondaryAction", () => {
  it("returns null for non-OAuth-capable servers", () => {
    expect(getMcpOAuthSecondaryAction(stdioServer())).toBeNull();
  });

  it("returns null while a connection attempt is in flight", () => {
    expect(
      getMcpOAuthSecondaryAction(httpServer({ oauthAlias: "alice@example.com" }), {
        serverKey: "powerbi-remote",
        state: "connecting",
      }),
    ).toBeNull();
    expect(getMcpOAuthSecondaryAction(httpServer({ status: "pending" }))).toBeNull();
  });

  it("returns null when the server is not signed in", () => {
    expect(getMcpOAuthSecondaryAction(httpServer({ status: "needs-auth" }))).toBeNull();
  });

  it("returns 'Log out' for signed-in servers", () => {
    expect(getMcpOAuthSecondaryAction(httpServer({ oauthAlias: "alice@example.com" }))).toEqual({
      label: "Log out",
      reason: "sign-out",
      disabled: false,
    });
  });

  it("disables 'Log out' while a sign-out is in flight (matches primary)", () => {
    expect(
      getMcpOAuthSecondaryAction(httpServer({ oauthAlias: "alice@example.com" }), undefined, true),
    ).toEqual({ label: "Log out", reason: "sign-out", disabled: true });
  });
});

describe("getMcpServerDescription", () => {
  it("returns the URL for HTTP servers", () => {
    expect(getMcpServerDescription(httpServer())).toBe("https://mcp.example.com/v1/mcp/powerbi");
  });

  it("returns undefined for stdio servers (command shows in details instead)", () => {
    expect(getMcpServerDescription(stdioServer())).toBeUndefined();
  });
});

describe("getMcpServerDetails", () => {
  it("includes URL + Status + Tools-placeholder for a connected remote server", () => {
    const details = getMcpServerDetails(httpServer({ oauthAlias: "alice@example.com" }));
    expect(details).toEqual([
      {
        label: "URL",
        value: "https://mcp.example.com/v1/mcp/powerbi",
        linkify: true,
      },
      { label: "Status", value: "Signed in as alice@example.com" },
      // Remote MCP tools are discovered inside chat sessions, not enumerated
      // up front, so the dialog renders an explanatory placeholder when no
      // tools have been observed yet.
      {
        label: "Tools",
        value:
          "Remote MCP tools are discovered by the Copilot SDK inside chat sessions and are not listed individually here.",
      },
    ]);
  });

  it("renders Command (not URL) for stdio servers and lists discovered tools", () => {
    const details = getMcpServerDetails(
      stdioServer({
        tools: [
          { name: "read_file", description: "" },
          { name: "write_file", description: "" },
        ],
      }),
    );
    expect(details).toEqual([
      { label: "Command", value: "node", linkify: false },
      { label: "Status", value: "Connected" },
      { label: "Tools", value: "read_file, write_file" },
    ]);
  });

  // This is the key branch that prompted the dedicated unit test: when the
  // OAuth store reports `connecting`, the Status row must mirror that
  // transition so the detail dialog row stays in sync with the action
  // button. Without this branch, the row would lag behind by a render and
  // briefly show the stale "Signed in as <alias>" while the button already
  // reads "Connecting...".
  it("overrides server.status with uiState=connecting in the Status row", () => {
    const details = getMcpServerDetails(
      httpServer({ status: "connected", oauthAlias: "alice@example.com" }),
      { serverKey: "powerbi-remote", state: "connecting" },
    );
    expect(details).toContainEqual({ label: "Status", value: "Connecting" });
    expect(details?.some((d) => d.label === "Status" && d.value.startsWith("Signed in"))).toBe(
      false,
    );
  });

  it("renders Status='Failed' (no error suffix) and a separate Error row when the server has an error", () => {
    // Detail dialog passes includeError:false to getMcpServerStatusLabel so
    // the failure shows as Status=Failed + Error=<msg> instead of being
    // duplicated as a "Failed · <msg>" suffix.
    const details = getMcpServerDetails(httpServer({ status: "failed", error: "Token expired" }));
    expect(details).toContainEqual({ label: "Status", value: "Failed" });
    expect(details).toContainEqual({ label: "Error", value: "Token expired" });
  });
});
