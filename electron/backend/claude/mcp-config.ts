import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

import type { RuntimeMcpServerConfig } from "../runtime-contract";
import { CLAUDE_HOST_MCP_SERVER_NAME } from "./tool-names";

function validateToolFilter(serverName: string, config: RuntimeMcpServerConfig): void {
  const tools = config.tools;
  if (!tools || (tools.length === 1 && tools[0] === "*")) return;
  throw new Error(
    `Claude Agent SDK cannot apply Marshal's per-server tool allowlist for MCP server "${serverName}"`,
  );
}

function toClaudeMcpServer(
  serverName: string,
  config: RuntimeMcpServerConfig,
): McpServerConfig | undefined {
  if (config.tools?.length === 0) return undefined;
  validateToolFilter(serverName, config);
  if ("url" in config) {
    return {
      type: config.type,
      url: config.url,
      ...(config.headers ? { headers: { ...config.headers } } : {}),
      ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
    };
  }

  if (config.workingDirectory) {
    throw new Error(
      `Claude Agent SDK does not support a per-server working directory for stdio MCP server "${serverName}"`,
    );
  }
  return {
    type: "stdio",
    command: config.command,
    ...(config.args ? { args: [...config.args] } : {}),
    ...(config.env ? { env: { ...config.env } } : {}),
    ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
  };
}

export function toClaudeMcpServers(
  servers: Record<string, RuntimeMcpServerConfig> | undefined,
  hostServer: McpServerConfig | undefined,
): Record<string, McpServerConfig> | undefined {
  const result: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers ?? {})) {
    // Browser automation in Marshal is provided by the in-process Agentic
    // Browser Runtime extension. Do not expose the legacy Playwright MCP to
    // Claude as a fallback: it starts a competing browser/profile lifecycle
    // and makes a failed Runtime call turn into an unrelated Playwright flow.
    if (name === "playwright") continue;
    if (name === CLAUDE_HOST_MCP_SERVER_NAME && hostServer) {
      throw new Error(
        `MCP server name "${CLAUDE_HOST_MCP_SERVER_NAME}" is reserved for Marshal host tools`,
      );
    }
    const server = toClaudeMcpServer(name, config);
    if (server) result[name] = server;
  }
  if (hostServer) result[CLAUDE_HOST_MCP_SERVER_NAME] = hostServer;
  return Object.keys(result).length > 0 ? result : undefined;
}

export const CLAUDE_MCP_OAUTH_UNSUPPORTED_MESSAGE =
  "Claude Agent SDK does not run interactive MCP OAuth. Complete OAuth in Marshal and pass the access token through the server headers.";
