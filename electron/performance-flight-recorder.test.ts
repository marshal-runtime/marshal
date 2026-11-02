import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CpuProfilerTarget,
  PerformanceFlightRecorderOptions,
} from "./performance-flight-recorder";
import { PerformanceFlightRecorder } from "./performance-flight-recorder";

vi.mock("./process-lifecycle-diagnostics", () => ({
  writeProcessLifecycleEventSync: vi.fn<() => void>(),
}));

function createTarget(profile: unknown = { nodes: [{ id: 1 }], samples: [1, 1] }) {
  return {
    start: vi.fn<CpuProfilerTarget["start"]>(async () => undefined),
    stop: vi.fn<CpuProfilerTarget["stop"]>(async () => profile),
    dispose: vi.fn<CpuProfilerTarget["dispose"]>(),
  } satisfies CpuProfilerTarget;
}

describe("PerformanceFlightRecorder", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rotates bounded main CPU profiles and captures a named stall window", async () => {
    const target = createTarget();
    const writeProfile = vi.fn<NonNullable<PerformanceFlightRecorderOptions["writeProfile"]>>(
      async () => undefined,
    );
    const recorder = new PerformanceFlightRecorder({
      enabled: true,
      profileDir: "/profiles",
      rotationIntervalMs: 1_000,
      maxProfileFiles: 4,
      createMainTarget: () => target,
      writeProfile,
    });

    recorder.startMain();
    await vi.waitFor(() => expect(target.start).toHaveBeenCalledOnce());

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(writeProfile).toHaveBeenCalledOnce());
    expect(writeProfile.mock.calls[0]?.[1]).toMatch(/-main-\d+-rolling\.cpuprofile$/);
    expect(writeProfile.mock.calls[0]?.[3]).toBe(4);

    recorder.captureMain("main-event-loop-stall");
    await vi.waitFor(() => expect(writeProfile).toHaveBeenCalledTimes(2));
    expect(writeProfile.mock.calls[1]?.[1]).toMatch(/-main-\d+-main-event-loop-stall\.cpuprofile$/);
    expect(target.start).toHaveBeenCalledTimes(3);
    expect(target.stop).toHaveBeenCalledTimes(2);

    await recorder.stop();
    expect(target.stop).toHaveBeenCalledTimes(3);
    expect(target.dispose).toHaveBeenCalledOnce();
  });

  it("does no profiling work when disabled", async () => {
    const target = createTarget();
    const writeProfile = vi.fn<NonNullable<PerformanceFlightRecorderOptions["writeProfile"]>>(
      async () => undefined,
    );
    const recorder = new PerformanceFlightRecorder({
      enabled: false,
      profileDir: "/profiles",
      createMainTarget: () => target,
      writeProfile,
    });

    recorder.startMain();
    recorder.captureMain("stall");
    await vi.runAllTimersAsync();
    await recorder.stop();

    expect(target.start).not.toHaveBeenCalled();
    expect(target.stop).not.toHaveBeenCalled();
    expect(target.dispose).not.toHaveBeenCalled();
    expect(writeProfile).not.toHaveBeenCalled();
  });

  it("disables a failed profiler without retry-looping", async () => {
    const target = createTarget();
    target.start.mockRejectedValueOnce(new Error("profiler unavailable"));
    const writeProfile = vi.fn<NonNullable<PerformanceFlightRecorderOptions["writeProfile"]>>(
      async () => undefined,
    );
    const recorder = new PerformanceFlightRecorder({
      enabled: true,
      profileDir: "/profiles",
      rotationIntervalMs: 1_000,
      createMainTarget: () => target,
      writeProfile,
    });

    recorder.startMain();
    await vi.waitFor(() => expect(target.dispose).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(5_000);

    expect(target.start).toHaveBeenCalledOnce();
    expect(target.stop).not.toHaveBeenCalled();
    expect(writeProfile).not.toHaveBeenCalled();
    await recorder.stop();
  });
});
