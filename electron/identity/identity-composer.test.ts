import { describe, it, expect } from "vitest";

import type { GatewayAuthState } from "../../common/marshal-ipc-contract";
import { composeIdentity } from "./identity-composer";
import type { IdentityComposerDeps } from "./identity-composer";

function makeDeps(overrides: Partial<IdentityComposerDeps> = {}): IdentityComposerDeps {
  return {
    getRuntimeId: () => "copilot",
    getGatewayAuthState: () => null,
    getRuntimeAuthStatus: async () => ({ isAuthenticated: true, login: "janesmith" }),
    getGitHubAvatar: async () => "https://example.com/jane.png",
    getRelayStatus: () => ({ connected: false }),
    getRelayAvailable: () => true,
    ...overrides,
  };
}

describe("composeIdentity — Copilot runtime", () => {
  it("uses the GitHub handle as display name, subtitle, and account name", async () => {
    const id = await composeIdentity(makeDeps());
    expect(id.displayName).toBe("janesmith");
    expect(id.subtitle).toBe("janesmith");
    expect(id.accountName).toBe("janesmith");
    expect(id.avatarUrl).toBe("https://example.com/jane.png");
  });

  it("falls back to 'Signed in' when GitHub has no handle", async () => {
    const id = await composeIdentity(
      makeDeps({
        getRuntimeAuthStatus: async () => ({ isAuthenticated: true }),
      }),
    );
    expect(id.displayName).toBe("Signed in");
    expect(id.subtitle).toBeNull();
  });

  it("statusColor=danger when Copilot is not authenticated", async () => {
    const id = await composeIdentity(
      makeDeps({ getRuntimeAuthStatus: async () => ({ isAuthenticated: false }) }),
    );
    expect(id.statusColor).toBe("danger");
    expect(id.statusText).toBe("Disconnected");
  });

  it("statusColor=success when Copilot and the relay are both good", async () => {
    const id = await composeIdentity(
      makeDeps({
        getRelayStatus: () => ({ connected: true, displaced: false }),
      }),
    );
    expect(id.statusColor).toBe("success");
  });

  it("statusColor=warning when the relay is displaced", async () => {
    const id = await composeIdentity(
      makeDeps({
        getRelayStatus: () => ({ connected: true, displaced: true }),
      }),
    );
    expect(id.statusColor).toBe("warning");
  });

  it("ignores a disconnected relay when no relay provider is available", async () => {
    const id = await composeIdentity(
      makeDeps({
        getRelayStatus: () => ({ connected: false }),
        getRelayAvailable: () => false,
      }),
    );
    expect(id.statusColor).toBe("success");
    expect(id.statusText).toBe("Connected");
  });

  it("integrations list reflects relay state", async () => {
    const id = await composeIdentity(
      makeDeps({
        getRelayStatus: () => ({ connected: true }),
      }),
    );
    expect(id.integrations).toEqual([{ id: "relay", name: "Relay", connected: true }]);
  });

  it("signOut copy names the GitHub account", async () => {
    const id = await composeIdentity(makeDeps());
    expect(id.signOut.title).toBe("Sign out of Copilot?");
    expect(id.signOut.confirmLabel).toBe("Sign out");
    expect(id.signOut.description).toMatch(/GitHub/);
  });
});

describe("composeIdentity — local runtime", () => {
  it("uses runtime metadata instead of treating Claude auth as a GitHub identity", async () => {
    let avatarCalled = false;
    const id = await composeIdentity(
      makeDeps({
        getRuntimeId: () => "claude",
        getRuntimeAuthStatus: async () => ({ isAuthenticated: true, login: "api-key" }),
        getGitHubAvatar: async () => {
          avatarCalled = true;
          return "should-not-be-used";
        },
      }),
    );

    expect(avatarCalled).toBe(false);
    expect(id.displayName).toBe("Claude Agent");
    expect(id.subtitle).toBe("Claude Agent · api-key");
    expect(id.avatarUrl).toBeNull();
    expect(id.accountName).toBeNull();
  });

  it("uses runtime-only sign-out copy for Claude", async () => {
    const id = await composeIdentity(
      makeDeps({
        getRuntimeId: () => "claude",
        getRuntimeAuthStatus: async () => ({ isAuthenticated: true, login: "google-vertex" }),
      }),
    );

    expect(id.signOut.title).toBe("Sign out of Claude Agent?");
    expect(id.signOut.description).toContain("launch environment");
    expect(id.signOut.description).not.toContain("GitHub");
  });
});

describe("composeIdentity — Gateway runtime", () => {
  function gatewayState(overrides: Partial<GatewayAuthState> = {}): GatewayAuthState {
    return {
      status: "signed-in",
      identity: { mode: "hosted", oid: "alice-oid-001" },
      ...overrides,
    };
  }

  it("displays demo-user for no-auth mode", async () => {
    const id = await composeIdentity(
      makeDeps({
        getRuntimeId: () => "gateway",
        getGatewayAuthState: () => gatewayState({ identity: { mode: "no-auth" } }),
      }),
    );
    expect(id.displayName).toBe("demo-user");
    expect(id.subtitle).toBe("Lobster · no auth");
  });

  it("displays the credential oid in hosted mode", async () => {
    const id = await composeIdentity(
      makeDeps({
        getRuntimeId: () => "gateway",
        getGatewayAuthState: () =>
          gatewayState({ identity: { mode: "hosted", oid: "alice-oid-001" } }),
      }),
    );
    expect(id.displayName).toBe("alice-oid-001");
    expect(id.subtitle).toBe("Lobster · hosted");
    expect(id.accountName).toBe("alice-oid-001");
  });

  it("falls back to 'signed in' in hosted mode when no oid is available", async () => {
    const id = await composeIdentity(
      makeDeps({
        getRuntimeId: () => "gateway",
        getGatewayAuthState: () => gatewayState({ identity: { mode: "hosted" } }),
      }),
    );
    expect(id.displayName).toBe("signed in");
    expect(id.accountName).toBeNull();
  });

  it("does NOT surface relay integrations in gateway mode", async () => {
    const id = await composeIdentity(
      makeDeps({
        getRuntimeId: () => "gateway",
        getGatewayAuthState: () => gatewayState(),
        getRelayStatus: () => ({ connected: true, displaced: false }),
      }),
    );
    expect(id.integrations).toEqual([]);
  });

  it("signOut copy is Lobster-flavored", async () => {
    const id = await composeIdentity(
      makeDeps({
        getRuntimeId: () => "gateway",
        getGatewayAuthState: () => gatewayState(),
      }),
    );
    expect(id.signOut.title).toBe("Disconnect from Lobster?");
    expect(id.signOut.confirmLabel).toBe("Disconnect");
  });

  it("skips the GitHub avatar lookup in gateway mode", async () => {
    let avatarCalled = false;
    const id = await composeIdentity(
      makeDeps({
        getRuntimeId: () => "gateway",
        getGatewayAuthState: () => gatewayState(),
        getGitHubAvatar: async () => {
          avatarCalled = true;
          return "should-not-be-used";
        },
      }),
    );
    expect(avatarCalled).toBe(false);
    expect(id.avatarUrl).toBeNull();
  });
});
