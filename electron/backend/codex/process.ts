import {
  type ChildProcessWithoutNullStreams,
  spawn,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { createLogger } from "../../../common/marshal-logger";
import { GIT_SAFE_ALIAS_SUBCOMMANDS } from "../../permission-policy";
import { CodexJsonlRpcConnection, type CodexRpcConnection } from "./jsonl-rpc";

const log = createLogger("CodexProcess");

const require = createRequire(import.meta.url);

interface CodexTarget {
  packageName: string;
  targetTriple: string;
  executableName: string;
}

const TARGETS: Readonly<Record<string, CodexTarget>> = {
  "darwin-arm64": {
    packageName: "@openai/codex-darwin-arm64",
    targetTriple: "aarch64-apple-darwin",
    executableName: "codex",
  },
  "darwin-x64": {
    packageName: "@openai/codex-darwin-x64",
    targetTriple: "x86_64-apple-darwin",
    executableName: "codex",
  },
  "linux-arm64": {
    packageName: "@openai/codex-linux-arm64",
    targetTriple: "aarch64-unknown-linux-musl",
    executableName: "codex",
  },
  "linux-x64": {
    packageName: "@openai/codex-linux-x64",
    targetTriple: "x86_64-unknown-linux-musl",
    executableName: "codex",
  },
  "win32-arm64": {
    packageName: "@openai/codex-win32-arm64",
    targetTriple: "aarch64-pc-windows-msvc",
    executableName: "codex.exe",
  },
  "win32-x64": {
    packageName: "@openai/codex-win32-x64",
    targetTriple: "x86_64-pc-windows-msvc",
    executableName: "codex.exe",
  },
};

export interface ResolveCodexExecutableOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  isPackaged?: boolean;
  resourcesPath?: string;
  resolvePackageJson?: (specifier: string) => string;
  pathExists?: (candidate: string) => boolean;
  canonicalizePath?: (candidate: string) => string;
}

export interface CodexSpawnOptions {
  workspaceDir: string;
  codexHome?: string;
  executablePath?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  maxMessageBytes?: number;
  spawnProcess?: CodexSpawnFunction;
  isPackaged?: boolean;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  windowsRunnerPath?: string;
}

export type CodexSpawnFunction = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

export interface CodexInstallation {
  executablePath: string;
  packageManifestPath: string;
  packageRoot: string;
  targetRoot: string;
}

function deleteEnvironmentKey(env: NodeJS.ProcessEnv, expected: string): void {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === expected.toLowerCase()) delete env[key];
  }
}

export function defaultCodexHome(): string {
  return path.join(os.homedir(), ".marshal", "marshal-codex");
}

export function buildCodexEnvironment(
  codexHome: string,
  source: NodeJS.ProcessEnv = process.env,
  options: { pathDirs?: readonly string[]; platform?: NodeJS.Platform } = {},
): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of [
    "CODEX_HOME",
    "ELECTRON_NO_ASAR",
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CHATGPT_ACCESS_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    deleteEnvironmentKey(env, key);
  }

  env.CODEX_HOME = codexHome;
  env.LOG_FORMAT = "json";
  env.RUST_LOG = "warn";
  env.NO_COLOR = "1";
  env.GIT_PAGER = "";
  env.GIT_TERMINAL_PROMPT = "0";
  deleteEnvironmentKey(env, "GIT_EXTERNAL_DIFF");
  deleteEnvironmentKey(env, "GIT_EDITOR");
  deleteEnvironmentKey(env, "GIT_ASKPASS");
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/i.test(key)) delete env[key];
  }
  GIT_SAFE_ALIAS_SUBCOMMANDS.forEach((subcommand, index) => {
    env[`GIT_CONFIG_KEY_${index}`] = `alias.${subcommand}`;
    env[`GIT_CONFIG_VALUE_${index}`] = subcommand;
  });
  env.GIT_CONFIG_COUNT = String(GIT_SAFE_ALIAS_SUBCOMMANDS.length);
  if (options.pathDirs && options.pathDirs.length > 0) {
    const platform = options.platform ?? process.platform;
    const pathKey = env.PATH !== undefined ? "PATH" : "Path";
    const existingPath = env[pathKey] ?? "";
    const separator = platform === "win32" ? ";" : ":";
    env[pathKey] = [...options.pathDirs, ...(existingPath ? [existingPath] : [])].join(separator);
  }
  return env;
}

function targetPathApi(platform: NodeJS.Platform): typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

function validateCodexInstallation(
  packageRoot: string,
  target: CodexTarget,
  platform: NodeJS.Platform,
  isPackaged: boolean,
  pathExists: (candidate: string) => boolean,
): CodexInstallation {
  const pathApi = targetPathApi(platform);
  const targetRoot = pathApi.join(packageRoot, "vendor", target.targetTriple);
  const packageManifestPath = pathApi.join(targetRoot, "codex-package.json");
  if (!pathExists(packageManifestPath)) {
    throw new Error(`Codex package manifest is missing: ${packageManifestPath}`);
  }

  const rawExecutable = pathApi.join(targetRoot, "bin", target.executableName);
  const candidates =
    platform === "darwin" && isPackaged
      ? [pathApi.join(targetRoot, "bin", "codex.app", "Contents", "MacOS", "codex"), rawExecutable]
      : [rawExecutable];
  const executablePath = candidates.find(pathExists);
  if (!executablePath) {
    throw new Error(`Codex executable is missing; checked: ${candidates.join(", ")}`);
  }
  return { executablePath, packageManifestPath, packageRoot, targetRoot };
}

export function resolveCodexInstallation(
  options: ResolveCodexExecutableOptions = {},
): CodexInstallation {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const target = TARGETS[`${platform}-${arch}`];
  if (!target) {
    throw new Error(`Unsupported Codex app-server platform: ${platform} (${arch})`);
  }

  const resolvePackageJson =
    options.resolvePackageJson ?? ((specifier: string) => require.resolve(specifier));
  const pathExists = options.pathExists ?? existsSync;
  const canonicalizePath = options.canonicalizePath ?? realpathSync;
  const pathApi = targetPathApi(platform);
  const processResourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  const resourcesPath = options.resourcesPath ?? processResourcesPath;
  // The composition root must pass Electron's authoritative app.isPackaged.
  // process.resourcesPath also exists in unpackaged Electron and is not a
  // reliable packaged-build signal.
  const isPackaged = options.isPackaged === true;
  const packageRoots: string[] = [];

  if (isPackaged) {
    if (!resourcesPath) {
      throw new Error("process.resourcesPath is required to resolve packaged Codex");
    }
    packageRoots.push(
      pathApi.join(resourcesPath, "app.asar.unpacked", "node_modules", target.packageName),
    );
  } else {
    try {
      const packageJson = resolvePackageJson(`${target.packageName}/package.json`);
      packageRoots.push(pathApi.dirname(canonicalizePath(packageJson)));
    } catch {
      // The wrapper package has a vendor fallback for non-isolated installs.
    }
    try {
      const wrapperPackageJson = resolvePackageJson("@openai/codex/package.json");
      packageRoots.push(pathApi.dirname(canonicalizePath(wrapperPackageJson)));
    } catch {
      // The final error below identifies the missing exact dependency.
    }
  }

  const errors: string[] = [];
  for (const packageRoot of packageRoots) {
    try {
      return validateCodexInstallation(packageRoot, target, platform, isPackaged, pathExists);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Unknown Codex installation error");
    }
  }

  throw new Error(
    `Unable to resolve the native Codex installation for ${platform} (${arch}); ${errors.join("; ") || "reinstall @openai/codex"}`,
  );
}

export function resolveCodexExecutable(options: ResolveCodexExecutableOptions = {}): string {
  return resolveCodexInstallation(options).executablePath;
}

async function terminateCodexProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform,
): Promise<void> {
  const pid = child.pid;
  if (typeof pid !== "number") {
    if (child.exitCode === null) child.kill(signal);
    return;
  }
  if (platform === "win32") {
    // node-runner owns a kill-on-close Job Object, so terminating the exact
    // wrapper process also reaps the Codex process tree.
    if (child.exitCode === null) child.kill(signal);
    return;
  }
  try {
    // The app-server is a detached POSIX process-group leader. The group id
    // remains valid for surviving descendants even after the leader exits.
    process.kill(-pid, signal);
  } catch {
    if (child.exitCode === null) child.kill(signal);
  }
}

function packagedRuntime(options: CodexSpawnOptions): {
  isPackaged: boolean;
  resourcesPath?: string;
} {
  const processResourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  const resourcesPath = options.resourcesPath ?? processResourcesPath;
  return {
    isPackaged: options.isPackaged === true,
    ...(resourcesPath ? { resourcesPath } : {}),
  };
}

function resolveWindowsRunnerPath(
  options: CodexSpawnOptions,
  runtime: { isPackaged: boolean; resourcesPath?: string },
): string {
  if (options.windowsRunnerPath) return path.resolve(options.windowsRunnerPath);
  if (runtime.isPackaged) {
    if (!runtime.resourcesPath) {
      throw new Error("process.resourcesPath is required to resolve packaged node-runner.exe");
    }
    return path.win32.join(path.win32.dirname(runtime.resourcesPath), "node-runner.exe");
  }
  return path.resolve(process.env.APP_ROOT ?? process.cwd(), "sidecar", "node-runner.exe");
}

export async function spawnCodexAppServer(
  options: CodexSpawnOptions,
): Promise<ChildProcessWithoutNullStreams> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const codexHome = path.resolve(options.codexHome ?? defaultCodexHome());
  await mkdir(codexHome, { recursive: true, mode: 0o700 });

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const runtime = packagedRuntime(options);
  const installation = options.executablePath
    ? null
    : resolveCodexInstallation({
        platform,
        arch,
        isPackaged: runtime.isPackaged,
        resourcesPath: runtime.resourcesPath,
      });
  const executable = options.executablePath ?? installation?.executablePath;
  if (!executable) throw new Error("Codex executable resolution returned no path");
  if (!path.isAbsolute(executable)) {
    throw new Error("Codex executable path must be absolute");
  }

  const spawnProcess: CodexSpawnFunction = options.spawnProcess ?? spawn;
  const windowsRunner = platform === "win32" ? resolveWindowsRunnerPath(options, runtime) : null;
  if (windowsRunner && !existsSync(windowsRunner)) {
    throw new Error(`Codex Windows job runner is missing: ${windowsRunner}`);
  }
  const command = windowsRunner ?? executable;
  const args = windowsRunner ? [executable, "app-server", "--stdio"] : ["app-server", "--stdio"];
  const child = spawnProcess(command, args, {
    cwd: workspaceDir,
    env: buildCodexEnvironment(codexHome, options.env, {
      platform,
      ...(installation
        ? {
            pathDirs: [targetPathApi(platform).join(installation.targetRoot, "codex-path")],
          }
        : {}),
    }),
    shell: false,
    detached: platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  log.info("Started Codex app-server", {
    pid: child.pid,
    platform,
    arch,
  });
  return child;
}

export async function createCodexAppServerConnection(
  options: CodexSpawnOptions,
): Promise<CodexRpcConnection> {
  const child = await spawnCodexAppServer(options);
  const platform = options.platform ?? process.platform;
  return new CodexJsonlRpcConnection(child, {
    requestTimeoutMs: options.requestTimeoutMs,
    maxMessageBytes: options.maxMessageBytes,
    terminateProcess: (signal) => terminateCodexProcessTree(child, signal, platform),
  });
}
