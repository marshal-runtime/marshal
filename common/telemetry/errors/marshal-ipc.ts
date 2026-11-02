import type { MidgardError, TelemetryCallbacks } from "../types";
import { defineFamily } from "./marshal-define-family";

// Persisted local telemetry family name; keep stable for historical log analysis.
const family = defineFamily("marshal-ipc");

// APPEND-ONLY. Existing enum values are stable persisted codes. Never reorder,
// renumber, or delete members; renaming is safe because the numeric code stays.
export enum ipcErrors {
  HANDLER_UNCAUGHT,
  UNAUTHORIZED_SENDER,
}

export function makeIpcError(code: ipcErrors): MidgardError {
  return { family, code };
}

export function registerIpcErrors(callbacks: TelemetryCallbacks): void {
  callbacks.registerErrors(family, ipcErrors);
}
