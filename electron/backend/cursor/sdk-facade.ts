import type {
  AgentOptions,
  Run,
  SDKAgent,
  LocalAgentStore,
  SDKModel,
  SDKUser,
  SdkAuthStatus,
  SdkAuthStatusOptions,
  SdkCredentialStore,
  SdkLoginOptions,
  SdkLoginResult,
  SdkLogoutOptions,
  StoredSdkCredentials,
} from "@cursor/sdk";

export type {
  AgentOptions,
  SDKAgent,
  SDKModel,
  SDKUser,
  SdkAuthStatus,
  SdkCredentialStore,
  SdkLoginOptions,
  SdkLoginResult,
  StoredSdkCredentials,
};

export interface CursorSdkFacade {
  getConversation?(agentId: string, cwd: string): Promise<unknown>;
  createAgent(options: AgentOptions): Promise<SDKAgent>;
  resumeAgent(agentId: string, options: AgentOptions): Promise<SDKAgent>;
  listRuns(agentId: string, options: { runtime: "local"; cwd: string }): Promise<Run[]>;
  cancelRun(runId: string, options: { runtime: "local"; cwd: string }): Promise<void>;
  listModels(options?: { apiKey?: string }): Promise<SDKModel[]>;
  me(options?: { apiKey?: string }): Promise<SDKUser>;
  login(options?: SdkLoginOptions): Promise<SdkLoginResult>;
  logout(options?: SdkLogoutOptions): Promise<void>;
  authStatus(options?: SdkAuthStatusOptions): Promise<SdkAuthStatus>;
  createFileCredentialStore(filePath: string): SdkCredentialStore;
}

export async function loadCursorSdk(facadeOptions?: {
  localStore?: LocalAgentStore;
}): Promise<CursorSdkFacade> {
  const sdk = await import("@cursor/sdk");
  return {
    getConversation: async (agentId, cwd) => {
      const platform = await sdk.createAgentPlatform({
        workspaceRef: cwd,
        scopedWorkspaceRef: cwd,
        localStore: facadeOptions?.localStore,
      });
      return platform.checkpointStore.getFullConversation(agentId);
    },
    createAgent: (options) => sdk.Agent.create(options),
    resumeAgent: (agentId, options) => sdk.Agent.resume(agentId, options),
    listRuns: async (agentId, options) => {
      const runs: Run[] = [];
      let cursor: string | undefined;
      do {
        // oxlint-disable-next-line no-await-in-loop -- Each cursor comes from the preceding page.
        const page = await sdk.Agent.listRuns(agentId, { ...options, limit: 100, cursor });
        runs.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      return runs;
    },
    cancelRun: (runId, options) => sdk.Agent.cancelRun(runId, options),
    listModels: (options) => sdk.Cursor.models.list(options),
    me: (options) => sdk.Cursor.me(options),
    login: (options) => sdk.Cursor.auth.login(options),
    logout: (options) => sdk.Cursor.auth.logout(options),
    authStatus: (options) => sdk.Cursor.auth.status(options),
    createFileCredentialStore: (filePath) => new sdk.FileCredentialStore(filePath),
  };
}
