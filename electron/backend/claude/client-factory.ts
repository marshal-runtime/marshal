import { spawn } from "node:child_process";

import type { SettingSource, SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

import type { RuntimeClientFactory } from "../runtime-contract";
import { ensureClaudeAccountConfigDir, withoutLaunchCredentials } from "./accounts";
import { ClaudeRuntimeClient } from "./client";
import {
  configureClaudeSdkHostEnvironment,
  DEFAULT_CLAUDE_CONFIG_DIR,
  type ClaudeEnvironment,
} from "./environment";
import { resolveClaudeExecutablePath, resolveInstalledClaudeExecutable } from "./executable-path";
import { ClaudeProcessRegistry } from "./process-registry";
import { loadClaudeSdk } from "./sdk-facade";

export interface ClaudeClientFactoryOptions {
  env?: ClaudeEnvironment;
  /** Host `CLAUDE_CONFIG_DIR`; also the original account's credential home. */
  configDir?: string;
  /** An extra account: its subprocesses use that account's config dir (see accounts.ts). */
  accountId?: string;
  /** Root for extra account config dirs; tests override it. */
  accountHomeDir?: string;
  pathToClaudeCodeExecutable?: string;
  spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
  settingSources?: SettingSource[];
  isPackaged?: boolean;
  resourcesPath?: string;
}

function drainProcessStderr(process: SpawnedProcess): void {
  const stderr = Reflect.get(process, "stderr");
  if (!stderr || typeof stderr !== "object") return;
  const resume = Reflect.get(stderr, "resume");
  if (typeof resume === "function") Reflect.apply(resume, stderr, []);
}

function spawnLocalClaudeProcess(options: SpawnOptions): SpawnedProcess {
  const env: NodeJS.ProcessEnv = {
    APP_ROOT: process.env.APP_ROOT,
    NODE_ENV: process.env.NODE_ENV,
    VITE_DEV_SERVER_URL: process.env.VITE_DEV_SERVER_URL,
    VITE_PUBLIC: process.env.VITE_PUBLIC,
  };
  for (const [name, value] of Object.entries(options.env)) {
    if (value !== undefined) env[name] = value;
  }
  return spawn(options.command, options.args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function sessionIdFromSpawnOptions(options: SpawnOptions): string | undefined {
  for (const [index, arg] of options.args.entries()) {
    for (const flag of ["--session-id", "--resume"]) {
      if (arg === flag) return options.args[index + 1];
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1) || undefined;
    }
  }
  return undefined;
}

export function createTrackedClaudeSpawner(
  processes: ClaudeProcessRegistry,
  spawnProcess: (options: SpawnOptions) => SpawnedProcess = spawnLocalClaudeProcess,
): (options: SpawnOptions) => SpawnedProcess {
  return (spawnOptions) => {
    const process = spawnProcess(spawnOptions);
    drainProcessStderr(process);
    processes.add(process, sessionIdFromSpawnOptions(spawnOptions));
    return process;
  };
}

export function createClaudeClientFactory(
  options: ClaudeClientFactoryOptions = {},
): RuntimeClientFactory {
  return async (workspaceDir) => {
    const hostConfigDir = configureClaudeSdkHostEnvironment(
      options.configDir ?? DEFAULT_CLAUDE_CONFIG_DIR,
    );
    const configDir = options.accountId
      ? await ensureClaudeAccountConfigDir(hostConfigDir, options.accountId, {
          ...(options.accountHomeDir ? { homeDir: options.accountHomeDir } : {}),
        })
      : hostConfigDir;
    const pathToClaudeCodeExecutable = resolveClaudeExecutablePath(
      options.pathToClaudeCodeExecutable,
      {
        ...(options.isPackaged !== undefined ? { isPackaged: options.isPackaged } : {}),
        ...(options.resourcesPath ? { resourcesPath: options.resourcesPath } : {}),
      },
    );
    const authExecutablePath = pathToClaudeCodeExecutable ?? resolveInstalledClaudeExecutable();
    const sdk = await loadClaudeSdk();
    const processes = new ClaudeProcessRegistry();
    const spawnClaudeCodeProcess = createTrackedClaudeSpawner(
      processes,
      options.spawnClaudeCodeProcess,
    );
    return new ClaudeRuntimeClient(
      sdk,
      {
        workspaceDir,
        env: options.accountId
          ? withoutLaunchCredentials(options.env ?? process.env)
          : { ...(options.env ?? process.env) },
        configDir,
        pathToClaudeCodeExecutable,
        authExecutablePath,
        spawnClaudeCodeProcess,
        settingSources: options.settingSources ?? ["project"],
      },
      processes,
    );
  };
}

export const createRealClientFactory = createClaudeClientFactory;
