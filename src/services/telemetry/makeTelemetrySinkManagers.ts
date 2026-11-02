import type { LocalTelemetryEventPayload } from "@common/local-telemetry";
import { TELEMETRY_HOST_APP } from "@common/marshal-constants";
import { createLogger } from "@common/marshal-logger";

import {
  makeConsoleSink,
  makeTelemetrySinkManager,
  type TelemetryEvent,
  type TelemetrySink,
  type TelemetrySinkManager,
} from "./opensource";
import {
  enqueueTelemetryWrite,
  isTelemetryFinalizing,
  resetTelemetryFinalization,
} from "./pending-writes";

const log = createLogger("Telemetry");
const IMPORTANT_LOCAL_EVENT_TYPES = new Set([
  "Marshal.Error",
  "Marshal.SessionStart",
  "Marshal.SessionEnd",
]);

type LocalTelemetryApi = Pick<NonNullable<typeof window.telemetryAPI>, "writeLocalEvent">;

export type SinkSetup = {
  sinkManagers: TelemetrySinkManager[];
};

export function shouldUseLocalSink(
  telemetryEnabled: boolean,
  telemetryApiAvailable: boolean,
): boolean {
  return telemetryEnabled && telemetryApiAvailable;
}

export const makeTelemetrySinkManagers = (telemetryEnabled: boolean): SinkSetup => {
  resetTelemetryFinalization();
  const sinkManagers: TelemetrySinkManager[] = [];
  const telemetryApi = window.telemetryAPI;

  if (telemetryApi && shouldUseLocalSink(telemetryEnabled, true)) {
    sinkManagers.push(makeLocalSinkManager(telemetryApi));
  } else if (telemetryEnabled && __IS_RELEASE_BUILD__) {
    log.warn("Local telemetry API is unavailable; telemetry events will not be stored.");
  }

  if (telemetryEnabled && !__IS_RELEASE_BUILD__) {
    sinkManagers.unshift(makeConsoleSinkManager());
  }

  return { sinkManagers };
};

const makeConsoleSinkManager = (): TelemetrySinkManager => ({
  ...makeConsoleSink(TELEMETRY_HOST_APP),
  hasNoSink: () => false,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setSink: (_: TelemetrySink) => null,
});

function toLocalPayload(event: TelemetryEvent): LocalTelemetryEventPayload {
  return {
    eventType: event.eventType,
    fields: { ...event.fields },
    ...(event.tags ? { tags: { ...event.tags } } : {}),
  };
}

export function makeLocalSinkManager(api: LocalTelemetryApi): TelemetrySinkManager {
  const manager = makeTelemetrySinkManager();
  manager.setSink({
    send: (event) => {
      if (isTelemetryFinalizing()) return;
      const payload = toLocalPayload(event);
      const important = IMPORTANT_LOCAL_EVENT_TYPES.has(event.eventType);
      const queued = enqueueTelemetryWrite(
        async () => {
          try {
            const result = await api.writeLocalEvent(payload);
            if (!result.success) {
              log.error("Local telemetry write was rejected", result.error ?? "unknown");
            }
          } catch (error) {
            log.error(
              "Local telemetry IPC write failed",
              error instanceof Error ? error.name : "unknown",
            );
          }
        },
        { important },
      );
      if (!queued.accepted) {
        log.warn("Local telemetry queue overflow; event was dropped", {
          eventType: event.eventType,
          important,
          pendingCount: queued.pendingCount,
        });
      } else if (queued.evictedBestEffort) {
        log.warn("Local telemetry queue overflow; evicted one best-effort event", {
          eventType: event.eventType,
          pendingCount: queued.pendingCount,
        });
      }
    },
  });
  return manager;
}
