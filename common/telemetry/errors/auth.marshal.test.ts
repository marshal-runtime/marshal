// Marshal-owned test
import { describe, expect, it } from "vitest";

import { authErrors, makeAuthError, registerAuthErrors } from "./marshal-auth";
import { mockTelemetryCallbacks } from "./marshal-test-helpers";

describe("auth error family", () => {
  it("makeAuthError returns correct family and code for every member", () => {
    expect(makeAuthError(authErrors.AUTH_SILENT_ACQUIRE_FAILED)).toEqual({
      family: "marshal-auth",
      code: 0,
    });
    expect(makeAuthError(authErrors.AUTH_INTERACTIVE_ACQUIRE_FAILED)).toEqual({
      family: "marshal-auth",
      code: 1,
    });
    expect(makeAuthError(authErrors.TOKEN_CACHE_READ_FAILED)).toEqual({
      family: "marshal-auth",
      code: 2,
    });
    expect(makeAuthError(authErrors.TOKEN_CACHE_WRITE_FAILED)).toEqual({
      family: "marshal-auth",
      code: 3,
    });
    expect(makeAuthError(authErrors.GITHUB_TOKEN_FAILED)).toEqual({
      family: "marshal-auth",
      code: 4,
    });
    expect(makeAuthError(authErrors.GATEWAY_DEVICE_IDENTITY_FAILED)).toEqual({
      family: "marshal-auth",
      code: 5,
    });
    expect(makeAuthError(authErrors.AUTH_FLOW_CANCELLED_OR_TIMEOUT)).toEqual({
      family: "marshal-auth",
      code: 6,
    });
  });

  it("registerAuthErrors calls callbacks.registerErrors with correct args", () => {
    const callbacks = mockTelemetryCallbacks();
    registerAuthErrors(callbacks);
    expect(callbacks.registerErrors).toHaveBeenCalledWith("marshal-auth", authErrors);
  });
});
