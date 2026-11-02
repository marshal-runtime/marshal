import * as fs from "fs";
import { createRequire } from "node:module";
import * as path from "path";
import { fileURLToPath } from "url";

import { validateMcpUrl } from "../common/extensions/mcp/mcp-url-validation";
import { createLogger } from "../common/marshal-logger";
import { getCopilotCliLogsDir } from "./backend/copilot/cli-paths.mjs";
import type {
  RuntimeMcpHttpServerConfig,
  RuntimeMcpServerConfig,
  RuntimeMcpStdioServerConfig,
} from "./backend/runtime-contract";
import type { CustomMcpServer } from "./ipc/types";
import { resolveMcpEnv } from "./mcp-env";
import { detectBrowser } from "./platform/browser-discovery";
import { toMcpServerKey } from "./platform/extensions/mcp-server-key";

const log = createLogger("McpTools");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// Reverse map: MCP config key (as it appears in CLI logs) → UI name
export const MCP_CONFIG_KEY_TO_UI: Record<string, string> = {
  playwright: "Browser Control and Web Browsing",
};

// These "servers" in the UI are built-in SDK capabilities, not MCP servers.
// They are always available when the CLI is running.
export const BUILTIN_SERVERS = ["Shell", "Search Web"];

export function getNodeModulesPath(isPackaged: boolean): string {
  if (isPackaged) {
    if (!process.resourcesPath)
      throw new Error("process.resourcesPath is undefined in packaged mode");
    return path.join(process.resourcesPath, "app.asar.unpacked", "node_modules");
  }
  return path.join(__dirname, "..", "node_modules");
}

/** Resolve the path to the bundled Node binary inside the packaged resources dir. */
export function bundledNodePath(resourcesPath: string, platform: string): string {
  // Use platform-explicit path joiners (not path.join, which follows the host
  // separator) so the produced path is always correct for the TARGET platform,
  // not whichever OS is running the build/test. Otherwise a Windows test
  // runner produces backslashes inside the POSIX branch.
  if (platform === "win32") return path.win32.join(resourcesPath, "node", "node.exe");
  return path.posix.join(resourcesPath, "node", "node");
}

/** Resolve the repository-pinned Node binary used by Runtime workers in development. */
export function developmentNodePath(appPath: string, platform: string, arch: string): string {
  const binary = platform === "win32" ? "node.exe" : "node";
  return path.join(appPath, "node-bin", `${platform}-${arch}`, binary);
}

function playwrightManagedChromiumPath(): string | null {
  try {
    // Resolve Playwright from the MCP package so its executable revision stays
    // aligned with the server that will launch it.
    const requireFromMcp = createRequire(require.resolve("@playwright/mcp"));
    const playwright: unknown = requireFromMcp("playwright");
    if (playwright === null || typeof playwright !== "object") return null;
    const chromium: unknown = Reflect.get(playwright, "chromium");
    if (chromium === null || typeof chromium !== "object") return null;
    const executablePath: unknown = Reflect.get(chromium, "executablePath");
    if (typeof executablePath !== "function") return null;
    const resolved: unknown = Reflect.apply(executablePath, chromium, []);
    return typeof resolved === "string" ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Build the MCP server command and argument prefix for spawning MCP servers.
 *
 * Packaged builds spawn the bundled Node binary at `resources/node/`.
 * On Windows we route through `sidecar/node-runner.exe` for windowless spawn.
 *
 * Dev mode uses `node` from PATH.
 */
export function buildMcpCommand(opts: {
  isPackaged: boolean;
  platform: string;
  resourcesPath: string;
}): { command: string; prefix: string[] } {
  if (!opts.isPackaged) return { command: "node", prefix: [] };

  const nodePath = bundledNodePath(opts.resourcesPath, opts.platform);

  if (opts.platform === "win32") {
    // node-runner.exe ships via win.extraFiles (electron-builder.json5), which
    // lands it in the application directory next to Marshal.exe — i.e. the
    // PARENT of resourcesPath, not inside it. See writeCliShim in sessions.ts.
    const runnerPath = path.win32.join(path.win32.dirname(opts.resourcesPath), "node-runner.exe");
    return { command: runnerPath, prefix: [nodePath] };
  }
  return { command: nodePath, prefix: [] };
}

/**
 * Build the full MCP server configuration object.
 * Includes the built-in playwright server and any user-configured custom servers.
 */
export function buildMcpConfig(
  workspaceDir: string,
  customMcpServers: CustomMcpServer[],
  isPackaged: boolean,
  interceptFileChooser = false,
  playwrightHeadless = false,
  activeWorkspaceFolder?: string,
  playwrightOutputDir?: string,
  playwrightConfigPath?: string,
): Record<string, RuntimeMcpServerConfig> {
  const nodeModulesPath = getNodeModulesPath(isPackaged);

  log.info(`MCP config: isPackaged=${isPackaged}, resourcesPath=${process.resourcesPath}`);

  const { command: mcpCommand, prefix: mcpPrefix } = buildMcpCommand({
    isPackaged,
    platform: process.platform,
    resourcesPath: process.resourcesPath,
  });

  const installedBrowser = detectBrowser();
  const managedChromiumPath = playwrightManagedChromiumPath();
  const config: Record<string, RuntimeMcpServerConfig> = {
    playwright: {
      command: mcpCommand,
      args: [
        ...mcpPrefix,
        path.join(nodeModulesPath, "@playwright", "mcp", "cli.js"),
        // When no branded Chrome/Edge installation exists, let Playwright use
        // its managed Chromium. detectBrowser() intentionally returns an Edge
        // fallback path for legacy callers, so verify the path before choosing
        // that channel.
        ...(fs.existsSync(installedBrowser.path)
          ? ["--browser", installedBrowser.channel]
          : managedChromiumPath && fs.existsSync(managedChromiumPath)
            ? ["--executable-path", managedChromiumPath]
            : []),
        ...(interceptFileChooser ? ["--handle-file-chooser"] : []),
        ...(playwrightHeadless ? ["--headless"] : []),
        ...(playwrightOutputDir ? ["--output-dir", playwrightOutputDir] : []),
        ...(playwrightConfigPath ? ["--config", playwrightConfigPath] : []),
      ],
      tools: ["*"],
    },
  };

  const reservedKeys = new Set(Object.keys(config));

  for (const custom of customMcpServers) {
    const key = toMcpServerKey(custom.name);
    if (reservedKeys.has(key)) {
      log.warn(
        `Custom server "${custom.name}" conflicts with built-in key "${key}" — skipping to prevent override`,
      );
      continue;
    }
    if (custom.type === "command") {
      const entry: RuntimeMcpStdioServerConfig = {
        type: "local",
        command: custom.command,
        args: custom.args ?? [],
        tools: ["*"],
      };
      const env = resolveMcpEnv(custom, activeWorkspaceFolder ?? workspaceDir);
      if (env) entry.env = env;
      if (typeof custom.timeout === "number") entry.timeout = custom.timeout;
      config[key] = entry;
    } else if (custom.url) {
      const urlValidation = validateMcpUrl(custom.url);
      if (!urlValidation.ok) {
        log.warn(
          `Custom server "${custom.name}" has invalid URL "${custom.url}": ${urlValidation.reason} — skipping`,
        );
        continue;
      }
      if (urlValidation.isLocalhost) {
        log.warn(
          `Custom server "${custom.name}" is connecting to a localhost URL — ensure this is intentional`,
        );
      }
      const entry: RuntimeMcpHttpServerConfig = {
        type: custom.type ?? "http",
        url: custom.url,
        tools: ["*"],
      };
      if (custom.accessToken) {
        const originOk =
          !custom.accessTokenOrigin ||
          (() => {
            try {
              return new URL(custom.url).origin === custom.accessTokenOrigin;
            } catch {
              return false;
            }
          })();
        if (originOk) {
          entry.headers = { Authorization: `Bearer ${custom.accessToken}` };
        } else {
          log.warn(`MCP server "${custom.name}": dropping bearer token -- origin mismatch.`);
        }
      }
      if (typeof custom.timeout === "number") entry.timeout = custom.timeout;
      config[key] = entry;
    }
  }

  return config;
}

/**
 * Determine which MCP servers are connected by reading the latest CLI log.
 * Returns the list of UI server names that are confirmed connected.
 * Built-in capabilities (Shell, Search Web) are always included.
 *
 * NOTE: Copilot CLI logs use the CLI-owned profile regardless of dev/prod mode.
 * Because the Copilot CLI is a shared process, dev mode may read
 * log entries from a prod CLI session (or vice versa). This is cosmetic-only
 * and doesn't cause data corruption.
 */
export function getMcpStatus(): string[] {
  const connected = [...BUILTIN_SERVERS];
  try {
    const logDir = getCopilotCliLogsDir();
    if (!fs.existsSync(logDir)) return connected;

    // Find the most recently modified log file
    const files = fs
      .readdirSync(logDir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(logDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return connected;

    const logContent = fs.readFileSync(path.join(logDir, files[0].name), "utf-8");

    // Parse "MCP client for <key> connected" lines
    const connectedPattern = /MCP client for (\S+) connected/g;
    let match: RegExpExecArray | null;
    while ((match = connectedPattern.exec(logContent)) !== null) {
      const configKey = match[1];
      const uiName = MCP_CONFIG_KEY_TO_UI[configKey];
      if (uiName && !connected.includes(uiName)) {
        connected.push(uiName);
      }
    }
  } catch (err) {
    log.error("Failed to read MCP status from CLI logs:", err);
  }
  return connected;
}
