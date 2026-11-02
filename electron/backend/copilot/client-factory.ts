/**
 * Copilot CLI client factory — spawns the real Copilot CLI subprocess.
 *
 * Extracted from sessions.ts to keep SessionManager backend-agnostic.
 * Only CopilotBackend (via create-backend.ts) should reference this module.
 */
import * as fs from "fs";
import * as path from "path";

import type { CopilotClientOptions } from "@github/copilot-sdk";

import { createLogger } from "../../../common/marshal-logger";
import { getBundledCliPath } from "../../cli-path";
import { GIT_SAFE_ALIAS_SUBCOMMANDS } from "../../permission-policy";
import type { RuntimeClientFactory } from "../runtime-contract";
import { CopilotSdkClientAdapter } from "./sdk-adapter";

const log = createLogger("CopilotClientFactory");
const MARSHAL_TOOL_WORKER_LIMIT = "4";

// ── PowerShell path helpers (Windows only) ────────────────────────────────

const DEFAULT_WIN_SYSTEM_ROOT = "C:\\Windows";
const DEFAULT_PROGRAM_FILES = "C:\\Program Files";
const POWERSHELL_DIR_FNS = [
  (env: NodeJS.ProcessEnv) =>
    path.join(env.ProgramFiles || DEFAULT_PROGRAM_FILES, "PowerShell", "7"),
  (env: NodeJS.ProcessEnv) =>
    path.join(env.SystemRoot || DEFAULT_WIN_SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0"),
];

/**
 * Ensure PowerShell is on PATH in the given environment. The Copilot CLI uses
 * PowerShell as its shell on Windows, but some systems don't include it in PATH.
 * Mutates `env` in-place by prepending discovered PowerShell directories.
 */
function ensurePowerShellInPath(env: NodeJS.ProcessEnv): void {
  const pathEnv = env.PATH ?? env.Path ?? "";
  const normalize = (d: string) => d.toLowerCase().replace(/\//g, "\\").replace(/\\$/, "");
  const normalizedDirs = pathEnv.split(";").map(normalize);
  const expectedPaths = POWERSHELL_DIR_FNS.map((fn) => normalize(fn(env)));
  const alreadyOnPath = expectedPaths.some((p) => normalizedDirs.includes(p));
  if (alreadyOnPath) return;

  const psDirs = POWERSHELL_DIR_FNS.map((fn) => fn(env)).filter(fs.existsSync);
  if (psDirs.length > 0) {
    const pathKey = env.PATH !== undefined ? "PATH" : "Path";
    env[pathKey] = psDirs.join(";") + (pathEnv ? ";" + pathEnv : "");
    log.info("Added PowerShell to PATH:", psDirs);
  } else {
    log.warn(
      "PowerShell not found in PATH and not detected at known locations — shell commands may fail",
    );
  }
}

// ── Client factory ────────────────────────────────────────────────────────

/** Create the production client factory — spawns the real Copilot CLI. */
export function createRealClientFactory(): RuntimeClientFactory {
  return async (workspaceDir: string) => {
    const { CopilotClient, RuntimeConnection } = await import("@github/copilot-sdk");
    let cliPath: string;
    try {
      cliPath = getBundledCliPath();
      log.info("Using bundled Copilot CLI:", cliPath);
    } catch (err) {
      log.error("Failed to find bundled CLI:", err);
      throw err;
    }

    // Clean env vars that can interfere with the CLI subprocess
    const cleanEnv = { ...process.env };
    delete cleanEnv.ELECTRON_NO_ASAR;
    // Strip ELECTRON_RUN_AS_NODE (no-op now the fuse is off) and NODE_OPTIONS
    // (would otherwise let a parent env inject --require into the bundled
    // node spawned by the Copilot CLI).
    delete cleanEnv.ELECTRON_RUN_AS_NODE;
    delete cleanEnv.NODE_OPTIONS;
    // Remove any stale GitHub tokens — the CLI should use its own device flow auth,
    // not tokens from an unauthenticated `gh` CLI that happens to be on PATH
    delete cleanEnv.GH_TOKEN;
    delete cleanEnv.GITHUB_TOKEN;
    for (const key of Object.keys(cleanEnv)) {
      if (/^npm_config_cache$/i.test(key)) delete cleanEnv[key];
    }
    if (process.platform === "win32") {
      const localAppData = cleanEnv.LOCALAPPDATA;
      if (localAppData) cleanEnv.NPM_CONFIG_CACHE = path.join(localAppData, "npm-cache");
    }
    // Prevent git from executing attacker-controlled commands via gitconfig.
    // GIT_SSH_COMMAND left intact — stripping breaks SSH remotes with custom key paths.
    cleanEnv.GIT_PAGER = "";
    cleanEnv.GIT_TERMINAL_PROMPT = "0";
    delete cleanEnv.GIT_EXTERNAL_DIFF;
    delete cleanEnv.GIT_EDITOR;
    delete cleanEnv.GIT_ASKPASS;
    for (const key of Object.keys(cleanEnv)) {
      // /i is belt-and-suspenders: git reads only uppercase on Linux, but Windows
      // env keys are case-insensitive so lowercase variants can exist there.
      if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/i.test(key)) delete cleanEnv[key];
    }
    // Re-inject our own trusted alias overrides — prevents gitconfig alias
    // hijacking for all auto-approved git subcommands.
    // Must come after the stripping loop so our entries are not deleted.
    GIT_SAFE_ALIAS_SUBCOMMANDS.forEach((sub, i) => {
      cleanEnv[`GIT_CONFIG_KEY_${i}`] = `alias.${sub}`;
      cleanEnv[`GIT_CONFIG_VALUE_${i}`] = sub;
    });
    cleanEnv.GIT_CONFIG_COUNT = String(GIT_SAFE_ALIAS_SUBCOMMANDS.length);
    cleanEnv.CARGO_BUILD_JOBS ??= MARSHAL_TOOL_WORKER_LIMIT;
    cleanEnv.CMAKE_BUILD_PARALLEL_LEVEL ??= MARSHAL_TOOL_WORKER_LIMIT;
    cleanEnv.CTEST_PARALLEL_LEVEL ??= MARSHAL_TOOL_WORKER_LIMIT;
    cleanEnv.MAKEFLAGS ??= `-j${MARSHAL_TOOL_WORKER_LIMIT}`;
    cleanEnv.NINJAFLAGS ??= `-j${MARSHAL_TOOL_WORKER_LIMIT}`;

    if (process.platform === "win32") {
      ensurePowerShellInPath(cleanEnv);
    }

    const clientOptions: CopilotClientOptions = {
      logLevel: "info",
      workingDirectory: workspaceDir,
      connection: RuntimeConnection.forStdio({ path: cliPath }),
      env: cleanEnv,
    };

    const client = new CopilotClient(clientOptions);
    await client.start();
    const adapter = new CopilotSdkClientAdapter(client);
    log.info("Copilot client started");
    return adapter;
  };
}
