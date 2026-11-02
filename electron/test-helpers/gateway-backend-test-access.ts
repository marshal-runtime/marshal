/**
 * Typed accessor for GatewaySessionBackend internal syncState maps in tests.
 *
 * The four accessors `setSessionKey` / `getSessionKey` / `deleteSessionKey` /
 * `getSessionIdBySessionKey` were removed from the public class surface once
 * production call sites all went through either `ISessionBackend` symmetric
 * methods or direct `syncState` access inside the module. Tests still need
 * to seed and inspect the maps — funnel that through this helper so only one
 * file bypasses the encapsulation.
 */
import type { GatewaySessionBackend } from "../backend/gateway/session";
import type { GatewaySyncState } from "../backend/gateway/session-sync";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion */

type AnyGatewaySessionBackend = any;

export class GatewayBackendTestAccess {
  private readonly backend: AnyGatewaySessionBackend;

  constructor(backend: GatewaySessionBackend) {
    this.backend = backend as AnyGatewaySessionBackend;
  }

  get syncState(): GatewaySyncState {
    return this.backend.syncState;
  }

  /** Seed a session's sessionKey (routing token). For tests that need to
   *  exercise send/destroy/abort without driving a full create() flow. */
  setSessionKey(sessionId: string, sessionKey: string): void {
    this.syncState.sessionKeys.set(sessionId, sessionKey);
    this.syncState.localIdBySessionKey.set(sessionKey, sessionId);
  }

  /** Seed all three sync maps for a session. Use when the test also needs
   *  backendId (cloud sessionId) to be present, e.g. when asserting
   *  forgetSession clears every map. */
  seedSession(sessionId: string, sessionKey: string, backendId: string): void {
    this.syncState.sessionKeys.set(sessionId, sessionKey);
    this.syncState.localIdBySessionKey.set(sessionKey, sessionId);
    this.syncState.backendIds.set(sessionId, backendId);
  }

  getSessionKey(sessionId: string): string | undefined {
    return this.syncState.sessionKeys.get(sessionId);
  }

  getBackendId(sessionId: string): string | undefined {
    return this.syncState.backendIds.get(sessionId);
  }

  getActiveLocalRunId(sessionId: string): string | undefined {
    return this.backend.activeLocalRunBySession.get(sessionId) as string | undefined;
  }
}

/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion */
