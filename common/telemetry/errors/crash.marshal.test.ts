// Marshal-owned test
import { describe, expect, it } from "vitest";

import { crashErrors, makeCrashError, registerCrashErrors } from "./marshal-crash";
import { mockTelemetryCallbacks } from "./marshal-test-helpers";

describe("crash error family", () => {
  it("makeCrashError returns correct family and code", () => {
    expect(makeCrashError(crashErrors.REACT_ERROR_BOUNDARY)).toEqual({
      family: "marshal-crash",
      code: 0,
    });
    expect(makeCrashError(crashErrors.MAIN_PROCESS_CRASH)).toEqual({
      family: "marshal-crash",
      code: 1,
    });
    expect(makeCrashError(crashErrors.UNCAUGHT_EXCEPTION)).toEqual({
      family: "marshal-crash",
      code: 2,
    });
    expect(makeCrashError(crashErrors.UNHANDLED_REJECTION)).toEqual({
      family: "marshal-crash",
      code: 3,
    });
    expect(makeCrashError(crashErrors.WORKSPACE_FALLBACK_USED)).toEqual({
      family: "marshal-crash",
      code: 4,
    });
  });

  it("registerCrashErrors calls callbacks.registerErrors with correct args", () => {
    const callbacks = mockTelemetryCallbacks();
    registerCrashErrors(callbacks);
    expect(callbacks.registerErrors).toHaveBeenCalledWith("marshal-crash", crashErrors);
  });
});
