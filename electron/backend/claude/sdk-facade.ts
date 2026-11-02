import type {
  createSdkMcpServer,
  deleteSession,
  getSessionMessages,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeSdkFacade {
  query: typeof query;
  deleteSession: typeof deleteSession;
  getSessionMessages: typeof getSessionMessages;
  createSdkMcpServer: typeof createSdkMcpServer;
  tool: typeof tool;
}

export async function loadClaudeSdk(): Promise<ClaudeSdkFacade> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return {
    query: sdk.query,
    deleteSession: sdk.deleteSession,
    getSessionMessages: sdk.getSessionMessages,
    createSdkMcpServer: sdk.createSdkMcpServer,
    tool: sdk.tool,
  };
}
