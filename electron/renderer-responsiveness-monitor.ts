import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import type {
  MainEventLoopDelaySnapshot,
  RendererResponsivenessAck,
  RendererResponsivenessHeartbeat,
  RendererStallDiagnosticSnapshot,
} from "../common/marshal-ipc-contract";
import { createLogger } from "../common/marshal-logger";
import { writeProcessLifecycleEventSync } from "./process-lifecycle-diagnostics";

const log = createLogger("RendererResponsiveness");

const CHECK_INTERVAL_MS = 1_000;
const STALL_THRESHOLD_MS = 5_000;
const EVENT_LOOP_SAMPLE_INTERVAL_MS = 1_000;
const EVENT_LOOP_SAMPLE_COUNT = 10;

interface RendererWindowState {
  readonly visible: boolean;
  readonly minimized: boolean;
  readonly focused: boolean;
  readonly rendererPid: number;
}

interface RendererState {
  heartbeat: RendererResponsivenessHeartbeat;
  lastHeartbeatAtUnixMs: number;
  lastFrameProgressAtUnixMs: number;
  lastIpcDeliveryMs: number;
  stallReported: boolean;
}

interface RendererRecoveryDiagnosticSnapshot {
  readonly webContentsId: number;
  readonly stallDurationMs: number;
}

export interface RendererResponsivenessMonitorOptions {
  readonly getWindowState: (webContentsId: number) => RendererWindowState | null;
  readonly getEventLoopDelay: () => MainEventLoopDelaySnapshot;
  readonly onStall?: (snapshot: RendererStallDiagnosticSnapshot) => void;
  readonly now?: () => number;
  readonly writeSnapshot?: (snapshot: RendererStallDiagnosticSnapshot) => void;
  readonly writeRecovery?: (snapshot: RendererRecoveryDiagnosticSnapshot) => void;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
}

export class RendererResponsivenessMonitor {
  private readonly states = new Map<number, RendererState>();
  private readonly now: () => number;
  private readonly writeSnapshot: (snapshot: RendererStallDiagnosticSnapshot) => void;
  private readonly writeRecovery: (snapshot: RendererRecoveryDiagnosticSnapshot) => void;
  private readonly setIntervalFn: typeof globalThis.setInterval;
  private readonly clearIntervalFn: typeof globalThis.clearInterval;
  private checkTimer: ReturnType<typeof globalThis.setInterval> | null = null;

  constructor(private readonly options: RendererResponsivenessMonitorOptions) {
    this.now = options.now ?? Date.now;
    this.writeSnapshot =
      options.writeSnapshot ??
      ((snapshot) => {
        writeProcessLifecycleEventSync("renderer-responsiveness.visible-frame-stall", {
          ...snapshot,
        });
      });
    this.writeRecovery =
      options.writeRecovery ??
      ((snapshot) => {
        writeProcessLifecycleEventSync("renderer-responsiveness.frames-recovered", {
          ...snapshot,
        });
      });
    this.setIntervalFn = options.setInterval ?? globalThis.setInterval;
    this.clearIntervalFn = options.clearInterval ?? globalThis.clearInterval;
  }

  start(): void {
    if (this.checkTimer) return;
    this.checkTimer = this.setIntervalFn(() => this.checkForStalls(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.checkTimer) this.clearIntervalFn(this.checkTimer);
    this.checkTimer = null;
    this.states.clear();
  }

  remove(webContentsId: number): void {
    this.states.delete(webContentsId);
  }

  recordHeartbeat(
    webContentsId: number,
    heartbeat: RendererResponsivenessHeartbeat,
  ): RendererResponsivenessAck {
    if (!isValidHeartbeat(heartbeat)) {
      return { success: false, error: "Invalid renderer responsiveness heartbeat" };
    }

    const now = this.now();
    const previous = this.states.get(webContentsId);
    const rendererReloaded =
      previous != null && heartbeat.frameCount < previous.heartbeat.frameCount;
    const becameVisible =
      previous && !previous.heartbeat.documentVisible && heartbeat.documentVisible;
    const framesAdvanced =
      !previous || rendererReloaded || heartbeat.frameCount > previous.heartbeat.frameCount;
    const recovered = previous?.stallReported === true && framesAdvanced;

    const state: RendererState = {
      heartbeat,
      lastHeartbeatAtUnixMs: now,
      lastFrameProgressAtUnixMs:
        framesAdvanced || becameVisible ? now : previous.lastFrameProgressAtUnixMs,
      lastIpcDeliveryMs: Math.max(0, now - heartbeat.sentAtUnixMs),
      stallReported: recovered ? false : (previous?.stallReported ?? false),
    };
    this.states.set(webContentsId, state);

    if (recovered && previous) {
      const stallDurationMs = Math.max(0, now - previous.lastFrameProgressAtUnixMs);
      log.info("Visible renderer frames recovered", { webContentsId, stallDurationMs });
      this.writeRecovery({ webContentsId, stallDurationMs });
    }

    return {
      success: true,
      sequence: heartbeat.sequence,
      receivedAtUnixMs: now,
      mainEventLoopDelay: this.options.getEventLoopDelay(),
    };
  }

  checkForStalls(): void {
    const now = this.now();
    for (const [webContentsId, state] of this.states) {
      const windowState = this.options.getWindowState(webContentsId);
      if (!windowState) {
        this.states.delete(webContentsId);
        continue;
      }

      const visible =
        state.heartbeat.documentVisible && windowState.visible && !windowState.minimized;
      if (!visible) {
        state.lastFrameProgressAtUnixMs = now;
        state.stallReported = false;
        continue;
      }

      const stallDurationMs = now - state.lastFrameProgressAtUnixMs;
      if (stallDurationMs < STALL_THRESHOLD_MS || state.stallReported) continue;

      state.stallReported = true;
      const memory = process.memoryUsage();
      const snapshot: RendererStallDiagnosticSnapshot = {
        schemaVersion: 1,
        observedAtUnixMs: now,
        webContentsId,
        rendererPid: windowState.rendererPid,
        frameCount: state.heartbeat.frameCount,
        stallDurationMs,
        heartbeatAgeMs: Math.max(0, now - state.lastHeartbeatAtUnixMs),
        ipcDeliveryMs: state.lastIpcDeliveryMs,
        lastAckRoundTripMs: state.heartbeat.lastAckRoundTripMs,
        longTasksSupported: state.heartbeat.longTasksSupported,
        longTaskCount: state.heartbeat.longTaskCount,
        longTaskTotalDurationMs: state.heartbeat.longTaskTotalDurationMs,
        longTaskMaxDurationMs: state.heartbeat.longTaskMaxDurationMs,
        windowVisible: windowState.visible,
        windowMinimized: windowState.minimized,
        windowFocused: windowState.focused,
        mainEventLoopDelay: this.options.getEventLoopDelay(),
        mainProcessPid: process.pid,
        mainProcessUptimeMs: Math.round(process.uptime() * 1_000),
        mainProcessRssBytes: memory.rss,
        mainProcessHeapUsedBytes: memory.heapUsed,
      };
      this.writeSnapshot(snapshot);
      this.options.onStall?.(snapshot);
      log.warn("Visible renderer frames stopped advancing", snapshot);
    }
  }
}

export interface MainEventLoopDelayMonitor {
  getSnapshot(): MainEventLoopDelaySnapshot;
  stop(): void;
}

type MainEventLoopDelayHistogram = Pick<
  ReturnType<typeof monitorEventLoopDelay>,
  "mean" | "max" | "percentile" | "enable" | "reset" | "disable"
>;

export function startMainEventLoopDelayMonitor(
  histogram: MainEventLoopDelayHistogram = monitorEventLoopDelay({ resolution: 20 }),
  now: () => number = () => performance.now(),
  onSample?: (snapshot: MainEventLoopDelaySnapshot) => void,
): MainEventLoopDelayMonitor {
  const samples: MainEventLoopDelaySnapshot[] = [];
  let stopped = false;
  histogram.enable();
  let sampleStartedAt = now();

  const sample = () => {
    const sampledAt = now();
    const snapshot = readEventLoopDelay(histogram, Math.max(0, sampledAt - sampleStartedAt));
    samples.push(snapshot);
    if (samples.length > EVENT_LOOP_SAMPLE_COUNT) samples.shift();
    histogram.reset();
    sampleStartedAt = sampledAt;
    onSample?.(snapshot);
  };
  const timer = globalThis.setInterval(sample, EVENT_LOOP_SAMPLE_INTERVAL_MS);

  return {
    getSnapshot() {
      return aggregateEventLoopDelay(samples);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      globalThis.clearInterval(timer);
      histogram.disable();
    },
  };
}

function readEventLoopDelay(
  histogram: Pick<ReturnType<typeof monitorEventLoopDelay>, "mean" | "max" | "percentile">,
  sampleWindowMs: number,
): MainEventLoopDelaySnapshot {
  return {
    sampleWindowMs,
    meanMs: nanosecondsToMilliseconds(histogram.mean),
    maxSampleP95Ms: nanosecondsToMilliseconds(histogram.percentile(95)),
    maxMs: nanosecondsToMilliseconds(histogram.max),
  };
}

function aggregateEventLoopDelay(
  samples: MainEventLoopDelaySnapshot[],
): MainEventLoopDelaySnapshot {
  if (samples.length === 0) {
    return {
      sampleWindowMs: 0,
      meanMs: 0,
      maxSampleP95Ms: 0,
      maxMs: 0,
    };
  }

  return {
    sampleWindowMs: samples.reduce((total, sample) => total + sample.sampleWindowMs, 0),
    meanMs:
      Math.round(
        (samples.reduce((total, sample) => total + sample.meanMs, 0) / samples.length) * 100,
      ) / 100,
    maxSampleP95Ms: Math.max(...samples.map((sample) => sample.maxSampleP95Ms)),
    maxMs: Math.max(...samples.map((sample) => sample.maxMs)),
  };
}

function nanosecondsToMilliseconds(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round((value / 1_000_000) * 100) / 100;
}

function isValidHeartbeat(value: RendererResponsivenessHeartbeat): boolean {
  return (
    value?.schemaVersion === 1 &&
    isNonNegativeInteger(value.sequence) &&
    isNonNegativeFinite(value.sentAtUnixMs) &&
    isNonNegativeInteger(value.frameCount) &&
    isNonNegativeFinite(value.rendererUptimeMs) &&
    typeof value.documentVisible === "boolean" &&
    typeof value.longTasksSupported === "boolean" &&
    isNonNegativeInteger(value.longTaskCount) &&
    isNonNegativeFinite(value.longTaskTotalDurationMs) &&
    isNonNegativeFinite(value.longTaskMaxDurationMs) &&
    (value.lastAckRoundTripMs === null || isNonNegativeFinite(value.lastAckRoundTripMs))
  );
}

function isNonNegativeFinite(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
