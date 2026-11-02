import type { MidgardError, TelemetryCallbacks } from "../types";
import { defineFamily } from "./marshal-define-family";

// Persisted local telemetry family name; keep stable for historical log analysis.
const family = defineFamily("marshal-auth");

// APPEND-ONLY. Existing enum values are stable persisted codes. Never reorder,
// renumber, or delete members; renaming is safe because the numeric code stays.
export enum authErrors {
  AUTH_SILENT_ACQUIRE_FAILED,
  AUTH_INTERACTIVE_ACQUIRE_FAILED,
  TOKEN_CACHE_READ_FAILED,
  TOKEN_CACHE_WRITE_FAILED,
  GITHUB_TOKEN_FAILED,
  GATEWAY_DEVICE_IDENTITY_FAILED,
  /**
   * OAuth deep-link callback never arrived. Covers both flow cancellation
   * (user closes browser / hits back) and timeout — the loopback auth client
   * doesn't expose a cancel reason, so the two are indistinguishable at this
   * layer.
   *
   * This is not necessarily a hard failure: user cancellation is expected UX.
   * Local analysis should separate this code from infrastructure failures.
   */
  AUTH_FLOW_CANCELLED_OR_TIMEOUT,
  /**
   * macOS broker failed with an infrastructure error (Keychain entitlement,
   * SSO extension rejection) and the app fell back to deep-link browser auth.
   * Fires once per session, not per call.
   */
  BROKER_FALLBACK_TO_DEEP_LINK,
}

export function makeAuthError(code: authErrors): MidgardError {
  return { family, code };
}

export function registerAuthErrors(callbacks: TelemetryCallbacks): void {
  callbacks.registerErrors(family, authErrors);
}
