export function invalidRuntimeRequest<T extends TypeError | RangeError>(
  error: T,
): T & { readonly code: "invalid_request" } {
  return Object.assign(error, { code: "invalid_request" as const });
}
