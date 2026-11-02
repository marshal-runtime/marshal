import type { AgentOptions, SDKAgent, SDKModel } from "@cursor/sdk";

import { CURSOR_AUTH_SETUP_INSTRUCTIONS } from "../../../common/runtime-config";
import type {
  RuntimeAuthLoginRequest,
  RuntimeAuthLoginResult,
  RuntimeClient,
  RuntimeModelInfo,
  RuntimeProcessHandle,
  RuntimeSessionConfig,
} from "../runtime-contract";
import {
  clearCursorApiKey,
  loadStoredCursorApiKey,
  saveCursorApiKey,
  startCursorBrowserLogin,
  cursorLoginRequestUnsupported,
  unauthenticatedCursorStatus,
} from "./auth";
import { CURSOR_DEFAULT_MODEL_ID, type CursorProcessEnv } from "./constants";
import { cursorConversationState } from "./conversation-state";
import { toCursorMcpServers } from "./mcp";
import { mapCursorModel, toCursorModelSelection } from "./model-selection";
import type { CursorSdkFacade, SdkCredentialStore } from "./sdk-facade";
import { CursorRuntimeSession } from "./session";
import { toCursorCustomTools, type CursorToolSessionIdentity } from "./tools";

// The SDK's "mcp" group also carries customTools, so it keeps the allowlisted host tools and drops built-ins.
const CURSOR_HOST_TOOL_GROUP = "mcp";

export interface CursorRuntimeClientOptions {
  workspaceDir: string;
  env?: CursorProcessEnv;
  store: SdkCredentialStore;
}

export class CursorRuntimeClient implements RuntimeClient {
  private readonly sessions = new Map<string, CursorRuntimeSession>();
  private sdkModels: SDKModel[] | undefined;
  private cachedModels: RuntimeModelInfo[] | undefined;
  private loginError: Error | undefined;

  constructor(
    private readonly sdk: CursorSdkFacade,
    private readonly options: CursorRuntimeClientOptions,
  ) {}

  get process(): RuntimeProcessHandle | undefined {
    return undefined;
  }

  async stop(): Promise<Error[]> {
    const sessions = [...this.sessions.values()];
    const results = await Promise.allSettled(sessions.map((session) => session.disconnect()));
    this.sessions.clear();
    return results.flatMap((result) =>
      result.status === "rejected"
        ? [result.reason instanceof Error ? result.reason : new Error(String(result.reason))]
        : [],
    );
  }

  async deleteSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    await session?.disconnect();
    this.sessions.delete(id);
  }

  async getAuthStatus(): Promise<{
    isAuthenticated: boolean;
    login?: string;
    statusMessage?: string;
  }> {
    if (this.loginError) throw this.loginError;
    const apiKey = await loadStoredCursorApiKey(this.options.store, this.env);
    if (!apiKey) return unauthenticatedCursorStatus();
    const stored = await this.options.store.load();
    return {
      isAuthenticated: true,
      ...(stored?.email ? { login: stored.email } : { login: "api-key" }),
      statusMessage: "Cursor API key is configured",
    };
  }

  async getUsage(): Promise<null> {
    // The Cursor SDK exposes no plan or rate-limit usage, so there is nothing to report.
    return null;
  }

  async login(request: RuntimeAuthLoginRequest): Promise<RuntimeAuthLoginResult> {
    if (this.sessions.size > 0) {
      throw new Error("Cannot change Cursor authentication while sessions are active");
    }
    this.loginError = undefined;
    this.sdkModels = undefined;
    this.cachedModels = undefined;
    switch (request.type) {
      case "api-key":
        await saveCursorApiKey(this.options.store, request.apiKey, undefined, this.env);
        return { status: "authenticated" };
      case "browser": {
        const pending = await startCursorBrowserLogin(this.sdk, this.options.store);
        pending.completion.catch((error: unknown) => {
          this.loginError = error instanceof Error ? error : new Error(String(error));
        });
        return pending.result;
      }
      default:
        throw cursorLoginRequestUnsupported(request);
    }
  }

  async logout(): Promise<void> {
    const errors = await this.stop();
    await this.sdk.logout({ store: this.options.store });
    await clearCursorApiKey(this.options.store);
    this.cachedModels = undefined;
    this.sdkModels = undefined;
    this.loginError = undefined;
    if (errors.length > 0) {
      throw new AggregateError(errors, "Cursor logout could not stop every active session");
    }
  }

  async listModels(): Promise<RuntimeModelInfo[]> {
    if (this.cachedModels) return this.cachedModels;
    const apiKey = await this.requireApiKey();
    this.sdkModels = await this.sdk.listModels({ apiKey });
    this.cachedModels = this.sdkModels.map(mapCursorModel);
    return this.cachedModels;
  }

  async createSession(config: RuntimeSessionConfig): Promise<CursorRuntimeSession> {
    return this.startSession(config, (options) => this.sdk.createAgent(options));
  }

  async resumeSession(id: string, config: RuntimeSessionConfig): Promise<CursorRuntimeSession> {
    await this.cancelOrphanedRuns(id, config);
    return this.startSession(config, (options) => this.sdk.resumeAgent(id, options), id);
  }

  async readConversationState(
    id: string,
    workingDirectory: string,
    options?: { allowCompaction?: boolean },
  ) {
    if (this.sdk.getConversation)
      return cursorConversationState(await this.sdk.getConversation(id, workingDirectory));
    const active = this.sessions.get(id);
    if (active) return active.exportConversationState(options);
    const retained = await this.resumeSession(id, {
      workingDirectory,
      cwd: workingDirectory,
      projectContext: false,
      tools: [],
      availableTools: [],
      mcpServers: {},
      onPermissionRequest: async () => ({ kind: "reject" }),
    });
    try {
      return await retained.exportConversationState(options);
    } finally {
      await retained.disconnect();
    }
  }

  private async cancelOrphanedRuns(id: string, config: RuntimeSessionConfig): Promise<void> {
    const cwd = config.cwd ?? config.workingDirectory ?? this.options.workspaceDir;
    const runs = await this.sdk.listRuns(id, { runtime: "local", cwd });
    await Promise.all(
      runs
        .filter((run) => run.status === "running")
        .map((run) => this.sdk.cancelRun(run.id, { runtime: "local", cwd })),
    );
  }

  private get env(): CursorProcessEnv {
    return this.options.env ?? process.env;
  }

  private async requireApiKey(): Promise<string> {
    const apiKey = await loadStoredCursorApiKey(this.options.store, this.env);
    if (apiKey) return apiKey;
    throw new Error(CURSOR_AUTH_SETUP_INSTRUCTIONS);
  }

  private async startSession(
    config: RuntimeSessionConfig,
    create: (options: AgentOptions) => Promise<SDKAgent>,
    existingId?: string,
  ): Promise<CursorRuntimeSession> {
    const sessionIdentity: CursorToolSessionIdentity = { id: existingId ?? "" };
    await this.listModels();
    const agent = await create(await this.agentOptions(config, sessionIdentity));
    sessionIdentity.id = agent.agentId;
    return this.attachSession(agent, config, existingId !== undefined);
  }

  private async agentOptions(
    config: RuntimeSessionConfig,
    sessionIdentity: CursorToolSessionIdentity,
  ): Promise<AgentOptions> {
    const cwd = config.cwd ?? config.workingDirectory ?? this.options.workspaceDir;
    const customTools = toCursorCustomTools(config.tools, sessionIdentity);
    const mcpServers = toCursorMcpServers(config.mcpServers);
    return {
      apiKey: await this.requireApiKey(),
      model: toCursorModelSelection(
        this.sdkModels ?? [],
        config.model ?? CURSOR_DEFAULT_MODEL_ID,
        config.reasoningEffort,
      ),
      ...(config.availableTools
        ? { tools: config.availableTools.length === 0 ? [] : [CURSOR_HOST_TOOL_GROUP] }
        : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(config.agents
        ? {
            agents: Object.fromEntries(
              Object.entries(config.agents).map(([name, definition]) => [
                name,
                {
                  description: definition.description,
                  prompt: definition.prompt,
                  model: "inherit" as const,
                },
              ]),
            ),
          }
        : {}),
      local: {
        cwd,
        settingSources: config.projectContext === false ? [] : ["project"],
        ...(customTools ? { customTools } : {}),
      },
    };
  }

  private attachSession(
    agent: SDKAgent,
    config: RuntimeSessionConfig,
    resumed = false,
  ): CursorRuntimeSession {
    if (this.sessions.has(agent.agentId)) {
      throw new Error(`Cursor session ${agent.agentId} is already active`);
    }
    const session = new CursorRuntimeSession(
      agent,
      config,
      (modelId, reasoningEffort) =>
        toCursorModelSelection(this.sdkModels ?? [], modelId, reasoningEffort),
      resumed
        ? async () => {
            if (this.sdk.getConversation)
              return cursorConversationState(
                await this.sdk.getConversation(
                  agent.agentId,
                  config.cwd ?? config.workingDirectory ?? this.options.workspaceDir,
                ),
              );
            throw new Error(
              "This Cursor chat predates retained-context checkpoints and has no exportable context.",
            );
          }
        : undefined,
      () => {
        if (this.sessions.get(session.sessionId) === session)
          this.sessions.delete(session.sessionId);
      },
    );
    this.sessions.set(session.sessionId, session);
    return session;
  }
}
