import type { MidgardError } from "@common/telemetry/types";

type ErrorLogger = (error: MidgardError) => void;

// Module-level slots paired with the single-window assumption in
// electron/telemetry-errors.ts (_win). If multi-window is introduced, key these
// by window. The in-session logger (set by TelemetryErrorBridge inside
// SessionScope) carries sessionCorrelationId; the out-of-session logger (set by
// TelemetryErrorRouter) emits via logErrorEventOutsideAppSession with none.
let inSessionLogError: ErrorLogger | null = null;
let outOfSessionLogError: ErrorLogger | null = null;

export function setInSessionErrorLogger(fn: ErrorLogger | null): void {
  inSessionLogError = fn;
}

export function setOutOfSessionErrorLogger(fn: ErrorLogger | null): void {
  outOfSessionLogError = fn;
}

/** Routes an error to the in-session logger when a session is active, else the
 *  out-of-session logger. No-op until at least one logger registers. */
export function routeError(error: MidgardError): void {
  (inSessionLogError ?? outOfSessionLogError)?.(error);
}

/** Called by ErrorBoundary, which sits above the provider tree. Routes the same
 *  way as routeError so crashes are reported in- or out-of-session. */
export function logErrorForCrash(error: MidgardError): void {
  routeError(error);
}
