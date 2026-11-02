import { createLogger } from "../../common/marshal-logger";

const log = createLogger("IpcLimits");
const sf4Log = log.child("SF-4");

/**
 * SF-4 IPC payload size limits (defense-in-depth).
 *
 * NOTE: These checks run after Electron has already deserialized the
 * structured-clone payload into JS memory. They prevent further
 * amplification (base64→Buffer, JSON.parse→objects, disk writes)
 * but cannot prevent the initial IPC memory allocation.
 */
export const IPC_LIMITS = {
  /** Max base64 image payload (~15 MB decoded). */
  IMAGE_BASE64_BYTES: 20 * 1024 * 1024,
  /** Max JSON string payload for imports. */
  JSON_IMPORT_BYTES: 5 * 1024 * 1024,
  /** Max file content for workspace writes. */
  FILE_CONTENT_BYTES: 10 * 1024 * 1024,
  /** Max text message (copilot:send, relay). */
  TEXT_MESSAGE_BYTES: 1 * 1024 * 1024,
  /** Max serialized telemetry event accepted for local telemetry filtering. */
  TELEMETRY_EVENT_BYTES: 64 * 1024,
  /** Max array length for batch operations. */
  ARRAY_MAX_LENGTH: 10_000,
  /** Max messages per save-messages call. */
  MESSAGES_MAX_LENGTH: 5_000,
  /** Allowed image MIME types for copilot:saveImage. */
  ALLOWED_IMAGE_MIMES: new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
    // HEIC/HEIF: only convertible on macOS (via sips). The copilot:saveImage
    // handler rejects these on other platforms with a clear error.
    "image/heic",
    "image/heif",
  ]),
} as const;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/**
 * Returns an error result if the string exceeds the limit, or null if within bounds.
 * Uses value.length (not Buffer.byteLength) — for base64 this is exact,
 * for UTF-8 it's a conservative lower bound (worst case: 2x under-count —
 * a surrogate pair is 2 UTF-16 code units → 4 UTF-8 bytes). Good enough for
 * defense-in-depth.
 */
export function checkStringSize(
  value: string,
  limit: number,
  label: string,
): { success: false; error: string } | null {
  if (value.length > limit) {
    const humanLimit = formatBytes(limit);
    sf4Log.warn(`${label} rejected: ${value.length} chars exceeds ${humanLimit} limit`);
    return { success: false, error: `${label} exceeds ${humanLimit} limit` };
  }
  return null;
}

/**
 * Returns an error result if the array exceeds the length limit, or null if within bounds.
 */
export function checkArrayLength(
  arr: unknown[],
  limit: number,
  label: string,
): { success: false; error: string } | null {
  if (arr.length > limit) {
    sf4Log.warn(`${label} rejected: ${arr.length} items exceeds ${limit} limit`);
    return { success: false, error: `${label}: ${arr.length} items exceeds ${limit} limit` };
  }
  return null;
}
