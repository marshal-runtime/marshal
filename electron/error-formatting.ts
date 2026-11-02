/**
 * Format raw SDK/network error strings into user-friendly messages.
 * Raw errors are preserved for internal consumers (auth detection, sendAndCollect).
 * This function is used only for the user-visible chat bubble text.
 */

const BAD_ATTACHMENT_UPLOAD_PATTERN =
  /CAPIError:\s*400\b[\s\S]*file you uploaded[\s\S]*badly formatted or corrupted/i;

const ERROR_PATTERNS: [RegExp, string][] = [
  [
    BAD_ATTACHMENT_UPLOAD_PATTERN,
    "One of the attached files couldn't be read by the AI service. Remove or re-save the file, then try again.",
  ],
  [/\b499\b|\b504\b|client.*(closed|disconnect)/i, "The AI service timed out. Please try again."],
  [
    /\b429\b|rate.?limit|too many requests/i,
    "Too many requests. Please wait a moment and try again.",
  ],
  [
    /\b5\d{2}\b|server error|internal error|service unavailable/i,
    "The AI service is temporarily unavailable. Please try again in a moment.",
  ],
  [/timed?\s*out|timeout|ETIMEDOUT|ECONNABORTED/i, "The request timed out. Please try again."],
  [
    /ECONNREFUSED|ENOTFOUND|network|offline/i,
    "Unable to connect. Please check your internet connection.",
  ],
];

/** Auth-related patterns — these should pass through unchanged so the
 *  existing auth banner/callback handling can detect and act on them. */
const AUTH_PATTERN = /\b40[13]\b|unauthorized|forbidden|token.*expired/i;

/** Runtime adapters already phrase these for the user, including where to act. */
const RUNTIME_GUIDANCE_PATTERN =
  /Sign in under Settings|usage limit reached|Send your message again to reconnect/i;

export function isBadAttachmentUploadError(rawError: unknown): boolean {
  return BAD_ATTACHMENT_UPLOAD_PATTERN.test(String(rawError));
}

export function formatUserFacingError(rawError: string): string {
  if (!rawError) return "Something went wrong. Please try again.";

  // Let auth errors pass through — they're handled by the auth banner
  if (AUTH_PATTERN.test(rawError)) return rawError;
  if (RUNTIME_GUIDANCE_PATTERN.test(rawError)) return rawError;

  for (const [pattern, friendly] of ERROR_PATTERNS) {
    if (pattern.test(rawError)) return friendly;
  }

  const providerMessage = readProviderErrorMessage(rawError);
  if (providerMessage) return `The AI service rejected the request: ${providerMessage}`;

  return "Something went wrong. Please try again.";
}

const PROVIDER_MESSAGE_MAX_LENGTH = 300;

/**
 * The human-readable message of a provider error body embedded in the raw
 * error (`{"error":{"message":…}}`, the OpenAI and Anthropic shape), so an
 * actionable rejection such as an unsupported model is not reduced to the
 * generic fallback.
 */
function readProviderErrorMessage(rawError: string): string | null {
  const start = rawError.indexOf("{");
  if (start < 0) return null;
  let body: unknown;
  try {
    body = JSON.parse(rawError.slice(start)) as unknown;
  } catch {
    return null;
  }
  const nested = isRecord(body) && isRecord(body["error"]) ? body["error"]["message"] : undefined;
  const message = typeof nested === "string" ? nested.trim() : "";
  if (!message) return null;
  return message.length > PROVIDER_MESSAGE_MAX_LENGTH
    ? `${message.slice(0, PROVIDER_MESSAGE_MAX_LENGTH)}…`
    : message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coerce an unknown thrown/emitted error value into a stable, bounded string.
 * Preserves the human-readable message so downstream pattern-matching (auth
 * detection, {@link formatUserFacingError}) and logs keep working, and never
 * yields the useless "[object Object]" for error objects. Bounded so a large
 * SDK/network error object can't flood logs or the UI.
 */
export function coerceErrorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || error.name || "Error";
  if (error && typeof error === "object") {
    const read = (key: string): unknown => {
      try {
        return Reflect.get(error, key);
      } catch {
        // Hostile proxy / throwing getter — treat as absent.
        return undefined;
      }
    };
    const message = read("message");
    if (typeof message === "string" && message.length > 0) return message;
    const fields = ["code", "status", "statusCode", "reason"]
      .map((k) => {
        const v = read(k);
        return typeof v === "string" || typeof v === "number" ? `${k}=${v}` : null;
      })
      .filter((p): p is string => p !== null);
    if (fields.length > 0) return fields.join(" ");
    try {
      const json = JSON.stringify(error);
      if (json && json !== "{}") return json.length > 500 ? `${json.slice(0, 500)}…` : json;
    } catch {
      // Circular / unserializable — fall through to the generic label.
    }
    return "Unknown error";
  }
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }
  return "Unknown error";
}
