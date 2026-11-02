import type { MidgardError, TelemetryCallbacks } from "../types";
import { defineFamily } from "./marshal-define-family";

// Persisted local telemetry family name; keep stable for historical log analysis.
const family = defineFamily("marshal-session");

// APPEND-ONLY. Existing enum values are stable persisted codes. Never reorder,
// renumber, or delete members; renaming is safe because the numeric code stays.
export enum sessionErrors {
  SESSION_INIT_FAILED,
  SESSION_LOAD_FAILED,
  SESSION_PERSIST_FAILED,
  SESSION_INDEX_CORRUPT,
  TURN_SEND_FAILED,
  /** Session received no backend events for STUCK_TIMEOUT_MS (30s). Fires
   * from the BusySessionTracker stuck callback — covers any reason for
   * idle-while-busy (hung MCP tool, paused session, pending tool-approval
   * dialog, dropped turn-event stream), not only true turn timeouts.
   * Renamed from TURN_TIMEOUT for accuracy; persisted code stays at 5. */
  SESSION_STUCK,
  SESSION_RESTORE_FAILED,
  /** One-shot inference (`backend.infer`) failed. Covers every internal
   * non-conversational LLM call: title generation, context summarization,
   * shell-command classification.
   * Most commonly a timeout (the SDK's `sendAndWait` exceeded `opts.timeoutMs`)
   * but also fires on auth/init failures. Generic by design — the SDK does
   * not expose a typed timeout error, so sniffing message strings would be
   * fragile. Emitted inside the backend providers so every caller is covered
   * automatically (mirrors the SESSION_PERSIST_FAILED pattern). */
  INFER_FAILED,
}

export function makeSessionError(code: sessionErrors): MidgardError {
  return { family, code };
}

export function registerSessionErrors(callbacks: TelemetryCallbacks): void {
  callbacks.registerErrors(family, sessionErrors);
}
