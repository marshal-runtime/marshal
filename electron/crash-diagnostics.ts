import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { writeHeapSnapshot } from "node:v8";

import type { App, CrashReporter } from "electron";

import { APP_NAME } from "../common/marshal-constants";
import { getAppDataDir } from "./app-paths";
import { secureMkdirSync, secureWriteFileSync } from "./platform-security";
import { summarizeError, writeProcessLifecycleEventSync } from "./process-lifecycle-diagnostics";

const CRASH_DIRNAME = "marshal-crashes";
const CRASHPAD_DIRNAME = "crashpad";
const WER_DIRNAME = "wer";
const WATCHDOG_DIRNAME = "watchdog";
const HEAP_SNAPSHOT_DIRNAME = "heap-snapshots";
const HEARTBEAT_FILENAME = "marshal-process-heartbeat.json";
const WATCHDOG_SCRIPT_FILENAME = "marshal-process-watchdog.ps1";
const WATCHDOG_LOG_FILENAME = "marshal-process-watchdog.jsonl";
const HEARTBEAT_INTERVAL_MS = 30000;
const DEFAULT_WER_DUMP_COUNT = 10;
const DEFAULT_HEAP_SNAPSHOT_THRESHOLD_MB = 3 * 1024;
const DEFAULT_HEAP_SNAPSHOT_MAX_COUNT = 3;
const HEAP_SNAPSHOT_PREFIX = "m-main-heap";

type CrashReporterForDiagnostics = Pick<CrashReporter, "start" | "addExtraParameter">;

export interface CrashDiagnosticsInstallOptions {
  readonly app: Pick<App, "getVersion" | "isPackaged" | "setPath">;
  readonly crashReporter: CrashReporterForDiagnostics;
  readonly execPath?: string;
  readonly pid?: number;
  readonly ppid?: number;
  readonly platform?: NodeJS.Platform;
}

export interface CrashDiagnosticsHandle {
  readonly paths: CrashDiagnosticsPaths;
  stop(reason?: string): void;
}

export interface CrashDiagnosticsPaths {
  readonly rootDir: string;
  readonly crashpadDir: string;
  readonly werDir: string;
  readonly watchdogDir: string;
  readonly heapSnapshotDir: string;
  readonly heartbeatPath: string;
  readonly watchdogLogPath: string;
}

interface ProcessHeartbeatSnapshot {
  readonly timestamp: string;
  readonly pid: number;
  readonly ppid: number;
  readonly uptimeMs: number;
  readonly reason: string;
  readonly memory: NodeJS.MemoryUsage;
}

interface HeapSnapshotConfig {
  readonly enabled: boolean;
  readonly dir: string;
  readonly thresholdBytes: number;
  readonly maxCount: number;
}

export interface HeapSnapshotResult {
  readonly path: string;
  readonly heapUsed: number;
  readonly thresholdBytes: number;
}

export function installCrashDiagnostics(
  options: CrashDiagnosticsInstallOptions,
): CrashDiagnosticsHandle {
  const platform = options.platform ?? process.platform;
  const pid = options.pid ?? process.pid;
  const ppid = options.ppid ?? process.ppid;
  const execPath = options.execPath ?? process.execPath;
  const paths = resolveCrashDiagnosticsPaths(undefined, platform);
  const heapSnapshotConfig = resolveHeapSnapshotConfig(paths.heapSnapshotDir);

  writeProcessLifecycleEventSync("crash-diagnostics.install.started", {
    platform,
    pid,
    ppid,
  });

  startElectronCrashReporter(options.app, options.crashReporter, paths.crashpadDir, pid, ppid);
  const heartbeat = startProcessHeartbeat(paths.heartbeatPath, pid, ppid, heapSnapshotConfig);
  maybeScheduleCrashDiagnosticProbe();

  if (platform === "win32") {
    registerWindowsLocalDumps(paths.werDir, execPath);
    startWindowsProcessWatchdog({
      pid,
      execPath,
      heartbeatPath: paths.heartbeatPath,
      watchdogDir: paths.watchdogDir,
      logPath: paths.watchdogLogPath,
    });
  }

  writeProcessLifecycleEventSync("crash-diagnostics.install.complete", { ...paths });

  return {
    paths,
    stop(reason = "stop") {
      heartbeat.stop(reason);
    },
  };
}

export function resolveCrashDiagnosticsPaths(
  appDataDir = getAppDataDir(),
  platform: NodeJS.Platform = process.platform,
  existsSync: (filePath: string) => boolean = fs.existsSync,
): CrashDiagnosticsPaths {
  const rootDir = path.join(appDataDir, CRASH_DIRNAME);
  const crashpadDir = path.join(rootDir, CRASHPAD_DIRNAME);
  const werDir = path.join(rootDir, WER_DIRNAME);
  const watchdogDir = path.join(rootDir, WATCHDOG_DIRNAME);
  const heapSnapshotDir = resolveHeapSnapshotDir(appDataDir, platform, existsSync);
  return {
    rootDir,
    crashpadDir,
    werDir,
    watchdogDir,
    heapSnapshotDir,
    heartbeatPath: path.join(rootDir, HEARTBEAT_FILENAME),
    watchdogLogPath: path.join(watchdogDir, WATCHDOG_LOG_FILENAME),
  };
}

export function resolveHeapSnapshotDir(
  appDataDir = getAppDataDir(),
  platform: NodeJS.Platform = process.platform,
  existsSync: (filePath: string) => boolean = fs.existsSync,
): string {
  const override = process.env.MARSHAL_HEAP_SNAPSHOT_DIR?.trim();
  if (override) return path.resolve(override);

  if (platform === "win32" && existsSync("Q:\\")) {
    return "Q:\\.marshal\\marshal-crashes\\heap-snapshots";
  }

  return path.join(appDataDir, CRASH_DIRNAME, HEAP_SNAPSHOT_DIRNAME);
}

export function writeProcessHeartbeatSnapshot(
  heartbeatPath: string,
  pid = process.pid,
  ppid = process.ppid,
  reason = "tick",
): ProcessHeartbeatSnapshot {
  const snapshot = {
    timestamp: new Date().toISOString(),
    pid,
    ppid,
    uptimeMs: Math.round(process.uptime() * 1000),
    reason,
    memory: process.memoryUsage(),
  };
  secureMkdirSync(path.dirname(heartbeatPath), 0o700);
  secureWriteFileSync(heartbeatPath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  return snapshot;
}

export function getWindowsLocalDumpExeNames(execPath: string): string[] {
  const names = new Set(["Marshal.exe", "node.exe", "node-runner.exe", "copilot.exe"]);
  const currentName = path.win32.basename(execPath);
  if (/\.exe$/i.test(currentName)) names.add(currentName);
  return [...names].sort((left, right) => left.localeCompare(right));
}

export function buildWindowsLocalDumpRegistryCommands(
  exeName: string,
  dumpFolder: string,
  dumpCount = DEFAULT_WER_DUMP_COUNT,
): string[][] {
  const key = `HKCU\\Software\\Microsoft\\Windows\\Windows Error Reporting\\LocalDumps\\${exeName}`;
  return [
    ["add", key, "/v", "DumpFolder", "/t", "REG_EXPAND_SZ", "/d", dumpFolder, "/f"],
    ["add", key, "/v", "DumpType", "/t", "REG_DWORD", "/d", "2", "/f"],
    ["add", key, "/v", "DumpCount", "/t", "REG_DWORD", "/d", String(dumpCount), "/f"],
  ];
}

export function buildWatchdogScript(): string {
  return String.raw`param(
  [Parameter(Mandatory=$true)][int]$WatchedPid,
  [Parameter(Mandatory=$true)][string]$LogPath,
  [Parameter(Mandatory=$true)][string]$HeartbeatPath,
  [Parameter(Mandatory=$true)][string]$ExeName,
  [Parameter(Mandatory=$true)][string]$StartedAt
)

$ErrorActionPreference = 'SilentlyContinue'

function Write-WatchdogEvent {
  param([string]$Event, [hashtable]$Details)
  $entry = [ordered]@{
    timestamp = (Get-Date).ToUniversalTime().ToString('o')
    pid = $PID
    watchedPid = $WatchedPid
    event = $Event
    details = $Details
  }
  $line = $entry | ConvertTo-Json -Compress -Depth 8
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
}

$logDir = Split-Path -Parent $LogPath
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$process = Get-Process -Id $WatchedPid -ErrorAction SilentlyContinue
if ($null -eq $process) {
  Write-WatchdogEvent 'watchdog.process-missing-at-start' @{ exeName = $ExeName; startedAt = $StartedAt }
  exit 0
}

Write-WatchdogEvent 'watchdog.started' @{
  exeName = $ExeName
  startedAt = $StartedAt
  processStartTime = $process.StartTime.ToUniversalTime().ToString('o')
}

try {
  $process.WaitForExit()
} catch {
  Wait-Process -Id $WatchedPid
}

$heartbeatTimestamp = $null
$heartbeatAgeMs = $null
$heartbeatPid = $null
$heartbeatReason = $null
if (Test-Path -LiteralPath $HeartbeatPath) {
  try {
    $heartbeat = Get-Content -LiteralPath $HeartbeatPath -Raw | ConvertFrom-Json
    $heartbeatTimestamp = [string]$heartbeat.timestamp
    $heartbeatPid = $heartbeat.pid
    $heartbeatReason = [string]$heartbeat.reason
    if ($heartbeatTimestamp) {
      $heartbeatAgeMs = [int]((Get-Date).ToUniversalTime() - [datetime]$heartbeatTimestamp).TotalMilliseconds
    }
  } catch {}
}

$exitCode = $null
try { $exitCode = $process.ExitCode } catch {}

Write-WatchdogEvent 'watchdog.process-exited' @{
  exeName = $ExeName
  startedAt = $StartedAt
  exitCode = $exitCode
  heartbeatTimestamp = $heartbeatTimestamp
  heartbeatAgeMs = $heartbeatAgeMs
  heartbeatPid = $heartbeatPid
  heartbeatReason = $heartbeatReason
}
`;
}

function startElectronCrashReporter(
  app: CrashDiagnosticsInstallOptions["app"],
  crashReporter: CrashReporterForDiagnostics,
  crashpadDir: string,
  pid: number,
  ppid: number,
): void {
  secureMkdirSync(crashpadDir, 0o700);
  let setPathSucceeded = false;
  try {
    app.setPath("crashDumps", crashpadDir);
    setPathSucceeded = true;
  } catch (error) {
    writeProcessLifecycleEventSync("crashReporter.setPath.failed", {
      error: summarizeError(error),
    });
  }

  try {
    crashReporter.start({
      productName: APP_NAME,
      uploadToServer: false,
      ignoreSystemCrashHandler: false,
      compress: false,
      globalExtra: {
        appVersion: app.getVersion().slice(0, 127),
        packaged: String(app.isPackaged),
        pid: String(pid),
        ppid: String(ppid),
      },
    });
    crashReporter.addExtraParameter("mainPid", String(pid));
    writeProcessLifecycleEventSync("crashReporter.started", {
      setPathSucceeded,
      uploadToServer: false,
    });
  } catch (error) {
    writeProcessLifecycleEventSync("crashReporter.start.failed", {
      setPathSucceeded,
      error: summarizeError(error),
    });
  }
}

function startProcessHeartbeat(
  heartbeatPath: string,
  pid: number,
  ppid: number,
  heapSnapshotConfig?: HeapSnapshotConfig,
): { stop(reason: string): void } {
  let heapSnapshotWritten = false;
  const record = (reason: string): void => {
    const snapshot = writeProcessHeartbeatSnapshot(heartbeatPath, pid, ppid, reason);
    if (!heapSnapshotConfig?.enabled || heapSnapshotWritten) return;
    const result = maybeWriteHeapSnapshot({
      memory: snapshot.memory,
      dir: heapSnapshotConfig.dir,
      thresholdBytes: heapSnapshotConfig.thresholdBytes,
      maxCount: heapSnapshotConfig.maxCount,
      reason,
    });
    if (result) heapSnapshotWritten = true;
  };

  record("start");
  const timer = setInterval(() => {
    record("tick");
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  return {
    stop(reason: string) {
      clearInterval(timer);
      record(reason);
    },
  };
}

function resolveHeapSnapshotConfig(dir: string): HeapSnapshotConfig {
  const thresholdMb = Number(
    process.env.MARSHAL_HEAP_SNAPSHOT_THRESHOLD_MB ?? DEFAULT_HEAP_SNAPSHOT_THRESHOLD_MB,
  );
  const maxCount = Number(
    process.env.MARSHAL_HEAP_SNAPSHOT_MAX_COUNT ?? DEFAULT_HEAP_SNAPSHOT_MAX_COUNT,
  );
  return {
    enabled: process.env.MARSHAL_DISABLE_HEAP_SNAPSHOT !== "1",
    dir,
    thresholdBytes:
      Number.isFinite(thresholdMb) && thresholdMb > 0
        ? Math.floor(thresholdMb * 1024 * 1024)
        : DEFAULT_HEAP_SNAPSHOT_THRESHOLD_MB * 1024 * 1024,
    maxCount:
      Number.isFinite(maxCount) && maxCount > 0
        ? Math.floor(maxCount)
        : DEFAULT_HEAP_SNAPSHOT_MAX_COUNT,
  };
}

export function maybeWriteHeapSnapshot(args: {
  readonly memory: NodeJS.MemoryUsage;
  readonly dir: string;
  readonly thresholdBytes: number;
  readonly maxCount?: number;
  readonly reason?: string;
  readonly snapshotWriter?: (filePath: string) => string;
}): HeapSnapshotResult | null {
  if (args.memory.heapUsed < args.thresholdBytes) return null;

  try {
    secureMkdirSync(args.dir, 0o700);
    const filePath = path.join(
      args.dir,
      `${HEAP_SNAPSHOT_PREFIX}-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.heapsnapshot`,
    );
    writeProcessLifecycleEventSync("heap-snapshot.threshold-crossed", {
      reason: args.reason,
      heapUsed: args.memory.heapUsed,
      heapTotal: args.memory.heapTotal,
      rss: args.memory.rss,
      thresholdBytes: args.thresholdBytes,
      path: filePath,
    });
    const writtenPath = args.snapshotWriter?.(filePath) ?? writeHeapSnapshot(filePath);
    pruneHeapSnapshots(args.dir, args.maxCount ?? DEFAULT_HEAP_SNAPSHOT_MAX_COUNT);
    writeProcessLifecycleEventSync("heap-snapshot.written", {
      path: writtenPath,
      heapUsed: args.memory.heapUsed,
      thresholdBytes: args.thresholdBytes,
    });
    return {
      path: writtenPath,
      heapUsed: args.memory.heapUsed,
      thresholdBytes: args.thresholdBytes,
    };
  } catch (error) {
    writeProcessLifecycleEventSync("heap-snapshot.failed", {
      error: summarizeError(error),
      dir: args.dir,
      heapUsed: args.memory.heapUsed,
      thresholdBytes: args.thresholdBytes,
    });
    return null;
  }
}

function pruneHeapSnapshots(dir: string, maxCount: number): void {
  try {
    const snapshots = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".heapsnapshot"))
      .map((entry) => {
        const filePath = path.join(dir, entry.name);
        return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs);

    for (const snapshot of snapshots.slice(maxCount)) {
      fs.rmSync(snapshot.filePath, { force: true });
    }
  } catch (error) {
    writeProcessLifecycleEventSync("heap-snapshot.prune.failed", {
      error: summarizeError(error),
      dir,
    });
  }
}

function registerWindowsLocalDumps(dumpFolder: string, execPath: string): void {
  if (process.env.MARSHAL_DISABLE_WER_LOCAL_DUMPS === "1") {
    writeProcessLifecycleEventSync("windows.local-dumps.disabled", {});
    return;
  }

  secureMkdirSync(dumpFolder, 0o700);
  const exeNames = getWindowsLocalDumpExeNames(execPath);
  writeProcessLifecycleEventSync("windows.local-dumps.register.started", {
    exeNames,
  });

  for (const exeName of exeNames) {
    for (const args of buildWindowsLocalDumpRegistryCommands(exeName, dumpFolder)) {
      execFile("reg.exe", args, { windowsHide: true }, (error) => {
        writeProcessLifecycleEventSync("windows.local-dumps.reg", {
          exeName,
          valueName: args[3],
          success: !error,
          error: error ? summarizeError(error) : undefined,
        });
      });
    }
  }
}

function startWindowsProcessWatchdog(options: {
  readonly pid: number;
  readonly execPath: string;
  readonly heartbeatPath: string;
  readonly watchdogDir: string;
  readonly logPath: string;
}): void {
  if (process.env.MARSHAL_DISABLE_PROCESS_WATCHDOG === "1") {
    writeProcessLifecycleEventSync("process-watchdog.disabled", {});
    return;
  }

  secureMkdirSync(options.watchdogDir, 0o700);
  const scriptPath = path.join(options.watchdogDir, WATCHDOG_SCRIPT_FILENAME);
  secureWriteFileSync(scriptPath, buildWatchdogScript(), { mode: 0o600 });

  try {
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-WatchedPid",
        String(options.pid),
        "-LogPath",
        options.logPath,
        "-HeartbeatPath",
        options.heartbeatPath,
        "-ExeName",
        path.win32.basename(options.execPath),
        "-StartedAt",
        new Date().toISOString(),
      ],
      { detached: true, stdio: "ignore", windowsHide: true, shell: false },
    );
    child.unref();
    writeProcessLifecycleEventSync("process-watchdog.started", {
      watchdogPid: child.pid,
    });
  } catch (error) {
    writeProcessLifecycleEventSync("process-watchdog.start.failed", {
      error: summarizeError(error),
    });
  }
}

function maybeScheduleCrashDiagnosticProbe(): void {
  const probe = process.env.MARSHAL_CRASH_DIAGNOSTIC_PROBE;
  if (!probe) return;

  const delayMs = Number(process.env.MARSHAL_CRASH_DIAGNOSTIC_DELAY_MS ?? "5000");
  const timer = setTimeout(
    () => {
      writeProcessLifecycleEventSync("crash-diagnostic-probe.triggered", { probe });
      if (probe === "throw") {
        throw new Error("MARSHAL_CRASH_DIAGNOSTIC_PROBE=throw");
      }
      if (probe === "process-abort") {
        process.abort();
      }
      if (probe === "process-crash") {
        const maybeCrash = process as NodeJS.Process & { crash?: () => void };
        if (typeof maybeCrash.crash === "function") {
          maybeCrash.crash();
        }
        process.abort();
      }
      if (probe === "process-exit") {
        process.exit(86);
      }
    },
    Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 5000,
  );
  timer.unref?.();
  writeProcessLifecycleEventSync("crash-diagnostic-probe.scheduled", {
    probe,
    delayMs,
  });
}
