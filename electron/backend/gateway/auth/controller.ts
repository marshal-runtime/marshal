/**
 * Gateway auth controller. Three seams: `backend` (abstract, so main.ts
 * doesn't downcast), `store` (cred load/save/clear), `broadcaster` (state
 * push to the renderer). IPC handlers live in `handlers.ts`.
 *
 * Lives under `electron/backend/gateway/auth/` rather than `electron/ipc/` to
 * avoid a backend → ipc layer inversion via `GatewayBackend.attachAuthMachinery`.
 */

import type { GatewayAuthIdentity, GatewayAuthState } from "../../../../common/marshal-ipc-contract";
import { GATEWAY_AUTH_MODES } from "../../../../common/marshal-ipc-contract";
import { createLogger } from "../../../../common/marshal-logger";
import type { ControllerDeps, GatewayAuthController } from "./contracts";
import { PairingCancelledError } from "./pairing-cancelled-error";

const log = createLogger("GatewayAuthController");

// Sentinel matched by useLocalDeviceApprovals to mean "no panel"; any other
// error is treated as a transient network failure.
export const NOT_SUPPORTED_NON_LOCAL = "not-supported-non-local";

export function createGatewayAuthController(deps: ControllerDeps): GatewayAuthController {
  const { backend, store, broadcaster, onSignOut, onSignedIn } = deps;

  let state: GatewayAuthState = { status: "picking" };
  /** Carried onto the pairing-status push so the dialog can show which mode
   *  the user is waiting on. */
  let pendingIdentity: GatewayAuthIdentity | null = null;

  function setState(next: GatewayAuthState): void {
    state = next;
    broadcaster(next);
  }

  // Lift the backend's pairing-wait push into a state transition so the
  // renderer goes connecting → pairing with the requestId visible.
  backend.setPairingStatusCallback((requestId) => {
    setState({
      status: "pairing",
      identity: pendingIdentity ?? undefined,
      pairingRequestId: requestId,
    });
  });

  return {
    getState() {
      return state;
    },

    async signIn(cred) {
      // TODO: emit `auth.gateway-signin` audit-log entry.
      if (!GATEWAY_AUTH_MODES.includes(cred.mode)) {
        return { success: false, error: `Unknown auth mode: ${cred.mode}` };
      }
      pendingIdentity = cred;
      setState({ status: "connecting", identity: cred });
      try {
        await backend.login(cred);
        // Persist AFTER connect — a bad saved cred would otherwise loop on
        // every launch with no way for the user to clear it.
        store.save(cred);
        setState({ status: "signed-in", identity: cred });
        if (onSignedIn) {
          try {
            await onSignedIn(cred);
          } catch (hookErr) {
            // Hook failures don't roll back the operator sign-in — the user
            // is genuinely signed in even if the node side failed to start.
            // The renderer will show the operator-side success; node-side
            // errors surface in the Gateway Node Settings tab when present.
            log.warn("onSignedIn hook threw:", hookErr);
          }
        }
        return { success: true };
      } catch (err) {
        // Typed check (not err.message) so a backend wording change can't
        // silently route a user-cancel to the error-alert path.
        if (err instanceof PairingCancelledError) {
          setState({ status: "picking" });
          return { success: false, error: err.message };
        }
        log.error(`signIn failed mode=${cred.mode}:`, err);
        const rawMessage = err instanceof Error ? err.message : String(err);
        // AggregateError (happy-eyeballs ECONNREFUSED) leaves .message empty.
        const message =
          rawMessage.trim() || `Sign-in failed (${err instanceof Error ? err.name : "no message"})`;
        setState({ status: "error", identity: cred, error: message });
        return { success: false, error: message };
      } finally {
        pendingIdentity = null;
      }
    },

    async signOut() {
      // TODO: emit `auth.gateway-signout` audit-log entry.
      // Flip UI state FIRST — a slow/throwing backend teardown must not
      // leave the renderer stuck on "signed-in" with the cred already cleared.
      setState({ status: "picking" });
      store.clear();
      let result: { success: boolean; error?: string };
      try {
        await backend.signOut();
        result = { success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("backend.signOut threw:", message);
        result = { success: false, error: message };
      }
      // Always run the hook even if backend.signOut failed — stale handles
      // would otherwise short-circuit the next sign-in's createBackendSession.
      if (onSignOut) {
        try {
          await onSignOut();
        } catch (err) {
          log.warn("onSignOut hook threw:", err);
        }
      }
      return result;
    },

    setReconnecting(reconnecting) {
      // Only meaningful while signed-in — during connecting / pairing /
      // error / picking the UI already conveys connection state via
      // ``status`` and we don't want a stale "reconnecting" banner
      // bleeding through onto the picker.
      if (state.status !== "signed-in") return;
      const current = state.reconnecting ?? false;
      if (current === reconnecting) return; // de-bounce idempotent calls
      setState({ ...state, reconnecting });
    },

    async cancelPairing() {
      // No setState here — the in-flight signIn()'s catch will observe
      // PairingCancelledError and flip state to "picking" itself. Calling
      // setState too would race the two transitions.
      backend.cancelPairing();
      return { success: true };
    },

    async tryAutoSignIn() {
      const saved = store.load();
      if (!saved) return;
      pendingIdentity = saved;
      setState({ status: "connecting", identity: saved });
      try {
        await backend.login(saved);
        setState({ status: "signed-in", identity: saved });
        if (onSignedIn) {
          try {
            await onSignedIn(saved);
          } catch (hookErr) {
            log.warn("onSignedIn hook threw on auto-sign-in:", hookErr);
          }
        }
      } catch (err) {
        // Mirror signIn(): a launch-time Cancel returns to the picker silently.
        if (err instanceof PairingCancelledError) {
          setState({ status: "picking" });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: "error", identity: saved, error: message });
      } finally {
        pendingIdentity = null;
      }
    },

    async listPendingDevices() {
      if (!backend.isLocalGateway()) {
        return { success: false, error: NOT_SUPPORTED_NON_LOCAL };
      }
      try {
        const result = await backend.listPendingDevices();
        return { success: true, pending: result.pending, paired: result.paired };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("listPendingDevices failed:", message);
        return { success: false, error: message };
      }
    },

    async approveDevice(requestId) {
      if (typeof requestId !== "string" || !requestId.trim()) {
        return { success: false, error: "invalid requestId" };
      }
      if (!backend.isLocalGateway()) {
        return { success: false, error: NOT_SUPPORTED_NON_LOCAL };
      }
      try {
        await backend.approveDevice(requestId);
        // TODO: emit a `gateway-device-approve` audit-log entry once AuditLogEntry supports scope-grant rows.
        log.info(`approveDevice succeeded for requestId=${requestId}`);
        return { success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`approveDevice(${requestId}) failed:`, message);
        return { success: false, error: message };
      }
    },
  };
}
