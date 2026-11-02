// Marshal-owned test
import { describe, expect, it } from "vitest";

import { sessionErrors, makeSessionError, registerSessionErrors } from "./marshal-session";
import { mockTelemetryCallbacks } from "./marshal-test-helpers";

describe("session error family", () => {
  it("makeSessionError returns correct family and code for every member", () => {
    expect(makeSessionError(sessionErrors.SESSION_INIT_FAILED)).toEqual({
      family: "marshal-session",
      code: 0,
    });
    expect(makeSessionError(sessionErrors.SESSION_LOAD_FAILED)).toEqual({
      family: "marshal-session",
      code: 1,
    });
    expect(makeSessionError(sessionErrors.SESSION_PERSIST_FAILED)).toEqual({
      family: "marshal-session",
      code: 2,
    });
    expect(makeSessionError(sessionErrors.SESSION_INDEX_CORRUPT)).toEqual({
      family: "marshal-session",
      code: 3,
    });
    expect(makeSessionError(sessionErrors.TURN_SEND_FAILED)).toEqual({
      family: "marshal-session",
      code: 4,
    });
    expect(makeSessionError(sessionErrors.SESSION_STUCK)).toEqual({
      family: "marshal-session",
      code: 5,
    });
    expect(makeSessionError(sessionErrors.SESSION_RESTORE_FAILED)).toEqual({
      family: "marshal-session",
      code: 6,
    });
    expect(makeSessionError(sessionErrors.INFER_FAILED)).toEqual({
      family: "marshal-session",
      code: 7,
    });
  });

  it("registerSessionErrors calls callbacks.registerErrors with correct args", () => {
    const callbacks = mockTelemetryCallbacks();
    registerSessionErrors(callbacks);
    expect(callbacks.registerErrors).toHaveBeenCalledWith("marshal-session", sessionErrors);
  });
});
