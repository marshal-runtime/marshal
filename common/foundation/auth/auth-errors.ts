/**
 * Runtime-neutral turn error code for "the runtime's sign-in is missing,
 * expired, or cannot be refreshed". Adapters set it as the `session.error`
 * errorType so auth handling does not depend on the wording of the message.
 */
export const AUTH_REQUIRED_ERROR_CODE = "authentication_failed";

/** What a collector rejects with when a turn failed with {@link AUTH_REQUIRED_ERROR_CODE}. */
export class RuntimeAuthError extends Error {
  readonly name = "RuntimeAuthError";
  readonly code = AUTH_REQUIRED_ERROR_CODE;
}

export function isRuntimeAuthError(error: unknown): error is RuntimeAuthError {
  return error instanceof RuntimeAuthError;
}

/** Returns true when the stringified error looks like an auth / entitlement failure. */
const AUTH_ERROR_MARKERS = [
  "401",
  "403",
  "unauthorized",
  "forbidden",
  "not authorized",
  "entitlement",
  "no copilot access",
  "copilot is not enabled",
] as const;

/**
 * True for a typed auth failure (`code` or a {@link RuntimeAuthError}), or an
 * error whose text looks like an auth / entitlement failure.
 */
export function isAuthError(error: unknown, code?: string): boolean {
  if (code === AUTH_REQUIRED_ERROR_CODE || isRuntimeAuthError(error)) return true;
  const normalized = String(error).toLowerCase();
  return AUTH_ERROR_MARKERS.some((marker) => normalized.includes(marker));
}
