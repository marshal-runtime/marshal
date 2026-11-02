// Marshal-owned test
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSendErrorTelemetry = vi.hoisted(() => vi.fn<(...args: unknown[]) => void>());
vi.mock("./telemetry-errors", () => ({
  sendErrorTelemetry: mockSendErrorTelemetry,
}));

import {
  emitWorkspaceFallbackTelemetryIfNeeded,
  resetStartupTelemetryForTests,
} from "./startup-telemetry";

beforeEach(() => {
  vi.clearAllMocks();
  resetStartupTelemetryForTests();
});

describe("emitWorkspaceFallbackTelemetryIfNeeded", () => {
  it("emits WORKSPACE_FALLBACK_USED when usedFallback is true", () => {
    emitWorkspaceFallbackTelemetryIfNeeded({ dir: "/anywhere", usedFallback: true });

    expect(mockSendErrorTelemetry).toHaveBeenCalledTimes(1);
    expect(mockSendErrorTelemetry).toHaveBeenCalledWith({
      family: "marshal-crash",
      code: 4,
    });
  });

  it("does not emit when usedFallback is false", () => {
    emitWorkspaceFallbackTelemetryIfNeeded({ dir: "/anywhere", usedFallback: false });

    expect(mockSendErrorTelemetry).not.toHaveBeenCalled();
  });

  it("is one-shot: a second invocation with usedFallback: true does not re-fire", () => {
    // Defense in depth — even if a future contributor wires this into a
    // re-running path (e.g. app.on("activate") on macOS dock re-open), the
    // metric must not double-count.
    emitWorkspaceFallbackTelemetryIfNeeded({ dir: "/anywhere", usedFallback: true });
    emitWorkspaceFallbackTelemetryIfNeeded({ dir: "/anywhere", usedFallback: true });
    emitWorkspaceFallbackTelemetryIfNeeded({ dir: "/anywhere", usedFallback: true });

    expect(mockSendErrorTelemetry).toHaveBeenCalledTimes(1);
  });

  it("one-shot latch carries across mixed-value calls", () => {
    emitWorkspaceFallbackTelemetryIfNeeded({ dir: "/x", usedFallback: true });
    emitWorkspaceFallbackTelemetryIfNeeded({ dir: "/x", usedFallback: false });
    emitWorkspaceFallbackTelemetryIfNeeded({ dir: "/x", usedFallback: true });

    expect(mockSendErrorTelemetry).toHaveBeenCalledTimes(1);
  });
});
