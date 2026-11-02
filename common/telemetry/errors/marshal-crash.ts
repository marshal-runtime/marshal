import type { MidgardError, TelemetryCallbacks } from "../types";
import { defineFamily } from "./marshal-define-family";

// Persisted local telemetry family name; keep stable for historical log analysis.
const family = defineFamily("marshal-crash");

// APPEND-ONLY. Existing enum values are stable persisted codes. Never reorder,
// renumber, or delete members; renaming is safe because the numeric code stays.
export enum crashErrors {
  REACT_ERROR_BOUNDARY,
  /** @deprecated Kept for persisted-code compatibility. New emits should use UNCAUGHT_EXCEPTION or UNHANDLED_REJECTION. */
  MAIN_PROCESS_CRASH,
  UNCAUGHT_EXCEPTION,
  UNHANDLED_REJECTION,
  /** `app.getPath("documents")` threw or the Documents folder failed write-probe.
   * Counts unique startups that landed on the app-data workspace fallback. */
  WORKSPACE_FALLBACK_USED,
}

export function makeCrashError(code: crashErrors): MidgardError {
  return { family, code };
}

export function registerCrashErrors(callbacks: TelemetryCallbacks): void {
  callbacks.registerErrors(family, crashErrors);
}
