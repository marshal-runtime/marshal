// Ownership: shared diagnostic value sanitization.

/**
 * PII sanitization for diagnostic data.
 *
 * Shared by the diagnostic logger (main process) and the diagnostics IPC
 * handlers. Extracted into its own module to avoid circular imports.
 */

import * as os from "os";

/** Coerce unknown value to a plain string for telemetry */
function coerceToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

/** Replace current user's home directory paths with ~ (handles native, forward-slash, and JSON-escaped variants) */
function redactHomePaths(text: string): string {
  const homeDir = os.homedir();
  if (!homeDir) return text;
  let result = text;
  result = result.replaceAll(homeDir, "~");
  const forwardSlash = homeDir.replaceAll("\\", "/");
  if (forwardSlash !== homeDir) result = result.replaceAll(forwardSlash, "~");
  const jsonEscaped = homeDir.replaceAll("\\", "\\\\");
  if (jsonEscaped !== homeDir) result = result.replaceAll(jsonEscaped, "~");
  return result;
}

/** Redact any user profile path, not just the current user's home dir */
function redactUserPaths(text: string): string {
  return (
    text
      // macOS/Linux: /Users/<name>/ or /home/<name>/
      .replace(/\/(?:Users|home)\/[^\s/\\)]+/gi, "~")
      // Windows: C:\Users\<name>\ — single or double backslash, forward-slash, case-insensitive
      .replace(/[A-Za-z]:[/\\]{1,2}[Uu]sers[/\\]{1,2}[^\s/\\)]+/g, "~")
  );
}

/** Redact email addresses */
function redactEmails(text: string): string {
  return text.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "<email>");
}

/** Redact bearer tokens, access tokens, and other secret patterns */
function redactSecrets(text: string): string {
  return (
    text
      // Authorization headers (case-insensitive)
      .replace(
        /(?:authorization|x-api-key)\s*[:=]\s*(?:bearer|token|apikey)?\s*[A-Za-z0-9\-._~+/]+=*/gi,
        "<auth-redacted>",
      )
      // Common secret query/body params
      .replace(
        /(access_token|refresh_token|client_secret|sig|signature|token|api_key|apikey|AccountKey|SharedAccessSignature)=([^\s&"']+)/gi,
        "$1=<redacted>",
      )
      // JSON-style secret fields: "access_token":"..."
      .replace(
        /"(access_token|refresh_token|client_secret|api_key|apikey|AccountKey)"\s*:\s*"[^"]+"/gi,
        '"$1":"<redacted>"',
      )
      // util.inspect-style secret fields: access_token: '...'
      .replace(
        /\b(access_token|refresh_token|client_secret|api_key|apikey|AccountKey)\s*:\s*'(?:\\'|[^'])*'/gi,
        "$1: '<redacted>'",
      )
      // JWT-like tokens (3 base64url segments)
      .replace(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<jwt-redacted>")
  );
}

/** Truncate to a max length to prevent oversized payloads */
function truncate(text: string, maxLength = 4096): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "…[truncated]";
}

/** Strip PII from error data: coerce to string, redact paths and emails, truncate */
export function sanitizeForTelemetry(value: unknown): string {
  const text = coerceToString(value);
  if (!text || text === "[unserializable]") return text;
  return [redactHomePaths, redactUserPaths, redactEmails, redactSecrets, truncate].reduce(
    (result, fn) => fn(result),
    text,
  );
}

/**
 * Same redactors as `sanitizeForTelemetry`, **without** the 4096-char cap.
 * Use for content that will be displayed to a human or posted to a system
 * that doesn't want mid-sentence truncation (e.g. GitHub issue bodies).
 */
export function redactForDisplay(value: unknown): string {
  const text = coerceToString(value);
  if (!text || text === "[unserializable]") return text;
  return [redactHomePaths, redactUserPaths, redactEmails, redactSecrets].reduce(
    (result, fn) => fn(result),
    text,
  );
}
