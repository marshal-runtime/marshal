/**
 * Composes a `UserIdentity` from whichever backend is active.
 *
 * Pure module (no Electron imports) so it's unit-testable with simple stub
 * deps. The IPC handler module wires the real functions in.
 *
 * Per the Phase 2 backend-abstraction spec: "Renderer checks
 * BackendCapabilities, never backend identity. No `if (isGateway)` in UI
 * code." This composer is the single seam where backend-specific identity
 * shaping lives — PersonContextMenu just renders what it gets.
 */

import type {
  GatewayAuthIdentity,
  GatewayAuthState,
  UserIdentity,
} from "../../common/marshal-ipc-contract";
import { getRuntimeMetadata } from "../../common/runtime-config";

interface RelayStatusLike {
  connected: boolean;
  displaced?: boolean;
}

interface RuntimeAuthStatusLike {
  isAuthenticated: boolean;
  login?: string;
}

export interface IdentityComposerDeps {
  getRuntimeId(): string;
  /** Gateway auth state — only read when backend is gateway. */
  getGatewayAuthState(): GatewayAuthState | null;
  /** Active runtime auth status. */
  getRuntimeAuthStatus(): Promise<RuntimeAuthStatusLike>;
  /** GitHub avatar lookup. May return null on fetch failure. */
  getGitHubAvatar(login: string): Promise<string | null>;
  /** Messaging-relay status (orthogonal to chat backend; hidden in gateway mode). */
  getRelayStatus(): RelayStatusLike;
  /** Relay availability; when no relay is configured it must not affect profile status. */
  getRelayAvailable(): boolean;
}

function gatewayModeLabel(mode: GatewayAuthIdentity["mode"]): string {
  switch (mode) {
    case "no-auth":
      return "no auth";
    case "hosted":
      return "hosted";
    default:
      mode satisfies never;
      return "signed in";
  }
}

function gatewayDisplayName(identity: GatewayAuthIdentity): string {
  if (identity.mode === "no-auth") return "demo-user";
  return identity.oid ?? "signed in";
}

const GATEWAY_SIGN_OUT_COPY = {
  title: "Disconnect from Lobster?",
  description:
    "Disconnecting will sign you out of the Lobster gateway. You can sign in again with a different identity.",
  confirmLabel: "Disconnect",
} as const;

function composeGatewayIdentity(state: GatewayAuthState): UserIdentity {
  const identity = state.identity;
  const isAuthenticated = state.status === "signed-in";
  if (!identity) {
    // Defensive — GatewayAuthGate only renders children when status is
    // "signed-in" and identity is always populated in that case.
    return {
      isAuthenticated,
      displayName: "Signed in",
      subtitle: null,
      accountName: null,
      avatarUrl: null,
      statusColor: "muted",
      statusText: "signed in",
      integrations: [],
      signOut: GATEWAY_SIGN_OUT_COPY,
    };
  }
  const mode = gatewayModeLabel(identity.mode);
  return {
    isAuthenticated,
    displayName: gatewayDisplayName(identity),
    subtitle: `Lobster · ${mode}`,
    accountName: identity.oid ?? null,
    avatarUrl: null,
    statusColor: "success",
    statusText: mode,
    // Gateway mode doesn't surface relay integrations — the gateway is a
    // separate identity plane, and showing them as "Disconnected" would be
    // misleading.
    integrations: [],
    signOut: GATEWAY_SIGN_OUT_COPY,
  };
}

async function composeCopilotIdentity(deps: IdentityComposerDeps): Promise<UserIdentity> {
  const copilotAuth = await deps.getRuntimeAuthStatus();
  const relay = deps.getRelayStatus();
  const relayAvailable = deps.getRelayAvailable();

  const githubHandle = copilotAuth.login ?? null;
  const avatarUrl = githubHandle ? await deps.getGitHubAvatar(githubHandle) : null;
  const displayName = githubHandle ?? "Signed in";

  const relayConnected = !relayAvailable || (relay.connected && !relay.displaced);
  const statusColor: UserIdentity["statusColor"] = !copilotAuth.isAuthenticated
    ? "danger"
    : relayConnected
      ? "success"
      : "warning";
  const statusText = copilotAuth.isAuthenticated ? "Connected" : "Disconnected";

  return {
    isAuthenticated: copilotAuth.isAuthenticated,
    displayName,
    subtitle: githubHandle,
    accountName: githubHandle,
    avatarUrl,
    statusColor,
    statusText,
    integrations: [{ id: "relay", name: "Relay", connected: relayConnected }],
    signOut: {
      title: "Sign out of Copilot?",
      description: "Signing out disconnects the GitHub account used by the Copilot runtime.",
      confirmLabel: "Sign out",
    },
  };
}

async function composeLocalRuntimeIdentity(
  deps: IdentityComposerDeps,
  runtimeId: string,
): Promise<UserIdentity> {
  const runtime = getRuntimeMetadata(runtimeId);
  const auth = await deps.getRuntimeAuthStatus();
  const relay = deps.getRelayStatus();
  const relayConnected = !deps.getRelayAvailable() || (relay.connected && !relay.displaced);
  const runtimeSubtitle = auth.login
    ? `${runtime.displayName} · ${auth.login}`
    : runtime.displayName;

  return {
    isAuthenticated: auth.isAuthenticated,
    displayName: runtime.displayName,
    subtitle: runtimeSubtitle,
    accountName: null,
    avatarUrl: null,
    statusColor: auth.isAuthenticated ? "success" : "danger",
    statusText: auth.isAuthenticated ? "Connected" : "Disconnected",
    integrations: [{ id: "relay", name: "Relay", connected: relayConnected }],
    signOut: runtime.auth.signOut ?? {
      title: `Sign out of ${runtime.displayName}?`,
      description: `Signing out disconnects ${runtime.displayName}.`,
      confirmLabel: "Sign out",
    },
  };
}

export async function composeIdentity(deps: IdentityComposerDeps): Promise<UserIdentity> {
  const runtimeId = deps.getRuntimeId();
  const runtime = getRuntimeMetadata(runtimeId);
  switch (runtime.rendererRoot) {
    case "gateway": {
      const gatewayState = deps.getGatewayAuthState();
      if (!gatewayState) {
        // Shouldn't reach PersonContextMenu in this case (GatewayAuthGate
        // holds the user on the login screen), but defend anyway.
        return composeGatewayIdentity({ status: "picking" });
      }
      return composeGatewayIdentity(gatewayState);
    }
    case "copilot":
      return composeCopilotIdentity(deps);
    case "local":
      return composeLocalRuntimeIdentity(deps, runtimeId);
  }
  runtime.rendererRoot satisfies never;
  throw new Error(`Unsupported renderer root for runtime "${runtimeId}"`);
}
