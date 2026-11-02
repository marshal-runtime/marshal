import type { SinkSetup } from "./makeTelemetrySinkManagers";
import type { TelemetryEvent, TelemetrySinkManager } from "./opensource";

/**
 * Finds the first UserAction event matching the given action name and full telemetry path.
 * `fullPath` is the concatenation of `path` (ancestors) and `moduleName` (current component),
 * e.g. "/App/Nav".
 */
export function findUserAction(
  events: TelemetryEvent[],
  action: string,
  fullPath: string,
): TelemetryEvent | undefined {
  return events.find(
    (e) =>
      e.eventType === "Marshal.UserAction" &&
      (e.fields as Record<string, unknown>).action === action &&
      `${String((e.fields as Record<string, unknown>).path)}/${String((e.fields as Record<string, unknown>).moduleName)}` ===
        fullPath,
  );
}

/**
 * Counts the number of UserAction events matching the given action name and full telemetry path.
 * `fullPath` is the concatenation of `path` (ancestors) and `moduleName` (current component),
 * e.g. "/App/Nav". Use this (not `findUserAction`) when the assertion is about
 * the exact count — for example pinning a double-fire regression.
 */
export function countUserActions(
  events: TelemetryEvent[],
  action: string,
  fullPath: string,
): number {
  return events.filter(
    (e) =>
      e.eventType === "Marshal.UserAction" &&
      (e.fields as Record<string, unknown>).action === action &&
      `${String((e.fields as Record<string, unknown>).path)}/${String((e.fields as Record<string, unknown>).moduleName)}` ===
        fullPath,
  ).length;
}

/** Returns a TelemetrySinkManager that pushes all events into `events`. */
export function createCaptureSink(): {
  sinkManager: TelemetrySinkManager;
  events: TelemetryEvent[];
} {
  const events: TelemetryEvent[] = [];
  return {
    events,
    sinkManager: {
      send: (event) => events.push(event),
      hasNoSink: () => false,
      setSink: () => {},
    },
  };
}

/**
 * Builds the `SinkSetup` that a mocked `makeTelemetrySinkManagers` returns.
 * Centralizing the shape here means a future change to `SinkSetup` is a single
 * edit, not a sweep across every `*.telemetry.test` file.
 * Read `sinkManager` lazily inside the `vi.mock` factory's inner function so the
 * hoisted factory doesn't touch it before the top-level binding initializes.
 */
export function sinkSetup(sinkManager: TelemetrySinkManager): SinkSetup {
  return { sinkManagers: [sinkManager] };
}
