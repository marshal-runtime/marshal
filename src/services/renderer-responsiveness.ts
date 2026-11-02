import type { DiagnosticsAPI, RendererResponsivenessHeartbeat } from "@common/marshal-ipc-contract";
import { createLogger } from "@common/marshal-logger";

const log = createLogger("RendererResponsiveness");

const HEARTBEAT_INTERVAL_MS = 1_000;

interface LongTaskObservation {
  readonly supported: boolean;
  disconnect(): void;
}

interface RendererResponsivenessProbeOptions {
  readonly api: Pick<DiagnosticsAPI, "rendererHeartbeat">;
  readonly now: () => number;
  readonly monotonicNow: () => number;
  readonly isDocumentVisible: () => boolean;
  readonly requestFrame: (callback: FrameRequestCallback) => number;
  readonly cancelFrame: (handle: number) => void;
  readonly setInterval: (callback: () => void, delayMs: number) => number;
  readonly clearInterval: (handle: number) => void;
  readonly subscribeVisibility: (callback: () => void) => () => void;
  readonly observeLongTasks: (callback: (durationMs: number) => void) => LongTaskObservation;
}

export class RendererResponsivenessProbe {
  private frameCount = 0;
  private sequence = 0;
  private longTaskCount = 0;
  private longTaskTotalDurationMs = 0;
  private longTaskMaxDurationMs = 0;
  private lastAckRoundTripMs: number | null = null;
  private frameHandle: number | null = null;
  private intervalHandle: number | null = null;
  private visibilityUnsubscribe: (() => void) | null = null;
  private longTaskObservation: LongTaskObservation | null = null;
  private heartbeatInFlight = false;
  private ipcDegraded = false;
  private stopped = true;

  constructor(private readonly options: RendererResponsivenessProbeOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.longTaskObservation = this.options.observeLongTasks((durationMs) => {
      if (!Number.isFinite(durationMs) || durationMs < 0) return;
      this.longTaskCount += 1;
      this.longTaskTotalDurationMs += durationMs;
      this.longTaskMaxDurationMs = Math.max(this.longTaskMaxDurationMs, durationMs);
    });
    this.frameHandle = this.options.requestFrame(this.onFrame);
    this.intervalHandle = this.options.setInterval(
      () => void this.sendHeartbeat(),
      HEARTBEAT_INTERVAL_MS,
    );
    this.visibilityUnsubscribe = this.options.subscribeVisibility(() => void this.sendHeartbeat());
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.frameHandle != null) this.options.cancelFrame(this.frameHandle);
    if (this.intervalHandle != null) this.options.clearInterval(this.intervalHandle);
    this.visibilityUnsubscribe?.();
    this.longTaskObservation?.disconnect();
    this.frameHandle = null;
    this.intervalHandle = null;
    this.visibilityUnsubscribe = null;
    this.longTaskObservation = null;
  }

  async sendHeartbeat(): Promise<void> {
    if (this.stopped || this.heartbeatInFlight) return;

    this.heartbeatInFlight = true;
    const sequence = ++this.sequence;
    const startedAt = this.options.monotonicNow();
    const heartbeat: RendererResponsivenessHeartbeat = {
      schemaVersion: 1,
      sequence,
      sentAtUnixMs: this.options.now(),
      frameCount: this.frameCount,
      rendererUptimeMs: startedAt,
      documentVisible: this.options.isDocumentVisible(),
      longTasksSupported: this.longTaskObservation?.supported ?? false,
      longTaskCount: this.longTaskCount,
      longTaskTotalDurationMs: roundMilliseconds(this.longTaskTotalDurationMs),
      longTaskMaxDurationMs: roundMilliseconds(this.longTaskMaxDurationMs),
      lastAckRoundTripMs: this.lastAckRoundTripMs,
    };

    try {
      const ack = await this.options.api.rendererHeartbeat(heartbeat);
      if (ack.success && ack.sequence === sequence) {
        this.lastAckRoundTripMs = roundMilliseconds(
          Math.max(0, this.options.monotonicNow() - startedAt),
        );
        if (this.ipcDegraded) {
          this.ipcDegraded = false;
          log.info("Renderer responsiveness IPC recovered");
        }
      }
    } catch (error) {
      if (!this.ipcDegraded) {
        this.ipcDegraded = true;
        log.warn("Renderer responsiveness IPC unavailable", error);
      }
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  private readonly onFrame = () => {
    if (this.stopped) return;
    if (this.options.isDocumentVisible()) this.frameCount += 1;
    this.frameHandle = this.options.requestFrame(this.onFrame);
  };
}

export function startRendererResponsivenessProbe(): () => void {
  const api = window.diagnosticsAPI;
  if (!api) return () => {};

  const probe = new RendererResponsivenessProbe({
    api,
    now: Date.now,
    monotonicNow: () => performance.now(),
    isDocumentVisible: () => document.visibilityState === "visible",
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (handle) => window.cancelAnimationFrame(handle),
    setInterval: (callback, delayMs) => window.setInterval(callback, delayMs),
    clearInterval: (handle) => window.clearInterval(handle),
    subscribeVisibility: (callback) => {
      document.addEventListener("visibilitychange", callback);
      return () => document.removeEventListener("visibilitychange", callback);
    },
    observeLongTasks,
  });
  probe.start();
  void probe.sendHeartbeat();

  const stop = () => {
    window.removeEventListener("pagehide", stop);
    probe.stop();
  };
  window.addEventListener("pagehide", stop, { once: true });
  return stop;
}

function observeLongTasks(callback: (durationMs: number) => void): LongTaskObservation {
  if (
    typeof PerformanceObserver === "undefined" ||
    !PerformanceObserver.supportedEntryTypes?.includes("longtask")
  ) {
    return { supported: false, disconnect() {} };
  }

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) callback(entry.duration);
    });
    observer.observe({ type: "longtask", buffered: true });
    return { supported: true, disconnect: () => observer.disconnect() };
  } catch {
    return { supported: false, disconnect() {} };
  }
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}
