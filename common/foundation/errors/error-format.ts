function stringifyUnknownError(error: unknown): string | null {
  if (error === null || error === undefined) return null;

  const seen = new WeakSet();
  const json = JSON.stringify(error, (_key, value: unknown) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    if (value instanceof Error) {
      // `stack` is intentionally omitted: this helper feeds user-visible
      // surfaces (chat transcript, auth banner, init placeholder), and a raw
      // stack trace is noisy and can leak absolute filesystem paths. Stacks
      // belong in console.error / log files, not the UI.
      return {
        name: value.name,
        message: value.message,
        cause: value.cause,
      };
    }
    return value;
  });

  return json ?? null;
}

function isPrimitiveErrorValue(error: unknown): error is number | boolean | bigint {
  return typeof error === "number" || typeof error === "boolean" || typeof error === "bigint";
}

export function formatErrorForDisplay(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || "Unknown error";
  }
  if (typeof error === "string") return error;
  if (isPrimitiveErrorValue(error)) return String(error);
  if (typeof error === "object" && error !== null) {
    const withMessage = error as { message?: unknown };
    if (typeof withMessage.message === "string" && withMessage.message.trim()) {
      return withMessage.message;
    }

    const json = stringifyUnknownError(error);
    if (json) return json;
  }
  if (typeof error === "symbol") return error.toString();
  return "Unknown error";
}
