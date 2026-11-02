import fs from "node:fs/promises";
import * as inspector from "node:inspector";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { WebContents } from "electron";

import { createLogger } from "../common/marshal-logger";
import { writeProcessLifecycleEventSync } from "./process-lifecycle-diagnostics";

const log = createLogger("PerformanceFlightRecorder");

const DEFAULT_ROTATION_INTERVAL_MS = 30_000;
const DEFAULT_MAX_PROFILE_FILES = 12;
const DEFAULT_SAMPLING_INTERVAL_US = 5_000;

export interface CpuProfilerTarget {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  dispose(): void;
}

interface ProfileTrack {
  readonly key: string;
  readonly source: "main" | "renderer";
  readonly pid: number;
  readonly target: CpuProfilerTarget;
  started: boolean;
  operation: Promise<void>;
  timer: ReturnType<typeof setInterval> | null;
}

export interface PerformanceFlightRecorderOptions {
  readonly enabled: boolean;
  readonly profileDir: string;
  readonly rotationIntervalMs?: number;
  readonly maxProfileFiles?: number;
  readonly samplingIntervalUs?: number;
  readonly createMainTarget?: (samplingIntervalUs: number) => CpuProfilerTarget;
  readonly createRendererTarget?: (
    webContents: WebContents,
    samplingIntervalUs: number,
  ) => CpuProfilerTarget;
  readonly writeProfile?: (
    profileDir: string,
    filename: string,
    profile: unknown,
    maxProfileFiles: number,
  ) => Promise<void>;
}

/**
 * Keeps a small rolling window of V8 CPU samples for the Electron main process
 * and attached renderers. Completed chunks survive a hard kill; an explicit
 * stall capture rotates the current chunk as soon as the target responds.
 * Profiles remain local and contain code locations/function names, never tool
 * arguments, prompts, or message bodies.
 */
export class PerformanceFlightRecorder {
  private readonly tracks = new Map<string, ProfileTrack>();
  private readonly rotationIntervalMs: number;
  private readonly maxProfileFiles: number;
  private readonly samplingIntervalUs: number;
  private readonly createMainTarget: (samplingIntervalUs: number) => CpuProfilerTarget;
  private readonly createRendererTarget: (
    webContents: WebContents,
    samplingIntervalUs: number,
  ) => CpuProfilerTarget;
  private readonly writeProfile: NonNullable<PerformanceFlightRecorderOptions["writeProfile"]>;
  private stopped = false;

  constructor(private readonly options: PerformanceFlightRecorderOptions) {
    this.rotationIntervalMs = options.rotationIntervalMs ?? DEFAULT_ROTATION_INTERVAL_MS;
    this.maxProfileFiles = options.maxProfileFiles ?? DEFAULT_MAX_PROFILE_FILES;
    this.samplingIntervalUs = options.samplingIntervalUs ?? DEFAULT_SAMPLING_INTERVAL_US;
    this.createMainTarget = options.createMainTarget ?? createMainCpuProfilerTarget;
    this.createRendererTarget = options.createRendererTarget ?? createRendererCpuProfilerTarget;
    this.writeProfile = options.writeProfile ?? writeBoundedProfile;
  }

  startMain(): void {
    if (!this.options.enabled || this.stopped || this.tracks.has("main")) return;
    this.addTrack("main", "main", process.pid, this.createMainTarget(this.samplingIntervalUs));
  }

  attachRenderer(webContents: WebContents): void {
    if (!this.options.enabled || this.stopped || webContents.isDestroyed()) return;
    const key = rendererTrackKey(webContents.id);
    this.removeTrack(key);
    this.addTrack(
      key,
      "renderer",
      webContents.getOSProcessId(),
      this.createRendererTarget(webContents, this.samplingIntervalUs),
    );
  }

  removeRenderer(webContentsId: number): void {
    this.removeTrack(rendererTrackKey(webContentsId));
  }

  captureMain(reason: string): void {
    this.queueRotation(this.tracks.get("main"), reason);
  }

  captureRenderer(webContentsId: number, reason: string): void {
    this.queueRotation(this.tracks.get(rendererTrackKey(webContentsId)), reason);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const tracks = [...this.tracks.values()];
    this.tracks.clear();
    for (const track of tracks) {
      if (track.timer) clearInterval(track.timer);
      track.timer = null;
    }
    await Promise.all(
      tracks.map(async (track) => {
        await track.operation.catch(() => undefined);
        if (track.started) {
          await track.target.stop().catch(() => undefined);
          track.started = false;
        }
        track.target.dispose();
      }),
    );
  }

  private addTrack(
    key: string,
    source: ProfileTrack["source"],
    pid: number,
    target: CpuProfilerTarget,
  ): void {
    const track: ProfileTrack = {
      key,
      source,
      pid,
      target,
      started: false,
      operation: Promise.resolve(),
      timer: null,
    };
    this.tracks.set(key, track);
    track.operation = this.startTrack(track);
    track.timer = setInterval(() => this.queueRotation(track, "rolling"), this.rotationIntervalMs);
    track.timer.unref?.();
  }

  private async startTrack(track: ProfileTrack): Promise<void> {
    try {
      await track.target.start();
      track.started = true;
      writeProcessLifecycleEventSync("performance-profile.started", {
        source: track.source,
        targetPid: track.pid,
        samplingIntervalUs: this.samplingIntervalUs,
      });
    } catch (error) {
      this.disableTrack(track, "start-failed", error);
    }
  }

  private queueRotation(track: ProfileTrack | undefined, reason: string): void {
    if (!track || this.stopped || this.tracks.get(track.key) !== track) return;
    track.operation = track.operation
      .then(() => this.rotateTrack(track, reason))
      .catch((error: unknown) => this.disableTrack(track, "rotation-failed", error));
  }

  private async rotateTrack(track: ProfileTrack, reason: string): Promise<void> {
    if (!track.started || this.stopped || this.tracks.get(track.key) !== track) return;
    const startedAt = performance.now();
    const profile = await track.target.stop();
    track.started = false;
    const filename = profileFilename(track.source, track.pid, reason, Date.now());
    await this.writeProfile(this.options.profileDir, filename, profile, this.maxProfileFiles);
    writeProcessLifecycleEventSync("performance-profile.rotated", {
      source: track.source,
      targetPid: track.pid,
      reason,
      filename,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      ...profileCardinality(profile),
    });
    if (this.stopped || this.tracks.get(track.key) !== track) return;
    await track.target.start();
    track.started = true;
  }

  private removeTrack(key: string): void {
    const track = this.tracks.get(key);
    if (!track) return;
    this.tracks.delete(key);
    if (track.timer) clearInterval(track.timer);
    track.timer = null;
    void track.operation.finally(() => {
      if (track.started) {
        void track.target
          .stop()
          .catch(() => undefined)
          .finally(() => track.target.dispose());
      } else {
        track.target.dispose();
      }
    });
  }

  private disableTrack(track: ProfileTrack, reason: string, error: unknown): void {
    if (this.tracks.get(track.key) === track) this.tracks.delete(track.key);
    if (track.timer) clearInterval(track.timer);
    track.timer = null;
    track.started = false;
    track.target.dispose();
    log.warn(`Disabled ${track.source} CPU profile track (${reason}):`, error);
    writeProcessLifecycleEventSync("performance-profile.disabled", {
      source: track.source,
      targetPid: track.pid,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

class MainCpuProfilerTarget implements CpuProfilerTarget {
  private readonly session = new inspector.Session();
  private connected = false;

  constructor(private readonly samplingIntervalUs: number) {}

  async start(): Promise<void> {
    if (!this.connected) {
      this.session.connect();
      this.connected = true;
      await postInspector(this.session, "Profiler.enable");
      await postInspector(this.session, "Profiler.setSamplingInterval", {
        interval: this.samplingIntervalUs,
      });
    }
    await postInspector(this.session, "Profiler.start");
  }

  async stop(): Promise<unknown> {
    return await stopInspectorProfile(this.session);
  }

  dispose(): void {
    if (!this.connected) return;
    this.connected = false;
    this.session.disconnect();
  }
}

class RendererCpuProfilerTarget implements CpuProfilerTarget {
  private attached = false;

  constructor(
    private readonly webContents: WebContents,
    private readonly samplingIntervalUs: number,
  ) {}

  async start(): Promise<void> {
    if (this.webContents.isDestroyed()) throw new Error("Renderer webContents was destroyed");
    if (!this.attached) {
      if (this.webContents.debugger.isAttached()) {
        throw new Error("Renderer debugger is already attached");
      }
      this.webContents.debugger.attach("1.3");
      this.attached = true;
      await this.webContents.debugger.sendCommand("Profiler.enable");
      await this.webContents.debugger.sendCommand("Profiler.setSamplingInterval", {
        interval: this.samplingIntervalUs,
      });
    }
    await this.webContents.debugger.sendCommand("Profiler.start");
  }

  async stop(): Promise<unknown> {
    if (this.webContents.isDestroyed() || !this.attached) {
      throw new Error("Renderer profiler is not attached");
    }
    const result: unknown = await this.webContents.debugger.sendCommand("Profiler.stop");
    if (!isRecord(result) || !("profile" in result)) {
      throw new Error("Renderer profiler returned no CPU profile");
    }
    return result.profile;
  }

  dispose(): void {
    if (!this.attached || this.webContents.isDestroyed()) return;
    this.attached = false;
    try {
      this.webContents.debugger.detach();
    } catch {
      // The renderer may have exited between the destroyed check and detach.
    }
  }
}

function createMainCpuProfilerTarget(samplingIntervalUs: number): CpuProfilerTarget {
  return new MainCpuProfilerTarget(samplingIntervalUs);
}

function createRendererCpuProfilerTarget(
  webContents: WebContents,
  samplingIntervalUs: number,
): CpuProfilerTarget {
  return new RendererCpuProfilerTarget(webContents, samplingIntervalUs);
}

function postInspector(
  session: inspector.Session,
  method: "Profiler.enable" | "Profiler.start",
): Promise<void>;
function postInspector(
  session: inspector.Session,
  method: "Profiler.setSamplingInterval",
  params: { interval: number },
): Promise<void>;
function postInspector(
  session: inspector.Session,
  method: "Profiler.enable" | "Profiler.start" | "Profiler.setSamplingInterval",
  params?: { interval: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const callback = (error: Error | null) => (error ? reject(error) : resolve());
    if (method === "Profiler.setSamplingInterval" && params) {
      session.post(method, params, callback);
    } else {
      session.post(method, callback);
    }
  });
}

function stopInspectorProfile(session: inspector.Session): Promise<unknown> {
  return new Promise((resolve, reject) => {
    session.post("Profiler.stop", (error, result) => {
      if (error) reject(error);
      else resolve(result.profile);
    });
  });
}

async function writeBoundedProfile(
  profileDir: string,
  filename: string,
  profile: unknown,
  maxProfileFiles: number,
): Promise<void> {
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  const destination = path.join(profileDir, filename);
  const temporary = `${destination}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(profile), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, destination);
  const entries = (await fs.readdir(profileDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".cpuprofile"))
    .map((entry) => entry.name);
  if (entries.length <= maxProfileFiles) return;
  const withTimes = await Promise.all(
    entries.map(async (entry) => ({
      entry,
      modifiedMs: (await fs.stat(path.join(profileDir, entry))).mtimeMs,
    })),
  );
  withTimes.sort((left, right) => right.modifiedMs - left.modifiedMs);
  await Promise.all(
    withTimes
      .slice(maxProfileFiles)
      .map(({ entry }) => fs.rm(path.join(profileDir, entry), { force: true })),
  );
}

function rendererTrackKey(webContentsId: number): string {
  return `renderer:${webContentsId}`;
}

function profileFilename(
  source: ProfileTrack["source"],
  pid: number,
  reason: string,
  timestamp: number,
): string {
  const safeReason = reason.replace(/[^a-z0-9-]+/gi, "-").slice(0, 40) || "capture";
  return `${timestamp}-${source}-${pid}-${safeReason}.cpuprofile`;
}

function profileCardinality(profile: unknown): { sampleCount?: number; nodeCount?: number } {
  if (!isRecord(profile)) return {};
  return {
    ...(Array.isArray(profile.samples) ? { sampleCount: profile.samples.length } : {}),
    ...(Array.isArray(profile.nodes) ? { nodeCount: profile.nodes.length } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
