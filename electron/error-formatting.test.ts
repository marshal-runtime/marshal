import { describe, it, expect } from "vitest";

import { coerceErrorText, formatUserFacingError } from "./error-formatting";

describe("formatUserFacingError", () => {
  it("formats CAPIError 499 to timeout message", () => {
    const raw =
      "Error: Execution failed: Error: Failed to get response from the AI model; " +
      "retried 5 times (total retry wait time: 11.31 seconds) " +
      "(Request-ID 5F86:29BE35:99BB85:A66851:69EA448D) " +
      "Last error: CAPIError: 499 499 status code (no body)";
    const result = formatUserFacingError(raw);
    expect(result).toBe("The AI service timed out. Please try again.");
    expect(result).not.toContain("Request-ID");
    expect(result).not.toContain("CAPIError");
  });

  it("formats CAPIError 400 corrupted attachment errors", () => {
    const raw =
      "Execution failed: CAPIError: 400 The file you uploaded is badly formatted or corrupted. " +
      "Please fix the file and try again. (Request ID: E186:1ECCA1:32984A5:38964DA:6A01B80E)";

    const result = formatUserFacingError(raw);

    expect(result).toBe(
      "One of the attached files couldn't be read by the AI service. Remove or re-save the file, then try again.",
    );
    expect(result).not.toContain("Request ID");
    expect(result).not.toContain("CAPIError");
  });

  it("formats 500 server error", () => {
    expect(formatUserFacingError("500 internal server error")).toBe(
      "The AI service is temporarily unavailable. Please try again in a moment.",
    );
  });

  it("formats 502 bad gateway", () => {
    expect(formatUserFacingError("502 Bad Gateway")).toBe(
      "The AI service is temporarily unavailable. Please try again in a moment.",
    );
  });

  it("formats 503 service unavailable", () => {
    expect(formatUserFacingError("503 Service Unavailable")).toBe(
      "The AI service is temporarily unavailable. Please try again in a moment.",
    );
  });

  it("formats 429 rate limit", () => {
    expect(formatUserFacingError("429 Too Many Requests")).toBe(
      "Too many requests. Please wait a moment and try again.",
    );
  });

  it("formats timeout errors", () => {
    expect(formatUserFacingError("ETIMEDOUT connecting to api.github.com")).toBe(
      "The request timed out. Please try again.",
    );
  });

  it("formats connection errors", () => {
    expect(formatUserFacingError("ECONNREFUSED 127.0.0.1:443")).toBe(
      "Unable to connect. Please check your internet connection.",
    );
  });

  it("passes auth errors through unchanged", () => {
    const authError = "401 Unauthorized: token expired";
    expect(formatUserFacingError(authError)).toBe(authError);
  });

  it("passes 403 forbidden through unchanged", () => {
    const forbidden = "403 Forbidden: insufficient permissions";
    expect(formatUserFacingError(forbidden)).toBe(forbidden);
  });

  it("formats 504 gateway timeout", () => {
    expect(formatUserFacingError("504 Gateway Timeout")).toBe(
      "The AI service timed out. Please try again.",
    );
  });

  it("does not pass through strings that mention auth incidentally", () => {
    expect(formatUserFacingError("authentication service crashed internally")).toBe(
      "Something went wrong. Please try again.",
    );
  });

  it("returns generic message for unknown errors", () => {
    expect(formatUserFacingError("something completely unexpected")).toBe(
      "Something went wrong. Please try again.",
    );
  });

  it("returns generic message for empty string", () => {
    expect(formatUserFacingError("")).toBe("Something went wrong. Please try again.");
  });

  it("surfaces the provider's message for a rejected request", () => {
    const raw =
      'Error: {"type":"error","status":400,"error":{"type":"invalid_request_error",' +
      '"message":"The \'gpt-0-nonexistent\' model is not supported when using Codex with a ChatGPT account."}}';
    expect(formatUserFacingError(raw)).toBe(
      "The AI service rejected the request: The 'gpt-0-nonexistent' model is not supported when using Codex with a ChatGPT account.",
    );
  });

  it("keeps the generic message for malformed or message-less provider bodies", () => {
    expect(formatUserFacingError('Error: {"error":{"type":"x"}}')).toBe(
      "Something went wrong. Please try again.",
    );
    expect(formatUserFacingError("Error: {not json")).toBe(
      "Something went wrong. Please try again.",
    );
  });
});

describe("coerceErrorText", () => {
  it("returns a string unchanged", () => {
    expect(coerceErrorText("429 Too Many Requests")).toBe("429 Too Many Requests");
  });

  it("extracts the message from an Error", () => {
    expect(coerceErrorText(new Error("boom"))).toBe("boom");
  });

  it("extracts the message from a plain error-like object", () => {
    expect(coerceErrorText({ message: "rate limited" })).toBe("rate limited");
  });

  it("never returns [object Object] for an object with a message", () => {
    const result = coerceErrorText({ message: "503 service unavailable", extra: { a: 1 } });
    expect(result).toBe("503 service unavailable");
    expect(result).not.toContain("[object Object]");
  });

  it("falls back to known fields when there is no message", () => {
    expect(coerceErrorText({ code: "ETIMEDOUT", status: 504 })).toBe("code=ETIMEDOUT status=504");
  });

  it("falls back to bounded JSON for a messageless plain object", () => {
    const result = coerceErrorText({ foo: "bar" });
    expect(result).toBe('{"foo":"bar"}');
    expect(result).not.toContain("[object Object]");
  });

  it("returns Unknown error for an empty object", () => {
    expect(coerceErrorText({})).toBe("Unknown error");
  });

  it("returns Unknown error for null / undefined", () => {
    expect(coerceErrorText(null)).toBe("Unknown error");
    expect(coerceErrorText(undefined)).toBe("Unknown error");
  });

  it("bounds very large serialized objects", () => {
    const result = coerceErrorText({ blob: "x".repeat(2000) });
    expect(result.length).toBeLessThanOrEqual(501);
    expect(result.endsWith("…")).toBe(true);
  });

  it("survives circular objects without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(coerceErrorText(circular)).toBe("Unknown error");
  });

  it("survives an object with a throwing message getter", () => {
    const hostile = {
      get message(): string {
        throw new Error("nope");
      },
    };
    expect(coerceErrorText(hostile)).toBe("Unknown error");
  });
});
