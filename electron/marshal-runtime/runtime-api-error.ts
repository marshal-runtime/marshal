import type { MarshalRuntimeApiErrorCode } from "./contracts";

export class RuntimeApiError extends Error {
  constructor(
    readonly code: MarshalRuntimeApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeApiError";
  }
}

function upstreamCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function upstreamMessage(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const message = Reflect.get(error, "message");
  return typeof message === "string" && message.trim() ? message.trim() : undefined;
}

function isRuntimeApiErrorCode(code: string): code is MarshalRuntimeApiErrorCode {
  return (
    code === "aborted" ||
    code === "approval-required" ||
    code === "idempotency-capacity" ||
    code === "idempotency-conflict" ||
    code === "invalid-request" ||
    code === "not-found" ||
    code === "permission-denied" ||
    code === "runtime-unavailable" ||
    code === "operation-failed"
  );
}

export function normalizeRuntimeApiError(error: unknown): RuntimeApiError {
  if (error instanceof RuntimeApiError) return error;
  const code = upstreamCode(error);
  const normalizedCode: MarshalRuntimeApiErrorCode =
    code !== undefined && isRuntimeApiErrorCode(code)
      ? code
      : code === "ABORTED" || code === "BROKER_CALL_ABORTED" || code === "CANCELLED"
        ? "aborted"
        : code === "runtime_unavailable" || code === "MANAGER_DISPOSED"
          ? "runtime-unavailable"
          : code === "permission_denied"
            ? "permission-denied"
            : code === "approval_required"
              ? "approval-required"
              : code === "not_found" || code === "NOT_INSTALLED" || code === "RESOURCE_NOT_FOUND"
                ? "not-found"
                : code === "invalid_request" ||
                    code === "ALREADY_INSTALLED" ||
                    code === "IDENTITY_MISMATCH" ||
                    code?.startsWith("INVALID_") ||
                    code === "SOURCE_UNAVAILABLE" ||
                    code === "ROOT_NOT_ALLOWED" ||
                    code === "UNSAFE_PACKAGE_TREE" ||
                    code === "PACKAGE_LIMIT_EXCEEDED" ||
                    code === "INTEGRITY_MISMATCH" ||
                    code === "VERSION_MISMATCH" ||
                    code === "UNSUPPORTED_MODULE_FORMAT" ||
                    code === "UNSUPPORTED_MODULE_DEPENDENCY" ||
                    code === "UNSUPPORTED_MODULE_SHAPE" ||
                    error instanceof TypeError ||
                    error instanceof RangeError
                  ? "invalid-request"
                  : "operation-failed";
  const message =
    error instanceof Error && error.message.trim()
      ? error.message.trim().slice(0, 512)
      : (upstreamMessage(error)?.slice(0, 512) ?? "Marshal Runtime operation failed.");
  return new RuntimeApiError(normalizedCode, message);
}
