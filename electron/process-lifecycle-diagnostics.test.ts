import { describe, expect, it } from "vitest";

import { summarizeError } from "./process-lifecycle-diagnostics";

describe("summarizeError", () => {
  it("preserves bounded error codes and causes for startup diagnostics", () => {
    const cause = Object.assign(new Error("extension activation failed"), {
      code: "extension-activation-failed",
    });
    const error = Object.assign(new Error("Marshal Runtime host failed to start.", { cause }), {
      code: "runtime_unavailable",
    });

    expect(summarizeError(error)).toMatchObject({
      name: "Error",
      code: "runtime_unavailable",
      message: "Marshal Runtime host failed to start.",
      errors: [
        {
          name: "Error",
          code: "extension-activation-failed",
          message: "extension activation failed",
        },
      ],
    });
  });
});
