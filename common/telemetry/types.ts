export type ErrorFamily = string;

export interface MidgardError {
  family: ErrorFamily;
  code: number;
}

export type EventType =
  | "Marshal.SessionStart"
  | "Marshal.SessionEnd"
  | "Marshal.UserAction"
  | "Marshal.Fetch"
  | "Marshal.FetchDebug"
  | "Marshal.Render"
  | "Marshal.Error"
  | "Marshal.ErrorDebug";

export type TelemetryFieldValue = string | string[] | number | boolean | MidgardError | undefined;

export interface TelemetryEvent {
  eventType: EventType;
  fields: Record<string, TelemetryFieldValue>;
  tags?: Partial<{
    isGdprExportable: boolean;
    gdprExportActionName: string;
    gdprExportTargetName: string;
    diagnosticLevel: number;
  }>;
}

export type TelemetryEventMiddleware = (event: TelemetryEvent) => TelemetryEvent;

export interface TelemetrySink {
  send(event: TelemetryEvent): void;
}

export interface TelemetrySinkManager {
  send(event: TelemetryEvent): void;
  hasNoSink(): boolean;
  setSink(sink: TelemetrySink): void;
}

type TelemetryFields = Record<string, TelemetryFieldValue>;

export interface TelemetryCallbacks {
  logSessionStartEvent(fields: TelemetryFields): void;
  logSessionEndEvent(fields: TelemetryFields): void;
  logUserActionEvent(fields: TelemetryFields): void;
  logFetchEvent(fields: TelemetryFields): void;
  logFetchDebugEvent(fields: TelemetryFields): void;
  logRenderEvent(fields: TelemetryFields): void;
  logErrorEvent(fields: TelemetryFields): void;
  logErrorDebugEvent(fields: TelemetryFields): void;
  registerErrors(family: ErrorFamily, errors: Record<string | number, string | number>): void;
  lookupError(error: MidgardError): [string, number | undefined, string];
  errorMap: Record<string, Record<number, string>>;
}
