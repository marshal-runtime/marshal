import { describe, expect, it } from "vitest";

import { formatErrorForDisplay } from "./foundation/errors/error-format";

describe("formatErrorForDisplay", () => {
  it("uses the message from Error instances", () => {
    expect(formatErrorForDisplay(new Error("Boom"))).toBe("Boom");
  });

  it("uses the message from plain-object errors", () => {
    expect(
      formatErrorForDisplay({
        code: "TEST_POJO_ERROR",
        message: "Synthetic object error for chat UI testing",
      }),
    ).toBe("Synthetic object error for chat UI testing");
  });

  it("serializes plain objects without messages", () => {
    expect(formatErrorForDisplay({ code: "TEST_POJO_ERROR" })).toBe('{"code":"TEST_POJO_ERROR"}');
  });

  it("handles circular objects", () => {
    const error = { code: "TEST_POJO_ERROR" } as { code: string; self?: unknown };
    error.self = error;
    expect(formatErrorForDisplay(error)).toBe('{"code":"TEST_POJO_ERROR","self":"[Circular]"}');
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a function", () => {}],
  ])("returns 'Unknown error' for %s", (_label, input) => {
    expect(formatErrorForDisplay(input)).toBe("Unknown error");
  });

  it("stringifies symbols via their toString", () => {
    expect(formatErrorForDisplay(Symbol("x"))).toBe("Symbol(x)");
  });

  it("handles a nested Error whose cause references itself", () => {
    const inner = new Error("inner boom") as Error & { cause?: unknown };
    inner.cause = inner;
    const wrapper = { code: "TEST_POJO_ERROR", inner };
    // Should not recurse infinitely; circular cause is replaced with [Circular].
    const result = formatErrorForDisplay(wrapper);
    expect(result).toContain('"message":"inner boom"');
    expect(result).toContain('"cause":"[Circular]"');
  });

  it("omits stack frames from nested Error instances", () => {
    // POJO wrapping an Error is the case this helper exists to handle.
    // The stack is intentionally dropped so user-visible surfaces (chat
    // transcript, auth banner) don't leak file paths or noisy frames.
    const wrapper = { code: "TEST_POJO_ERROR", inner: new Error("nested boom") };
    const result = formatErrorForDisplay(wrapper);
    expect(result).toContain('"message":"nested boom"');
    expect(result).not.toContain("stack");
    expect(result).not.toContain("at ");
  });
});
