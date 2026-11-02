import { crashErrors, makeCrashError } from "../common/telemetry/errors/marshal-crash";
import type { WorkspaceResolution } from "./app-paths";
import { sendErrorTelemetry } from "./telemetry-errors";

let workspaceFallbackEmitted = false;

/**
 * Emit `WORKSPACE_FALLBACK_USED` once if the workspace resolved into the
 * app-data fallback. Wired from `main.ts`'s `whenReady` callback so the call
 * runs after `setTelemetryWindow(win)` has attached the renderer bridge —
 * firing before that point silently drops the event.
 *
 * The module-level latch is defense in depth: structurally the call site
 * already runs once per process, but a future contributor wiring this into
 * a re-running path (e.g. `app.on("activate")`) would otherwise produce a
 * duplicate emit on every macOS dock re-open.
 */
export function emitWorkspaceFallbackTelemetryIfNeeded(resolution: WorkspaceResolution): void {
  if (!resolution.usedFallback || workspaceFallbackEmitted) return;
  workspaceFallbackEmitted = true;
  sendErrorTelemetry(makeCrashError(crashErrors.WORKSPACE_FALLBACK_USED));
}

/** Test-only: reset the one-shot latch between cases. */
export function resetStartupTelemetryForTests(): void {
  workspaceFallbackEmitted = false;
}
