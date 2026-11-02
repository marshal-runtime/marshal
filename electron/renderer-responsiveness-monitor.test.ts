import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  MainEventLoopDelaySnapshot,
  RendererResponsivenessHeartbeat,
  RendererStallDiagnosticSnapshot,
} from "../common/marshal-ipc-contract";
import {
  RendererResponsivenessMonitor,
  startMainEventLoopDelayMonitor,
} from "./renderer-responsiveness-monitor";

const EVENT_LOOP_DELAY: MainEventLoopDelaySnapshot = {
  sampleWindowMs: 10_000,
  meanMs: 2,
  maxSampleP95Ms: 4,
  maxMs: 8,
};

function createEventLoopHistogram() {
  let percentile95 = 0;
  const histogram = {
    mean: 0,
    max: 0,
    percentile: vi.fn<(percentile: number) => number>(() => percentile95),
    enable: vi.fn<() => boolean>(() => true),
    reset: vi.fn<() => void>(),
    disable: vi.fn<() => boolean>(() => true),
  };

  return {
    histogram,
    setSample(meanMs: number, p95Ms: number, maxMs: number) {
      histogram.mean = meanMs * 1_000_000;
      percentile95 = p95Ms * 1_000_000;
      histogram.max = maxMs * 1_000_000;
    },
  };
}

function heartbeat(overrides: Partial<RendererResponsivenessHeartbeat> = {}) {
  return {
    schemaVersion: 1,
    sequence: 1,
    sentAtUnixMs: 1_000,
    frameCount: 10,
    rendererUptimeMs: 500,
    documentVisible: true,
    longTasksSupported: true,
    longTaskCount: 2,
    longTaskTotalDurationMs: 125,
    longTaskMaxDurationMs: 75,
    lastAckRoundTripMs: 12,
    ...overrides,
  } satisfies RendererResponsivenessHeartbeat;
}

function setup() {
  let now = 1_000;
  let windowVisible = true;
  const snapshots: RendererStallDiagnosticSnapshot[] = [];
  const recoveries: Array<{ webContentsId: number; stallDurationMs: number }> = [];
  const onStall = vi.fn<(snapshot: RendererStallDiagnosticSnapshot) => void>();
  const monitor = new RendererResponsivenessMonitor({
    now: () => now,
    getWindowState: () => ({
      visible: windowVisible,
      minimized: false,
      focused: true,
      rendererPid: 4321,
    }),
    getEventLoopDelay: () => EVENT_LOOP_DELAY,
    onStall,
    writeSnapshot: (snapshot) => snapshots.push(snapshot),
    writeRecovery: (snapshot) => recoveries.push(snapshot),
  });

  return {
    monitor,
    snapshots,
    recoveries,
    onStall,
    advance(ms: number) {
      now += ms;
    },
    setVisible(visible: boolean) {
      windowVisible = visible;
    },
  };
}

describe("RendererResponsivenessMonitor", () => {
  it("writes one metadata-only snapshot after visible frames stop for five seconds", () => {
    const fixture = setup();
    const ack = fixture.monitor.recordHeartbeat(7, heartbeat());

    expect(ack).toEqual({
      success: true,
      sequence: 1,
      receivedAtUnixMs: 1_000,
      mainEventLoopDelay: EVENT_LOOP_DELAY,
    });

    fixture.advance(4_999);
    fixture.monitor.checkForStalls();
    expect(fixture.snapshots).toHaveLength(0);

    fixture.advance(1);
    fixture.monitor.checkForStalls();
    fixture.advance(10_000);
    fixture.monitor.checkForStalls();

    expect(fixture.snapshots).toHaveLength(1);
    expect(fixture.onStall).toHaveBeenCalledOnce();
    expect(fixture.onStall).toHaveBeenCalledWith(fixture.snapshots[0]);
    expect(fixture.snapshots[0]).toMatchObject({
      schemaVersion: 1,
      webContentsId: 7,
      rendererPid: 4321,
      frameCount: 10,
      stallDurationMs: 5_000,
      heartbeatAgeMs: 5_000,
      ipcDeliveryMs: 0,
      lastAckRoundTripMs: 12,
      longTaskCount: 2,
      longTaskTotalDurationMs: 125,
      mainEventLoopDelay: EVENT_LOOP_DELAY,
    });
    expect(Object.keys(fixture.snapshots[0]).sort()).toEqual(
      [
        "frameCount",
        "heartbeatAgeMs",
        "ipcDeliveryMs",
        "lastAckRoundTripMs",
        "longTaskCount",
        "longTaskMaxDurationMs",
        "longTaskTotalDurationMs",
        "longTasksSupported",
        "mainEventLoopDelay",
        "mainProcessHeapUsedBytes",
        "mainProcessPid",
        "mainProcessRssBytes",
        "mainProcessUptimeMs",
        "observedAtUnixMs",
        "rendererPid",
        "schemaVersion",
        "stallDurationMs",
        "webContentsId",
        "windowFocused",
        "windowMinimized",
        "windowVisible",
      ].sort(),
    );
  });

  it("suppresses hidden-window stalls and starts a fresh visible interval", () => {
    const fixture = setup();
    fixture.monitor.recordHeartbeat(7, heartbeat());
    fixture.setVisible(false);
    fixture.advance(20_000);
    fixture.monitor.checkForStalls();
    fixture.setVisible(true);
    fixture.monitor.checkForStalls();

    expect(fixture.snapshots).toHaveLength(0);

    fixture.advance(5_000);
    fixture.monitor.checkForStalls();
    expect(fixture.snapshots).toHaveLength(1);
  });

  it("allows another snapshot only after frame progress recovers", () => {
    const fixture = setup();
    fixture.monitor.recordHeartbeat(7, heartbeat());
    fixture.advance(5_000);
    fixture.monitor.checkForStalls();
    fixture.advance(5_000);
    fixture.monitor.checkForStalls();
    expect(fixture.snapshots).toHaveLength(1);

    fixture.monitor.recordHeartbeat(7, heartbeat({ sequence: 2, frameCount: 11 }));
    expect(fixture.recoveries).toEqual([{ webContentsId: 7, stallDurationMs: 10_000 }]);
    fixture.advance(5_000);
    fixture.monitor.checkForStalls();
    expect(fixture.snapshots).toHaveLength(2);
  });

  it("rejects malformed timing payloads", () => {
    const fixture = setup();
    const invalid = heartbeat({ frameCount: Number.NaN });

    expect(fixture.monitor.recordHeartbeat(7, invalid)).toEqual({
      success: false,
      error: "Invalid renderer responsiveness heartbeat",
    });
    fixture.advance(10_000);
    fixture.monitor.checkForStalls();
    expect(fixture.snapshots).toHaveLength(0);
  });

  it("drops state when the renderer window no longer exists", () => {
    let now = 1_000;
    const writeSnapshot = vi.fn<(snapshot: RendererStallDiagnosticSnapshot) => void>();
    const monitor = new RendererResponsivenessMonitor({
      now: () => now,
      getWindowState: () => null,
      getEventLoopDelay: () => EVENT_LOOP_DELAY,
      writeSnapshot,
      writeRecovery:
        vi.fn<(snapshot: { webContentsId: number; stallDurationMs: number }) => void>(),
    });
    monitor.recordHeartbeat(7, heartbeat());
    now += 10_000;

    monitor.checkForStalls();

    expect(writeSnapshot).not.toHaveBeenCalled();
  });
});

describe("main event-loop delay sampler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports only completed samples", () => {
    vi.useFakeTimers();
    let now = 0;
    const fixture = createEventLoopHistogram();
    const monitor = startMainEventLoopDelayMonitor(fixture.histogram, () => now);

    fixture.setSample(2, 4, 8);
    expect(monitor.getSnapshot()).toEqual({
      sampleWindowMs: 0,
      meanMs: 0,
      maxSampleP95Ms: 0,
      maxMs: 0,
    });

    now += 1_000;
    vi.advanceTimersByTime(1_000);
    fixture.setSample(20, 40, 80);

    expect(monitor.getSnapshot()).toEqual({
      sampleWindowMs: 1_000,
      meanMs: 2,
      maxSampleP95Ms: 4,
      maxMs: 8,
    });
    monitor.stop();
  });

  it("uses the actual elapsed duration when a sample callback is delayed", () => {
    vi.useFakeTimers();
    let now = 10_000;
    const fixture = createEventLoopHistogram();
    const monitor = startMainEventLoopDelayMonitor(fixture.histogram, () => now);

    fixture.setSample(2, 4, 8);
    now += 2_500;
    vi.advanceTimersByTime(1_000);

    expect(monitor.getSnapshot()).toEqual({
      sampleWindowMs: 2_500,
      meanMs: 2,
      maxSampleP95Ms: 4,
      maxMs: 8,
    });
    monitor.stop();
  });

  it("reports each completed main event-loop sample to the flight recorder seam", () => {
    vi.useFakeTimers();
    let now = 0;
    const fixture = createEventLoopHistogram();
    const onSample = vi.fn<(sample: MainEventLoopDelaySnapshot) => void>();
    const monitor = startMainEventLoopDelayMonitor(fixture.histogram, () => now, onSample);

    fixture.setSample(25, 100, 1_500);
    now += 1_250;
    vi.advanceTimersByTime(1_000);

    expect(onSample).toHaveBeenCalledWith({
      sampleWindowMs: 1_250,
      meanMs: 25,
      maxSampleP95Ms: 100,
      maxMs: 1_500,
    });
    monitor.stop();
  });

  it("aggregates the ten most recent samples", () => {
    vi.useFakeTimers();
    let now = 0;
    const fixture = createEventLoopHistogram();
    const monitor = startMainEventLoopDelayMonitor(fixture.histogram, () => now);

    for (let sample = 1; sample <= 11; sample += 1) {
      fixture.setSample(sample, sample * 2, sample * 3);
      now += 1_000;
      vi.advanceTimersByTime(1_000);
    }

    expect(monitor.getSnapshot()).toEqual({
      sampleWindowMs: 10_000,
      meanMs: 6.5,
      maxSampleP95Ms: 22,
      maxMs: 33,
    });
    expect(fixture.histogram.reset).toHaveBeenCalledTimes(11);
    monitor.stop();
    expect(fixture.histogram.disable).toHaveBeenCalledOnce();
  });
});
