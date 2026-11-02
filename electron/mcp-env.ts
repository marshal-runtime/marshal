import * as fs from "node:fs";
import * as path from "node:path";

import { parseEnvFile } from "../common/foundation/parsing/env-file";
import { createLogger } from "../common/marshal-logger";
import { getAppDataDir } from "./app-paths";
import type { CustomMcpServer } from "./ipc/types";

export { parseEnvFile };

const log = createLogger("McpEnv");

type CommandServer = Extract<CustomMcpServer, { type: "command" }>;

/** Directory holding per-server secret files. App-data scoped (not user-visible
 *  workspace) so secrets don't leak into consumer cloud-sync folders. */
export function getMcpEnvDir(): string {
  return path.join(getAppDataDir(), "marshal-mcp-env");
}

/** Upper bound on envFile size. .env files are KEY=VALUE only; 64 KiB is
 *  generously above any realistic secrets payload. */
const MAX_ENV_FILE_BYTES = 64 * 1024;

/** Resolve the env map for a stdio custom MCP server.
 *  - Reads `envFile` (if set), with `${workspaceFolder}` and `${mcpEnvDir}`
 *    substitution.
 *  Returns undefined when no env is configured. */
export function resolveMcpEnv(
  server: CommandServer,
  workspaceDir?: string,
): Record<string, string> | undefined {
  if (!server.envFile) return undefined;

  // ${workspaceFolder} only resolves when a workspaceDir is passed in. The
  // Gateway backend is app-global (no active session, so no workspace) and
  // calls this without workspaceDir. Bailing early with a specific warning
  // keeps a misconfigured server from silently resolving to a CWD-relative
  // path on disk and reading whatever happens to live there.
  if (!workspaceDir && server.envFile.includes("${workspaceFolder}")) {
    log.warn(
      `envFile for "${server.name}" uses \${workspaceFolder} but no workspace is active; ` +
        "skipping (this server is reachable from Gateway, which is workspace-agnostic).",
    );
    return undefined;
  }

  let substitutedPath = server.envFile.replace(/\$\{mcpEnvDir\}/g, getMcpEnvDir());
  if (workspaceDir) {
    substitutedPath = substitutedPath.replace(/\$\{workspaceFolder\}/g, workspaceDir);
  }
  const resolvedPath = path.resolve(substitutedPath);

  try {
    // Cap envFile reads to keep a runaway or corrupt file from pinning the
    // main process event loop.
    const stat = fs.statSync(resolvedPath);
    if (stat.size > MAX_ENV_FILE_BYTES) {
      log.warn(
        `envFile "${path.basename(resolvedPath)}" for "${server.name}" exceeds ${MAX_ENV_FILE_BYTES} bytes; skipping.`,
      );
      return undefined;
    }
    const text = fs.readFileSync(resolvedPath, "utf-8");
    const parsed = parseEnvFile(text);
    return Object.keys(parsed).length > 0 ? parsed : undefined;
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "unknown";
    log.warn(
      `Failed to read envFile "${path.basename(resolvedPath)}" for "${server.name}": ${code}`,
    );
    return undefined;
  }
}
