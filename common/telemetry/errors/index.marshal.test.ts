// Marshal-owned test
import { describe, expect, it } from "vitest";

import {
  authErrors,
  crashErrors,
  ipcErrors,
  mcpErrors,
  registerAllErrors,
  sessionErrors,
  updaterErrors,
} from "./marshal-index";
import { mockTelemetryCallbacks } from "./marshal-test-helpers";

describe("registerAllErrors", () => {
  it("registers all six error families", () => {
    const callbacks = mockTelemetryCallbacks();
    registerAllErrors(callbacks);
    expect(callbacks.registerErrors).toHaveBeenCalledTimes(6);
    expect(callbacks.registerErrors).toHaveBeenCalledWith("marshal-auth", authErrors);
    expect(callbacks.registerErrors).toHaveBeenCalledWith("marshal-session", sessionErrors);
    expect(callbacks.registerErrors).toHaveBeenCalledWith("marshal-mcp", mcpErrors);
    expect(callbacks.registerErrors).toHaveBeenCalledWith("marshal-crash", crashErrors);
    expect(callbacks.registerErrors).toHaveBeenCalledWith("marshal-ipc", ipcErrors);
    expect(callbacks.registerErrors).toHaveBeenCalledWith("marshal-updater", updaterErrors);
  });
});
