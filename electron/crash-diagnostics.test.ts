import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildWatchdogScript,
  buildWindowsLocalDumpRegistryCommands,
  getWindowsLocalDumpExeNames,
  maybeWriteHeapSnapshot,
  resolveCrashDiagnosticsPaths,
  resolveHeapSnapshotDir,
  writeProcessHeartbeatSnapshot,
} from "./crash-diagnostics";

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.MARSHAL_HEAP_SNAPSHOT_DIR;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-crash-diagnostics-"));
  tempDirs.push(dir);
  return dir;
}

describe("crash diagnostics", () => {
  it("resolves all diagnostic paths under the app data crash root", () => {
    const root = makeTempDir();
    const paths = resolveCrashDiagnosticsPaths(root, "linux", () => false);

    expect(paths.rootDir).toBe(path.join(root, "marshal-crashes"));
    expect(paths.crashpadDir).toBe(path.join(root, "marshal-crashes", "crashpad"));
    expect(paths.werDir).toBe(path.join(root, "marshal-crashes", "wer"));
    expect(paths.watchdogDir).toBe(path.join(root, "marshal-crashes", "watchdog"));
    expect(paths.heapSnapshotDir).toBe(path.join(root, "marshal-crashes", "heap-snapshots"));
    expect(paths.heartbeatPath).toBe(
      path.join(root, "marshal-crashes", "marshal-process-heartbeat.json"),
    );
  });

  it("prefers Q: for heap snapshots on Windows when that drive exists", () => {
    const dir = resolveHeapSnapshotDir(
      "C:\\Users\\me\\.marshal",
      "win32",
      (filePath) => filePath === "Q:\\",
    );

    expect(dir).toBe("Q:\\.marshal\\marshal-crashes\\heap-snapshots");
  });

  it("allows an explicit heap snapshot directory override", () => {
    const override = path.join(path.sep, "custom-heap");
    process.env.MARSHAL_HEAP_SNAPSHOT_DIR = override;

    expect(resolveHeapSnapshotDir("C:\\Users\\me\\.marshal", "win32", () => false)).toBe(override);
  });

  it("writes a heartbeat snapshot with process identity and memory", () => {
    const heartbeatPath = path.join(makeTempDir(), "heartbeat.json");
    const snapshot = writeProcessHeartbeatSnapshot(heartbeatPath, 123, 45, "test");
    const parsed = JSON.parse(fs.readFileSync(heartbeatPath, "utf8"));

    expect(snapshot.pid).toBe(123);
    expect(parsed.pid).toBe(123);
    expect(parsed.ppid).toBe(45);
    expect(parsed.reason).toBe("test");
    expect(parsed.memory.rss).toBeGreaterThan(0);
  });

  it("writes a heap snapshot when heap usage crosses the configured threshold", () => {
    const dir = makeTempDir();
    const written: string[] = [];
    const result = maybeWriteHeapSnapshot({
      dir,
      thresholdBytes: 1024,
      memory: {
        rss: 2048,
        heapTotal: 2048,
        heapUsed: 1500,
        external: 0,
        arrayBuffers: 0,
      },
      snapshotWriter: (filePath) => {
        written.push(filePath);
        fs.writeFileSync(filePath, "snapshot");
        return filePath;
      },
    });

    expect(result?.path).toBe(written[0]);
    expect(written[0]).toContain("m-main-heap-");
    expect(written[0]).toMatch(/\.heapsnapshot$/);
  });

  it("does not write a heap snapshot below threshold", () => {
    const writer = () => {
      throw new Error("should not write");
    };

    expect(
      maybeWriteHeapSnapshot({
        dir: makeTempDir(),
        thresholdBytes: 2048,
        memory: { rss: 2048, heapTotal: 2048, heapUsed: 1024, external: 0, arrayBuffers: 0 },
        snapshotWriter: writer,
      }),
    ).toBeNull();
  });

  it("builds WER LocalDumps registry commands", () => {
    const commands = buildWindowsLocalDumpRegistryCommands(
      "Marshal.exe",
      "C:\\Users\\me\\.marshal\\marshal-crashes\\wer",
      7,
    );

    expect(commands).toEqual([
      [
        "add",
        "HKCU\\Software\\Microsoft\\Windows\\Windows Error Reporting\\LocalDumps\\Marshal.exe",
        "/v",
        "DumpFolder",
        "/t",
        "REG_EXPAND_SZ",
        "/d",
        "C:\\Users\\me\\.marshal\\marshal-crashes\\wer",
        "/f",
      ],
      [
        "add",
        "HKCU\\Software\\Microsoft\\Windows\\Windows Error Reporting\\LocalDumps\\Marshal.exe",
        "/v",
        "DumpType",
        "/t",
        "REG_DWORD",
        "/d",
        "2",
        "/f",
      ],
      [
        "add",
        "HKCU\\Software\\Microsoft\\Windows\\Windows Error Reporting\\LocalDumps\\Marshal.exe",
        "/v",
        "DumpCount",
        "/t",
        "REG_DWORD",
        "/d",
        "7",
        "/f",
      ],
    ]);
  });

  it("includes current executable and known sidecar executables for WER", () => {
    const names = getWindowsLocalDumpExeNames("C:\\Program Files\\Marshal\\MarshalDev.exe");

    expect(names).toEqual(
      expect.arrayContaining([
        "copilot.exe",
        "Marshal.exe",
        "node-runner.exe",
        "node.exe",
        "MarshalDev.exe",
      ]),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it("builds a watchdog script that records start and exit observations", () => {
    const script = buildWatchdogScript();

    expect(script).toContain("watchdog.started");
    expect(script).toContain("watchdog.process-exited");
    expect(script).toContain("$process.WaitForExit()");
    expect(script).toContain("heartbeatAgeMs");
  });
});
