import {
  type ChildProcessWithoutNullStreams,
  spawn,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import {
  BAILEYS_STAGE0_BUNDLE_NAME,
  BAILEYS_STAGE0_RESOURCE_DIR,
  BAILEYS_STAGE0_SCHEMA_VERSION,
  type BaileysStage0ChildFrame,
  type BaileysStage0ParentFrame,
  parseBaileysStage0ChildFrame,
  serializeBaileysStage0Frame,
} from "./protocol";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_STDERR_BYTES = 16 * 1024;
const ENVIRONMENT_ALLOWLIST = new Set([
  "appdata",
  "home",
  "lang",
  "lc_all",
  "localappdata",
  "systemroot",
  "temp",
  "tmp",
  "tmpdir",
  "userprofile",
  "windir",
]);

export type BaileysStage0LaunchOptions =
  | {
      mode: "development";
      sidecarPath: string;
      nodeExecutable?: string;
      timeoutMs?: number;
    }
  | {
      mode: "packaged";
      resourcesPath: string;
      platform: NodeJS.Platform;
      timeoutMs?: number;
    };

export interface BaileysStage0ResolvedLaunch {
  command: string;
  args: string[];
  sidecarPath: string;
}

export interface BaileysStage0TranscriptEntry {
  direction: "parent->child" | "child->parent";
  frame: BaileysStage0ParentFrame | BaileysStage0ChildFrame;
}

export interface BaileysStage0ProbeResult {
  exitCode: 0;
  transcript: BaileysStage0TranscriptEntry[];
}

type SpawnSidecar = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

function assertAbsoluteFile(filePath: string, label: string): void {
  if (!path.isAbsolute(filePath)) {
    throw new Error(`${label} path must be absolute: ${filePath}`);
  }
  if (!existsSync(filePath)) {
    throw new Error(`${label} is missing: ${filePath}`);
  }
}

function resolvePackagedNode(resourcesPath: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return path.win32.join(resourcesPath, "node", "node.exe");
  return path.posix.join(resourcesPath, "node", "node");
}

export function resolveBaileysStage0Launch(
  options: BaileysStage0LaunchOptions,
): BaileysStage0ResolvedLaunch {
  if (options.mode === "development") {
    const command = options.nodeExecutable ?? process.execPath;
    assertAbsoluteFile(command, "Baileys Stage 0 Node executable");
    assertAbsoluteFile(options.sidecarPath, "Baileys Stage 0 sidecar");
    return { command, args: [options.sidecarPath], sidecarPath: options.sidecarPath };
  }

  if (!path.isAbsolute(options.resourcesPath)) {
    throw new Error(`Packaged resources path must be absolute: ${options.resourcesPath}`);
  }
  const sidecarPath =
    options.platform === "win32"
      ? path.win32.join(
          options.resourcesPath,
          BAILEYS_STAGE0_RESOURCE_DIR,
          BAILEYS_STAGE0_BUNDLE_NAME,
        )
      : path.posix.join(
          options.resourcesPath,
          BAILEYS_STAGE0_RESOURCE_DIR,
          BAILEYS_STAGE0_BUNDLE_NAME,
        );
  const nodeExecutable = resolvePackagedNode(options.resourcesPath, options.platform);
  assertAbsoluteFile(nodeExecutable, "Packaged Baileys Stage 0 Node executable");
  assertAbsoluteFile(sidecarPath, "Packaged Baileys Stage 0 sidecar");

  if (options.platform === "win32") {
    const runner = path.win32.join(path.win32.dirname(options.resourcesPath), "node-runner.exe");
    assertAbsoluteFile(runner, "Packaged Baileys Stage 0 Windows runner");
    return {
      command: runner,
      args: [nodeExecutable, sidecarPath],
      sidecarPath,
    };
  }
  return { command: nodeExecutable, args: [sidecarPath], sidecarPath };
}

export function buildBaileysStage0Environment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    APP_ROOT: "",
    NODE_ENV: "production",
    NO_COLOR: "1",
    VITE_DEV_SERVER_URL: "",
    VITE_PUBLIC: "",
    WS_NO_BUFFER_UTIL: "1",
    WS_NO_UTF_8_VALIDATE: "1",
  };
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ENVIRONMENT_ALLOWLIST.has(key.toLowerCase())) {
      environment[key] = value;
    }
  }
  return environment;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for Baileys Stage 0 ${label}`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runBaileysStage0Probe(
  options: BaileysStage0LaunchOptions,
  spawnSidecar: SpawnSidecar = spawn,
): Promise<BaileysStage0ProbeResult> {
  const launch = resolveBaileysStage0Launch(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const child = spawnSidecar(launch.command, launch.args, {
    cwd: path.dirname(launch.sidecarPath),
    env: buildBaileysStage0Environment(),
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const output = stdout[Symbol.asyncIterator]();
  const transcript: BaileysStage0TranscriptEntry[] = [];
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string | Buffer) => {
    if (Buffer.byteLength(stderr, "utf8") >= MAX_STDERR_BYTES) return;
    stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (Buffer.byteLength(stderr, "utf8") > MAX_STDERR_BYTES) {
      stderr = Buffer.from(stderr, "utf8").subarray(0, MAX_STDERR_BYTES).toString("utf8");
    }
  });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  const readFrame = async (label: string): Promise<BaileysStage0ChildFrame> => {
    const next = await withTimeout(output.next(), timeoutMs, label);
    if (next.done) throw new Error(`Baileys Stage 0 sidecar closed stdout before ${label}`);
    return parseBaileysStage0ChildFrame(next.value);
  };
  const sendFrame = (frame: BaileysStage0ParentFrame): void => {
    transcript.push({ direction: "parent->child", frame });
    child.stdin.write(serializeBaileysStage0Frame(frame));
  };

  try {
    const ping: BaileysStage0ParentFrame = {
      schemaVersion: BAILEYS_STAGE0_SCHEMA_VERSION,
      kind: "ping",
      requestId: "stage0-ping",
    };
    sendFrame(ping);
    const capabilities = await readFrame("capabilities");
    transcript.push({ direction: "child->parent", frame: capabilities });
    if (capabilities.kind === "error") {
      throw new Error(
        `Baileys Stage 0 sidecar error: ${capabilities.code}: ${capabilities.message}`,
      );
    }
    if (capabilities.kind !== "capabilities" || capabilities.requestId !== ping.requestId) {
      throw new Error("Baileys Stage 0 sidecar returned an unexpected capabilities response");
    }

    const shutdown: BaileysStage0ParentFrame = {
      schemaVersion: BAILEYS_STAGE0_SCHEMA_VERSION,
      kind: "shutdown",
      requestId: "stage0-shutdown",
    };
    sendFrame(shutdown);
    const acknowledgement = await readFrame("shutdown acknowledgement");
    transcript.push({ direction: "child->parent", frame: acknowledgement });
    if (
      acknowledgement.kind !== "shutdown-ack" ||
      acknowledgement.requestId !== shutdown.requestId
    ) {
      throw new Error("Baileys Stage 0 sidecar returned an unexpected shutdown response");
    }
    child.stdin.end();

    const result = await withTimeout(exit, timeoutMs, "sidecar exit");
    if (result.code !== 0 || result.signal !== null) {
      throw new Error(
        `Baileys Stage 0 sidecar exited with code ${String(result.code)} and signal ${String(
          result.signal,
        )}`,
      );
    }
    return { exitCode: 0, transcript };
  } catch (error) {
    if (child.exitCode === null && !child.killed) child.kill();
    const suffix = stderr.trim() ? `; stderr: ${stderr.trim()}` : "";
    throw new Error(`${formatError(error)}${suffix}`, { cause: error });
  } finally {
    stdout.close();
  }
}
