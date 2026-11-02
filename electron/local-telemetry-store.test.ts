import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createSocket as createDatagramSocket } from "node:dgram";
import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ipcErrors, makeIpcError } from "../common/telemetry/errors/marshal-ipc";
import {
  formatLocalTelemetryFileName,
  parseLocalTelemetryFileName,
} from "./local-telemetry-file-name";
import {
  LocalTelemetryStore as LocalTelemetryStoreImpl,
  type SanitizedLocalTelemetryEvent,
  type LocalTelemetrySecurityOps,
  type LocalTelemetryStoreOptions,
  resolveLocalTelemetryAdmissionEndpoints,
  resolveLocalTelemetryCommitEndpoints,
  sanitizeLocalTelemetryEvent,
} from "./local-telemetry-store";
import * as platformSecurity from "./platform-security";

const NOW = new Date("2026-08-01T09:00:00.000Z");
const IPC_UNAUTHORIZED = makeIpcError(ipcErrors.UNAUTHORIZED_SENDER);
const execFileAsync = promisify(execFile);

let tempDir: string;
let stores: LocalTelemetryStoreImpl[];

class LocalTelemetryStore extends LocalTelemetryStoreImpl {
  private generationPrime: Promise<void> | null = null;

  constructor(options: LocalTelemetryStoreOptions = {}) {
    super(options);
    stores.push(this);
  }

  override append(event: SanitizedLocalTelemetryEvent): Promise<void> {
    const prime = this.generationPrime ?? this.primeGeneration();
    return prime.then(() => super.append(event));
  }

  override prune(): Promise<void> {
    const prune = super.prune();
    this.generationPrime = prune;
    void prune.catch(() => {
      if (this.generationPrime === prune) this.generationPrime = null;
    });
    return prune;
  }

  private primeGeneration(): Promise<void> {
    const prime = super.prune();
    this.generationPrime = prime;
    void prime.catch(() => {
      if (this.generationPrime === prime) this.generationPrime = null;
    });
    return prime;
  }
}

beforeEach(async () => {
  stores = [];
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "marshal-local-telemetry-"));
});

afterEach(async () => {
  await Promise.allSettled(stores.map((store) => store.flush()));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.all(
    [
      ...new Set(
        stores.flatMap((store) => {
          const parent = path.dirname(store.directory);
          const base = path.basename(store.directory);
          return [
            path.join(parent, `.${base}-blocked-v1`),
            path.join(parent, `.${base}-owner-v1`),
            path.join(parent, `.${base}-delete-fence-v1`),
            path.join(parent, `.${base}-logical-dates-v2-a`),
            path.join(parent, `.${base}-logical-dates-v2-b`),
            path.join(parent, `.${base}-logical-dates-required-v1`),
            path.join(parent, `.${base}-commit.lock`),
          ];
        }),
      ),
    ].map((metadataPath) => fs.rm(metadataPath, { recursive: true, force: true })),
  );
  await fs.rm(tempDir, { recursive: true, force: true });
});

function fetchEvent(overrides: Record<string, unknown> = {}) {
  return sanitizeLocalTelemetryEvent({
    eventType: "Marshal.Fetch",
    fields: {
      appVersion: "1.2.3",
      sessionCorrelationId: "session-local-1",
      scenario: "LlmTokenUsage",
      source: "HostApp",
      result: "success",
      duration: 250,
      requestCorrelationId: "remote-request-id",
      responseCorrelationId: "remote-provider-id",
      userId: "user-id-1",
      tenantId: "tenant-id-1",
      misc: JSON.stringify({
        model: "gpt-5",
        inputTokens: 100,
        outputTokens: 50,
        cost: 0.01,
        apiCallId: "remote-request-id",
        providerCallId: "remote-provider-id",
        prompt: "customer prompt",
        response: "customer response",
        email: "person@example.com",
        feedbackText: "free form feedback",
      }),
      ...overrides,
    },
  });
}

async function telemetryFileNames(directory = tempDir): Promise<string[]> {
  return (await fs.readdir(directory))
    .filter((name) => parseLocalTelemetryFileName(name) !== null)
    .sort();
}

async function commitEndpointsForDirectory(directory: string) {
  const ancestor = await fs.realpath(path.dirname(directory));
  const basename = path.basename(directory).normalize("NFC");
  const profileKey = `${
    process.platform === "win32" ? ancestor.toLowerCase() : ancestor
  }\0${process.platform === "win32" ? basename.toLowerCase() : basename}`;
  return resolveLocalTelemetryCommitEndpoints(profileKey);
}

async function readLogicalDateMetadata(directory = tempDir): Promise<string> {
  const parent = path.dirname(directory);
  const base = path.basename(directory);
  const contents = await Promise.all(
    (["a", "b"] as const).map(async (buffer) => {
      try {
        return await fs.readFile(path.join(parent, `.${base}-logical-dates-v2-${buffer}`), "utf8");
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return "";
        }
        throw error;
      }
    }),
  );
  return contents.join("\n");
}

async function createOwnedCapture(
  configuredDirectory: string,
  captureDirectory: string,
  createdAtMs: number,
): Promise<void> {
  const ownerPath = path.join(
    path.dirname(configuredDirectory),
    `.${path.basename(configuredDirectory)}-owner-v1`,
  );
  const [, ownerToken] = (await fs.readFile(ownerPath, "utf8")).trim().split("\t");
  await fs.mkdir(captureDirectory);
  const stat = await fs.lstat(captureDirectory);
  await fs.writeFile(
    path.join(captureDirectory, ".marshal-telemetry-root-v1"),
    `v1\t${ownerToken}\t${stat.dev}\t${stat.ino}\t${createdAtMs}\n`,
  );
}

async function createMappedOldShell(options: { maxLogicalDatesBytes?: number } = {}) {
  const oldNames = ["events-2020-01-01-000.jsonl", "events-2020-01-02-000.jsonl"];
  await Promise.all(oldNames.map((name) => fs.writeFile(path.join(tempDir, name), "")));
  const store = new LocalTelemetryStore({
    directory: tempDir,
    now: () => new Date("2026-08-01T09:00:00.000Z"),
    maxShells: 2,
    maxLogicalDatesBytes: options.maxLogicalDatesBytes,
  });
  await store.append({
    eventType: "Marshal.Fetch",
    fields: { scenario: "mapped-current-event" },
  });
  await store.flush();
  const mapped = (
    await Promise.all(
      oldNames.map(async (name) => ({
        name,
        content: await fs.readFile(path.join(tempDir, name), "utf8"),
      })),
    )
  ).find((entry) => entry.content.includes("mapped-current-event"));
  if (!mapped) throw new Error("mapped_shell_missing");
  return {
    mappedPath: path.join(tempDir, mapped.name),
    bufferA: path.join(path.dirname(tempDir), `.${path.basename(tempDir)}-logical-dates-v2-a`),
    bufferB: path.join(path.dirname(tempDir), `.${path.basename(tempDir)}-logical-dates-v2-b`),
    requiredPath: path.join(
      path.dirname(tempDir),
      `.${path.basename(tempDir)}-logical-dates-required-v1`,
    ),
  };
}

function logicalDateChecksum(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

async function createLogicalDateGenerationFixture(days = 6) {
  const oldNames = ["events-2020-01-01-000.jsonl", "events-2020-01-02-000.jsonl"];
  await Promise.all(oldNames.map((name) => fs.writeFile(path.join(tempDir, name), "")));
  let now = new Date("2026-08-01T09:00:00.000Z");
  const options = {
    directory: tempDir,
    now: () => now,
    maxShells: 2,
    maxFileBytes: 220,
    maxTotalBytes: 1024 * 1024,
    maxLogicalDatesBytes: 1024,
    retentionDays: 30,
  };
  const store = new LocalTelemetryStore(options);
  for (let day = 1; day <= days; day++) {
    now = new Date(Date.UTC(2026, 7, day, 9));
    // eslint-disable-next-line no-await-in-loop -- each day advances one recycled-shell revision
    await store.append({
      eventType: "Marshal.Fetch",
      fields: { scenario: `logical-generation-${String(day).padStart(2, "0")}` },
    });
  }
  await store.flush();
  const parent = path.dirname(tempDir);
  const base = path.basename(tempDir);
  const buffers = await Promise.all(
    (["a", "b"] as const).map(async (buffer) => {
      const filePath = path.join(parent, `.${base}-logical-dates-v2-${buffer}`);
      const content = await fs.readFile(filePath, "utf8");
      const generation = Number(content.split("\n", 1)[0]?.split("\t")[2]);
      return { buffer, filePath, content, generation };
    }),
  );
  const active = [...buffers].sort((left, right) => right.generation - left.generation)[0];
  const inactive = buffers.find((entry) => entry.buffer !== active.buffer);
  if (!inactive) throw new Error("logical_inactive_buffer_missing");
  const latestMarker = `logical-generation-${String(days).padStart(2, "0")}`;
  const latest = (
    await Promise.all(
      oldNames.map(async (name) => ({
        path: path.join(tempDir, name),
        content: await fs.readFile(path.join(tempDir, name), "utf8"),
      })),
    )
  ).find((entry) => entry.content.includes(latestMarker));
  if (!latest) throw new Error("logical_latest_event_missing");
  return { active, inactive, latest, options, setNow: (value: Date) => (now = value) };
}

function createSecurityOps() {
  const modes = new Map<string, number>();
  let failFileChmod = false;
  const chmod = vi.fn<LocalTelemetrySecurityOps["chmod"]>(async (targetPath, mode) => {
    if (failFileChmod && targetPath.endsWith(".jsonl")) {
      failFileChmod = false;
      throw Object.assign(new Error("transient chmod failure"), { code: "EPERM" });
    }

    modes.set(targetPath, mode);
  });
  const securityOps: LocalTelemetrySecurityOps = {
    getPathInfo: async (targetPath) => {
      const stat = await fs.lstat(targetPath);
      return {
        kind: stat.isSymbolicLink()
          ? "other"
          : stat.isDirectory()
            ? "directory"
            : stat.isFile()
              ? "file"
              : "other",
        mode: modes.get(targetPath) ?? stat.mode,
        dev: stat.dev,
        ino: stat.ino,
        nlink: stat.nlink,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    },
    chmod,
    realpath: (targetPath) => fs.realpath(targetPath),
  };
  return {
    modes,
    chmod,
    securityOps,
    failNextFileChmod() {
      failFileChmod = true;
    },
  };
}

async function bundleLocalTelemetryStore(outputFile: string): Promise<void> {
  await build({
    entryPoints: [path.resolve("electron", "local-telemetry-store.ts")],
    outfile: outputFile,
    bundle: true,
    platform: "node",
    format: "cjs",
    plugins: [
      {
        name: "stub-electron",
        setup(buildApi) {
          buildApi.onResolve({ filter: /^electron$/ }, () => ({
            path: "electron",
            namespace: "marshal-test",
          }));
          buildApi.onLoad({ filter: /.*/, namespace: "marshal-test" }, () => ({
            contents:
              'export const app = { getPath() { throw new Error("unexpected app.getPath"); } };',
            loader: "js",
          }));
        },
      },
    ],
  });
}

async function appendFromChildProcess(
  bundlePath: string,
  directory: string,
  scenario: string,
): Promise<void> {
  const result = await runChildStoreOperation(bundlePath, directory, "append", scenario);
  if (!result.ok) throw new Error(result.error);
}

async function runChildStoreOperation(
  bundlePath: string,
  directory: string,
  operation: "append" | "delete",
  scenario = "child",
  options: {
    now?: string;
    maxShells?: number;
    maxFileBytes?: number;
    maxTotalBytes?: number;
    systemNowMs?: number;
  } = {},
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const script = `
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.url);
    const { LocalTelemetryStore } = require(process.argv[1]);
    const options = JSON.parse(process.argv[5]);
    if (options.systemNowMs !== undefined) Date.now = () => options.systemNowMs;
    const store = new LocalTelemetryStore({
      directory: process.argv[2],
      now: () => new Date(options.now ?? ${JSON.stringify(NOW.toISOString())}),
      ...(options.maxShells === undefined ? {} : { maxShells: options.maxShells }),
      ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
      ...(options.maxTotalBytes === undefined ? {} : { maxTotalBytes: options.maxTotalBytes }),
    });
    try {
      let result;
      if (process.argv[3] === "delete") {
        result = await store.deleteAll();
      } else {
        await store.prune();
        result = await store.append({
          eventType: "Marshal.Fetch",
          fields: { scenario: process.argv[4] },
        });
      }
      await store.flush();
      console.log("MARSHAL_RESULT " + JSON.stringify({ ok: true, result: result ?? null }));
    } catch (error) {
      console.log("MARSHAL_RESULT " + JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  `;
  const { stdout } = await execFileAsync(process.execPath, [
    "--input-type=module",
    "-e",
    script,
    bundlePath,
    directory,
    operation,
    scenario,
    JSON.stringify(options),
  ]);
  const resultLine = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((line: string) => line.startsWith("MARSHAL_RESULT "));
  if (!resultLine) throw new Error("child_store_result_missing");
  const parsed: unknown = JSON.parse(resultLine.slice("MARSHAL_RESULT ".length));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("ok" in parsed) ||
    typeof parsed.ok !== "boolean"
  ) {
    throw new Error("child_store_result_invalid");
  }
  if (parsed.ok) return { ok: true, result: "result" in parsed ? parsed.result : null };
  if (!("error" in parsed) || typeof parsed.error !== "string") {
    throw new Error("child_store_result_invalid");
  }
  return { ok: false, error: parsed.error };
}

async function spawnChildStoreAtPhase(
  bundlePath: string,
  directory: string,
  phase: "before-commit-lease" | "before-write" | "after-write" | "delete-truncate",
) {
  const script = `
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.url);
    const { LocalTelemetryStore } = require(process.argv[1]);
    const phase = process.argv[3];
    const pause = async () => {
      console.log("PHASE");
      await new Promise(() => {});
    };
    const store = new LocalTelemetryStore({
      directory: process.argv[2],
      now: () => new Date(${JSON.stringify(NOW.toISOString())}),
      ...(phase === "before-commit-lease" ? { beforeAppendCommitLease: pause } : {}),
      ...(phase === "before-write" ? { beforeAppendWrite: pause } : {}),
      ...(phase === "after-write" ? { afterAppendWrite: pause } : {}),
      ...(phase === "delete-truncate" ? {
        truncateFile: async () => pause(),
      } : {}),
    });
    if (phase !== "delete-truncate") await store.prune();
    if (phase === "delete-truncate") {
      await store.deleteAll();
    } else {
      await store.append({ eventType: "Marshal.Fetch", fields: { scenario: phase } });
    }
  `;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", script, bundlePath, directory, phase],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  await new Promise<void>((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (chunk.includes("PHASE")) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== null && code !== 0) reject(new Error(`phase child exited ${code}`));
    });
  });
  return child;
}

async function spawnPausableDeleteStore(
  bundlePath: string,
  directory: string,
  systemNowMs?: number,
): Promise<{
  child: ReturnType<typeof spawn>;
  completion: Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;
}> {
  const script = `
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.url);
    const { LocalTelemetryStore } = require(process.argv[1]);
    const systemNowMs = Number(process.argv[3]);
    if (Number.isFinite(systemNowMs)) Date.now = () => systemNowMs;
    let paused = false;
    const store = new LocalTelemetryStore({
      directory: process.argv[2],
      now: () => new Date(${JSON.stringify(NOW.toISOString())}),
      truncateFile: async (handle) => {
        await handle.truncate(0);
        if (paused) return;
        paused = true;
        console.log("PHASE");
        await new Promise((resolve) => {
          const release = () => {
            process.stdin.off("data", release);
            process.stdin.off("end", release);
            resolve();
          };
          process.stdin.once("data", release);
          process.stdin.once("end", release);
          process.stdin.resume();
        });
      },
    });
    try {
      const result = await store.deleteAll();
      console.log("MARSHAL_RESULT " + JSON.stringify({ ok: true, result }));
    } catch (error) {
      console.log("MARSHAL_RESULT " + JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  `;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", script, bundlePath, directory, String(systemNowMs)],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  let phaseResolved = false;
  let resolvePhase!: () => void;
  const phase = new Promise<void>((resolve) => {
    resolvePhase = resolve;
  });
  const completion = new Promise<{ ok: true; result: unknown } | { ok: false; error: string }>(
    (resolve, reject) => {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (!phaseResolved && stdout.includes("PHASE")) {
          phaseResolved = true;
          resolvePhase();
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        const resultLine = stdout
          .trim()
          .split("\n")
          .reverse()
          .find((line) => line.startsWith("MARSHAL_RESULT "));
        if (!resultLine) {
          reject(new Error(`pausable delete exited ${code}: ${stderr}`));
          return;
        }
        const parsed: unknown = JSON.parse(resultLine.slice("MARSHAL_RESULT ".length));
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          !("ok" in parsed) ||
          typeof parsed.ok !== "boolean"
        ) {
          reject(new Error("pausable_delete_result_invalid"));
          return;
        }
        if (parsed.ok) {
          resolve({ ok: true, result: "result" in parsed ? parsed.result : null });
          return;
        }
        if (!("error" in parsed) || typeof parsed.error !== "string") {
          reject(new Error("pausable_delete_result_invalid"));
          return;
        }
        resolve({ ok: false, error: parsed.error });
      });
    },
  );
  await Promise.race([
    phase,
    completion.then(() => {
      throw new Error("pausable_delete_phase_missing");
    }),
  ]);
  return { child, completion };
}

async function terminateChild(child: ReturnType<typeof spawn>): Promise<void> {
  child.kill();
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function openLeaseAttackClients(
  endpoints: Awaited<ReturnType<typeof commitEndpointsForDirectory>>,
  count: number,
) {
  const sockets: Array<ReturnType<typeof connect>> = [];
  await Promise.all(
    Array.from({ length: count }, (_, index) => {
      const endpoint = endpoints[index % endpoints.length];
      return new Promise<void>((resolve) => {
        const socket = connect({
          ...endpoint,
          allowHalfOpen: index % 2 === 0,
        });
        sockets.push(socket);
        socket.on("error", () => resolve());
        socket.once("connect", () => {
          socket.write(Buffer.from([0, 255, index % 256]));
          resolve();
        });
      });
    }),
  );
  return sockets;
}

async function sendLeaseAttackDatagrams(
  endpoints: Awaited<ReturnType<typeof commitEndpointsForDirectory>>,
  count: number,
) {
  const sockets = Array.from({ length: Math.min(count, 32) }, () => createDatagramSocket("udp4"));
  for (const socket of sockets) socket.on("error", () => {});
  await Promise.all(
    Array.from({ length: count }, (_, index) => {
      const socket = sockets[index % sockets.length];
      const endpoint = endpoints[index % endpoints.length];
      return new Promise<void>((resolve) => {
        socket.send(Buffer.from([0, 255, index % 256]), endpoint.port, endpoint.host, () =>
          resolve(),
        );
      });
    }),
  );
  return sockets;
}

describe("sanitizeLocalTelemetryEvent", () => {
  it("keeps privacy-safe LLM usage fields and removes identifiers and content", () => {
    expect(fetchEvent()).toEqual({
      eventType: "Marshal.Fetch",
      fields: {
        appVersion: "1.2.3",
        sessionCorrelationId: "session-local-1",
        duration: 250,
        model: "gpt-5",
        inputTokens: 100,
        outputTokens: 50,
        cost: 0.01,
        result: "success",
        scenario: "LlmTokenUsage",
        source: "HostApp",
      },
    });
  });

  it("keeps the unauthorized IPC channel without unrelated misc fields", () => {
    expect(
      fetchEvent({
        scenario: "ipc.unauthorized_sender",
        misc: JSON.stringify({
          channel: "settings:save",
          exception: "secret exception text",
          stack: "secret stack",
        }),
      }),
    ).toEqual({
      eventType: "Marshal.Fetch",
      fields: {
        appVersion: "1.2.3",
        sessionCorrelationId: "session-local-1",
        duration: 250,
        channel: "settings:save",
        result: "success",
        scenario: "ipc.unauthorized_sender",
        source: "HostApp",
      },
    });
  });

  it("limits Error events to registered family, code, and message names", () => {
    expect(
      sanitizeLocalTelemetryEvent({
        eventType: "Marshal.Error",
        fields: {
          sessionCorrelationId: "session-local-1",
          family: IPC_UNAUTHORIZED.family,
          code: IPC_UNAUTHORIZED.code,
          message: "UNAUTHORIZED_SENDER",
          midgardError: IPC_UNAUTHORIZED,
          exception: "customer exception text",
          stack: "customer stack",
          userId: "user-id-1",
          tenantId: "tenant-id-1",
        },
      }),
    ).toEqual({
      eventType: "Marshal.Error",
      fields: {
        sessionCorrelationId: "session-local-1",
        family: IPC_UNAUTHORIZED.family,
        code: IPC_UNAUTHORIZED.code,
        message: "UNAUTHORIZED_SENDER",
      },
    });
  });

  it("rejects unregistered-looking error message text", () => {
    expect(
      sanitizeLocalTelemetryEvent({
        eventType: "Marshal.Error",
        fields: {
          family: IPC_UNAUTHORIZED.family,
          code: IPC_UNAUTHORIZED.code,
          message: "Unauthorized sender: person@example.com",
        },
      }),
    ).toBeNull();
  });

  it("rejects debug and unknown event families", () => {
    expect(
      sanitizeLocalTelemetryEvent({
        eventType: "Marshal.ErrorDebug",
        fields: { debugMessage: "customer text" },
      }),
    ).toBeNull();
  });
});

describe("local telemetry file names", () => {
  it("round-trips indexes 999 and 1000 through one canonical contract", () => {
    expect(formatLocalTelemetryFileName("2026-08-01", 999)).toBe("events-2026-08-01-999.jsonl");
    expect(formatLocalTelemetryFileName("2026-08-01", 1000)).toBe("events-2026-08-01-1000.jsonl");
    expect(parseLocalTelemetryFileName("events-2026-08-01-1000.jsonl")).toEqual({
      date: "2026-08-01",
      index: 1000,
    });
  });

  it("rejects noncanonical and unsafe indexes", () => {
    expect(parseLocalTelemetryFileName("events-2026-08-01-0000.jsonl")).toBeNull();
    expect(parseLocalTelemetryFileName("events-2026-08-01-9007199254740992.jsonl")).toBeNull();
    expect(() => formatLocalTelemetryFileName("2026-08-01", Number.MAX_SAFE_INTEGER + 1)).toThrow(
      "telemetry_file_index_exhausted",
    );
  });
});

describe("LocalTelemetryStore", () => {
  it("writes structured JSONL with a stable schema", async () => {
    const store = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });
    await store.append(fetchEvent()!);

    const files = await telemetryFileNames();
    expect(files).toEqual(["events-2026-08-01-000.jsonl"]);
    const line = await fs.readFile(path.join(tempDir, files[0]), "utf8");
    expect(JSON.parse(line)).toEqual({
      schemaVersion: 1,
      recordedAt: NOW.toISOString(),
      eventType: "Marshal.Fetch",
      fields: fetchEvent()!.fields,
    });
  });

  it("preserves append ordering and reports queue wait separately from service time", async () => {
    const timings: Array<{
      operation: string;
      queueWaitMs: number;
      serviceMs: number;
      queueDepth: number;
      payloadBytes: number;
    }> = [];
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      onOperationTiming: (timing) => timings.push(timing),
    });

    await Promise.all([
      store.append({ eventType: "Marshal.Fetch", fields: { scenario: "first" } }),
      store.append({ eventType: "Marshal.Fetch", fields: { scenario: "second" } }),
    ]);

    const content = await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"), "utf8");
    expect(
      content
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).fields.scenario),
    ).toEqual(["first", "second"]);
    const writeTimings = timings.filter((timing) => timing.operation === "write");
    expect(writeTimings).toHaveLength(2);
    expect(writeTimings.map((timing) => timing.queueDepth)).toEqual([1, 2]);
    expect(writeTimings.every((timing) => timing.queueWaitMs >= 0 && timing.serviceMs >= 0)).toBe(
      true,
    );
    expect(writeTimings.every((timing) => timing.payloadBytes > 0)).toBe(true);
  });

  it("enumerates and prunes on a bounded cadence instead of every append", async () => {
    const readdir = vi.spyOn(fs, "readdir");
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      pruneEveryWrites: 3,
      pruneIntervalMs: Number.MAX_SAFE_INTEGER,
    });

    for (let index = 0; index < 5; index++) {
      // eslint-disable-next-line no-await-in-loop -- the test exercises the serialized append cadence
      await store.append({ eventType: "Marshal.Fetch", fields: { index } });
    }

    expect(readdir).toHaveBeenCalledTimes(3);
    readdir.mockRestore();
  });

  it("creates telemetry files without the pathname-following append helper", async () => {
    const secureAppend = vi.spyOn(platformSecurity, "secureAppendFile");
    const store = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });

    await store.append(fetchEvent()!);
    await store.append(fetchEvent()!);

    expect(secureAppend).not.toHaveBeenCalled();
  });

  it("recovers after the telemetry directory is deleted externally", async () => {
    const store = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });
    await store.append({ eventType: "Marshal.Fetch", fields: { scenario: "before-delete" } });
    await fs.rm(tempDir, { recursive: true, force: true });

    await store.append({ eventType: "Marshal.Fetch", fields: { scenario: "after-delete" } });

    const content = await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"), "utf8");
    expect(content).toContain("after-delete");
    expect(content).not.toContain("before-delete");
  });

  it("recreates a deleted directory during prune before the next append", async () => {
    const store = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });
    await store.append(fetchEvent()!);
    await fs.rm(tempDir, { recursive: true, force: true });

    await store.prune();
    await store.append({ eventType: "Marshal.Fetch", fields: { scenario: "after-prune" } });

    const content = await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"), "utf8");
    expect(content).toContain("after-prune");
  });

  it("rejects regular ancestor replacement during missing-directory recovery", async () => {
    const userData = path.join(tempDir, "user-data");
    const telemetryDirectory = path.join(userData, "telemetry");
    const displacedUserData = `${userData}-displaced`;
    const displacedTelemetry = path.join(userData, "telemetry-displaced");
    await fs.mkdir(userData);
    const store = new LocalTelemetryStore({ directory: telemetryDirectory, now: () => NOW });
    await store.append({ eventType: "Marshal.Fetch", fields: { scenario: "before-replace" } });
    await store.flush();
    await fs.rename(telemetryDirectory, displacedTelemetry);
    await fs.rename(userData, displacedUserData);
    await fs.mkdir(userData);

    await expect(
      store.append({ eventType: "Marshal.Fetch", fields: { scenario: "redirected" } }),
    ).rejects.toThrow("telemetry_ancestor_identity_changed");

    await expect(fs.stat(path.join(userData, "telemetry"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      await fs.readFile(
        path.join(displacedUserData, "telemetry-displaced", "events-2026-08-01-000.jsonl"),
        "utf8",
      ),
    ).toContain("before-replace");
  });

  it.runIf(process.platform === "win32")(
    "rejects junction ancestor replacement during missing-directory recovery",
    async () => {
      const userData = path.join(tempDir, "junction-user-data");
      const telemetryDirectory = path.join(userData, "telemetry");
      const displacedUserData = `${userData}-displaced`;
      const outsideDirectory = path.join(tempDir, "junction-target");
      await fs.mkdir(userData);
      await fs.mkdir(outsideDirectory);
      await fs.writeFile(path.join(outsideDirectory, "outside-sentinel.txt"), "outside");
      const store = new LocalTelemetryStore({ directory: telemetryDirectory, now: () => NOW });
      await store.append({
        eventType: "Marshal.Fetch",
        fields: { scenario: "before-junction" },
      });
      await fs.rm(telemetryDirectory, { recursive: true });
      await fs.rename(userData, displacedUserData);
      await fs.symlink(outsideDirectory, userData, "junction");
      try {
        await expect(
          store.append({ eventType: "Marshal.Fetch", fields: { scenario: "redirected" } }),
        ).rejects.toThrow("telemetry_path_is_not_directory");

        expect(await fs.readdir(outsideDirectory)).toEqual(["outside-sentinel.txt"]);
        expect(await fs.readFile(path.join(outsideDirectory, "outside-sentinel.txt"), "utf8")).toBe(
          "outside",
        );
      } finally {
        await fs.unlink(userData);
      }
    },
  );

  it("recovers a legacy directory capture across restart and concurrent processes", async () => {
    const parent = path.dirname(tempDir);
    const captureDirectory = path.join(
      parent,
      `.${path.basename(tempDir)}-create-crash-interruption`,
    );
    const bundlePath = `${tempDir}-child-store.cjs`;
    const seed = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });
    await seed.append({ eventType: "Marshal.Fetch", fields: { scenario: "legacy" } });
    await seed.flush();
    await fs.rename(tempDir, captureDirectory);
    await bundleLocalTelemetryStore(bundlePath);
    try {
      await Promise.all([
        appendFromChildProcess(bundlePath, tempDir, "child-one"),
        appendFromChildProcess(bundlePath, tempDir, "child-two"),
      ]);
      const restarted = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });
      await restarted.append({
        eventType: "Marshal.Fetch",
        fields: { scenario: "parent-restart" },
      });
      await restarted.flush();

      await expect(fs.stat(tempDir)).rejects.toMatchObject({ code: "ENOENT" });
      const content = await fs.readFile(
        path.join(captureDirectory, "events-2026-08-01-000.jsonl"),
        "utf8",
      );
      expect(content).toContain('"legacy"');
      expect(content).toContain("child-one");
      expect(content).toContain("child-two");
      expect(content).toContain("parent-restart");
      expect(
        (await fs.readdir(parent)).filter((name) =>
          name.startsWith(`.${path.basename(tempDir)}-create-`),
        ),
      ).toEqual([path.basename(captureDirectory)]);
    } finally {
      await fs.rm(bundlePath, { force: true });
      await fs.rm(captureDirectory, { recursive: true, force: true });
      await fs.mkdir(tempDir, { recursive: true });
    }
  });

  it("selects the oldest owned capture by marker age instead of lexical name", async () => {
    const parent = path.dirname(tempDir);
    const base = path.basename(tempDir);
    const lexicallyFirstNewer = path.join(parent, `.${base}-create-a-newer`);
    const lexicallyLastOlder = path.join(parent, `.${base}-create-z-older`);
    const seed = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });
    await seed.append(fetchEvent()!);
    await seed.flush();
    await createOwnedCapture(tempDir, lexicallyFirstNewer, 200);
    await createOwnedCapture(tempDir, lexicallyLastOlder, 100);
    await fs.rm(tempDir, { recursive: true });
    try {
      const restarted = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });
      await restarted.append({
        eventType: "Marshal.Fetch",
        fields: { scenario: "oldest-owned-root" },
      });
      await restarted.flush();

      expect({
        older: await telemetryFileNames(lexicallyLastOlder),
        newer: await telemetryFileNames(lexicallyFirstNewer),
      }).toEqual({
        older: ["events-2026-08-01-000.jsonl"],
        newer: [],
      });
      await expect(fs.stat(tempDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(lexicallyFirstNewer, { recursive: true, force: true });
      await fs.rm(lexicallyLastOlder, { recursive: true, force: true });
      await fs.mkdir(tempDir, { recursive: true });
    }
  });

  it("ignores and preserves unowned and malformed legacy-root siblings", async () => {
    const parent = path.dirname(tempDir);
    const base = path.basename(tempDir);
    const unowned = path.join(parent, `.${base}-create-unowned`);
    const malformed = path.join(parent, `.${base}-delete-malformed`);
    const unownedFile = path.join(unowned, "events-2026-08-01-000.jsonl");
    const malformedFile = path.join(malformed, "events-2026-08-01-001.jsonl");
    const store = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });
    await store.append(fetchEvent()!);
    await store.flush();
    await fs.mkdir(unowned);
    await fs.writeFile(unownedFile, "unrelated-capture-content");
    await fs.mkdir(malformed);
    await fs.writeFile(path.join(malformed, ".marshal-telemetry-root-v1"), "malformed");
    await fs.writeFile(malformedFile, "malformed-root-content");
    try {
      const result = await store.deleteAll();
      expect(result.complete).toBe(true);
      expect(await fs.readFile(unownedFile, "utf8")).toBe("unrelated-capture-content");
      expect(await fs.readFile(malformedFile, "utf8")).toBe("malformed-root-content");
    } finally {
      await fs.rm(unowned, { recursive: true, force: true });
      await fs.rm(malformed, { recursive: true, force: true });
    }
  });

  it("rejects replacement of an owned legacy root before opening its child", async () => {
    const parent = path.dirname(tempDir);
    const capture = path.join(parent, `.${path.basename(tempDir)}-create-owned`);
    const displaced = `${capture}-displaced`;
    const seed = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });
    await seed.append(fetchEvent()!);
    await seed.flush();
    await createOwnedCapture(tempDir, capture, 100);
    await fs.rm(tempDir, { recursive: true });
    let replaceRoot = true;
    const restarted = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      beforeFileOpen: async () => {
        if (!replaceRoot) return;
        replaceRoot = false;
        await fs.rename(capture, displaced);
        await fs.mkdir(capture);
      },
    });
    try {
      await expect(restarted.append(fetchEvent()!)).rejects.toThrow(
        "telemetry_directory_identity_changed",
      );
      expect(await fs.readdir(capture)).toEqual([]);
      expect(await fs.readdir(displaced)).toEqual([".marshal-telemetry-root-v1"]);
    } finally {
      await fs.rm(capture, { recursive: true, force: true });
      await fs.rm(displaced, { recursive: true, force: true });
      await fs.mkdir(tempDir, { recursive: true });
    }
  });

  it("recovers an empty file left by interruption without creating capture artifacts", async () => {
    let interrupt = true;
    const interrupted = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      beforeAppendCommit: () => {
        if (!interrupt) return;
        interrupt = false;
        throw new Error("simulated-process-interruption");
      },
    });
    await expect(interrupted.append(fetchEvent()!)).rejects.toThrow(
      "simulated-process-interruption",
    );
    expect((await fs.stat(path.join(tempDir, "events-2026-08-01-000.jsonl"))).size).toBe(0);

    const restarted = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });
    await restarted.append({ eventType: "Marshal.Fetch", fields: { scenario: "recovered" } });
    await restarted.flush();

    expect(await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"), "utf8")).toContain(
      "recovered",
    );
    expect(
      (await fs.readdir(path.dirname(tempDir))).some((name) =>
        name.startsWith(`.${path.basename(tempDir)}-create-`),
      ),
    ).toBe(false);
  });

  it("keeps adversarial creation failures free of private-artifact growth", async () => {
    let day = 1;
    const outsideTargets: string[] = [];
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => new Date(`2026-08-${String(day).padStart(2, "0")}T09:00:00.000Z`),
      beforeFileCreate: async (filePath) => {
        const outside = `${tempDir}-outside-${day}.jsonl`;
        outsideTargets.push(outside);
        await fs.writeFile(outside, `outside-${day}`);
        await fs.link(outside, filePath);
      },
    });
    try {
      for (day = 1; day <= 25; day++) {
        // eslint-disable-next-line no-await-in-loop -- each day exercises a separate adversarial path
        await expect(store.append(fetchEvent()!)).rejects.toThrow(
          "telemetry_file_has_multiple_links",
        );
      }

      expect((await fs.readdir(tempDir)).filter((name) => name.includes("-create-"))).toEqual([]);
      const fresh = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });
      await expect(fresh.deleteAll()).resolves.toMatchObject({
        complete: false,
        deletedFiles: 0,
        remainingFiles: 25,
        failedFiles: 25,
      });
      for (const [index, outside] of outsideTargets.entries()) {
        // eslint-disable-next-line no-await-in-loop -- outside targets must all remain byte-for-byte intact
        expect(await fs.readFile(outside, "utf8")).toBe(`outside-${index + 1}`);
      }
    } finally {
      await Promise.all(outsideTargets.map((outside) => fs.rm(outside, { force: true })));
    }
  });

  it("keeps the warmed append path async and below the CI latency budget", async () => {
    const serviceMs: number[] = [];
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      pruneEveryWrites: 1_000,
      pruneIntervalMs: Number.MAX_SAFE_INTEGER,
      onOperationTiming: (timing) => {
        if (timing.operation === "write") serviceMs.push(timing.serviceMs);
      },
    });
    await store.append({ eventType: "Marshal.Fetch", fields: { scenario: "warm" } });
    serviceMs.length = 0;

    const lstat = vi.spyOn(fs, "lstat");
    const realpath = vi.spyOn(fs, "realpath");
    const delay = monitorEventLoopDelay({ resolution: 1 });
    delay.enable();
    let timerTicks = 0;
    const timer = setInterval(() => {
      timerTicks += 1;
    }, 1);
    const startedAt = performance.now();
    try {
      for (let index = 0; index < 300; index++) {
        // eslint-disable-next-line no-await-in-loop -- sequential writes measure the serialized production path
        await store.append({ eventType: "Marshal.Fetch", fields: { index } });
      }
    } finally {
      clearInterval(timer);
      delay.disable();
    }
    const elapsedMs = performance.now() - startedAt;
    const lstatCalls = lstat.mock.calls.length;
    const realpathCalls = realpath.mock.calls.length;
    lstat.mockRestore();
    realpath.mockRestore();

    expect(lstatCalls).toBe(2_100);
    expect(realpathCalls).toBe(1_200);
    expect(timerTicks).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(3_000);
    if (process.env.MARSHAL_TELEMETRY_BENCHMARK === "1") {
      process.stdout.write(
        `TELEMETRY_BENCH warm ${JSON.stringify({
          totalMs: elapsedMs,
          meanMs: serviceMs.reduce((sum, value) => sum + value, 0) / serviceMs.length,
          p50Ms: percentile(serviceMs, 0.5),
          p95Ms: percentile(serviceMs, 0.95),
          maxMs: Math.max(...serviceMs),
          eventLoopMaxMs: delay.max / 1_000_000,
        })}\n`,
      );
    }
    const source = await fs.readFile(path.resolve("electron", "local-telemetry-store.ts"), "utf8");
    expect(source).not.toMatch(/\b(?:lstatSync|realpathSync)\b/);
  });

  it("reasserts directory and file modes after mode drift", async () => {
    const security = createSecurityOps();
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      platform: "linux",
      securityOps: security.securityOps,
    });
    await store.append({ eventType: "Marshal.Fetch", fields: { scenario: "first" } });
    const filePath = path.join(tempDir, "events-2026-08-01-000.jsonl");
    security.modes.set(tempDir, 0o755);
    security.modes.set(filePath, 0o644);
    await fs.chmod(filePath, 0o644);
    security.chmod.mockClear();

    await store.append({ eventType: "Marshal.Fetch", fields: { scenario: "mode-repaired" } });

    expect(security.chmod).toHaveBeenCalledWith(tempDir, 0o700);
    expect(security.chmod).toHaveBeenCalledWith(filePath, 0o600);
    expect(security.modes.get(tempDir)).toBe(0o700);
    expect(security.modes.get(filePath)).toBe(0o600);
    expect(await fs.readFile(filePath, "utf8")).toContain("mode-repaired");
  });

  it("retries a transient chmod failure before writing telemetry content", async () => {
    const security = createSecurityOps();
    const filePath = path.join(tempDir, "events-2026-08-01-000.jsonl");
    await fs.writeFile(filePath, "");
    security.modes.set(filePath, 0o644);
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      platform: "linux",
      securityOps: security.securityOps,
    });
    security.failNextFileChmod();
    await store.append({ eventType: "Marshal.Fetch", fields: { scenario: "secure-retry" } });

    const fileChmods = security.chmod.mock.calls.filter(([targetPath]) => targetPath === filePath);
    expect(fileChmods).toHaveLength(4);
    const lines = (await fs.readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("secure-retry");
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlink inserted between ENOENT and exclusive creation",
    async () => {
      const outsidePath = path.join(
        path.dirname(tempDir),
        `${path.basename(tempDir)}-creation-target.jsonl`,
      );
      await fs.writeFile(outsidePath, "outside-content");
      const outsideMode = (await fs.stat(outsidePath)).mode;
      const store = new LocalTelemetryStore({
        directory: tempDir,
        now: () => NOW,
        beforeFileCreate: (filePath) => fs.symlink(outsidePath, filePath),
      });
      try {
        await expect(
          store.append({ eventType: "Marshal.Fetch", fields: { scenario: "blocked" } }),
        ).rejects.toThrow("telemetry_path_is_not_file");

        expect(await fs.readFile(outsidePath, "utf8")).toBe("outside-content");
        expect((await fs.stat(outsidePath)).mode).toBe(outsideMode);
      } finally {
        await fs.rm(outsidePath, { force: true });
      }
    },
  );

  it("rejects a hard link inserted between ENOENT and creation under Windows semantics", async () => {
    const outsidePath = path.join(
      path.dirname(tempDir),
      `${path.basename(tempDir)}-windows-creation-target.jsonl`,
    );
    await fs.writeFile(outsidePath, "outside-content");
    const security = createSecurityOps();
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      platform: "win32",
      securityOps: security.securityOps,
      beforeFileCreate: (filePath) => fs.link(outsidePath, filePath),
    });
    try {
      await expect(
        store.append({ eventType: "Marshal.Fetch", fields: { scenario: "blocked" } }),
      ).rejects.toThrow("telemetry_file_has_multiple_links");

      expect(await fs.readFile(outsidePath, "utf8")).toBe("outside-content");
      expect(security.chmod.mock.calls.some(([targetPath]) => targetPath.endsWith(".jsonl"))).toBe(
        false,
      );
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
  });

  it.each([
    ["after exclusive open", "afterFileOpen"],
    ["immediately before append", "beforeAppendCommit"],
  ] as const)(
    "binds a newly created file identity %s and preserves both swapped files",
    async (_description, boundary) => {
      let now = NOW;
      const displacedPath = path.join(tempDir, "events-2026-07-31-998.jsonl");
      const telemetryPath = path.join(tempDir, "events-2026-08-01-000.jsonl");
      let swap = true;
      const swapCreatedFile = async (filePath: string) => {
        if (!swap) return;
        swap = false;
        await fs.rename(filePath, displacedPath);
        await fs.writeFile(filePath, "replacement-content");
      };
      const store = new LocalTelemetryStore({
        directory: tempDir,
        now: () => now,
        retentionDays: 30,
        ...(boundary === "afterFileOpen"
          ? { afterFileOpen: swapCreatedFile }
          : { beforeAppendCommit: swapCreatedFile }),
      });

      await expect(
        store.append({ eventType: "Marshal.Fetch", fields: { scenario: "blocked" } }),
      ).rejects.toThrow("telemetry_file_identity_changed");

      expect(await fs.readFile(displacedPath, "utf8")).toBe("");
      expect(await fs.readFile(telemetryPath, "utf8")).toBe("replacement-content");
      expect((await fs.readdir(tempDir)).some((name) => name.includes("quarantine"))).toBe(false);

      now = new Date("2027-01-01T00:00:00.000Z");
      await expect(store.prune()).resolves.toBeUndefined();
      expect(await fs.readFile(displacedPath, "utf8")).toBe("");
      expect(await fs.readFile(telemetryPath, "utf8")).toBe("replacement-content");
    },
  );

  it("rejects regular parent replacement immediately before exclusive file creation", async () => {
    const displacedDirectory = `${tempDir}-create-parent`;
    const sentinel = path.join(tempDir, "outside-sentinel.txt");
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      beforeFileCreate: async () => {
        await fs.rename(tempDir, displacedDirectory);
        await fs.mkdir(tempDir);
        await fs.writeFile(sentinel, "outside");
      },
    });
    try {
      await expect(
        store.append({ eventType: "Marshal.Fetch", fields: { scenario: "blocked" } }),
      ).rejects.toThrow("telemetry_directory_identity_changed");

      expect(await fs.readdir(displacedDirectory)).toEqual([".marshal-telemetry-root-v1"]);
      expect(await fs.readFile(sentinel, "utf8")).toBe("outside");
      expect(await fs.readdir(tempDir)).toEqual(["outside-sentinel.txt"]);
    } finally {
      await fs.rm(displacedDirectory, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")(
    "rejects junction parent replacement immediately before exclusive file creation",
    async () => {
      const displacedDirectory = `${tempDir}-create-junction-parent`;
      const outsideDirectory = `${tempDir}-create-junction-target`;
      await fs.mkdir(outsideDirectory);
      await fs.writeFile(path.join(outsideDirectory, "outside-sentinel.txt"), "outside");
      const store = new LocalTelemetryStore({
        directory: tempDir,
        now: () => NOW,
        beforeBoundFileCreate: (capturedDirectory) => {
          fsSync.renameSync(capturedDirectory, displacedDirectory);
          fsSync.symlinkSync(outsideDirectory, capturedDirectory, "junction");
        },
      });
      try {
        await expect(
          store.append({ eventType: "Marshal.Fetch", fields: { scenario: "blocked" } }),
        ).rejects.toThrow("telemetry_path_is_not_directory");

        expect(await fs.readdir(displacedDirectory)).toEqual([".marshal-telemetry-root-v1"]);
        expect(await fs.readdir(outsideDirectory)).toEqual(["outside-sentinel.txt"]);
        expect(await fs.readFile(path.join(outsideDirectory, "outside-sentinel.txt"), "utf8")).toBe(
          "outside",
        );
      } finally {
        await fs.rm(tempDir, { force: true });
        await fs.rm(displacedDirectory, { recursive: true, force: true });
        await fs.rm(outsideDirectory, { recursive: true, force: true });
        await fs.mkdir(tempDir);
      }
    },
  );

  it("rejects a replacement of the captured parent immediately before child creation", async () => {
    let displacedCapturedDirectory = "";
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      beforeBoundFileCreate: (capturedDirectory) => {
        displacedCapturedDirectory = `${capturedDirectory}-displaced`;
        fsSync.renameSync(capturedDirectory, displacedCapturedDirectory);
        fsSync.mkdirSync(capturedDirectory);
        fsSync.writeFileSync(path.join(capturedDirectory, "outside-sentinel.txt"), "outside");
      },
    });
    try {
      await expect(
        store.append({ eventType: "Marshal.Fetch", fields: { scenario: "blocked" } }),
      ).rejects.toThrow("telemetry_directory_identity_changed");

      expect(await fs.readdir(displacedCapturedDirectory)).toEqual([".marshal-telemetry-root-v1"]);
      expect(await fs.readdir(tempDir)).toEqual(["outside-sentinel.txt"]);
      expect(await fs.readFile(path.join(tempDir, "outside-sentinel.txt"), "utf8")).toBe("outside");
    } finally {
      await fs.rm(displacedCapturedDirectory, { recursive: true, force: true });
    }
  });

  it("rejects replacement between validation and open without modifying the outside hard link", async () => {
    const outsidePath = path.join(
      path.dirname(tempDir),
      `${path.basename(tempDir)}-outside-telemetry.jsonl`,
    );
    await fs.writeFile(outsidePath, "outside-content");
    let replaceOnOpen = false;
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      beforeFileOpen: async (filePath) => {
        if (!replaceOnOpen) return;
        replaceOnOpen = false;
        await fs.rm(filePath);
        await fs.link(outsidePath, filePath);
      },
    });
    try {
      await store.append({ eventType: "Marshal.Fetch", fields: { scenario: "first" } });
      replaceOnOpen = true;

      await expect(
        store.append({ eventType: "Marshal.Fetch", fields: { scenario: "blocked" } }),
      ).rejects.toThrow("telemetry_file_has_multiple_links");
      await store.prune();

      expect(await fs.readFile(outsidePath, "utf8")).toBe("outside-content");
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
  });

  it("rejects parent directory replacement between validation and child open", async () => {
    const displacedDirectory = `${tempDir}-validated-parent`;
    let replaceParent = false;
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      beforeFileOpen: async () => {
        if (!replaceParent) return;
        replaceParent = false;
        await fs.rename(tempDir, displacedDirectory);
        await fs.mkdir(tempDir);
      },
    });
    try {
      await store.append({ eventType: "Marshal.Fetch", fields: { scenario: "original" } });
      await store.flush();
      replaceParent = true;

      await expect(
        store.append({ eventType: "Marshal.Fetch", fields: { scenario: "redirected" } }),
      ).rejects.toThrow("telemetry_directory_identity_changed");

      const originalFile = path.join(displacedDirectory, "events-2026-08-01-000.jsonl");
      const originalContent = await fs.readFile(originalFile, "utf8");
      expect(originalContent).toContain("original");
      expect(originalContent).not.toContain("redirected");
      expect(await fs.readdir(tempDir)).toEqual([]);
    } finally {
      await fs.rm(displacedDirectory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects a warm append when the configured ancestor is replaced by a symlink to the same inode",
    async () => {
      const userData = path.join(tempDir, "posix-user-data");
      const telemetryDirectory = path.join(userData, "telemetry");
      const displacedUserData = `${userData}-displaced`;
      await fs.mkdir(userData);
      const store = new LocalTelemetryStore({ directory: telemetryDirectory, now: () => NOW });
      await store.append({ eventType: "Marshal.Fetch", fields: { scenario: "original" } });
      await fs.rename(userData, displacedUserData);
      await fs.symlink(displacedUserData, userData, "dir");
      try {
        await expect(
          store.append({ eventType: "Marshal.Fetch", fields: { scenario: "redirected" } }),
        ).rejects.toThrow("telemetry_path_is_not_directory");

        const content = await fs.readFile(
          path.join(displacedUserData, "telemetry", "events-2026-08-01-000.jsonl"),
          "utf8",
        );
        expect(content.trim().split("\n")).toHaveLength(1);
        expect(content).not.toContain("redirected");
      } finally {
        await fs.unlink(userData);
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "keeps the warm append bound when Windows denies ancestor replacement",
    async () => {
      const userData = path.join(tempDir, "windows-user-data");
      const telemetryDirectory = path.join(userData, "telemetry");
      const displacedUserData = `${userData}-displaced`;
      await fs.mkdir(userData);
      const store = new LocalTelemetryStore({ directory: telemetryDirectory, now: () => NOW });
      await store.append({ eventType: "Marshal.Fetch", fields: { scenario: "original" } });

      await expect(fs.rename(userData, displacedUserData)).rejects.toMatchObject({
        code: expect.stringMatching(/^(?:EACCES|EBUSY|EPERM)$/),
      });
      const content = await fs.readFile(
        path.join(telemetryDirectory, "events-2026-08-01-000.jsonl"),
        "utf8",
      );
      expect(content.trim().split("\n")).toHaveLength(1);
    },
  );

  it("rolls back committed bytes when post-commit ancestry validation changes", async () => {
    const security = createSecurityOps();
    const ancestor = path.dirname(tempDir);
    const realpath = security.securityOps.realpath;
    let invalidateAncestry = false;
    let replaceOnWrite = false;
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      platform: "linux",
      securityOps: {
        ...security.securityOps,
        realpath: async (targetPath) => {
          const resolved = await realpath(targetPath);
          return invalidateAncestry && targetPath === ancestor ? `${resolved}-replaced` : resolved;
        },
      },
      beforeAppendWrite: () => {
        if (replaceOnWrite) invalidateAncestry = true;
      },
    });
    await store.append({ eventType: "Marshal.Fetch", fields: { scenario: "original" } });
    replaceOnWrite = true;

    await expect(
      store.append({ eventType: "Marshal.Fetch", fields: { scenario: "rolled-back" } }),
    ).rejects.toThrow("telemetry_ancestor_identity_changed");

    const content = await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"), "utf8");
    expect(content.trim().split("\n")).toHaveLength(1);
    expect(content).not.toContain("rolled-back");
  });

  it("falls back to native rollback when the injected rollback operation fails", async () => {
    const security = createSecurityOps();
    const ancestor = path.dirname(tempDir);
    const realpath = security.securityOps.realpath;
    let invalidateAncestry = false;
    let replaceOnWrite = false;
    const rollbackFile = vi.fn<NonNullable<LocalTelemetryStoreOptions["rollbackFile"]>>(
      async (handle, size) => {
        await handle.truncate(size - 10);
        throw Object.assign(new Error("injected rollback EIO"), { code: "EIO" });
      },
    );
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      platform: "linux",
      securityOps: {
        ...security.securityOps,
        realpath: async (targetPath) => {
          const resolved = await realpath(targetPath);
          return invalidateAncestry && targetPath === ancestor ? `${resolved}-replaced` : resolved;
        },
      },
      beforeAppendWrite: () => {
        if (replaceOnWrite) invalidateAncestry = true;
      },
      rollbackFile,
    });
    await store.append({
      eventType: "Marshal.Fetch",
      fields: { scenario: "original-🙂-é" },
    });
    const before = await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"));
    replaceOnWrite = true;

    await expect(
      store.append({ eventType: "Marshal.Fetch", fields: { scenario: "fallback-rollback" } }),
    ).rejects.toThrow("telemetry_ancestor_identity_changed");

    expect(rollbackFile).toHaveBeenCalledOnce();
    const after = await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"));
    expect(after.equals(before)).toBe(true);
  });

  it("restores the exact preimage after a rollback partially overwrites prior bytes", async () => {
    const security = createSecurityOps();
    const ancestor = path.dirname(tempDir);
    const realpath = security.securityOps.realpath;
    let invalidateAncestry = false;
    let replaceOnWrite = false;
    const rollbackFile = vi.fn<NonNullable<LocalTelemetryStoreOptions["rollbackFile"]>>(
      async (handle, size) => {
        await handle.write(Buffer.alloc(10), 0, 10, size - 10);
        await handle.truncate(size);
      },
    );
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      platform: "linux",
      securityOps: {
        ...security.securityOps,
        realpath: async (targetPath) => {
          const resolved = await realpath(targetPath);
          return invalidateAncestry && targetPath === ancestor ? `${resolved}-replaced` : resolved;
        },
      },
      beforeAppendWrite: () => {
        if (replaceOnWrite) invalidateAncestry = true;
      },
      rollbackFile,
    });
    await store.append({
      eventType: "Marshal.Fetch",
      fields: { scenario: "byte-exact-🙂" },
    });
    const before = await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"));
    replaceOnWrite = true;

    await expect(
      store.append({ eventType: "Marshal.Fetch", fields: { scenario: "corrupt-prefix" } }),
    ).rejects.toThrow("telemetry_ancestor_identity_changed");

    const after = await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"));
    expect(after.equals(before)).toBe(true);
    expect(JSON.parse(after.toString("utf8").trim()).fields.scenario).toBe("byte-exact-🙂");
  });

  it("handles short positional writes without corrupting JSONL", async () => {
    const writeChunk = vi.fn<NonNullable<LocalTelemetryStoreOptions["writeChunk"]>>(
      async (handle, buffer, offset, length, position) => {
        const chunkLength = Math.min(3, length);
        const result = await handle.write(buffer, offset, chunkLength, position);
        return result.bytesWritten;
      },
    );
    const store = new LocalTelemetryStore({ directory: tempDir, now: () => NOW, writeChunk });

    await store.append({
      eventType: "Marshal.Fetch",
      fields: { scenario: "short-write-🙂" },
    });

    const content = await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"), "utf8");
    expect(JSON.parse(content.trim()).fields.scenario).toBe("short-write-🙂");
    expect(writeChunk.mock.calls.length).toBeGreaterThan(1);
  });

  it.each(["before", "after"] as const)(
    "restores the exact preimage when a positional write returns EIO %s mutation",
    async (phase) => {
      let failWrite = false;
      const writeChunk = vi.fn<NonNullable<LocalTelemetryStoreOptions["writeChunk"]>>(
        async (handle, buffer, offset, length, position) => {
          if (!failWrite) {
            const result = await handle.write(buffer, offset, length, position);
            return result.bytesWritten;
          }
          failWrite = false;
          if (phase === "after") {
            await handle.write(buffer, offset, Math.min(5, length), position);
          }
          throw Object.assign(new Error("injected write EIO"), { code: "EIO" });
        },
      );
      const store = new LocalTelemetryStore({ directory: tempDir, now: () => NOW, writeChunk });
      await store.append({
        eventType: "Marshal.Fetch",
        fields: { scenario: "preimage-🙂" },
      });
      const before = await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"));
      failWrite = true;

      await expect(
        store.append({ eventType: "Marshal.Fetch", fields: { scenario: "write-eio" } }),
      ).rejects.toMatchObject({ code: "EIO" });

      const after = await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"));
      expect(after.equals(before)).toBe(true);
    },
  );

  it("restores the exact preimage after a post-write fsync failure", async () => {
    let failSync = false;
    const syncFile = vi.fn<NonNullable<LocalTelemetryStoreOptions["syncFile"]>>(async (handle) => {
      if (failSync) {
        failSync = false;
        throw Object.assign(new Error("injected fsync EIO"), { code: "EIO" });
      }
      await handle.sync();
    });
    const store = new LocalTelemetryStore({ directory: tempDir, now: () => NOW, syncFile });
    await store.append({
      eventType: "Marshal.Fetch",
      fields: { scenario: "fsync-preimage-🙂" },
    });
    const before = await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"));
    failSync = true;

    await expect(
      store.append({ eventType: "Marshal.Fetch", fields: { scenario: "fsync-failure" } }),
    ).rejects.toMatchObject({ code: "EIO" });

    const after = await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"));
    expect(after.equals(before)).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "rolls back when an ancestor above userData is replaced immediately before commit",
    async () => {
      const grandparent = path.join(tempDir, "grandparent");
      const userData = path.join(grandparent, "userData");
      const directory = path.join(userData, "telemetry");
      const displacedGrandparent = `${grandparent}-displaced`;
      await fs.mkdir(userData, { recursive: true });
      let replaceOnWrite = false;
      const store = new LocalTelemetryStore({
        directory,
        now: () => NOW,
        beforeAppendWrite: async () => {
          if (!replaceOnWrite) return;
          replaceOnWrite = false;
          await fs.rename(grandparent, displacedGrandparent);
          await fs.symlink(displacedGrandparent, grandparent, "dir");
        },
      });
      await store.append({ eventType: "Marshal.Fetch", fields: { scenario: "original" } });
      replaceOnWrite = true;
      try {
        await expect(
          store.append({ eventType: "Marshal.Fetch", fields: { scenario: "redirected" } }),
        ).rejects.toThrow(/telemetry_(?:ancestor|directory|path)/);
        const content = await fs.readFile(
          path.join(displacedGrandparent, "userData", "telemetry", "events-2026-08-01-000.jsonl"),
          "utf8",
        );
        expect(content.trim().split("\n")).toHaveLength(1);
        expect(content).not.toContain("redirected");
      } finally {
        await fs.unlink(grandparent);
        await fs.rm(displacedGrandparent, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "keeps commit bound when Windows blocks a junction replacement at the write boundary",
    async () => {
      const userData = path.join(tempDir, "commit-user-data");
      const directory = path.join(userData, "telemetry");
      const displaced = `${userData}-displaced`;
      const outside = path.join(tempDir, "commit-junction-target");
      await fs.mkdir(userData);
      await fs.mkdir(outside);
      let replaceOnWrite = false;
      const store = new LocalTelemetryStore({
        directory,
        now: () => NOW,
        beforeAppendWrite: async () => {
          if (!replaceOnWrite) return;
          replaceOnWrite = false;
          await fs.rename(userData, displaced);
          await fs.symlink(outside, userData, "junction");
        },
      });
      await store.append({ eventType: "Marshal.Fetch", fields: { scenario: "original" } });
      replaceOnWrite = true;

      await expect(
        store.append({ eventType: "Marshal.Fetch", fields: { scenario: "redirected" } }),
      ).rejects.toThrow(/(?:EPERM|EACCES|EBUSY|telemetry_)/);

      const originalRoot = await fs.stat(displaced).then(
        () => displaced,
        () => userData,
      );
      const content = await fs.readFile(
        path.join(originalRoot, "telemetry", "events-2026-08-01-000.jsonl"),
        "utf8",
      );
      expect(content.trim().split("\n")).toHaveLength(1);
      expect(content).not.toContain("redirected");
      await fs.rm(userData, { recursive: true, force: true });
      await fs.rm(displaced, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    },
  );

  it("rejects parent directory replacement before prune removes a child", async () => {
    const displacedDirectory = `${tempDir}-prune-parent`;
    let now = NOW;
    let replaceParent = false;
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => now,
      retentionDays: 30,
      beforeFileRemove: async () => {
        if (!replaceParent) return;
        replaceParent = false;
        await fs.rename(tempDir, displacedDirectory);
        await fs.mkdir(tempDir);
      },
    });
    try {
      await store.append({ eventType: "Marshal.Fetch", fields: { scenario: "retain-me" } });
      now = new Date("2027-01-01T00:00:00.000Z");
      replaceParent = true;

      await expect(store.prune()).rejects.toThrow("telemetry_directory_identity_changed");

      const originalFile = path.join(displacedDirectory, "events-2026-08-01-000.jsonl");
      expect(await fs.readFile(originalFile, "utf8")).toContain("retain-me");
      expect(await fs.readdir(tempDir)).toEqual([]);
    } finally {
      await fs.rm(displacedDirectory, { recursive: true, force: true });
    }
  });

  it("rejects child replacement after the prune hook and preserves both files", async () => {
    const replacementPath = path.join(
      path.dirname(tempDir),
      `${path.basename(tempDir)}-replacement.jsonl`,
    );
    await fs.writeFile(replacementPath, "replacement-content");
    let now = NOW;
    let replaceChild = false;
    const originalAside = path.join(tempDir, "events-2026-07-31-999.jsonl");
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => now,
      retentionDays: 30,
      beforeFileRemove: async (filePath) => {
        if (!replaceChild) return;
        replaceChild = false;
        await fs.rename(filePath, originalAside);
        await fs.rename(replacementPath, filePath);
      },
    });
    try {
      await store.append({ eventType: "Marshal.Fetch", fields: { scenario: "original" } });
      now = new Date("2027-01-01T00:00:00.000Z");
      replaceChild = true;

      await expect(store.prune()).rejects.toThrow("telemetry_file_identity_changed");

      const telemetryPath = path.join(tempDir, "events-2026-08-01-000.jsonl");
      expect(await fs.readFile(originalAside, "utf8")).toContain("original");
      expect(await fs.readFile(telemetryPath, "utf8")).toBe("replacement-content");
      expect((await fs.readdir(tempDir)).some((name) => name.includes("quarantine"))).toBe(false);

      await expect(store.prune()).resolves.toBeUndefined();
      expect(await fs.readFile(originalAside, "utf8")).toContain("original");
      expect(await fs.readFile(telemetryPath, "utf8")).toBe("replacement-content");
    } finally {
      await fs.rm(replacementPath, { force: true });
    }
  });

  it("does not adopt a replacement discovered while refreshing the cached file list", async () => {
    const replacementPath = path.join(
      path.dirname(tempDir),
      `${path.basename(tempDir)}-cached-replacement.jsonl`,
    );
    await fs.writeFile(replacementPath, "replacement-content");
    let now = NOW;
    const displacedOriginal = path.join(tempDir, "events-2026-07-31-994.jsonl");
    const telemetryPath = path.join(tempDir, "events-2026-08-01-000.jsonl");
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => now,
      retentionDays: 30,
    });
    try {
      await store.append({ eventType: "Marshal.Fetch", fields: { scenario: "original" } });
      await fs.rename(telemetryPath, displacedOriginal);
      await fs.rename(replacementPath, telemetryPath);
      now = new Date("2027-01-01T00:00:00.000Z");

      await expect(store.prune()).rejects.toThrow("telemetry_file_identity_changed");
      expect(await fs.readFile(displacedOriginal, "utf8")).toContain("original");
      expect(await fs.readFile(telemetryPath, "utf8")).toBe("replacement-content");
      expect((await fs.readdir(tempDir)).some((name) => name.includes("quarantine"))).toBe(false);

      await expect(store.prune()).resolves.toBeUndefined();
      expect(await fs.readFile(displacedOriginal, "utf8")).toContain("original");
      expect(await fs.readFile(telemetryPath, "utf8")).toBe("replacement-content");
    } finally {
      await fs.rm(replacementPath, { force: true });
    }
  });

  it("persists replacement blocks across restart with one bounded artifact", async () => {
    const outcomes: Array<{ day: number; error: string | null }> = [];
    for (let day = 1; day <= 25; day++) {
      const currentDay = day;
      let mismatchIdentity = false;
      const security = createSecurityOps();
      const store = new LocalTelemetryStore({
        directory: tempDir,
        now: () => new Date(`2026-08-${String(currentDay).padStart(2, "0")}T09:00:00.000Z`),
        securityOps: {
          ...security.securityOps,
          getPathInfo: async (targetPath) => {
            const info = await security.securityOps.getPathInfo(targetPath);
            return mismatchIdentity && targetPath.endsWith(".jsonl")
              ? { ...info, ino: -(info.ino ?? 0) - currentDay }
              : info;
          },
        },
        beforeAppendCommit: () => {
          mismatchIdentity = true;
        },
      });
      // eslint-disable-next-line no-await-in-loop -- each date creates an independent persisted replacement proof
      try {
        // eslint-disable-next-line no-await-in-loop -- outcomes must preserve the actual persisted sequence
        await store.append(fetchEvent()!);
        outcomes.push({ day, error: null });
      } catch (error) {
        outcomes.push({
          day,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    expect(outcomes).toEqual(
      Array.from({ length: 25 }, (_, index) => ({
        day: index + 1,
        error: "telemetry_file_identity_changed",
      })),
    );

    const parent = path.dirname(tempDir);
    const blocklist = path.join(parent, `.${path.basename(tempDir)}-blocked-v1`);
    const privateArtifacts = (await fs.readdir(parent)).filter((name) =>
      name.startsWith(`.${path.basename(tempDir)}-`),
    );
    expect(privateArtifacts.sort()).toEqual(
      [path.basename(blocklist), `.${path.basename(tempDir)}-owner-v1`].sort(),
    );
    expect((await fs.stat(blocklist)).size).toBeLessThan(64 * 1024);

    const fresh = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });
    await expect(fresh.prune()).resolves.toBeUndefined();
    await expect(fresh.deleteAll()).resolves.toMatchObject({
      complete: true,
      remainingFiles: 0,
      failedFiles: 0,
    });
    const sizes = await Promise.all(
      (await telemetryFileNames()).map(async (name) =>
        fs.stat(path.join(tempDir, name)).then((stat) => stat.size),
      ),
    );
    expect(sizes.every((size) => size === 0)).toBe(true);
  });

  it("does not replay a line when close fails after append", async () => {
    let failClose = true;
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      pruneEveryWrites: 1,
      closeFile: async (handle) => {
        await handle.close();
        if (!failClose) return;
        failClose = false;
        throw Object.assign(new Error("busy after append"), { code: "EBUSY" });
      },
    });

    await expect(
      store.append({ eventType: "Marshal.Fetch", fields: { scenario: "committed-once" } }),
    ).rejects.toMatchObject({ code: "EBUSY" });

    const filePath = path.join(tempDir, "events-2026-08-01-000.jsonl");
    const lines = (await fs.readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("committed-once");
  });

  it("does not replay a line when post-append pruning fails", async () => {
    const readdir = vi.spyOn(fs, "readdir");
    let injectPruneFailure = true;
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      pruneEveryWrites: 1,
      closeFile: async (handle) => {
        await handle.close();
        if (!injectPruneFailure) return;
        injectPruneFailure = false;
        readdir.mockRejectedValueOnce(Object.assign(new Error("prune busy"), { code: "EBUSY" }));
      },
    });

    await expect(
      store.append({ eventType: "Marshal.Fetch", fields: { scenario: "prune-once" } }),
    ).rejects.toMatchObject({ code: "EBUSY" });

    const filePath = path.join(tempDir, "events-2026-08-01-000.jsonl");
    const lines = (await fs.readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("prune-once");
    readdir.mockRestore();
  });

  it("rotates before an append would exceed the per-file limit", async () => {
    const event = fetchEvent()!;
    const lineBytes = Buffer.byteLength(
      JSON.stringify({
        schemaVersion: 1,
        recordedAt: NOW.toISOString(),
        eventType: event.eventType,
        fields: event.fields,
      }) + "\n",
      "utf8",
    );
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      maxFileBytes: lineBytes + 1,
    });

    await store.append(event);
    await store.append(event);

    expect(await telemetryFileNames()).toEqual([
      "events-2026-08-01-000.jsonl",
      "events-2026-08-01-001.jsonl",
    ]);
  });

  it("rotates from index 999 to 1000 without orphaning the file", async () => {
    const event = fetchEvent()!;
    const lineBytes = Buffer.byteLength(
      JSON.stringify({
        schemaVersion: 1,
        recordedAt: NOW.toISOString(),
        eventType: event.eventType,
        fields: event.fields,
      }) + "\n",
      "utf8",
    );
    await Promise.all(
      Array.from({ length: 1000 }, (_, index) =>
        fs.writeFile(
          path.join(tempDir, formatLocalTelemetryFileName("2026-08-01", index)),
          Buffer.alloc(lineBytes, 0x20),
        ),
      ),
    );
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      maxFileBytes: lineBytes,
      maxTotalBytes: lineBytes * 2000,
    });

    await store.append(event);

    const index1000 = path.join(tempDir, "events-2026-08-01-1000.jsonl");
    expect(await fs.readFile(index1000, "utf8")).toContain(event.eventType);
    const deleted = await store.deleteAll();
    expect(deleted.complete).toBe(true);
    expect(deleted.remainingFiles).toBe(0);
    expect((await fs.stat(index1000)).size).toBe(0);
  });

  it("reports malformed and unsafe-index event paths instead of hiding them", async () => {
    const alias = path.join(tempDir, "events-2026-08-01-0000.jsonl");
    const overflow = path.join(tempDir, "events-2026-08-01-9007199254740992.jsonl");
    await fs.writeFile(alias, "alias-content");
    await fs.writeFile(overflow, "overflow-content");
    const store = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });

    const result = await store.deleteAll();

    expect(result).toMatchObject({
      complete: false,
      remainingFiles: 2,
      failedFiles: 2,
    });
    expect(await fs.readFile(alias, "utf8")).toBe("alias-content");
    expect(await fs.readFile(overflow, "utf8")).toBe("overflow-content");
  });

  it("binds the exact identity of a newly created rotated file", async () => {
    const event = fetchEvent()!;
    const lineBytes = Buffer.byteLength(
      JSON.stringify({
        schemaVersion: 1,
        recordedAt: NOW.toISOString(),
        eventType: event.eventType,
        fields: event.fields,
      }) + "\n",
      "utf8",
    );
    const displacedPath = path.join(tempDir, "events-2026-07-31-997.jsonl");
    const replacementPath = path.join(tempDir, "events-2026-08-01-001.jsonl");
    let replaceRotatedFile = false;
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      maxFileBytes: lineBytes + 1,
      afterFileOpen: async (filePath) => {
        if (!replaceRotatedFile || !filePath.endsWith("-001.jsonl")) return;
        replaceRotatedFile = false;
        await fs.rename(filePath, displacedPath);
        await fs.writeFile(filePath, "rotated-replacement");
      },
    });

    await store.append(event);
    replaceRotatedFile = true;
    await expect(store.append(event)).rejects.toThrow("telemetry_file_identity_changed");

    expect(await fs.readFile(displacedPath, "utf8")).toBe("");
    expect(await fs.readFile(replacementPath, "utf8")).toBe("rotated-replacement");
    expect((await fs.readdir(tempDir)).some((name) => name.includes("quarantine"))).toBe(false);
    const original = await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"), "utf8");
    expect(original.trim().split("\n")).toHaveLength(1);
  });

  it("prunes files older than retention", async () => {
    const stalePath = path.join(tempDir, "events-2026-06-01-000.jsonl");
    const currentPath = path.join(tempDir, "events-2026-08-01-000.jsonl");
    await fs.writeFile(stalePath, "{}\n");
    await fs.writeFile(currentPath, "{}\n");
    await fs.utimes(stalePath, new Date("2026-06-01T00:00:00Z"), new Date("2026-06-01T00:00:00Z"));
    await fs.utimes(currentPath, NOW, NOW);

    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      retentionDays: 30,
    });
    await store.prune();

    expect((await fs.stat(stalePath)).size).toBe(0);
    expect((await fs.stat(currentPath)).size).toBeGreaterThan(0);
  });

  it("serializes a real child append against parent prune truncation", async () => {
    const bundlePath = `${tempDir}-append-prune-child.cjs`;
    await bundleLocalTelemetryStore(bundlePath);
    let now = NOW;
    let childAppend = Promise.resolve<{ ok: true; result: unknown } | { ok: false; error: string }>(
      { ok: false, error: "child_not_started" },
    );
    let childStarted = false;
    let launchChild = false;
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => now,
      retentionDays: 30,
      beforeFileRemove: () => {
        if (!launchChild || childStarted) return;
        childStarted = true;
        childAppend = runChildStoreOperation(bundlePath, tempDir, "append", "after-prune");
      },
    });
    try {
      await store.append({
        eventType: "Marshal.Fetch",
        fields: { scenario: "expired-parent" },
      });
      now = new Date("2027-01-01T00:00:00.000Z");
      launchChild = true;

      await store.prune();
      const childResult = await childAppend;

      expect(childResult).toMatchObject({ ok: true });
      const content = await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"), "utf8");
      expect(content).toContain("after-prune");
      expect(content).not.toContain("expired-parent");
    } finally {
      await fs.rm(bundlePath, { force: true });
    }
  });

  it("removes oldest rotated files to enforce the total size cap", async () => {
    const event = fetchEvent()!;
    const lineBytes = Buffer.byteLength(
      JSON.stringify({
        schemaVersion: 1,
        recordedAt: NOW.toISOString(),
        eventType: event.eventType,
        fields: event.fields,
      }) + "\n",
      "utf8",
    );
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      maxFileBytes: lineBytes + 1,
      maxTotalBytes: lineBytes * 2 + 1,
    });

    await store.append(event);
    await store.append(event);
    await store.append(event);

    const files = await telemetryFileNames();
    const sizes = await Promise.all(
      files.map(async (file) => (await fs.stat(path.join(tempDir, file))).size),
    );
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(lineBytes * 2 + 1);
    expect(sizes.filter((size) => size === 0)).toHaveLength(1);
  });

  it("serializes a real child append against parent cap enforcement", async () => {
    const bundlePath = `${tempDir}-append-cap-child.cjs`;
    await bundleLocalTelemetryStore(bundlePath);
    const event = fetchEvent()!;
    const lineBytes = Buffer.byteLength(
      JSON.stringify({
        schemaVersion: 1,
        recordedAt: NOW.toISOString(),
        eventType: event.eventType,
        fields: event.fields,
      }) + "\n",
      "utf8",
    );
    let childAppend = Promise.resolve<{ ok: true; result: unknown } | { ok: false; error: string }>(
      { ok: false, error: "child_not_started" },
    );
    let childStarted = false;
    let launchChild = false;
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      maxFileBytes: lineBytes + 1,
      maxTotalBytes: lineBytes * 2 + 1,
      beforeFileRemove: () => {
        if (!launchChild || childStarted) return;
        childStarted = true;
        childAppend = runChildStoreOperation(bundlePath, tempDir, "append", "after-cap");
      },
    });
    try {
      await store.append(event);
      await store.append(event);
      launchChild = true;

      await store.append(event);
      const childResult = await childAppend;

      expect(childResult).toMatchObject({ ok: true });
      const contents = await Promise.all(
        (await telemetryFileNames()).map((name) => fs.readFile(path.join(tempDir, name), "utf8")),
      );
      expect(contents.some((content) => content.includes("after-cap"))).toBe(true);
    } finally {
      await fs.rm(bundlePath, { force: true });
    }
  });

  it("quarantines a cap-enforcement replacement across subsequent cap pruning", async () => {
    const event = fetchEvent()!;
    const lineBytes = Buffer.byteLength(
      JSON.stringify({
        schemaVersion: 1,
        recordedAt: NOW.toISOString(),
        eventType: event.eventType,
        fields: event.fields,
      }) + "\n",
      "utf8",
    );
    const outsideReplacement = `${tempDir}-cap-replacement.jsonl`;
    const displacedOriginal = path.join(tempDir, "events-2026-07-31-996.jsonl");
    await fs.writeFile(outsideReplacement, "cap-replacement");
    let replaceOldest = false;
    let replacedFilePath = "";
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      maxFileBytes: lineBytes + 1,
      maxTotalBytes: lineBytes * 2 + 1,
      beforeFileRemove: async (filePath) => {
        if (!replaceOldest) return;
        replaceOldest = false;
        replacedFilePath = filePath;
        await fs.rename(filePath, displacedOriginal);
        await fs.rename(outsideReplacement, filePath);
      },
    });
    try {
      await store.append(event);
      await store.append(event);
      replaceOldest = true;
      await expect(store.append(event)).rejects.toThrow("telemetry_file_identity_changed");

      const replacementAtPath = replacedFilePath;
      expect(await fs.readFile(displacedOriginal, "utf8")).toContain(event.eventType);
      expect(await fs.readFile(replacementAtPath, "utf8")).toBe("cap-replacement");
      expect((await fs.readdir(tempDir)).some((name) => name.includes("quarantine"))).toBe(false);

      await expect(store.prune()).resolves.toBeUndefined();
      expect(await fs.readFile(displacedOriginal, "utf8")).toContain(event.eventType);
      expect(await fs.readFile(replacementAtPath, "utf8")).toBe("cap-replacement");
    } finally {
      await fs.rm(outsideReplacement, { force: true });
    }
  });

  it("reuses a bounded shell pool across over a thousand rotations, restart, cap, and deleteAll", async () => {
    const event = fetchEvent()!;
    const lineBytes = Buffer.byteLength(
      JSON.stringify({
        schemaVersion: 1,
        recordedAt: NOW.toISOString(),
        eventType: event.eventType,
        fields: event.fields,
      }) + "\n",
      "utf8",
    );
    const options = {
      directory: tempDir,
      now: () => NOW,
      maxFileBytes: lineBytes + 1,
      maxTotalBytes: lineBytes * 2 + 1,
      maxShells: 8,
      pruneEveryWrites: 10_000,
      pruneIntervalMs: Number.MAX_SAFE_INTEGER,
    };
    const store = new LocalTelemetryStore(options);
    for (let index = 0; index < 1_024; index++) {
      // eslint-disable-next-line no-await-in-loop -- serialized rotations exercise the production shell reuse path
      await store.append(event);
    }
    await store.flush();
    expect((await telemetryFileNames()).length).toBeLessThanOrEqual(8);

    const lstat = vi.spyOn(fs, "lstat");
    const restarted = new LocalTelemetryStore(options);
    await restarted.prune();
    const restartLstatCalls = lstat.mock.calls.length;
    lstat.mockRestore();
    expect(restartLstatCalls).toBeLessThan(50);
    await restarted.append(event);
    expect((await telemetryFileNames()).length).toBeLessThanOrEqual(8);

    const deleted = await restarted.deleteAll();
    expect(deleted.complete).toBe(true);
    expect(deleted.remainingFiles).toBe(0);
    expect((await telemetryFileNames()).length).toBeLessThanOrEqual(8);
  }, 60_000);

  it("persists logical dates when only old shells are available at capacity", async () => {
    const oldNames = ["events-2020-01-01-000.jsonl", "events-2020-01-02-000.jsonl"];
    await Promise.all(oldNames.map((name) => fs.writeFile(path.join(tempDir, name), "")));
    const event = fetchEvent()!;
    const lineBytes = Buffer.byteLength(
      JSON.stringify({
        schemaVersion: 1,
        recordedAt: NOW.toISOString(),
        eventType: event.eventType,
        fields: event.fields,
      }) + "\n",
      "utf8",
    );
    let now = new Date("2026-08-01T09:00:00.000Z");
    const options = {
      directory: tempDir,
      now: () => now,
      maxFileBytes: lineBytes + 1,
      maxTotalBytes: 180,
      maxShells: 2,
      retentionDays: 30,
    };
    const first = new LocalTelemetryStore(options);
    await first.append({
      eventType: "Marshal.Fetch",
      fields: { scenario: "logical-day-one" },
    });
    await first.flush();
    now = new Date("2026-08-02T09:00:00.000Z");
    const second = new LocalTelemetryStore(options);
    await second.append({
      eventType: "Marshal.Fetch",
      fields: { scenario: "logical-day-two" },
    });
    await second.flush();

    const contents = await Promise.all(
      oldNames.map((name) => fs.readFile(path.join(tempDir, name), "utf8")),
    );
    const logicalMapBeforeRestart = await readLogicalDateMetadata();
    expect({
      dayOnePresent: contents.some((content) => content.includes("logical-day-one")),
      dayTwoPresent: contents.some((content) => content.includes("logical-day-two")),
      logicalMapBeforeRestart,
    }).toEqual({
      dayOnePresent: false,
      dayTwoPresent: true,
      logicalMapBeforeRestart: expect.stringContaining("2026-08-02"),
    });
    await Promise.all(
      oldNames.map((name) =>
        fs.utimes(
          path.join(tempDir, name),
          new Date("2020-01-01T00:00:00.000Z"),
          new Date("2020-01-01T00:00:00.000Z"),
        ),
      ),
    );
    now = new Date("2026-08-15T09:00:00.000Z");
    const restarted = new LocalTelemetryStore(options);
    await restarted.prune();

    const retained = await Promise.all(
      oldNames.map((name) => fs.readFile(path.join(tempDir, name), "utf8")),
    );
    expect(retained.some((content) => content.includes("logical-day-two"))).toBe(true);
    const logicalMap = await readLogicalDateMetadata();
    expect(logicalMap).toContain("2026-08-02");
    expect(await telemetryFileNames()).toEqual(oldNames);
  });

  it("recovers the prior logical-date generation after an interrupted compaction", async () => {
    const fixture = await createMappedOldShell();
    await fs.writeFile(
      fixture.bufferB,
      "H\tv2\t2\nR\tevents-2020-01-01-000.jsonl\t2026-08-01\t0\tpartial",
    );
    const before = await fs.readFile(fixture.mappedPath, "utf8");
    const restarted = new LocalTelemetryStore({
      directory: tempDir,
      now: () => new Date("2026-08-15T09:00:00.000Z"),
      maxShells: 2,
    });

    await restarted.prune();

    expect(await fs.readFile(fixture.mappedPath, "utf8")).toBe(before);
  });

  it("ignores a partial trailing logical-date journal update", async () => {
    const fixture = await createMappedOldShell();
    await fs.appendFile(fixture.bufferA, "U\tevents-2020-01-01-000.jsonl\t2026-08");
    const before = await fs.readFile(fixture.mappedPath, "utf8");
    const restarted = new LocalTelemetryStore({
      directory: tempDir,
      now: () => new Date("2026-08-15T09:00:00.000Z"),
      maxShells: 2,
    });

    await restarted.prune();

    expect(await fs.readFile(fixture.mappedPath, "utf8")).toBe(before);
  });

  it.each(["corrupt", "missing"] as const)(
    "fails closed when required logical-date metadata is %s",
    async (mode) => {
      const fixture = await createMappedOldShell();
      const before = await fs.readFile(fixture.mappedPath, "utf8");
      if (mode === "corrupt") {
        await fs.appendFile(fixture.bufferA, "U\tcorrupt\tcomplete\tline\tbad\n");
      } else {
        await fs.rm(fixture.bufferA, { force: true });
        await fs.rm(fixture.bufferB, { force: true });
      }
      const restarted = new LocalTelemetryStore({
        directory: tempDir,
        now: () => new Date("2027-01-01T09:00:00.000Z"),
        maxShells: 2,
      });

      await expect(restarted.prune()).rejects.toThrow("telemetry_logical_dates_untrusted");

      expect(await fs.readFile(fixture.mappedPath, "utf8")).toBe(before);
    },
  );

  it("fails closed instead of using a stale generation after a day-30 active record is corrupt", async () => {
    const fixture = await createLogicalDateGenerationFixture(30);
    const before = await fs.readFile(fixture.latest.path, "utf8");
    await fs.appendFile(
      fixture.active.filePath,
      "U\t9999\tevents-2020-01-01-000.jsonl\t2026-08-30\t0\tbad-checksum\n",
    );
    fixture.setNow(new Date("2026-09-15T09:00:00.000Z"));
    const restarted = new LocalTelemetryStore(fixture.options);

    await expect(restarted.prune()).rejects.toThrow("telemetry_logical_dates_untrusted");

    expect(await fs.readFile(fixture.latest.path, "utf8")).toBe(before);
  });

  it("detects a cleanly truncated active update from the mirrored witness sequence", async () => {
    const fixture = await createLogicalDateGenerationFixture();
    const before = await fs.readFile(fixture.latest.path, "utf8");
    const lines = fixture.active.content.trimEnd().split("\n");
    let updateIndex = -1;
    for (let index = lines.length - 1; index >= 0; index--) {
      if (!lines[index].startsWith("U\t")) continue;
      updateIndex = index;
      break;
    }
    expect(updateIndex).toBeGreaterThan(0);
    lines.splice(updateIndex, 1);
    await fs.writeFile(fixture.active.filePath, `${lines.join("\n")}\n`);
    fixture.setNow(new Date("2026-09-15T09:00:00.000Z"));
    const restarted = new LocalTelemetryStore(fixture.options);

    await expect(restarted.prune()).rejects.toThrow("telemetry_logical_dates_untrusted");

    expect(await fs.readFile(fixture.latest.path, "utf8")).toBe(before);
  });

  it.each(["post-commit", "switch-and-witness", "latest-witness"] as const)(
    "fails closed when the prior generation loses its %s tail",
    async (mode) => {
      const fixture = await createLogicalDateGenerationFixture(30);
      const before = await fs.readFile(fixture.latest.path, "utf8");
      expect(
        [fixture.active.generation, fixture.inactive.generation].sort(
          (left, right) => left - right,
        ),
      ).toEqual([5, 6]);
      const lines = fixture.inactive.content.trimEnd().split("\n");
      if (mode === "post-commit") {
        const commitIndex = lines.findIndex((line) => line.startsWith("C\t"));
        if (commitIndex <= 0) throw new Error("logical_commit_missing");
        lines.splice(commitIndex + 1);
      } else if (mode === "switch-and-witness") {
        const switchIndex = lines.findIndex((line) => line.startsWith("S\t"));
        if (switchIndex <= 0) throw new Error("logical_switch_missing");
        lines.splice(switchIndex);
      } else {
        let witnessIndex = -1;
        for (let index = lines.length - 1; index >= 0; index--) {
          if (!lines[index].startsWith("W\t")) continue;
          witnessIndex = index;
          break;
        }
        if (witnessIndex <= 0) throw new Error("logical_witness_missing");
        lines.splice(witnessIndex, 1);
      }
      await fs.writeFile(fixture.inactive.filePath, `${lines.join("\n")}\n`);
      fixture.setNow(new Date("2026-10-15T09:00:00.000Z"));
      const restarted = new LocalTelemetryStore(fixture.options);

      await expect(restarted.prune()).rejects.toThrow("telemetry_logical_dates_untrusted");

      expect(await fs.readFile(fixture.latest.path, "utf8")).toBe(before);
    },
  );

  it.each(["inactive", "both"] as const)(
    "fails closed when the %s logical-date generation is corrupt",
    async (mode) => {
      const fixture = await createLogicalDateGenerationFixture();
      const before = await fs.readFile(fixture.latest.path, "utf8");
      await fs.appendFile(fixture.inactive.filePath, "corrupt-inactive-generation\n");
      if (mode === "both") {
        await fs.appendFile(fixture.active.filePath, "corrupt-active-generation\n");
      }
      const restarted = new LocalTelemetryStore(fixture.options);

      await expect(restarted.prune()).rejects.toThrow("telemetry_logical_dates_untrusted");

      expect(await fs.readFile(fixture.latest.path, "utf8")).toBe(before);
    },
  );

  it.each(["duplicate", "gap", "out-of-order"] as const)(
    "rejects a complete %s logical-date journal sequence",
    async (mode) => {
      const fixture = await createLogicalDateGenerationFixture();
      const headerSequence = Number(fixture.active.content.split("\n", 1)[0]?.split("\t")[3]);
      const updateSequences = fixture.active.content
        .split("\n")
        .filter((line) => line.startsWith("U\t"))
        .map((line) => Number(line.split("\t")[1]));
      const currentSequence = Math.max(headerSequence, ...updateSequences);
      const sequence =
        mode === "duplicate"
          ? currentSequence
          : mode === "gap"
            ? currentSequence + 2
            : Math.max(0, currentSequence - 1);
      const payload = `U\t${sequence}\tevents-2020-01-01-000.jsonl\t2026-08-06\t0`;
      await fs.appendFile(fixture.active.filePath, `${payload}\t${logicalDateChecksum(payload)}\n`);
      const restarted = new LocalTelemetryStore(fixture.options);

      await expect(restarted.prune()).rejects.toThrow("telemetry_logical_dates_untrusted");

      expect(await fs.readFile(fixture.latest.path, "utf8")).toBe(fixture.latest.content);
    },
  );

  it("allows explicit deletion despite corrupt logical dates and a blocklist-all state", async () => {
    const fixture = await createLogicalDateGenerationFixture();
    await fs.appendFile(fixture.active.filePath, "corrupt-active-generation\n");
    await fs.writeFile(
      path.join(path.dirname(tempDir), `.${path.basename(tempDir)}-blocked-v1`),
      "v1\tall\n",
    );
    const restarted = new LocalTelemetryStore(fixture.options);

    await expect(restarted.deleteAll()).resolves.toMatchObject({
      complete: true,
      remainingFiles: 0,
      remainingBytes: 0,
    });

    expect((await fs.stat(fixture.latest.path)).size).toBe(0);
  });

  it("merges logical-date updates from simultaneous real processes", async () => {
    const oldNames = ["events-2020-01-01-000.jsonl", "events-2020-01-02-000.jsonl"];
    await Promise.all(oldNames.map((name) => fs.writeFile(path.join(tempDir, name), "")));
    const bundlePath = `${tempDir}-logical-multiprocess.cjs`;
    await bundleLocalTelemetryStore(bundlePath);
    try {
      const results = await Promise.all([
        runChildStoreOperation(bundlePath, tempDir, "append", "logical-process-one", {
          now: "2026-08-01T09:00:00.000Z",
          maxShells: 2,
        }),
        runChildStoreOperation(bundlePath, tempDir, "append", "logical-process-two", {
          now: "2026-08-02T09:00:00.000Z",
          maxShells: 2,
        }),
      ]);
      expect(results.filter((result) => !result.ok)).toEqual([]);

      const restarted = new LocalTelemetryStore({
        directory: tempDir,
        now: () => new Date("2026-08-15T09:00:00.000Z"),
        maxShells: 2,
      });
      await restarted.prune();
      const contents = await Promise.all(
        oldNames.map((name) => fs.readFile(path.join(tempDir, name), "utf8")),
      );
      expect(contents.some((content) => content.includes("logical-process-one"))).toBe(true);
      expect(contents.some((content) => content.includes("logical-process-two"))).toBe(true);
      const metadata = await readLogicalDateMetadata();
      expect(metadata).toContain("2026-08-01");
      expect(metadata).toContain("2026-08-02");
    } finally {
      await fs.rm(bundlePath, { force: true });
    }
  });

  it("compacts the logical-date journal into alternating complete generations", async () => {
    await Promise.all(
      ["events-2020-01-01-000.jsonl", "events-2020-01-02-000.jsonl"].map((name) =>
        fs.writeFile(path.join(tempDir, name), ""),
      ),
    );
    let now = new Date("2026-08-01T09:00:00.000Z");
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => now,
      maxShells: 2,
      maxFileBytes: 200,
      maxTotalBytes: 1024 * 1024,
      maxLogicalDatesBytes: 1024,
    });
    for (let day = 1; day <= 24; day++) {
      now = new Date(`2026-08-${String(day).padStart(2, "0")}T09:00:00.000Z`);
      // eslint-disable-next-line no-await-in-loop -- each day appends one checksummed journal update
      await store.append({
        eventType: "Marshal.Fetch",
        fields: { scenario: `compact-${day}` },
      });
    }
    await store.flush();

    const [bufferA, bufferB] = await Promise.all(
      (["a", "b"] as const).map((buffer) =>
        fs.readFile(
          path.join(path.dirname(tempDir), `.${path.basename(tempDir)}-logical-dates-v2-${buffer}`),
          "utf8",
        ),
      ),
    );
    expect(bufferA).toContain("\nC\t");
    expect(bufferB).toContain("\nC\t");
    expect(Buffer.byteLength(bufferA, "utf8")).toBeLessThanOrEqual(1536);
    expect(Buffer.byteLength(bufferB, "utf8")).toBeLessThanOrEqual(1536);
  });

  it("batches maintenance over 3000 legacy zero shells without blocking the event loop", async () => {
    const store = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });
    await store.append(fetchEvent()!);
    await store.deleteAll();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.all(
      Array.from({ length: 3000 }, (_, index) => {
        const date = `202${Math.floor(index / 1000) + 3}-01-01`;
        return fs.writeFile(
          path.join(tempDir, formatLocalTelemetryFileName(date, index % 1000)),
          "",
        );
      }),
    );
    const delay = monitorEventLoopDelay({ resolution: 1 });
    delay.enable();
    const startedAt = performance.now();

    await store.prune();

    const elapsedMs = performance.now() - startedAt;
    delay.disable();
    if (process.env.MARSHAL_TELEMETRY_BENCHMARK === "1") {
      process.stdout.write(
        `TELEMETRY_BENCH shells ${JSON.stringify({
          totalMs: elapsedMs,
          eventLoopMaxMs: delay.max / 1_000_000,
        })}\n`,
      );
    }
    expect(elapsedMs).toBeLessThan(500);
    expect(delay.max / 1_000_000).toBeLessThan(40);
    const beforeAppendCount = (await telemetryFileNames()).length;
    await store.append(fetchEvent()!);
    expect(await telemetryFileNames()).toHaveLength(beforeAppendCount);
  });

  it("bounds verified deletion across 100 telemetry files", async () => {
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        fs.writeFile(
          path.join(tempDir, formatLocalTelemetryFileName("2026-08-01", index)),
          `${JSON.stringify({ index })}\n`,
        ),
      ),
    );
    const store = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });
    const delay = monitorEventLoopDelay({ resolution: 1 });
    delay.enable();
    const startedAt = performance.now();

    const result = await store.deleteAll();

    const elapsedMs = performance.now() - startedAt;
    delay.disable();
    if (process.env.MARSHAL_TELEMETRY_BENCHMARK === "1") {
      process.stdout.write(
        `TELEMETRY_BENCH delete100 ${JSON.stringify({
          totalMs: elapsedMs,
          eventLoopMaxMs: delay.max / 1_000_000,
          complete: result.complete,
        })}\n`,
      );
    }
    expect(result).toMatchObject({
      complete: true,
      deletedFiles: 100,
      remainingFiles: 0,
      remainingBytes: 0,
    });
    expect(elapsedMs).toBeLessThan(1_000);
    expect(delay.max / 1_000_000).toBeLessThan(40);
  });

  it("propagates a failed append without poisoning later queued writes", async () => {
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      maxFileBytes: 180,
    });

    await expect(
      store.append({
        eventType: "Marshal.Fetch",
        fields: { scenario: "x".repeat(200) },
      }),
    ).rejects.toThrow("event_too_large");
    await expect(
      store.append({
        eventType: "Marshal.SessionStart",
        fields: {},
      }),
    ).resolves.toBeUndefined();

    const content = await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"), "utf8");
    expect(content).toContain("Marshal.SessionStart");
    expect(content).not.toContain("x".repeat(200));
    await expect(store.deleteAll()).resolves.toMatchObject({
      complete: true,
      remainingFiles: 0,
      remainingBytes: 0,
    });
  });

  it("erases only dedicated telemetry contents without pathname deletion", async () => {
    const store = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });
    await store.append(fetchEvent()!);
    const result = await store.deleteAll();

    expect(result.complete).toBe(true);
    expect(result.deletedFiles).toBe(1);
    expect(result.deletedBytes).toBeGreaterThan(0);
    expect(result.remainingFiles).toBe(0);
    expect(result.failedFiles).toBe(0);
    expect((await fs.stat(tempDir)).isDirectory()).toBe(true);
    expect((await fs.stat(path.join(tempDir, "events-2026-08-01-000.jsonl"))).size).toBe(0);
    await expect(
      store.append({
        eventType: "Marshal.Fetch",
        fields: { scenario: "immediately-after-delete" },
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["before mutation", false, 1],
    ["after mutation", true, 0],
  ] as const)(
    "reports deleteAll failure when truncate returns EIO %s",
    async (_description, truncateFirst, expectedRemainingFiles) => {
      let failOnce = true;
      const store = new LocalTelemetryStore({
        directory: tempDir,
        now: () => NOW,
        truncateFile: async (handle) => {
          if (!truncateFirst) {
            throw Object.assign(new Error("injected truncate failure"), { code: "EIO" });
          }
          if (!failOnce) {
            await handle.truncate(0);
            return;
          }
          failOnce = false;
          await handle.truncate(0);
          throw Object.assign(new Error("injected truncate failure"), { code: "EIO" });
        },
      });
      await store.append(fetchEvent()!);

      const result = await store.deleteAll();

      expect(result.complete).toBe(false);
      expect(result.deletedFiles).toBe(0);
      expect(result.failedFiles).toBe(1);
      expect(result.remainingFiles).toBe(expectedRemainingFiles);
      expect(result.failureCodes).toContain("EIO");
      const size = (await fs.stat(path.join(tempDir, "events-2026-08-01-000.jsonl"))).size;
      expect(size === 0).toBe(truncateFirst);
    },
  );

  it("explicit deletion bypasses a valid blocklist-all write prohibition", async () => {
    const store = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });
    await store.append(fetchEvent()!);
    await store.flush();
    const blocklist = path.join(path.dirname(tempDir), `.${path.basename(tempDir)}-blocked-v1`);
    await fs.writeFile(blocklist, "v1\tall\n");
    const fresh = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });
    await expect(fresh.append(fetchEvent()!)).rejects.toThrow(
      "telemetry_file_identity_capacity_exceeded",
    );

    const result = await fresh.deleteAll();

    expect(result).toMatchObject({
      complete: true,
      deletedFiles: 1,
      remainingFiles: 0,
      failedFiles: 0,
    });
    expect((await fs.stat(path.join(tempDir, "events-2026-08-01-000.jsonl"))).size).toBe(0);
  });

  it("loads the persistent blocklist before append after delete-first startup", async () => {
    const seed = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });
    await seed.append(fetchEvent()!);
    await seed.flush();
    const blocklist = path.join(path.dirname(tempDir), `.${path.basename(tempDir)}-blocked-v1`);
    await fs.writeFile(blocklist, "v1\tall\n");
    const deleteFirst = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });

    await expect(deleteFirst.deleteAll()).resolves.toMatchObject({
      complete: true,
      remainingFiles: 0,
      remainingBytes: 0,
    });
    await expect(
      deleteFirst.append({
        eventType: "Marshal.Fetch",
        fields: { scenario: "blocked-after-delete-first" },
      }),
    ).rejects.toThrow("telemetry_file_identity_capacity_exceeded");

    expect((await fs.stat(path.join(tempDir, "events-2026-08-01-000.jsonl"))).size).toBe(0);
  });

  it("fails the first UNKNOWN generation admission closed and refreshes the retry", async () => {
    const store = new LocalTelemetryStoreImpl({ directory: tempDir, now: () => NOW });
    stores.push(store);

    await expect(
      store.append({
        eventType: "Marshal.Fetch",
        fields: { scenario: "unknown-generation" },
      }),
    ).rejects.toThrow("telemetry_delete_generation_unknown");
    await expect(
      store.append({
        eventType: "Marshal.Fetch",
        fields: { scenario: "known-generation-retry" },
      }),
    ).resolves.toBeUndefined();

    expect(await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"), "utf8")).toContain(
      "known-generation-retry",
    );
  });

  it.each([undefined, 1, 9_000_000_000_000_000] as const)(
    "rejects a generation captured before delayed binds and child delete at clock %s",
    async (systemNowMs) => {
      const bundlePath = `${tempDir}-delayed-admission-delete.cjs`;
      await bundleLocalTelemetryStore(bundlePath);
      let delayBinds = false;
      let bindCount = 0;
      let releaseBinds!: () => void;
      let allBindsDelayed!: () => void;
      const bindsDelayed = new Promise<void>((resolve) => {
        allBindsDelayed = resolve;
      });
      const bindsReleased = new Promise<void>((resolve) => {
        releaseBinds = resolve;
      });
      const store = new LocalTelemetryStoreImpl({
        directory: tempDir,
        now: () => NOW,
        beforeAppendAdmissionBind: async () => {
          if (!delayBinds) return;
          bindCount += 1;
          if (bindCount === 5) allBindsDelayed();
          await bindsReleased;
        },
      });
      stores.push(store);
      try {
        await store.prune();
        await store.append({
          eventType: "Marshal.Fetch",
          fields: { scenario: "before-delayed-delete" },
        });
        delayBinds = true;
        const staleAppend = store.append({
          eventType: "Marshal.Fetch",
          fields: { scenario: "captured-before-delayed-delete" },
        });
        await bindsDelayed;

        const deleted = await runChildStoreOperation(
          bundlePath,
          tempDir,
          "delete",
          "delayed-delete",
          { systemNowMs },
        );
        expect(deleted).toMatchObject({
          ok: true,
          result: { complete: true, remainingFiles: 0, remainingBytes: 0 },
        });
        releaseBinds();

        await expect(staleAppend).rejects.toThrow("telemetry_delete_generation_changed");
        expect((await fs.stat(path.join(tempDir, "events-2026-08-01-000.jsonl"))).size).toBe(0);
        delayBinds = false;
        await expect(
          store.append({
            eventType: "Marshal.Fetch",
            fields: { scenario: "refreshed-generation-retry" },
          }),
        ).resolves.toBeUndefined();
      } finally {
        releaseBinds();
        await fs.rm(bundlePath, { force: true });
      }
    },
  );

  it("rejects many queued generation captures after a delayed-bind child delete", async () => {
    const bundlePath = `${tempDir}-many-delayed-admissions.cjs`;
    await bundleLocalTelemetryStore(bundlePath);
    let delayBinds = false;
    let bindCount = 0;
    let releaseBinds!: () => void;
    let allBindsDelayed!: () => void;
    const bindsDelayed = new Promise<void>((resolve) => {
      allBindsDelayed = resolve;
    });
    const bindsReleased = new Promise<void>((resolve) => {
      releaseBinds = resolve;
    });
    const store = new LocalTelemetryStoreImpl({
      directory: tempDir,
      now: () => NOW,
      beforeAppendAdmissionBind: async () => {
        if (!delayBinds) return;
        bindCount += 1;
        if (bindCount === 40) allBindsDelayed();
        await bindsReleased;
      },
    });
    stores.push(store);
    try {
      await store.prune();
      await store.append(fetchEvent()!);
      delayBinds = true;
      const queued = Array.from({ length: 8 }, (_, index) =>
        store.append({
          eventType: "Marshal.Fetch",
          fields: { scenario: `queued-generation-${index}` },
        }),
      );
      await bindsDelayed;

      await expect(
        runChildStoreOperation(bundlePath, tempDir, "delete", "many-delayed-delete"),
      ).resolves.toMatchObject({
        ok: true,
        result: { complete: true, remainingFiles: 0, remainingBytes: 0 },
      });
      releaseBinds();

      const settled = await Promise.allSettled(queued);
      expect(
        settled.map((result) =>
          result.status === "rejected" && result.reason instanceof Error
            ? result.reason.message
            : result.status,
        ),
      ).toEqual(Array.from({ length: 8 }, () => "telemetry_delete_generation_changed"));
      expect((await fs.stat(path.join(tempDir, "events-2026-08-01-000.jsonl"))).size).toBe(0);
    } finally {
      releaseBinds();
      await fs.rm(bundlePath, { force: true });
    }
  });

  it.each(["complete", "killed"] as const)(
    "does not cache an active delete generation when the child is %s",
    async (mode) => {
      const bundlePath = `${tempDir}-active-generation-${mode}.cjs`;
      await bundleLocalTelemetryStore(bundlePath);
      let observedDeleting!: () => void;
      const deletingObserved = new Promise<void>((resolve) => {
        observedDeleting = resolve;
      });
      let delayBinds = false;
      let bindCount = 0;
      let releaseBinds!: () => void;
      let allBindsDelayed!: () => void;
      const bindsDelayed = new Promise<void>((resolve) => {
        allBindsDelayed = resolve;
      });
      const bindsReleased = new Promise<void>((resolve) => {
        releaseBinds = resolve;
      });
      const store = new LocalTelemetryStoreImpl({
        directory: tempDir,
        now: () => NOW,
        afterDeleteFenceObserved: (fence) => {
          if (fence.state === "deleting") observedDeleting();
        },
        beforeAppendAdmissionBind: async () => {
          if (!delayBinds) return;
          bindCount += 1;
          if (bindCount === 5) allBindsDelayed();
          await bindsReleased;
        },
      });
      stores.push(store);
      let child: ReturnType<typeof spawn> | null = null;
      try {
        await store.prune();
        await store.append(fetchEvent()!);
        const paused = await spawnPausableDeleteStore(bundlePath, tempDir);
        child = paused.child;
        const prune = store.prune();
        await deletingObserved;
        delayBinds = true;
        const duringDelete = store.append({
          eventType: "Marshal.Fetch",
          fields: { scenario: `active-generation-${mode}` },
        });
        await bindsDelayed;

        let completionResult: { ok: true; result: unknown } | { ok: false; error: string } | null =
          null;
        if (mode === "complete") {
          if (!child.stdin) throw new Error("pausable_delete_stdin_missing");
          child.stdin.end("release\n");
          completionResult = await paused.completion;
        } else {
          const ignoredCompletion = paused.completion.catch(() => null);
          await terminateChild(child);
          await ignoredCompletion;
        }
        const completionSummary =
          completionResult?.ok &&
          typeof completionResult.result === "object" &&
          completionResult.result !== null
            ? {
                ok: true,
                complete:
                  "complete" in completionResult.result
                    ? completionResult.result.complete
                    : undefined,
                remainingFiles:
                  "remainingFiles" in completionResult.result
                    ? completionResult.result.remainingFiles
                    : undefined,
                remainingBytes:
                  "remainingBytes" in completionResult.result
                    ? completionResult.result.remainingBytes
                    : undefined,
              }
            : completionResult;
        expect(completionSummary).toEqual(
          mode === "complete"
            ? {
                ok: true,
                complete: true,
                remainingFiles: 0,
                remainingBytes: 0,
              }
            : null,
        );
        releaseBinds();

        await expect(prune).resolves.toBeUndefined();
        await expect(duringDelete).rejects.toThrow("telemetry_delete_generation_changed");
        expect((await fs.stat(path.join(tempDir, "events-2026-08-01-000.jsonl"))).size).toBe(0);
      } finally {
        releaseBinds();
        if (child?.exitCode === null && child.signalCode === null) await terminateChild(child);
        await fs.rm(bundlePath, { force: true });
      }
    },
  );

  it("rejects every append admitted while a same-store delete is active", async () => {
    let enterDelete!: () => void;
    let releaseDelete!: () => void;
    const deleteEntered = new Promise<void>((resolve) => {
      enterDelete = resolve;
    });
    const deleteReleased = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    let pauseDelete = true;
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      truncateFile: async (handle) => {
        await handle.truncate(0);
        if (!pauseDelete) return;
        pauseDelete = false;
        enterDelete();
        await deleteReleased;
      },
    });
    await store.append(fetchEvent()!);

    const deletion = store.deleteAll();
    await deleteEntered;
    const queued = Array.from({ length: 12 }, (_, index) =>
      store.append({
        eventType: "Marshal.Fetch",
        fields: { scenario: `queued-during-delete-${index}` },
      }),
    );
    releaseDelete();

    await expect(deletion).resolves.toMatchObject({
      complete: true,
      remainingFiles: 0,
      remainingBytes: 0,
    });
    const settled = await Promise.allSettled(queued);
    expect(
      settled.map((result) =>
        result.status === "rejected" && result.reason instanceof Error
          ? result.reason.message
          : result.status,
      ),
    ).toEqual(Array.from({ length: 12 }, () => "telemetry_delete_in_progress"));

    await store.append({
      eventType: "Marshal.Fetch",
      fields: { scenario: "admitted-after-delete-result" },
    });
    const content = await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"), "utf8");
    expect(content).toContain("admitted-after-delete-result");
    expect(content).not.toContain("queued-during-delete");
  });

  it("keeps timing-callback admissions inside the delete settlement boundary", async () => {
    let callbackAppend: Promise<void> | null = null;
    let callbackSawSettled: boolean | null = null;
    let deleteSettled = false;
    const storeRef: { current: LocalTelemetryStore | null } = { current: null };
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      onOperationTiming: (timing) => {
        if (timing.operation !== "delete" || callbackAppend) return;
        const currentStore = storeRef.current;
        if (!currentStore) throw new Error("timing_callback_store_missing");
        callbackSawSettled = deleteSettled;
        callbackAppend = currentStore.append({
          eventType: "Marshal.Fetch",
          fields: { scenario: "timing-callback-before-delete-settlement" },
        });
      },
    });
    storeRef.current = store;
    await store.append(fetchEvent()!);

    const deletion = store.deleteAll();
    void deletion.then(() => {
      deleteSettled = true;
    });
    await expect(deletion).resolves.toMatchObject({
      complete: true,
      remainingFiles: 0,
      remainingBytes: 0,
    });
    const reentrantAppend = callbackAppend;
    if (!reentrantAppend) throw new Error("timing_callback_append_missing");

    expect(callbackSawSettled).toBe(false);
    await expect(reentrantAppend).rejects.toThrow("telemetry_delete_in_progress");
    expect((await fs.stat(path.join(tempDir, "events-2026-08-01-000.jsonl"))).size).toBe(0);
  });

  it("lets an append admitted before delete commit first and then erases it", async () => {
    let enterAppend!: () => void;
    let releaseAppend!: () => void;
    const appendEntered = new Promise<void>((resolve) => {
      enterAppend = resolve;
    });
    const appendReleased = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let pauseAppend = true;
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      beforeAppendWrite: async () => {
        if (!pauseAppend) return;
        pauseAppend = false;
        enterAppend();
        await appendReleased;
      },
    });
    const append = store.append({
      eventType: "Marshal.Fetch",
      fields: { scenario: "admitted-before-delete" },
    });
    await appendEntered;
    const deletion = store.deleteAll();
    releaseAppend();

    await expect(append).resolves.toBeUndefined();
    await expect(deletion).resolves.toMatchObject({
      complete: true,
      remainingFiles: 0,
      remainingBytes: 0,
    });
    expect((await fs.stat(path.join(tempDir, "events-2026-08-01-000.jsonl"))).size).toBe(0);
  });

  it("keeps during-delete admissions rejected when deletion is incomplete", async () => {
    let enterDelete!: () => void;
    let releaseDelete!: () => void;
    const deleteEntered = new Promise<void>((resolve) => {
      enterDelete = resolve;
    });
    const deleteReleased = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    let injectFailure = true;
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      truncateFile: async (handle) => {
        await handle.truncate(0);
        if (!injectFailure) return;
        injectFailure = false;
        enterDelete();
        await deleteReleased;
        throw Object.assign(new Error("injected delete failure"), { code: "EIO" });
      },
    });
    await store.append(fetchEvent()!);

    const deletion = store.deleteAll();
    await deleteEntered;
    const rejected = store.append({
      eventType: "Marshal.Fetch",
      fields: { scenario: "queued-during-incomplete-delete" },
    });
    releaseDelete();

    await expect(deletion).resolves.toMatchObject({
      complete: false,
      failureCodes: expect.arrayContaining(["EIO"]),
    });
    await expect(rejected).rejects.toThrow("telemetry_delete_in_progress");
    await expect(
      store.append({
        eventType: "Marshal.Fetch",
        fields: { scenario: "after-incomplete-delete-result" },
      }),
    ).resolves.toBeUndefined();
  });

  it("fences a real child-process append until deleteAll has verified completion", async () => {
    const bundlePath = `${tempDir}-delete-child-store.cjs`;
    await bundleLocalTelemetryStore(bundlePath);
    let childRejected = false;
    let launchChild = true;
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      truncateFile: async (handle) => {
        await handle.truncate(0);
        if (!launchChild) return;
        launchChild = false;
        try {
          await appendFromChildProcess(bundlePath, tempDir, "overlap-delete");
        } catch {
          childRejected = true;
        }
      },
    });
    try {
      await store.append(fetchEvent()!);

      const result = await store.deleteAll();

      expect(childRejected).toBe(true);
      expect(result).toMatchObject({
        complete: true,
        remainingFiles: 0,
        remainingBytes: 0,
        failedFiles: 0,
      });
      expect((await fs.stat(path.join(tempDir, "events-2026-08-01-000.jsonl"))).size).toBe(0);
    } finally {
      await fs.rm(bundlePath, { force: true });
    }
  });

  it("prevents a child delete launched inside the append commit from returning success", async () => {
    const bundlePath = `${tempDir}-commit-delete-child.cjs`;
    const legacyLockPath = path.join(
      path.dirname(tempDir),
      `.${path.basename(tempDir)}-commit.lock`,
    );
    await bundleLocalTelemetryStore(bundlePath);
    let childDelete: { ok: true; result: unknown } | { ok: false; error: string } | undefined;
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      beforeAppendWrite: async () => {
        await fs.rm(legacyLockPath, { recursive: true, force: true });
        await fs.mkdir(legacyLockPath);
        childDelete = await runChildStoreOperation(bundlePath, tempDir, "delete");
      },
    });

    try {
      await store.append({
        eventType: "Marshal.Fetch",
        fields: { scenario: "mutex-linearization" },
      });

      expect(childDelete).toEqual({ ok: false, error: "telemetry_commit_locked" });
      expect(
        await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"), "utf8"),
      ).toContain("mutex-linearization");
      const retry = await runChildStoreOperation(bundlePath, tempDir, "delete");
      expect(retry).toMatchObject({
        ok: true,
        result: { complete: true, remainingFiles: 0, remainingBytes: 0 },
      });
    } finally {
      await fs.rm(bundlePath, { force: true });
      await fs.rm(legacyLockPath, { recursive: true, force: true });
    }
  });

  it.each([1, 9_000_000_000_000_000] as const)(
    "orders append admission before a child delete with system clock %s",
    async (systemNowMs) => {
      const bundlePath = `${tempDir}-clock-independent-delete.cjs`;
      await bundleLocalTelemetryStore(bundlePath);
      let childDelete: { ok: true; result: unknown } | { ok: false; error: string } | undefined;
      const store = new LocalTelemetryStore({
        directory: tempDir,
        now: () => NOW,
        beforeAppendCommitLease: async () => {
          childDelete = await runChildStoreOperation(
            bundlePath,
            tempDir,
            "delete",
            "clock-delete",
            {
              systemNowMs,
            },
          );
        },
      });
      try {
        await store.append({
          eventType: "Marshal.Fetch",
          fields: { scenario: `clock-independent-${systemNowMs}` },
        });

        expect(childDelete).toEqual({ ok: false, error: "telemetry_commit_locked" });
        expect(
          await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"), "utf8"),
        ).toContain(`clock-independent-${systemNowMs}`);
        const retry = await runChildStoreOperation(
          bundlePath,
          tempDir,
          "delete",
          "clock-delete-retry",
          { systemNowMs },
        );
        expect(retry).toMatchObject({
          ok: true,
          result: { complete: true, remainingFiles: 0, remainingBytes: 0 },
        });
      } finally {
        await fs.rm(bundlePath, { force: true });
      }
    },
  );

  it("keeps the kernel lease exclusive when the legacy lock pathname becomes a link", async () => {
    const bundlePath = `${tempDir}-commit-link-child.cjs`;
    const legacyLockPath = path.join(
      path.dirname(tempDir),
      `.${path.basename(tempDir)}-commit.lock`,
    );
    const outside = `${legacyLockPath}-target`;
    await fs.mkdir(outside);
    await bundleLocalTelemetryStore(bundlePath);
    let childDelete: { ok: true; result: unknown } | { ok: false; error: string } | undefined;
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      beforeAppendWrite: async () => {
        await fs.rm(legacyLockPath, { recursive: true, force: true });
        await fs.symlink(
          outside,
          legacyLockPath,
          process.platform === "win32" ? "junction" : "dir",
        );
        childDelete = await runChildStoreOperation(bundlePath, tempDir, "delete");
      },
    });
    try {
      await store.append({
        eventType: "Marshal.Fetch",
        fields: { scenario: "link-resistant-lease" },
      });

      expect(childDelete).toEqual({ ok: false, error: "telemetry_commit_locked" });
      expect(
        await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"), "utf8"),
      ).toContain("link-resistant-lease");
    } finally {
      await fs.rm(bundlePath, { force: true });
      await fs.rm(legacyLockPath, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("settles queued appends while held, half-open, flooded, and reset clients attack the lease", async () => {
    const endpoints = await commitEndpointsForDirectory(tempDir);
    let attacked = false;
    let sockets: Awaited<ReturnType<typeof openLeaseAttackClients>> = [];
    let datagramSockets: Awaited<ReturnType<typeof sendLeaseAttackDatagrams>> = [];
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      beforeAppendWrite: async () => {
        if (attacked) return;
        attacked = true;
        sockets = await openLeaseAttackClients(endpoints, 96);
        datagramSockets = await sendLeaseAttackDatagrams(endpoints, 512);
        for (const socket of sockets.slice(0, 16)) {
          socket.destroy(new Error("client reset"));
        }
      },
    });
    const startedAt = performance.now();

    await Promise.all([
      store.append({ eventType: "Marshal.Fetch", fields: { scenario: "attacked-one" } }),
      store.append({ eventType: "Marshal.Fetch", fields: { scenario: "attacked-two" } }),
    ]);

    const elapsedMs = performance.now() - startedAt;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(elapsedMs).toBeLessThan(1_500);
    for (const socket of sockets) socket.destroy();
    for (const socket of datagramSockets) socket.close();
    const content = await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"), "utf8");
    expect(content.trim().split("\n")).toHaveLength(2);
  });

  it("bounds prune and delete completion while clients connect during truncation", async () => {
    const endpoints = await commitEndpointsForDirectory(tempDir);
    let now = NOW;
    let attack = false;
    const sockets: Awaited<ReturnType<typeof openLeaseAttackClients>> = [];
    const datagramSockets: Awaited<ReturnType<typeof sendLeaseAttackDatagrams>> = [];
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => now,
      retentionDays: 30,
      beforeFileRemove: async () => {
        if (!attack) return;
        attack = false;
        sockets.push(...(await openLeaseAttackClients(endpoints, 32)));
        datagramSockets.push(...(await sendLeaseAttackDatagrams(endpoints, 128)));
      },
    });
    await store.append(fetchEvent()!);
    now = new Date("2027-01-01T00:00:00.000Z");
    attack = true;
    const pruneStartedAt = performance.now();
    await store.prune();
    const pruneMs = performance.now() - pruneStartedAt;
    now = NOW;
    await store.append(fetchEvent()!);
    attack = true;
    const deleteStartedAt = performance.now();
    const deleted = await store.deleteAll();
    const deleteMs = performance.now() - deleteStartedAt;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(pruneMs).toBeLessThan(1_500);
    expect(deleteMs).toBeLessThan(1_500);
    expect(deleted.complete).toBe(true);
    for (const socket of sockets) socket.destroy();
    for (const socket of datagramSockets) socket.close();
  });

  it("lets a store process exit after hostile clients connect during commit", async () => {
    const bundlePath = `${tempDir}-client-shutdown.cjs`;
    await bundleLocalTelemetryStore(bundlePath);
    const endpoints = await commitEndpointsForDirectory(tempDir);
    const script = `
      const { connect } = require("node:net");
      const { LocalTelemetryStore } = require(process.argv[1]);
      (async () => {
        const endpoints = JSON.parse(process.argv[3]);
        let attacked = false;
        const store = new LocalTelemetryStore({
          directory: process.argv[2],
          now: () => new Date(${JSON.stringify(NOW.toISOString())}),
          beforeAppendWrite: async () => {
            if (attacked) return;
            attacked = true;
            await Promise.all(Array.from({ length: 32 }, (_, index) => new Promise((resolve) => {
              const socket = connect({ ...endpoints[index % endpoints.length], allowHalfOpen: true });
              socket.on("error", () => resolve());
              socket.once("connect", () => {
                socket.write(Buffer.from([1, 2, 3, 4]));
                resolve();
              });
            })));
          },
        });
        await store.prune();
        await store.append({ eventType: "Marshal.Fetch", fields: { scenario: "shutdown" } });
        console.log("DONE");
      })().catch((error) => {
        console.error(error);
        process.exit(1);
      });
    `;
    try {
      const result = await execFileAsync(
        process.execPath,
        ["-e", script, bundlePath, tempDir, JSON.stringify(endpoints)],
        { timeout: 3_000 },
      );
      expect(result.stdout).toContain("DONE");
    } finally {
      await fs.rm(bundlePath, { force: true });
    }
  });

  it("isolates profiles that collide on the old single-port namespace", async () => {
    const ancestor = await fs.realpath(tempDir);
    const ports = new Map<
      number,
      { name: string; endpoints: ReturnType<typeof resolveLocalTelemetryCommitEndpoints> }
    >();
    let collision:
      | {
          left: {
            name: string;
            endpoints: ReturnType<typeof resolveLocalTelemetryCommitEndpoints>;
          };
          right: {
            name: string;
            endpoints: ReturnType<typeof resolveLocalTelemetryCommitEndpoints>;
          };
        }
      | undefined;
    for (let index = 0; index < 1_000 && !collision; index++) {
      const name = `p${index}`;
      const profileKey = `${ancestor}\0${name}`;
      const endpoints = resolveLocalTelemetryCommitEndpoints(profileKey);
      const prior = ports.get(endpoints[0].port);
      if (prior) {
        collision = { left: prior, right: { name, endpoints } };
      } else {
        ports.set(endpoints[0].port, { name, endpoints });
      }
    }
    expect(collision).toBeDefined();
    if (!collision) throw new Error("endpoint_collision_not_found");
    const leftDirectory = path.join(tempDir, collision.left.name);
    const rightDirectory = path.join(tempDir, collision.right.name);
    await fs.mkdir(leftDirectory);
    await fs.mkdir(rightDirectory);
    let rightDelete: Awaited<ReturnType<LocalTelemetryStoreImpl["deleteAll"]>> | undefined;
    const right = new LocalTelemetryStore({ directory: rightDirectory, now: () => NOW });
    const left = new LocalTelemetryStore({
      directory: leftDirectory,
      now: () => NOW,
      beforeAppendWrite: async () => {
        rightDelete = await right.deleteAll();
      },
    });

    await left.append({ eventType: "Marshal.Fetch", fields: { scenario: "left-profile" } });

    expect(collision.left.endpoints[0].port).toBe(collision.right.endpoints[0].port);
    const overlap = collision.left.endpoints.filter((leftEndpoint) =>
      collision.right.endpoints.some(
        (rightEndpoint) =>
          leftEndpoint.host === rightEndpoint.host && leftEndpoint.port === rightEndpoint.port,
      ),
    );
    expect(overlap.length).toBeLessThan(3);
    expect(rightDelete).toMatchObject({ complete: true });
    expect(
      await fs.readFile(path.join(leftDirectory, "events-2026-08-01-000.jsonl"), "utf8"),
    ).toContain("left-profile");
  });

  it("falls back around wildcard prebinds and does not split when occupancy disappears", async () => {
    const endpoints = await commitEndpointsForDirectory(tempDir);
    const blockers = [
      createDatagramSocket({ type: "udp4", reuseAddr: false }),
      createDatagramSocket({ type: "udp4", reuseAddr: false }),
    ];
    const ipv6Blocker = createDatagramSocket({
      type: "udp6",
      reuseAddr: false,
      ipv6Only: true,
    });
    let ipv6Bound = false;
    await new Promise<void>((resolve, reject) => {
      blockers[0].once("error", reject);
      blockers[0].bind({ address: "0.0.0.0", port: endpoints[0].port, exclusive: true }, () =>
        resolve(),
      );
    });
    await new Promise<void>((resolve, reject) => {
      blockers[1].once("error", reject);
      blockers[1].bind({ address: "0.0.0.0", port: endpoints[1].port, exclusive: true }, () =>
        resolve(),
      );
    });
    await new Promise<void>((resolve) => {
      ipv6Blocker.once("error", () => resolve());
      ipv6Blocker.bind({ address: "::", port: endpoints[2].port, exclusive: true }, () => {
        ipv6Bound = true;
        resolve();
      });
    });
    let childDelete: { ok: true; result: unknown } | { ok: false; error: string } | undefined;
    const bundlePath = `${tempDir}-wildcard-child.cjs`;
    await bundleLocalTelemetryStore(bundlePath);
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      beforeAppendWrite: async () => {
        await new Promise<void>((resolve) => blockers[0].close(() => resolve()));
        childDelete = await runChildStoreOperation(bundlePath, tempDir, "delete");
      },
    });
    try {
      await store.append({
        eventType: "Marshal.Fetch",
        fields: { scenario: "wildcard-fallback" },
      });

      expect(childDelete).toEqual({ ok: false, error: "telemetry_commit_locked" });
      expect(
        await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"), "utf8"),
      ).toContain("wildcard-fallback");
      expect(typeof ipv6Bound).toBe("boolean");
    } finally {
      await Promise.all(
        blockers.map(
          (blocker) =>
            new Promise<void>((resolve) => {
              try {
                blocker.close(() => resolve());
              } catch {
                resolve();
              }
            }),
        ),
      );
      if (ipv6Bound) {
        await new Promise<void>((resolve) => ipv6Blocker.close(() => resolve()));
      }
      await fs.rm(bundlePath, { force: true });
    }
  });

  it("normalizes case, UNC-style separators, and Unicode profile identity", () => {
    const composed = resolveLocalTelemetryCommitEndpoints(
      "\\\\Server\\Share\\Ångström\u0000Telemetry",
      "win32",
    );
    const decomposed = resolveLocalTelemetryCommitEndpoints(
      "\\\\server\\share\\A\u030Angström\u0000telemetry".replaceAll("/", "\\"),
      "win32",
    );
    expect(decomposed).toEqual(composed);
    expect(composed.every((endpoint) => endpoint.host === "127.0.0.1")).toBe(true);
    expect(new Set(composed.map((endpoint) => endpoint.port)).size).toBe(5);
    const admissionComposed = resolveLocalTelemetryAdmissionEndpoints(
      "\\\\Server\\Share\\Ångström\\Telemetry",
      "win32",
    );
    const admissionDecomposed = resolveLocalTelemetryAdmissionEndpoints(
      "\\\\server\\share\\A\u030Angström\\telemetry".replaceAll("/", "\\"),
      "win32",
    );
    expect(admissionDecomposed).toEqual(admissionComposed);
    expect(admissionComposed.every((endpoint) => endpoint.host === "127.0.0.2")).toBe(true);
    expect(
      admissionComposed.every(
        (endpoint) =>
          !composed.some(
            (commit) => commit.host === endpoint.host && commit.port === endpoint.port,
          ),
      ),
    ).toBe(true);
  });

  it("serializes simultaneous child-process writers without losing JSONL records", async () => {
    const bundlePath = `${tempDir}-simultaneous-writers.cjs`;
    await bundleLocalTelemetryStore(bundlePath);
    try {
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          runChildStoreOperation(bundlePath, tempDir, "append", `writer-${index}`),
        ),
      );

      expect(results.filter((result) => !result.ok)).toEqual([]);
      const content = await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"), "utf8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(4);
      expect(
        lines
          .map((line) => JSON.parse(line).fields.scenario)
          .sort((left: string, right: string) => left.localeCompare(right)),
      ).toEqual(["writer-0", "writer-1", "writer-2", "writer-3"]);
    } finally {
      await fs.rm(bundlePath, { force: true });
    }
  });

  it("allows only one simultaneous child-process delete transaction to complete", async () => {
    const bundlePath = `${tempDir}-simultaneous-deleters.cjs`;
    await bundleLocalTelemetryStore(bundlePath);
    const seed = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });
    await seed.append(fetchEvent()!);
    await seed.flush();
    try {
      const results = await Promise.all([
        runChildStoreOperation(bundlePath, tempDir, "delete"),
        runChildStoreOperation(bundlePath, tempDir, "delete"),
      ]);
      const completed = results.filter(
        (result) =>
          result.ok &&
          typeof result.result === "object" &&
          result.result !== null &&
          "complete" in result.result &&
          result.result.complete === true,
      );
      const rejected = results.filter((result) => !result.ok);

      expect(completed).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({ ok: false });
      expect((await fs.stat(path.join(tempDir, "events-2026-08-01-000.jsonl"))).size).toBe(0);
    } finally {
      await fs.rm(bundlePath, { force: true });
    }
  });

  it("recovers the kernel commit lease immediately after its owner process is killed", async () => {
    const seed = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });
    await seed.append(fetchEvent()!);
    await seed.flush();
    const ancestor = await fs.realpath(path.dirname(tempDir));
    const basename = path.basename(tempDir);
    const profileKey = `${
      process.platform === "win32" ? ancestor.toLowerCase() : ancestor
    }\0${process.platform === "win32" ? basename.toLowerCase() : basename}`;
    const endpoints = resolveLocalTelemetryCommitEndpoints(profileKey);
    const script = `
      const { createSocket } = require("node:dgram");
      const endpoints = JSON.parse(process.argv[1]);
      let listening = 0;
      for (const endpoint of endpoints) {
        const socket = createSocket({ type: "udp4", reuseAddr: false });
        socket.bind({ address: endpoint.host, port: endpoint.port, exclusive: true }, () => {
          listening += 1;
          if (listening === endpoints.length) console.log("LOCKED");
        });
        socket.on("error", (error) => {
          console.error(error);
          process.exit(1);
        });
      }
    `;
    const child = spawn(process.execPath, ["-e", script, JSON.stringify(endpoints)], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (chunk.includes("LOCKED")) resolve();
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code !== null && code !== 0) reject(new Error(`lock child exited ${code}`));
      });
    });
    child.kill();
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const recovered = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
    });
    await expect(
      recovered.append({
        eventType: "Marshal.Fetch",
        fields: { scenario: "after-stale-lock" },
      }),
    ).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"), "utf8")).toContain(
      "after-stale-lock",
    );
  }, 10_000);

  it("recovers after a writer is killed immediately before writing event bytes", async () => {
    const bundlePath = `${tempDir}-kill-before-write.cjs`;
    await bundleLocalTelemetryStore(bundlePath);
    try {
      const child = await spawnChildStoreAtPhase(bundlePath, tempDir, "before-write");
      await terminateChild(child);

      const recovered = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });
      await recovered.append({
        eventType: "Marshal.Fetch",
        fields: { scenario: "recovered-before-write" },
      });

      const content = await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"), "utf8");
      expect(content.trim().split("\n")).toHaveLength(1);
      expect(content).toContain("recovered-before-write");
    } finally {
      await fs.rm(bundlePath, { force: true });
    }
  });

  it("releases admission when a writer dies before acquiring the mutation lease", async () => {
    const bundlePath = `${tempDir}-kill-before-commit-lease.cjs`;
    await bundleLocalTelemetryStore(bundlePath);
    try {
      const child = await spawnChildStoreAtPhase(bundlePath, tempDir, "before-commit-lease");
      await terminateChild(child);

      const recovered = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });
      await expect(recovered.deleteAll()).resolves.toMatchObject({
        complete: true,
        remainingFiles: 0,
        remainingBytes: 0,
      });
    } finally {
      await fs.rm(bundlePath, { force: true });
    }
  });

  it("releases the kernel lease when a writer dies after fsync but before validation", async () => {
    const bundlePath = `${tempDir}-kill-after-write.cjs`;
    await bundleLocalTelemetryStore(bundlePath);
    try {
      const child = await spawnChildStoreAtPhase(bundlePath, tempDir, "after-write");
      await terminateChild(child);
      const contentBeforeDelete = await fs.readFile(
        path.join(tempDir, "events-2026-08-01-000.jsonl"),
        "utf8",
      );
      expect(contentBeforeDelete).toContain("after-write");

      const recovered = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });
      const deleted = await recovered.deleteAll();

      expect(deleted).toMatchObject({
        complete: true,
        remainingFiles: 0,
        remainingBytes: 0,
      });
      expect((await fs.stat(path.join(tempDir, "events-2026-08-01-000.jsonl"))).size).toBe(0);
    } finally {
      await fs.rm(bundlePath, { force: true });
    }
  });

  it("recovers deletion after its process dies inside truncate", async () => {
    const bundlePath = `${tempDir}-kill-delete-truncate.cjs`;
    await bundleLocalTelemetryStore(bundlePath);
    const seed = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });
    await seed.append(fetchEvent()!);
    await seed.flush();
    try {
      const child = await spawnChildStoreAtPhase(bundlePath, tempDir, "delete-truncate");
      await terminateChild(child);

      const recovered = new LocalTelemetryStore({ directory: tempDir, now: () => NOW });
      const deleted = await recovered.deleteAll();

      expect(deleted).toMatchObject({
        complete: true,
        remainingFiles: 0,
        remainingBytes: 0,
      });
      expect((await fs.stat(path.join(tempDir, "events-2026-08-01-000.jsonl"))).size).toBe(0);
    } finally {
      await fs.rm(bundlePath, { force: true });
    }
  });

  it("quarantines a deleteAll child replacement and never adopts it on retry", async () => {
    const outsideReplacement = `${tempDir}-delete-replacement.jsonl`;
    const displacedOriginal = path.join(tempDir, "events-2026-07-31-995.jsonl");
    await fs.writeFile(outsideReplacement, "delete-replacement");
    let replaceChild = false;
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      beforeFileRemove: async (filePath) => {
        if (!replaceChild) return;
        replaceChild = false;
        await fs.rename(filePath, displacedOriginal);
        await fs.rename(outsideReplacement, filePath);
      },
    });
    try {
      await store.append(fetchEvent()!);
      replaceChild = true;
      const result = await store.deleteAll();

      const replacementAtPath = path.join(tempDir, "events-2026-08-01-000.jsonl");
      expect(result.complete).toBe(false);
      expect(result.failedFiles).toBe(1);
      expect(result.remainingFiles).toBe(0);
      expect((await fs.stat(displacedOriginal)).size).toBe(0);
      expect((await fs.stat(replacementAtPath)).size).toBe(0);
      expect((await fs.readdir(tempDir)).some((name) => name.includes("quarantine"))).toBe(false);

      await expect(store.deleteAll()).resolves.toMatchObject({
        complete: true,
        deletedFiles: 0,
        remainingFiles: 0,
      });
    } finally {
      await fs.rm(outsideReplacement, { force: true });
    }
  });

  it("binds prune erasure to the opened handle when pathname replacement occurs inside truncate", async () => {
    const outsideReplacement = `${tempDir}-prune-truncate-replacement.jsonl`;
    const displacedOriginal = path.join(tempDir, "events-2026-07-31-993.jsonl");
    await fs.writeFile(outsideReplacement, "outside-replacement");
    let now = NOW;
    let replaceInsideTruncate = false;
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => now,
      retentionDays: 30,
      truncateFile: async (handle, filePath) => {
        if (replaceInsideTruncate) {
          replaceInsideTruncate = false;
          await fs.rename(filePath, displacedOriginal);
          await fs.rename(outsideReplacement, filePath);
        }
        await handle.truncate(0);
      },
    });
    try {
      await store.append(fetchEvent()!);
      now = new Date("2027-01-01T00:00:00.000Z");
      replaceInsideTruncate = true;

      await expect(store.prune()).rejects.toThrow("telemetry_file_identity_changed");
      expect((await fs.stat(displacedOriginal)).size).toBe(0);
      expect(await fs.readFile(path.join(tempDir, "events-2026-08-01-000.jsonl"), "utf8")).toBe(
        "outside-replacement",
      );
      await expect(store.prune()).resolves.toBeUndefined();
    } finally {
      await fs.rm(outsideReplacement, { force: true });
    }
  });

  it("binds deleteAll erasure to the opened handle when pathname replacement occurs inside truncate", async () => {
    const outsideReplacement = `${tempDir}-delete-truncate-replacement.jsonl`;
    const displacedOriginal = path.join(tempDir, "events-2026-07-31-993.jsonl");
    await fs.writeFile(outsideReplacement, "outside-replacement");
    let replaceInsideTruncate = false;
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => NOW,
      truncateFile: async (handle, filePath) => {
        if (replaceInsideTruncate) {
          replaceInsideTruncate = false;
          await fs.rename(filePath, displacedOriginal);
          await fs.rename(outsideReplacement, filePath);
        }
        await handle.truncate(0);
      },
    });
    try {
      await store.append(fetchEvent()!);
      replaceInsideTruncate = true;

      const result = await store.deleteAll();

      expect(result).toMatchObject({
        complete: false,
        failedFiles: 1,
        remainingFiles: 0,
      });
      expect((await fs.stat(displacedOriginal)).size).toBe(0);
      expect((await fs.stat(path.join(tempDir, "events-2026-08-01-000.jsonl"))).size).toBe(0);
    } finally {
      await fs.rm(outsideReplacement, { force: true });
    }
  });

  it("never calls pathname unlink or rmdir for retention or deleteAll", async () => {
    let now = NOW;
    const store = new LocalTelemetryStore({
      directory: tempDir,
      now: () => now,
      retentionDays: 30,
    });

    await store.append(fetchEvent()!);
    now = new Date("2027-01-01T00:00:00.000Z");
    await store.prune();
    await store.append(fetchEvent()!);
    await store.deleteAll();

    const source = await fs.readFile(path.resolve("electron", "local-telemetry-store.ts"), "utf8");
    expect(source).not.toMatch(/\b(?:unlink|unlinkSync|rmdir|rmdirSync)\b/);
  });
});
