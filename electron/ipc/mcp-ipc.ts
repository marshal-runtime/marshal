import * as fs from "node:fs";
import path from "node:path";

import { app, shell } from "electron";

import { validateMcpUrl } from "../../common/extensions/mcp/mcp-url-validation";
import type {
  AddMcpServerInput,
  CustomMcpServer,
  InstallCatalogMcpInput,
  SaveMcpConfigInput,
} from "../../common/marshal-ipc-contract";
import { createLogger } from "../../common/marshal-logger";
import { MCP_ENV_SERVER_KEY_PATTERN } from "../../common/marshal-mcp-env-file";
import { getAppDataDir } from "../app-paths";
import { getMcpEnvDir } from "../mcp-env";
import { buildMcpConfig } from "../mcp-tools";
import { toMcpServerKey } from "../platform/extensions/mcp-server-key";
import { buildCatalogMcpServer, buildMcpConfigArgs, validateAddMcpServer } from "./extensions-ipc";
import { checkStringSize, IPC_LIMITS } from "./ipc-limits";
import type { IpcDeps } from "./types";

const log = createLogger("McpIpc");

/** Strip sensitive token fields before sending config to the renderer. */
function sanitizeConfig(config: CustomMcpServer | undefined): CustomMcpServer | undefined {
  if (!config || config.type === "command") return config;
  const { accessToken: _, refreshToken: _r, ...safe } = config;
  return safe;
}

function requiresOAuth(config: CustomMcpServer | undefined, runtimeStatus?: string): boolean {
  if (!config || config.type === "command") return false;
  // If the SDK reports needs-auth, show OAuth regardless of any locally cached access token,
  // which may be stale from a pre-SDK-OAuth configuration.
  if (runtimeStatus === "needs-auth") return true;
  if (config.accessToken) return false;
  const validation = validateMcpUrl(config.url);
  return validation.ok && !validation.isLocalhost;
}

export function registerMcpHandlers({
  mcpStore,
  sessionManager,
  ipcHandle,
}: Pick<IpcDeps, "mcpStore" | "sessionManager" | "ipcHandle">) {
  ipcHandle("mcps:list", () => {
    try {
      const data = mcpStore.getAll();
      const statuses = sessionManager.mcpStatus.getMcpServerStatuses();
      const runtimeStatuses = mcpStore.getRuntimeStatuses();
      const servers = Object.entries(data.servers).map(([key, entry]) => {
        const sdkStatus = statuses[key];
        const displayName = entry.config?.name ?? key;
        const rtStatus = runtimeStatuses.get(displayName);
        const effectiveStatus = sdkStatus?.status ?? rtStatus?.status;
        const effectiveError = sdkStatus?.error ?? rtStatus?.error;
        return {
          key,
          name: displayName,
          builtin: entry.builtin,
          config: sanitizeConfig(entry.config),
          tools: entry.tools,
          status: effectiveStatus,
          error: effectiveError,
          requiresOAuth: requiresOAuth(entry.config, effectiveStatus),
          oauthAlias:
            entry.config && entry.config.type !== "command" ? entry.config.oauthAlias : undefined,
        };
      });
      const serverKeys = new Set(servers.map((server) => toMcpServerKey(server.name)));
      for (const [key, status] of Object.entries(statuses)) {
        if (serverKeys.has(key)) continue;
        servers.push({
          key,
          name: status.serverName,
          builtin: false,
          config: undefined,
          tools: undefined,
          status: status.status,
          error: status.error,
          requiresOAuth: status.status === "needs-auth",
          oauthAlias: undefined,
        });
      }
      return { success: true, servers };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("mcps:add", (_event, input: AddMcpServerInput) => {
    try {
      const existing = mcpStore.getCustomServers();
      const result = validateAddMcpServer(input, existing);
      if ("error" in result) return { success: false, error: result.error };

      const { server, needsOAuth } = result;
      mcpStore.addServer(server);
      refreshMcpServers("add");
      return { success: true, name: server.name, needsOAuth };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  function refreshMcpServers(reason: string): void {
    const runtimeServers = mcpStore.getCustomServers();
    sessionManager.mcpStatus.setCustomMcpServers(runtimeServers);
    mcpStore
      .discoverTools(
        buildMcpConfig(sessionManager.getWorkspaceDir(), runtimeServers, app.isPackaged),
      )
      .catch((err) => log.warn(`Rediscovery after ${reason} failed:`, err));
  }

  ipcHandle("mcps:install-catalog", (_event, input: InstallCatalogMcpInput) => {
    try {
      const sizeCheck = checkStringSize(
        input.catalogContent,
        IPC_LIMITS.JSON_IMPORT_BYTES,
        "Catalog content",
      );
      if (sizeCheck) return sizeCheck;
      const existing = mcpStore.getCustomServers();
      const result = buildCatalogMcpServer(input.name, input.catalogContent, existing);
      if ("error" in result) return { success: false, error: result.error };

      mcpStore.addServer(result.server);
      refreshMcpServers("install-catalog");
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("mcps:remove", async (_event, name: string) => {
    try {
      mcpStore.removeServer(name);
      sessionManager.mcpStatus.clearMcpServerStatus(name);
      refreshMcpServers("remove");
      // Sweep the managed secrets file so removing a server doesn't leave
      // unreferenced cleartext on disk. Custom envFile paths the user pointed
      // at (e.g. ${workspaceFolder}/.env) are user-owned and left alone.
      // Re-validate the key against the same allowlist resolveMcpEnvFilePath
      // uses — toMcpServerKey lowercases but does not strip `/`, `\`, or `..`,
      // so a malicious renderer could otherwise target files outside
      // marshal-mcp-env/.
      const key = toMcpServerKey(name);
      if (MCP_ENV_SERVER_KEY_PATTERN.test(key)) {
        const managedPath = path.join(getMcpEnvDir(), `${key}.env`);
        await fs.promises.unlink(managedPath).catch((err: unknown) => {
          const code =
            err && typeof err === "object" && "code" in err ? String(err.code) : "unknown";
          if (code !== "ENOENT") {
            log.warn(`Could not sweep managed envFile on remove: ${code}`);
          }
        });
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("mcps:update-config", (_event, input: SaveMcpConfigInput) => {
    try {
      const sizeCheck = checkStringSize(
        input.catalogContent,
        IPC_LIMITS.JSON_IMPORT_BYTES,
        "Catalog content",
      );
      if (sizeCheck) return sizeCheck;
      const argsResult = buildMcpConfigArgs(input.catalogContent, input.configParams, input.values);
      if (!Array.isArray(argsResult)) return { success: false, error: argsResult.error };

      const servers = mcpStore.getCustomServers();
      if (!servers.some((s) => s.name === input.serverName)) {
        return { success: false, error: `Server "${input.serverName}" not found` };
      }

      mcpStore.updateServerConfig(input.serverName, { args: argsResult } as Partial<
        Extract<import("../../common/marshal-ipc-contract").CustomMcpServer, { type: "command" }>
      >);
      refreshMcpServers("update-config");
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("mcps:rediscover", () => {
    try {
      const runtimeServers = mcpStore.getCustomServers();
      mcpStore
        .discoverTools(
          buildMcpConfig(sessionManager.getWorkspaceDir(), runtimeServers, app.isPackaged),
        )
        .catch((err) => log.warn("Manual rediscovery failed:", err));
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("mcps:openFile", async () => {
    try {
      const mcpPath = path.join(getAppDataDir(), "marshal-mcp-servers.json");
      if (!fs.existsSync(mcpPath)) {
        return { success: false, error: "MCP servers file not found" };
      }
      const result = await shell.openPath(mcpPath);
      if (result) return { success: false, error: result };
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("mcps:setExposeAsGatewayNodeCommand", (_event, name: string, expose: boolean) => {
    try {
      const servers = mcpStore.getCustomServers();
      if (!servers.some((s) => s.name === name)) {
        return { success: false, error: `Server "${name}" not found` };
      }
      mcpStore.updateServerConfig(name, { exposeAsGatewayNodeCommand: expose || undefined });
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle(
    "mcps:openEnvFile",
    async (_event, serverKey: string, target: "default" | "reveal" = "default") => {
      const envPath = resolveMcpEnvFilePath(serverKey);
      if ("error" in envPath) return { success: false, error: envPath.error };
      try {
        // Make sure the directory exists so reveal/open never fails for new servers.
        await fs.promises.mkdir(getMcpEnvDir(), { recursive: true }).catch(() => undefined);

        // For editor-style opens, materialize an empty file when missing so
        // the editor has something to open instead of erroring with "file not
        // found". Reveal stays no-create — selecting a file in Finder/Explorer
        // works even for a path that doesn't exist yet.
        if (target !== "reveal" && !fs.existsSync(envPath.path)) {
          await fs.promises.writeFile(envPath.path, "", { flag: "wx" }).catch(() => undefined);
          if (process.platform !== "win32") {
            await fs.promises.chmod(envPath.path, 0o600).catch(() => undefined);
          }
        }

        if (target === "reveal") {
          shell.showItemInFolder(envPath.path);
          return { success: true, revealed: true };
        }

        const result = await shell.openPath(envPath.path);
        if (result) {
          // openPath returns a non-empty error string when no default app is registered.
          shell.showItemInFolder(envPath.path);
          return { success: true, revealed: true };
        }
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );
}

/** Resolve a server-key to its on-disk `.env` path, rejecting anything that
 *  doesn't look like a normalized key (defense in depth — renderer should only
 *  ever send keys from `toMcpServerKey`, but main can never trust that). */
function resolveMcpEnvFilePath(serverKey: unknown): { path: string } | { error: string } {
  if (typeof serverKey !== "string" || !MCP_ENV_SERVER_KEY_PATTERN.test(serverKey)) {
    return { error: "Invalid MCP server key" };
  }
  return { path: path.join(getMcpEnvDir(), `${serverKey}.env`) };
}
