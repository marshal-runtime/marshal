// Secret redaction for acceptance receipts. No receipt, screenshot, or log
// produced by this facility may carry a token, cookie, password, or email —
// see repo CLAUDE.md "Never log customer content" and the D4 objective's "no
// secrets in any receipt/screenshot/log".
const SECRET_KEY_PATTERN =
  /token|secret|password|passwd|authorization|cookie|apikey|api_key|credential|bearer|refresh|sessionkey|privatekey/i;
const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._-]+/g;
const GITHUB_TOKEN_PATTERN = /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g;
const GENERIC_LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{32,}\b/g;

const REDACTED = "[REDACTED]";

/** Redacts a single string value's known secret shapes. Never returns the raw input untouched if it matched a pattern. */
export function redactString(value) {
  if (typeof value !== "string") return value;
  let next = value;
  next = next.replace(EMAIL_PATTERN, REDACTED);
  next = next.replace(BEARER_PATTERN, `Bearer ${REDACTED}`);
  next = next.replace(GITHUB_TOKEN_PATTERN, REDACTED);
  next = next.replace(GENERIC_LONG_TOKEN_PATTERN, (candidate) =>
    /^[0-9]+$/.test(candidate) ? candidate : REDACTED,
  );
  return next;
}

/**
 * Deep-clones `value`, replacing any object property whose key looks
 * secret-shaped (token/secret/password/...) with `[REDACTED]`, and running
 * every remaining string leaf through {@link redactString}. Arrays and plain
 * objects are recursed into; other value types pass through unchanged.
 */
export function redactSecrets(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, seen));
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactSecrets(entry, seen);
  }
  return result;
}

export function assertNoSecretsLeaked(value) {
  const serialized = JSON.stringify(redactSecrets(value));
  if (EMAIL_PATTERN.test(serialized) || GITHUB_TOKEN_PATTERN.test(serialized)) {
    throw new Error("Redacted payload still contains a secret-shaped value.");
  }
  return true;
}
