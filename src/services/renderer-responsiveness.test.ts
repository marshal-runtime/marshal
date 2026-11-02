import type { DiagnosticsAPI } from "@common/marshal-ipc-contract";
import { describe, expect, it, vi } from "vitest";

import { RendererResponsivenessProbe } from "./renderer-responsiveness";

function setup(options: { longTasksSupported?: boolean } = {}) {
  let frameCallback: FrameRequestCallback | null = null;
  let longTaskCallback: ((durationMs: number) => void) | null = null;
  let monotonicNow = 100;
  let ackLatencyMs = 0;
  let visible = true;
  const rendererHeartbeat = vi.fn<DiagnosticsAPI["rendererHeartbeat"]>(async (heartbeat) => {
    monotonicNow += ackLatencyMs;
    return {
      success: true,
      sequence: heartbeat.sequence,
      receivedAtUnixMs: heartbeat.sentAtUnixMs,
    };
  });
  const disconnect = vi.fn<() => void>();
  const probe = new RendererResponsivenessProbe({
    api: { rendererHeartbeat },
    now: () => 1_000,
    monotonicNow: () => monotonicNow,
    isDocumentVisible: () => visible,
    requestFrame: (callback) => {
      frameCallback = callback;
      return 1;
    },
    cancelFrame: vi.fn<(handle: number) => void>(),
    setInterval: vi.fn<(callback: () => void, delayMs: number) => number>(() => 2),
    clearInterval: vi.fn<(handle: number) => void>(),
    subscribeVisibility: vi.fn<(callback: () => void) => () => void>(() => vi.fn<() => void>()),
    observeLongTasks: (callback) => {
      longTaskCallback = callback;
      return { supported: options.longTasksSupported ?? true, disconnect };
    },
  });

  return {
    probe,
    rendererHeartbeat,
    disconnect,
    frame() {
      frameCallback?.(monotonicNow);
    },
    longTask(durationMs: number) {
      longTaskCallback?.(durationMs);
    },
    setMonotonicNow(value: number) {
      monotonicNow = value;
    },
    setAckLatency(value: number) {
      ackLatencyMs = value;
    },
    setVisible(value: boolean) {
      visible = value;
    },
  };
}

describe("RendererResponsivenessProbe", () => {
  it("reports visible rAF progress, long-task aggregates, and ack latency", async () => {
    const fixture = setup();
    fixture.probe.start();
    fixture.frame();
    fixture.frame();
    fixture.longTask(60.125);
    fixture.longTask(125.5);
    fixture.setAckLatency(12.25);

    await fixture.probe.sendHeartbeat();
    await fixture.probe.sendHeartbeat();

    expect(fixture.rendererHeartbeat).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        schemaVersion: 1,
        sequence: 1,
        frameCount: 2,
        documentVisible: true,
        longTasksSupported: true,
        longTaskCount: 2,
        longTaskTotalDurationMs: 185.63,
        longTaskMaxDurationMs: 125.5,
        lastAckRoundTripMs: null,
      }),
    );
    expect(fixture.rendererHeartbeat).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ lastAckRoundTripMs: 12.25 }),
    );
  });

  it("does not count hidden frames and disconnects observation on stop", async () => {
    const fixture = setup({ longTasksSupported: false });
    fixture.probe.start();
    fixture.setVisible(false);
    fixture.frame();

    await fixture.probe.sendHeartbeat();
    fixture.probe.stop();

    expect(fixture.rendererHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        frameCount: 0,
        documentVisible: false,
        longTasksSupported: false,
      }),
    );
    expect(fixture.disconnect).toHaveBeenCalledOnce();
  });

  it("does not queue heartbeats while an ack is pending", async () => {
    let resolveAck: (
      value: Awaited<ReturnType<DiagnosticsAPI["rendererHeartbeat"]>>,
    ) => void = () => {
      throw new Error("Heartbeat resolver was not initialized");
    };
    const rendererHeartbeat = vi.fn<DiagnosticsAPI["rendererHeartbeat"]>(
      (heartbeat) =>
        new Promise((resolve) => {
          resolveAck = resolve;
          expect(heartbeat.sequence).toBe(1);
        }),
    );
    const fixture = setup();
    const probe = new RendererResponsivenessProbe({
      api: { rendererHeartbeat },
      now: () => 1_000,
      monotonicNow: () => 100,
      isDocumentVisible: () => true,
      requestFrame: vi.fn<(callback: FrameRequestCallback) => number>(() => 1),
      cancelFrame: vi.fn<(handle: number) => void>(),
      setInterval: vi.fn<(callback: () => void, delayMs: number) => number>(() => 2),
      clearInterval: vi.fn<(handle: number) => void>(),
      subscribeVisibility: vi.fn<(callback: () => void) => () => void>(() => vi.fn<() => void>()),
      observeLongTasks: () => ({ supported: false, disconnect: fixture.disconnect }),
    });
    probe.start();

    const first = probe.sendHeartbeat();
    await probe.sendHeartbeat();
    expect(rendererHeartbeat).toHaveBeenCalledOnce();

    resolveAck({ success: true, sequence: 1, receivedAtUnixMs: 1_000 });
    await first;
    probe.stop();
  });
});
