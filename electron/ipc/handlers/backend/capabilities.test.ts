import { beforeEach, describe, expect, it, vi } from "vitest";

import { testDouble } from "../../../testing/harness";
import { registerBackendCapabilitiesHandler } from "./capabilities";

type RegisteredHandler = (...args: unknown[]) => unknown;

function setup() {
  const handlers = new Map<string, RegisteredHandler>();
  const ipcHandle = vi.fn<(channel: string, handler: RegisteredHandler) => void>(
    (channel, handler) => handlers.set(channel, handler),
  );
  const mockCapabilities = {
    taskList: false,
    cronExpressions: false,
    retryPolicy: false,
    policyEditor: false,
    heartbeatIsolated: false,
    modelFallback: false,
    connectionStatus: false,
    sessionCompaction: false,
  };
  const sessionManager = {
    getBackendCapabilities: vi.fn<() => typeof mockCapabilities>(() => mockCapabilities),
  };
  registerBackendCapabilitiesHandler(
    testDouble<Parameters<typeof registerBackendCapabilitiesHandler>[0]>({
      sessionManager,
      ipcHandle,
    }),
  );
  return { handlers, sessionManager, mockCapabilities };
}

beforeEach(() => vi.clearAllMocks());

describe("backend:capabilities handler", () => {
  it("calls sessionManager.getBackendCapabilities and returns the result", () => {
    const { handlers, sessionManager, mockCapabilities } = setup();
    expect(handlers.get("backend:capabilities")!()).toEqual(mockCapabilities);
    expect(sessionManager.getBackendCapabilities).toHaveBeenCalledTimes(1);
  });
});
