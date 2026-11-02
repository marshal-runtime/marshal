import type { McpServerConfig } from "@cursor/sdk";

import type { RuntimeMcpServerConfig } from "../runtime-contract";

export function toCursorMcpServers(
  servers: Record<string, RuntimeMcpServerConfig> | undefined,
): Record<string, McpServerConfig> | undefined {
  if (!servers || Object.keys(servers).length === 0) return undefined;
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [name, toCursorMcpServer(server)]),
  );
}

function toCursorMcpServer(server: RuntimeMcpServerConfig): McpServerConfig {
  if ("url" in server) {
    return {
      type: server.type,
      url: server.url,
      ...(server.headers ? { headers: server.headers } : {}),
    };
  }
  return {
    type: "stdio",
    command: server.command,
    ...(server.args ? { args: server.args } : {}),
    ...(server.env ? { env: server.env } : {}),
    ...(server.workingDirectory ? { cwd: server.workingDirectory } : {}),
  };
}
