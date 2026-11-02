import { AUTH_REQUIRED_ERROR_CODE, RuntimeAuthError } from "./foundation/auth/auth-errors";

/**
 * Runtime-neutral signal that a turn failed because the account's usage limit
 * was reached. Any runtime adapter can report it (turn error code
 * `usage_limit`, optional `retryAt`); consumers such as the goal engine wait
 * for the reset instead of treating the failure as an error.
 */
export const USAGE_LIMIT_ERROR_CODE = "usage_limit";

export class RuntimeUsageLimitError extends Error {
  readonly name = "RuntimeUsageLimitError";
  readonly code = USAGE_LIMIT_ERROR_CODE;

  constructor(
    message: string,
    /** Epoch milliseconds when the limit resets, when the runtime reported it. */
    readonly retryAt?: number,
  ) {
    super(message);
  }
}

/** The error a collector rejects with for a terminal `turn:error`. */
export function turnFailureError(event: { error: string; code?: string; retryAt?: number }): Error {
  if (event.code === USAGE_LIMIT_ERROR_CODE) {
    return new RuntimeUsageLimitError(event.error, event.retryAt);
  }
  if (event.code === AUTH_REQUIRED_ERROR_CODE) return new RuntimeAuthError(event.error);
  return new Error(event.error);
}

export function isRuntimeUsageLimitError(error: unknown): error is RuntimeUsageLimitError {
  return error instanceof RuntimeUsageLimitError;
}
