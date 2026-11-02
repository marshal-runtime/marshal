import { canonicalizeFirstPartyToolName } from "../../../common/tool-names";

export const CLAUDE_HOST_MCP_SERVER_NAME = "marshal";

export interface ClaudeToolName {
  runtimeName: string;
  sdkName: string;
  serverName?: string;
  mcpToolName?: string;
  isHostTool: boolean;
}

export function toClaudeHostToolName(runtimeName: string): string {
  return `mcp__${CLAUDE_HOST_MCP_SERVER_NAME}__${runtimeName}`;
}

export function parseClaudeToolName(sdkName: string): ClaudeToolName {
  const match = /^mcp__(.+?)__(.+)$/.exec(sdkName);
  if (!match) {
    return {
      runtimeName: sdkName,
      sdkName,
      isHostTool: false,
    };
  }

  const serverName = match[1];
  const mcpToolName = match[2];
  const isHostTool = serverName === CLAUDE_HOST_MCP_SERVER_NAME;
  return {
    runtimeName: isHostTool ? canonicalizeFirstPartyToolName(mcpToolName) : sdkName,
    sdkName,
    serverName,
    mcpToolName,
    isHostTool,
  };
}
