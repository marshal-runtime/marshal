import type { TelemetryAPI } from "@common/marshal-ipc-contract";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeLocalSinkManager, shouldUseLocalSink } from "./makeTelemetrySinkManagers";
import type { TelemetryEvent } from "./opensource";
import { flushPendingTelemetryWrites, resetTelemetryFinalization } from "./pending-writes";

afterEach(async () => {
  resetTelemetryFinalization();
  await flushPendingTelemetryWrites().catch(() => undefined);
});

describe("shouldUseLocalSink", () => {
  it("requires both user opt-in and the preload API", () => {
    expect(shouldUseLocalSink(true, true)).toBe(true);
    expect(shouldUseLocalSink(false, true)).toBe(false);
    expect(shouldUseLocalSink(true, false)).toBe(false);
    expect(shouldUseLocalSink(false, false)).toBe(false);
  });
});

describe("makeLocalSinkManager", () => {
  it("forwards telemetry events to typed local telemetry IPC", async () => {
    const writeLocalEvent = vi
      .fn<TelemetryAPI["writeLocalEvent"]>()
      .mockResolvedValue({ success: true });
    const manager = makeLocalSinkManager({ writeLocalEvent });
    const event: TelemetryEvent = {
      eventType: "Marshal.Fetch",
      fields: {
        scenario: "LlmTokenUsage",
        duration: 42,
        userId: "must-be-filtered-in-main",
      },
      tags: { diagnosticLevel: 10 },
    };

    manager.send(event);
    await flushPendingTelemetryWrites();

    expect(writeLocalEvent).toHaveBeenCalledWith({
      eventType: "Marshal.Fetch",
      fields: {
        scenario: "LlmTokenUsage",
        duration: 42,
        userId: "must-be-filtered-in-main",
      },
      tags: { diagnosticLevel: 10 },
    });
  });
});
