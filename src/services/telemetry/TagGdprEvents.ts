import type { MidgardError } from "@common/telemetry/types";

import {
  neverGuardDefault,
  type EventType,
  type TelemetryEvent,
  type TelemetryEventMiddleware,
} from "./opensource";

// SessionStart, SessionEnd, and UserAction events must be included in GDPR
// export requests so users can retrieve their activity data on request.
//
// Marshal.Fetch (LlmTokenUsage) is intentionally NOT GDPR-exportable:
// it is system-generated operational telemetry (token counts, cost, model),
// not a user-initiated action. The userId field is used for aggregation
// and cost attribution, not to surface user activity to the data subject.
const gdprExportEvents = [
  "Marshal.SessionStart",
  "Marshal.SessionEnd",
  "Marshal.UserAction",
] as const;
type GdprExportEvent = (typeof gdprExportEvents)[number];

export const TagGdprEvents: TelemetryEventMiddleware = (event: TelemetryEvent): TelemetryEvent => {
  if (!requiresGdprExport(event.eventType)) {
    return event;
  }

  return {
    ...event,
    tags: {
      ...event.tags,
      isGdprExportable: true,
      gdprExportActionName: getGdprExportActionName(event),
      gdprExportTargetName: getGdprExportTargetName(event),
    },
  };
};

function getGdprExportActionName(event: TelemetryEvent): string | undefined {
  const eventType = event.eventType;
  if (requiresGdprExport(eventType)) {
    switch (eventType) {
      case "Marshal.SessionStart":
        return "OpenedMarshal";
      case "Marshal.SessionEnd":
        return "ClosedMarshal";
      case "Marshal.UserAction":
        return fieldValueString(event.fields.action);
      default:
        return neverGuardDefault(eventType, undefined);
    }
  }
  return undefined;
}

function getGdprExportTargetName(event: TelemetryEvent): string | undefined {
  const eventType = event.eventType;
  if (requiresGdprExport(eventType)) {
    switch (eventType) {
      case "Marshal.SessionStart":
      case "Marshal.SessionEnd":
        return undefined;
      case "Marshal.UserAction":
        return fieldValueString(event.fields.moduleName);
      default:
        return neverGuardDefault(eventType, undefined);
    }
  }
  return undefined;
}

function requiresGdprExport(eventType: EventType): eventType is GdprExportEvent {
  return (gdprExportEvents as readonly EventType[]).indexOf(eventType) !== -1;
}

function fieldValueString(
  fieldValue: string | string[] | number | boolean | MidgardError | undefined,
): string | undefined {
  switch (typeof fieldValue) {
    case "string":
      return fieldValue;
    case "number":
    case "boolean":
      return fieldValue.toString();
    default:
      return undefined;
  }
}
