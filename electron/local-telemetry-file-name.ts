export const LOCAL_TELEMETRY_INDEX_MAX = Number.MAX_SAFE_INTEGER;

const TELEMETRY_FILE_RE = /^events-(\d{4}-\d{2}-\d{2})-(\d+)\.jsonl$/;

export interface LocalTelemetryFileName {
  date: string;
  index: number;
}

export function formatLocalTelemetryFileName(date: string, index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index > LOCAL_TELEMETRY_INDEX_MAX) {
    throw new Error("telemetry_file_index_exhausted");
  }
  return `events-${date}-${String(index).padStart(3, "0")}.jsonl`;
}

export function parseLocalTelemetryFileName(name: string): LocalTelemetryFileName | null {
  const match = name.match(TELEMETRY_FILE_RE);
  if (!match) return null;
  const index = Number(match[2]);
  if (!Number.isSafeInteger(index) || index < 0 || index > LOCAL_TELEMETRY_INDEX_MAX) {
    return null;
  }
  if (formatLocalTelemetryFileName(match[1], index) !== name) return null;
  return { date: match[1], index };
}

export function looksLikeLocalTelemetryFile(name: string): boolean {
  return name.startsWith("events-") && name.endsWith(".jsonl");
}
