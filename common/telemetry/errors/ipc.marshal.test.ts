// Marshal-owned test
import { describe, expect, it } from "vitest";

import { ipcErrors, makeIpcError, registerIpcErrors } from "./marshal-ipc";
import { mockTelemetryCallbacks } from "./marshal-test-helpers";

describe("ipc error family", () => {
  it("makeIpcError returns correct family and code", () => {
    expect(makeIpcError(ipcErrors.HANDLER_UNCAUGHT)).toEqual({
      family: "marshal-ipc",
      code: 0,
    });
  });

  it("registerIpcErrors calls callbacks.registerErrors with correct args", () => {
    const callbacks = mockTelemetryCallbacks();
    registerIpcErrors(callbacks);
    expect(callbacks.registerErrors).toHaveBeenCalledWith("marshal-ipc", ipcErrors);
  });
});
