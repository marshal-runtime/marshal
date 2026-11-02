import type { LogEntry, TelemetryEvent } from "../common/marshal-logger";
import { addLogSink, createLogger } from "../common/marshal-logger";
import type { MidgardError } from "../common/telemetry/types";

/**
 * Subset of `BrowserWindow` that this module actually uses. Defining a
 * structural interface (instead of importing `BrowserWindow`) means:
 *
 * 1. Production callers pass a real `BrowserWindow` — it satisfies the shape
 *    structurally, no cast needed.
 * 2. Tests can pass a stub with just `isDestroyed()` and `webContents.send`,
 *    no `as never` / `BrowserWindow` cast.
 *
 * Narrowing to what we actually depend on is also a sound design rule on its
 * own — this module doesn't need (or want) the full `BrowserWindow` API.
 */
export interface TelemetryWindow {
  isDestroyed(): boolean;
  webContents: { send: (channel: string, payload: unknown) => void };
}

// Single-window app assumption: Marshal only ever opens one BrowserWindow.
// If multi-window support is ever added, this ref needs to become a set and
// telemetry has to pick a target (or broadcast) per-window. The renderer-side
// analogue is the module-level logger slots in error-routing.ts (same
// assumption, same fix site if this invariant ever changes).
let _win: TelemetryWindow | null = null;

export function setTelemetryWindow(win: TelemetryWindow | null): void {
  _win = win;
}

/** Already-telemetered errors. ipc-handle's catch-all checks membership
 * before firing HANDLER_UNCAUGHT so one user action doesn't produce two
 * telemetry events. A WeakSet avoids mutating caller-owned error objects (which
 * would silently suppress future emits if any caller caches/reuses errors)
 * and lets GC reclaim the entry as soon as the error is unreachable. */
const telemeteredErrors = new WeakSet();

/** True if the error has already been emitted to telemetry. */
export function hasTelemetryMarker(err: unknown): boolean {
  return typeof err === "object" && err !== null && telemeteredErrors.has(err);
}

/**
 * Mark `err` as already-telemetered without sending an event. Used by
 * call-site dedupers (e.g. `SessionManager.emitAuthErrorTelemetry`) that
 * need to suppress an emit for signal-quality reasons but still want
 * `ipc-handle`'s catch-all to skip the error so it doesn't spuriously fire
 * `HANDLER_UNCAUGHT` for what was definitively an instrumented failure.
 *
 * Safe to call before any window-availability check — marking is a pure
 * in-process operation.
 */
export function markTelemetry(err: unknown): void {
  if (err instanceof Error) {
    telemeteredErrors.add(err);
  }
}

// ── Sink architecture (Phase 1) ─────────────────────────────────────────────
//
// `sendErrorTelemetry` now delegates through `log.fault()` on the shared
// logger, which routes the entry through registered sinks. The push to the
// renderer is performed by `telemetryPushSink` registered below. Existing
// call sites are unchanged — they keep calling `sendErrorTelemetry`. Direct
// `log.fault()` migration is tracked as a follow-up issue.
//
// CRITICAL ORDERING (do not change without updating the round-2 dedup test):
// the sink does the window-availability check FIRST and only marks `cause`
// after confirming the emit went through. Marking before the check would
// suppress ipc-handle's HANDLER_UNCAUGHT fallback for pre-window-attach
// errors (zero events instead of the safety-net one).
function telemetryPushSink(entry: LogEntry): void {
  if (!entry.telemetry) return;
  if (!_win || _win.isDestroyed()) return;
  markTelemetry(entry.cause);
  _win.webContents.send("telemetry:logError", entry.telemetry);
}

addLogSink(telemetryPushSink);

// ── Telemetry event sink ────────────────────────────────────────────────────
//
// Forwards structured telemetry events (from `log.event()`) to the renderer's
// telemetry pipeline via IPC. Same single-window invariant as telemetryPushSink.
// Same pre-window-attach gap — events before `setTelemetryWindow()` are dropped.

function telemetryEventSink(entry: LogEntry): void {
  if (!entry.event) return;
  if (!_win || _win.isDestroyed()) return;
  _win.webContents.send("telemetry:logEvent", entry.event);
}

addLogSink(telemetryEventSink);

/** Export for tests to verify the sink shape. */
export type { TelemetryEvent };

const telemetryLog = createLogger("Telemetry");

/**
 * Emit a telemetry error event. Thin wrapper over `log.fault()` retained for
 * call-site continuity — every existing emit site uses this name. Phase 2
 * of the sink refactor will migrate these to direct `log.fault()` calls.
 *
 * TODO(#follow-up): errors thrown between app bootstrap and
 * `setTelemetryWindow(win)` are silently dropped. On-disk pending-errors
 * queue flushed next launch would capture them reliably.
 */
export function sendErrorTelemetry(error: MidgardError, cause?: unknown): void {
  telemetryLog.fault(error, cause);
}
