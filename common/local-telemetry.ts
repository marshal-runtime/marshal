export interface LocalTelemetryEventPayload {
  eventType: string;
  fields: Record<string, unknown>;
  tags?: Record<string, unknown>;
}

interface LocalTelemetryDeleteCounts {
  deletedFiles: number;
  deletedBytes: number;
  remainingFiles: number;
  remainingBytes: number;
  failedFiles: number;
}

export type LocalTelemetryDeleteResult =
  | (LocalTelemetryDeleteCounts & { success: true })
  | (LocalTelemetryDeleteCounts & { success: false; error: string });
