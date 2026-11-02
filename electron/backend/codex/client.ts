import { createHash, randomUUID } from "node:crypto";

import { createLogger } from "../../../common/marshal-logger";
import { unavailableUsage, type RuntimeAccountUsage } from "../../../common/runtime-account-usage";
import type { RuntimeConversationState } from "../../../common/runtime-conversation-state";
import type {
  RuntimeAssistantMessageEvent,
  RuntimeSessionEvent,
} from "../../../common/runtime-events";
import type {
  RuntimeAuthLoginRequest,
  RuntimeAuthLoginResult,
  RuntimeClient,
  RuntimeClientSession,
  RuntimeModelInfo,
  RuntimePermissionRequest,
  RuntimePermissionResult,
  RuntimeProcessHandle,
  RuntimeSendOptions,
  RuntimeSessionConfig,
  RuntimeSessionRpc,
  RuntimeTool,
} from "../runtime-contract";
import { CodexCompactionTracker } from "./compaction";
import {
  codexDynamicToolsForConfig,
  toCodexResumeParams,
  toCodexSteerParams,
  toCodexThreadParams,
  toCodexTurnParams,
} from "./config";
import { readCodexConversationState } from "./conversation-state";
import {
  CODEX_PROCESS_LOST_MESSAGE,
  CodexEventTranslator,
  codexRateLimitStatus,
  isCodexUsageLimit,
  notificationThreadId,
  rateLimitRetryAt,
} from "./events";
import type { CodexNotification, CodexRpcConnection, CodexServerRequest } from "./jsonl-rpc";
import {
  type CodexAccountLoginResponse,
  CODEX_PACKAGE_VERSION,
  type CodexMcpServerStatus,
  type CodexMcpStatusListResponse,
  type CodexModel,
  type CodexModelListResponse,
  type CodexRequestId,
  type CodexThreadItem,
  type CodexTurnStartResponse,
  CodexProtocolError,
  decodeAccountLoginResponse,
  decodeAccountReadResponse,
  decodeEmptyResponse,
  decodeInitializeResponse,
  decodeMcpOauthLoginResponse,
  decodeMcpStatusListResponse,
  decodeModelListResponse,
  decodeThreadResponseFor,
  decodeTurnStartResponse,
  decodeTurnSteerResponse,
  decodeUnknownRecordFor,
  isRecord,
  nullableString,
  optionalRecord,
  optionalString,
  requireArray,
  requireRecord,
  requireString,
  threadParentId,
  type UnknownRecord,
} from "./protocol";
import { unwrapLoginShellArgv, unwrapLoginShellCommandText } from "./shell-wrapper";
import { CodexThreadToolStore, hashDynamicTools } from "./thread-tools";
import { CODEX_DEFERRED_TOOL_NAMESPACE } from "./tool-surface";
import { codexUsageFromRateLimits } from "./usage";

const log = createLogger("CodexRuntimeClient");

const SUPPORTED_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const SESSION_END_HOOK_TIMEOUT_MS = 3_000;
const TURN_INTERRUPT_TIMEOUT_MS = 5_000;
const CHILD_THREAD_LOOKUP_TIMEOUT_MS = 5_000;
const RATE_LIMIT_READ_TIMEOUT_MS = 5_000;
const MAX_PENDING_EVENTS = 100;
const MAX_COMPLETED_TURNS = 100;
type RuntimeReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

function isRuntimeReasoningEffort(value: string): value is RuntimeReasoningEffort {
  return SUPPORTED_REASONING_EFFORTS.has(value);
}

export interface CodexRuntimeClientOptions {
  clientInfo?: {
    name?: string;
    title?: string;
    version?: string;
  };
  experimentalApi?: boolean;
  /** Persist per-thread tool-set hashes under CODEX_HOME (production); tests keep them in memory. */
  persistThreadTools?: boolean;
}

interface TurnWaiter {
  resolve(event: RuntimeAssistantMessageEvent | undefined): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface PendingServerOperation {
  controller: AbortController;
  turnId?: string;
}

function requestIdKey(id: CodexRequestId): string {
  return `${typeof id}:${String(id)}`;
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

function permissionApproved(result: RuntimePermissionResult): boolean {
  return result.kind === "approve-once";
}

function deniedHookReason(value: unknown): string | null {
  if (!isRecord(value) || value["permissionDecision"] !== "deny") return null;
  return (
    optionalString(value, "permissionDecisionReason", "hook result") ?? "Denied by host policy"
  );
}

function modifiedPrompt(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return optionalString(value, "modifiedPrompt", "user prompt hook result");
}

function itemChangePaths(item: CodexThreadItem | undefined): string[] {
  const changes = item?.["changes"];
  if (!Array.isArray(changes)) return [];
  const paths: string[] = [];
  for (const change of changes) {
    if (!isRecord(change)) continue;
    const path = optionalString(change, "path", "file change");
    if (path) paths.push(path);
    const kind = isRecord(change["kind"]) ? change["kind"] : undefined;
    if (kind && kind["type"] === "update") {
      const movePath = optionalString(kind, "move_path", "file change kind");
      if (movePath) paths.push(movePath);
    }
  }
  return [...new Set(paths)];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function permissionProfileToolName(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value)) ?? "null";
  const digest = createHash("sha256").update(serialized).digest("hex").slice(0, 16);
  return `codex_request_permissions_${digest}`;
}

function cancellationMessage(): string {
  return "Host tool request was cancelled before execution";
}

function authStatusName(status: unknown): string {
  return typeof status === "string" ? status : "unknown";
}

function mcpStatus(status: CodexMcpServerStatus): string {
  return authStatusName(status.authStatus) === "notLoggedIn" ? "needs-auth" : "connected";
}

function mapModel(model: CodexModel): RuntimeModelInfo {
  const supportedReasoningEfforts = model.supportedReasoningEfforts
    .map((option) => option.reasoningEffort)
    .filter(isRuntimeReasoningEffort);
  const defaultReasoningEffort = isRuntimeReasoningEffort(model.defaultReasoningEffort)
    ? model.defaultReasoningEffort
    : undefined;
  const supportsVision = model.inputModalities.includes("image");
  return {
    id: model.id,
    name: model.displayName || model.model,
    featured: model.isDefault,
    supportedReasoningEfforts,
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    capabilities: {
      supportsVision,
      supports: {
        vision: supportsVision,
        reasoningEffort: supportedReasoningEfforts.length > 0,
      },
    },
  };
}

function toCodexLoginRequest(request: RuntimeAuthLoginRequest): UnknownRecord {
  switch (request.type) {
    case "api-key":
      return { type: "apiKey", apiKey: request.apiKey };
    case "browser":
      return {
        type: "chatgpt",
        codexStreamlinedLogin: true,
        useHostedLoginSuccessPage: true,
      };
    case "device-code":
      return { type: "chatgptDeviceCode" };
    case "external-token":
      if (!request.accountId) {
        throw new Error("Codex external-token login requires accountId");
      }
      return {
        type: "chatgptAuthTokens",
        accessToken: request.accessToken,
        chatgptAccountId: request.accountId,
        ...(request.planType ? { chatgptPlanType: request.planType } : {}),
      };
    case "amazon-bedrock":
      return {
        type: "amazonBedrock",
        apiKey: request.apiKey,
        region: request.region,
      };
  }
  throw new Error("Unsupported runtime auth login request");
}

function fromCodexLoginResponse(response: CodexAccountLoginResponse): RuntimeAuthLoginResult {
  switch (response.type) {
    case "chatgpt":
      return {
        status: "pending",
        method: "browser",
        loginId: response.loginId,
        authorizationUrl: response.authUrl,
      };
    case "chatgptDeviceCode":
      return {
        status: "pending",
        method: "device-code",
        loginId: response.loginId,
        verificationUri: response.verificationUrl,
        userCode: response.userCode,
      };
    case "apiKey":
    case "chatgptAuthTokens":
    case "amazonBedrock":
      return { status: "authenticated" };
  }
  throw new Error("Unsupported Codex account login response");
}

export class CodexRuntimeClient implements RuntimeClient {
  private readonly sessions = new Map<string, CodexRuntimeClientSession>();
  /** Native sub-agent thread id → the Marshal session (root thread) that spawned it. */
  private readonly childThreadRoots = new Map<string, string>();
  /** Last `RateLimitSnapshot` from `account/rateLimits/updated` or a read. */
  private latestRateLimits: unknown = null;
  private readonly experimentalApi: boolean;
  private forceStopping = false;
  private stopped = false;
  ownedCodexHome = "";
  private threadTools = new CodexThreadToolStore();

  private constructor(
    private readonly connection: CodexRpcConnection,
    private readonly workspaceDir: string,
    options: CodexRuntimeClientOptions,
  ) {
    this.experimentalApi = options.experimentalApi ?? true;
  }

  static async initialize(
    connection: CodexRpcConnection,
    workspaceDir: string,
    options: CodexRuntimeClientOptions = {},
  ): Promise<CodexRuntimeClient> {
    const client = new CodexRuntimeClient(connection, workspaceDir, options);
    const clientInfo = options.clientInfo;
    const initialization = await connection.request(
      "initialize",
      {
        clientInfo: {
          name: clientInfo?.name ?? "marshal",
          title: clientInfo?.title ?? "Marshal",
          version: clientInfo?.version ?? CODEX_PACKAGE_VERSION,
        },
        capabilities: {
          experimentalApi: client.experimentalApi,
          requestAttestation: false,
        },
      },
      decodeInitializeResponse,
    );
    client.ownedCodexHome = initialization.codexHome;
    if (options.persistThreadTools) {
      client.threadTools = new CodexThreadToolStore(initialization.codexHome);
    }
    await connection.notify("initialized");
    connection.setServerRequestHandler((request) => client.handleServerRequest(request));
    connection.onNotification((notification) => client.handleNotification(notification));
    connection.onError((error) => client.handleTransportError(error));
    return client;
  }

  get process(): RuntimeProcessHandle | undefined {
    return this.connection.process;
  }

  markForceStopping(): void {
    this.forceStopping = true;
  }

  isClosed(): boolean {
    const proc = this.connection.process;
    return (
      this.stopped ||
      this.connection.isClosed?.() === true ||
      (proc !== undefined && (proc.exitCode !== null || proc.killed))
    );
  }

  async stop(): Promise<Error[]> {
    if (this.stopped) return [];
    this.stopped = true;
    const sessionCleanup = Promise.all(
      [...this.sessions.values()].map((session) => session.prepareClientStop()),
    );
    const shutdown = this.connection.shutdown({ force: this.forceStopping });
    await sessionCleanup;
    this.sessions.clear();
    return shutdown;
  }

  async deleteSession(id: string): Promise<void> {
    await this.connection.request("thread/delete", { threadId: id }, decodeEmptyResponse);
    await this.sessions.get(id)?.markDeleted();
    this.sessions.delete(id);
    await this.threadTools.delete(id);
  }

  async getAuthStatus(): Promise<{
    isAuthenticated: boolean;
    login?: string;
    statusMessage?: string;
  }> {
    const response = await this.connection.request(
      "account/read",
      { refreshToken: false },
      decodeAccountReadResponse,
    );
    if (!response.account) {
      return {
        isAuthenticated: false,
        statusMessage: response.requiresOpenaiAuth ? "Sign in required" : "Authentication optional",
      };
    }
    switch (response.account.type) {
      case "chatgpt":
        return {
          isAuthenticated: true,
          ...(response.account.email ? { login: response.account.email } : {}),
          statusMessage: response.account.planType,
        };
      case "apiKey":
        return { isAuthenticated: true, statusMessage: "API key" };
      case "amazonBedrock":
        return { isAuthenticated: true, statusMessage: "Amazon Bedrock" };
    }
    throw new Error("Unsupported Codex account type");
  }

  /**
   * Plan usage from `account/rateLimits/read`; the app-server refreshes its ChatGPT token while
   * answering. A failed read falls back to the last rate-limit notice of a turn.
   */
  async getUsage(): Promise<RuntimeAccountUsage> {
    let plan: string | undefined;
    try {
      const { account } = await this.connection.request(
        "account/read",
        { refreshToken: false },
        decodeAccountReadResponse,
      );
      if (!account) return unavailableUsage("signed_out");
      if (account.type !== "chatgpt") {
        return unavailableUsage(
          "not_applicable",
          "Plan usage is only reported for ChatGPT sign-ins",
        );
      }
      plan = account.planType;
      const response = await this.connection.request(
        "account/rateLimits/read",
        undefined,
        decodeUnknownRecordFor("account/rateLimits/read"),
        { timeoutMs: RATE_LIMIT_READ_TIMEOUT_MS },
      );
      this.latestRateLimits = response["rateLimits"] ?? this.latestRateLimits;
      return codexUsageFromRateLimits(this.latestRateLimits, { plan, source: "fetch" });
    } catch (error) {
      if (/\b401\b|unauthori[sz]ed|sign in|log in/i.test(asError(error, "unknown").message)) {
        return unavailableUsage("auth_expired", "Sign in again to restore plan usage");
      }
      if (this.latestRateLimits) {
        return codexUsageFromRateLimits(this.latestRateLimits, { plan, source: "event" });
      }
      return unavailableUsage("error", "Plan usage could not be loaded");
    }
  }

  async login(request: RuntimeAuthLoginRequest): Promise<RuntimeAuthLoginResult> {
    const response = await this.connection.request(
      "account/login/start",
      toCodexLoginRequest(request),
      decodeAccountLoginResponse,
    );
    return fromCodexLoginResponse(response);
  }

  async logout(): Promise<void> {
    await this.connection.request("account/logout", undefined, decodeEmptyResponse);
  }

  async listModels(): Promise<RuntimeModelInfo[]> {
    const models: RuntimeModelInfo[] = [];
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    do {
      // oxlint-disable-next-line no-await-in-loop -- cursor pagination is inherently sequential
      const page: CodexModelListResponse = await this.connection.request(
        "model/list",
        { cursor, limit: 100, includeHidden: false },
        decodeModelListResponse,
      );
      models.push(...page.data.map(mapModel));
      cursor = page.nextCursor;
      if (cursor !== null && seenCursors.has(cursor)) {
        throw new CodexProtocolError("model/list returned a repeated pagination cursor");
      }
      if (cursor !== null) seenCursors.add(cursor);
    } while (cursor !== null);
    return models;
  }

  async createSession(config: RuntimeSessionConfig): Promise<CodexRuntimeClientSession> {
    const { session } = await this.startThread(config);
    await session.emitMcpSnapshot();
    return session;
  }

  async resumeSession(
    id: string,
    config: RuntimeSessionConfig,
  ): Promise<CodexRuntimeClientSession> {
    const toolHash = hashDynamicTools(codexDynamicToolsForConfig(config));
    const recordedHash = await this.threadTools.get(id);
    if (recordedHash !== undefined && recordedHash !== toolHash) {
      const replacement = await this.replaceThreadWithCurrentTools(id, config);
      if (replacement) return replacement;
    }
    const response = await this.connection.request(
      "thread/resume",
      toCodexResumeParams(id, this.workspaceDir, config, {
        experimentalApi: this.experimentalApi,
      }),
      decodeThreadResponseFor("thread/resume"),
    );
    const session = new CodexRuntimeClientSession(
      this,
      this.connection,
      response.thread.id,
      config,
      response.model ?? config.model ?? "",
    );
    this.sessions.set(session.sessionId, session);
    if (recordedHash === undefined) await this.threadTools.set(session.sessionId, toolHash);
    await session.emitMcpSnapshot();
    return session;
  }

  private async startThread(
    config: RuntimeSessionConfig,
  ): Promise<{ session: CodexRuntimeClientSession }> {
    const response = await this.connection.request(
      "thread/start",
      toCodexThreadParams(this.workspaceDir, config, {
        experimentalApi: this.experimentalApi,
      }),
      decodeThreadResponseFor("thread/start"),
    );
    const session = new CodexRuntimeClientSession(
      this,
      this.connection,
      response.thread.id,
      config,
      response.model ?? config.model ?? "",
    );
    this.sessions.set(session.sessionId, session);
    await this.threadTools.set(
      session.sessionId,
      hashDynamicTools(codexDynamicToolsForConfig(config)),
    );
    return { session };
  }

  /**
   * `thread/resume` cannot carry `dynamicTools`, so a thread keeps the tools
   * it started with. When the host's current tools differ (extension installed,
   * Marshal upgraded, schema changed), start a new thread with the current set
   * and hand the old thread's retained context to the host to replay on the
   * next prompt. The old thread is left on disk. Returns undefined to keep the
   * frozen thread when its context cannot be exported (e.g. encrypted
   * compaction), since a working thread with stale tools beats a blank one.
   */
  private async replaceThreadWithCurrentTools(
    previousThreadId: string,
    config: RuntimeSessionConfig,
  ): Promise<CodexRuntimeClientSession | undefined> {
    let state: RuntimeConversationState;
    try {
      state = await this.readThreadConversationState(previousThreadId);
    } catch (error) {
      log.warn(
        `Keeping thread ${previousThreadId} with its original tools: its context cannot be exported:`,
        error,
      );
      return undefined;
    }
    log.info(`Tool set changed since thread ${previousThreadId} started; starting a new thread`);
    const { session } = await this.startThread(config);
    session.setResumeHandoff(state);
    await session.emitMcpSnapshot();
    return session;
  }

  async readThreadConversationState(threadId: string): Promise<RuntimeConversationState> {
    const response = await this.connection.request(
      "thread/read",
      { threadId, includeTurns: true },
      decodeThreadResponseFor("thread/read"),
    );
    if (response.thread.path) {
      return readCodexConversationState(response.thread.path, this.ownedCodexHome);
    }
    // The UI projection omits compaction replacements; never use it for handoff.
    throw new Error(
      "Codex did not expose its retained context file. The source chat was not transferred.",
    );
  }

  removeSession(id: string): void {
    this.sessions.delete(id);
    for (const [childId, rootId] of this.childThreadRoots) {
      if (rootId === id) this.childThreadRoots.delete(childId);
    }
  }

  private async handleServerRequest(request: CodexServerRequest): Promise<unknown> {
    if (request.method === "account/chatgptAuthTokens/refresh") {
      // Marshal never hands Codex external ChatGPT tokens; the only fix is a
      // fresh sign-in, so fail the request and label the affected turns.
      for (const session of this.sessions.values()) session.noteAuthRefreshRefused();
      throw new CodexProtocolError("external token refresh is not supported", request.method);
    }
    if (request.method === "currentTime/read") {
      return { currentTimeAt: Math.floor(Date.now() / 1_000) };
    }
    const params = requireRecord(request.params, "params", request.method);
    const threadId =
      optionalString(params, "threadId", "params", request.method) ??
      optionalString(params, "conversationId", "params", request.method);
    if (!threadId) {
      throw new CodexProtocolError("server request has no thread identifier", request.method);
    }
    const session = this.sessions.get(threadId);
    if (session) return session.handleServerRequest(request);
    const root = this.sessions.get(
      this.childThreadRoots.get(threadId) ?? (await this.lookUpChildThreadRoot(threadId)) ?? "",
    );
    if (!root) {
      throw new CodexProtocolError("server request targets an inactive thread", request.method);
    }
    return root.handleServerRequest(request, { fromChildThread: true });
  }

  private handleNotification(notification: CodexNotification): void {
    const threadId = notificationThreadId(notification.method, notification.params);
    if (threadId) {
      this.learnChildThreads(threadId, notification);
      const session = this.sessions.get(threadId);
      if (session) {
        session.handleNotification(notification);
        return;
      }
      const rootId = this.childThreadRoots.get(threadId);
      if (rootId) this.sessions.get(rootId)?.handleChildNotification(notification);
      return;
    }
    if (notification.method === "account/rateLimits/updated") {
      if (!isRecord(notification.params)) return;
      this.latestRateLimits = notification.params["rateLimits"] ?? null;
      const status = codexRateLimitStatus(this.latestRateLimits);
      if (status) {
        for (const session of this.sessions.values()) session.showRateLimitStatus(status);
      }
      return;
    }
    if (
      notification.method === "warning" ||
      notification.method === "guardianWarning" ||
      notification.method === "configWarning" ||
      notification.method === "deprecationNotice"
    ) {
      for (const session of this.sessions.values()) {
        session.handleNotification(notification);
      }
    }
  }

  /**
   * Models with native multi-agent (gpt-5.6-sol/terra carry `multi_agent_version:
   * "v2"`, which `features.multi_agent=false` does not turn off) spawn child
   * threads Marshal never started. Their approvals and tool calls are answered
   * by the root session so they go through the same permission path; their
   * other notifications stay out of the root's transcript.
   */
  private learnChildThreads(threadId: string, notification: CodexNotification): void {
    const params = notification.params;
    if (!isRecord(params)) return;
    if (notification.method === "thread/started" && isRecord(params["thread"])) {
      const parent = threadParentId(params["thread"]);
      if (parent) this.noteChildThread(threadId, parent);
      return;
    }
    if (notification.method !== "item/started" && notification.method !== "item/completed") return;
    const item = params["item"];
    if (!isRecord(item) || item["type"] !== "collabAgentToolCall") return;
    const receivers = item["receiverThreadIds"];
    if (!Array.isArray(receivers)) return;
    for (const receiver of receivers) {
      if (typeof receiver === "string") this.noteChildThread(receiver, threadId);
    }
  }

  private noteChildThread(childId: string, parentId: string): void {
    if (childId === parentId || this.sessions.has(childId)) return;
    const rootId = this.sessions.has(parentId) ? parentId : this.childThreadRoots.get(parentId);
    if (rootId) this.childThreadRoots.set(childId, rootId);
  }

  /** When the exhausted usage limit resets (epoch ms), from a fresh read or the last update. */
  async usageLimitRetryAt(): Promise<number | undefined> {
    try {
      const response = await this.connection.request(
        "account/rateLimits/read",
        undefined,
        decodeUnknownRecordFor("account/rateLimits/read"),
        { timeoutMs: RATE_LIMIT_READ_TIMEOUT_MS },
      );
      this.latestRateLimits = response["rateLimits"] ?? this.latestRateLimits;
    } catch (error) {
      log.warn("Could not read Codex rate limits", asError(error, "unknown").name);
    }
    return rateLimitRetryAt(this.latestRateLimits);
  }

  /** A child whose spawn notification was missed: ask the app-server for its parent. */
  private async lookUpChildThreadRoot(threadId: string): Promise<string | undefined> {
    if (this.sessions.size === 0) return undefined;
    try {
      const response = await this.connection.request(
        "thread/read",
        { threadId, includeTurns: false },
        decodeThreadResponseFor("thread/read"),
        { timeoutMs: CHILD_THREAD_LOOKUP_TIMEOUT_MS },
      );
      const parent = response.thread.parentThreadId;
      if (parent) this.noteChildThread(threadId, parent);
    } catch (error) {
      log.warn("Could not resolve the parent of a Codex thread", asError(error, "unknown").name);
    }
    return this.childThreadRoots.get(threadId);
  }

  private handleTransportError(error: Error): void {
    // The connection also reports non-fatal failures (a throwing notification
    // handler); only a closed connection ends the sessions.
    if (this.connection.isClosed?.() === false) {
      log.warn("Codex app-server reported a non-fatal transport error", error.name);
      return;
    }
    for (const session of this.sessions.values()) {
      session.handleTransportError(error);
    }
  }
}

export class CodexRuntimeClientSession implements RuntimeClientSession {
  readonly rpc: RuntimeSessionRpc;
  private readonly handlers = new Set<(event: RuntimeSessionEvent) => void>();
  private readonly pendingEvents: RuntimeSessionEvent[] = [];
  private readonly translator: CodexEventTranslator;
  private readonly tools = new Map<string, RuntimeTool>();
  private readonly pendingServerOperations = new Map<string, PendingServerOperation>();
  // Multiple waiters per turn: a steered message joins the already-active
  // turn, so two sendAndWait callers can legitimately await the same turnId.
  private readonly waiters = new Map<string, TurnWaiter[]>();
  private readonly completedMessages = new Map<string, RuntimeAssistantMessageEvent>();
  private readonly completedTurns = new Set<string>();
  private readonly nativePreToolDecisions = new Map<string, Promise<string | null>>();
  private readonly hookDeniedTurns = new Set<string>();
  private readonly locallyInterruptedTurns = new Set<string>();
  /** Non-null while a usage-limited turn's completion waits for its reset time. */
  private heldNotifications: CodexNotification[] | null = null;
  private activeTurnId: string | null = null;
  private turnStartTail: Promise<unknown> = Promise.resolve();
  /** Bumped by abort() so sends queued behind the aborted one are dropped too. */
  private abortGeneration = 0;
  private currentModel: string;
  private currentEffort: RuntimeSessionConfig["reasoningEffort"];
  private closed = false;
  private sessionEndCalled = false;
  private turnStartController: AbortController | null = null;
  private resumeHandoff: RuntimeConversationState | undefined;
  private readonly compaction = new CodexCompactionTracker();

  constructor(
    private readonly client: CodexRuntimeClient,
    private readonly connection: CodexRpcConnection,
    readonly sessionId: string,
    private readonly config: RuntimeSessionConfig,
    model: string,
  ) {
    this.currentModel = model;
    this.currentEffort = config.reasoningEffort;
    this.translator = new CodexEventTranslator(() => this.currentModel);
    for (const tool of config.tools ?? []) this.tools.set(tool.name, tool);
    this.rpc = {
      history: { compact: () => this.compact() },
      mcp: {
        list: () => this.listMcpServers(),
        reload: async () => {
          await this.connection.request("config/mcpServer/reload", undefined, decodeEmptyResponse);
          return {};
        },
        oauth: {
          login: async (options) =>
            this.connection.request(
              "mcpServer/oauth/login",
              {
                name: options.serverName,
                threadId: this.sessionId,
              },
              decodeMcpOauthLoginResponse,
            ),
        },
      },
      auth: {
        getStatus: async () => ({ ...(await this.client.getAuthStatus()) }),
      },
    };
  }

  private async compact(): Promise<unknown> {
    if (this.closed) throw new Error("[codex-app-server] session is closed");
    if (this.activeTurnId || this.turnStartController || this.compaction.active) {
      throw new Error("Wait for the current response to finish before compacting.");
    }
    const completed = this.compaction.begin();
    // A start failure leaves `completed` pending forever; keep it from becoming an unhandled rejection.
    completed.catch(() => {});
    try {
      await this.connection.request(
        "thread/compact/start",
        { threadId: this.sessionId },
        decodeEmptyResponse,
      );
    } catch (error) {
      this.compaction.cancel();
      throw error;
    }
    await completed;
    return {};
  }

  setResumeHandoff(state: RuntimeConversationState): void {
    this.resumeHandoff = state;
  }

  takeResumeHandoff(): RuntimeConversationState | undefined {
    const state = this.resumeHandoff;
    this.resumeHandoff = undefined;
    return state;
  }

  on(handler: (event: RuntimeSessionEvent) => void): () => void {
    this.handlers.add(handler);
    if (this.pendingEvents.length > 0) {
      const pending = this.pendingEvents.splice(0);
      for (const event of pending) handler(event);
    }
    return () => this.handlers.delete(handler);
  }

  async send(options: RuntimeSendOptions): Promise<string> {
    const response = await this.startTurn(options);
    return response;
  }

  async sendAndWait(
    options: RuntimeSendOptions,
    timeout?: number,
  ): Promise<RuntimeAssistantMessageEvent | undefined> {
    const turnId = await this.startTurn(options);
    const completed = this.completedMessages.get(turnId);
    if (completed) return completed;
    if (this.completedTurns.has(turnId)) return undefined;
    return new Promise((resolve, reject) => {
      const waiter: TurnWaiter = { resolve, reject, timer: null };
      if (timeout !== undefined && timeout > 0) {
        waiter.timer = setTimeout(() => {
          this.removeWaiter(turnId, waiter);
          reject(new Error(`[codex-app-server] turn ${turnId} timed out after ${timeout} ms`));
        }, timeout);
      }
      const list = this.waiters.get(turnId) ?? [];
      list.push(waiter);
      this.waiters.set(turnId, list);
    });
  }

  private removeWaiter(turnId: string, waiter: TurnWaiter): void {
    const list = this.waiters.get(turnId);
    if (!list) return;
    const remaining = list.filter((entry) => entry !== waiter);
    if (remaining.length === 0) {
      this.waiters.delete(turnId);
    } else {
      this.waiters.set(turnId, remaining);
    }
  }

  async destroy(): Promise<void> {
    await this.disconnect();
  }

  async disconnect(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.turnStartController?.abort();
    this.abortPendingOperations();
    this.rejectWaiters(new Error("[codex-app-server] session disconnected"));
    try {
      await this.connection.request(
        "thread/unsubscribe",
        { threadId: this.sessionId },
        decodeUnknownRecordFor("thread/unsubscribe"),
      );
    } finally {
      await this.callSessionEnd("disconnect");
      this.client.removeSession(this.sessionId);
    }
  }

  async abort(): Promise<void> {
    this.abortGeneration += 1;
    if (this.turnStartController) {
      this.turnStartController.abort();
      // A live start controller with an active turn means an in-flight
      // turn/steer — fall through and interrupt the active turn too, matching
      // busy-abort semantics. A plain turn start has no active turn yet; its
      // late-response fence handles the interrupt.
      if (!this.activeTurnId) {
        this.emit({ ...this.eventBase(), type: "abort", data: {} });
        return;
      }
    }
    this.abortPendingOperations(this.activeTurnId ?? undefined);
    if (!this.activeTurnId) {
      this.emit({ ...this.eventBase(), type: "abort", data: {} });
      return;
    }
    const turnId = this.activeTurnId;
    try {
      await this.connection.request(
        "turn/interrupt",
        { threadId: this.sessionId, turnId },
        decodeEmptyResponse,
        { timeoutMs: TURN_INTERRUPT_TIMEOUT_MS },
      );
    } catch (error) {
      // A wedged app-server must not leave the chat stuck "running": finish
      // the turn locally and ignore its late completion, if one ever arrives.
      log
        .with({ sessionId: this.sessionId })
        .warn(
          "turn/interrupt did not complete; ending the turn locally",
          asError(error, "unknown").name,
        );
      if (this.closed || this.completedTurns.has(turnId)) return;
      this.handleTurnCompleted({
        threadId: this.sessionId,
        turn: { id: turnId, items: [], status: "interrupted", error: null, completedAt: null },
      });
      this.locallyInterruptedTurns.add(turnId);
    }
  }

  async setModel(
    model: string,
    options?: { reasoningEffort?: RuntimeSessionConfig["reasoningEffort"] },
  ): Promise<void> {
    this.currentModel = model;
    if (options?.reasoningEffort !== undefined) {
      this.currentEffort = options.reasoningEffort;
    }
    this.emit({
      ...this.eventBase(),
      type: "session.model_change",
      data: { newModel: model },
    });
    this.emit({
      ...this.eventBase(),
      type: "session.metadata_updated",
      data: { newModel: model },
    });
  }

  async getMessages(): Promise<RuntimeSessionEvent[]> {
    const response = await this.connection.request(
      "thread/read",
      { threadId: this.sessionId, includeTurns: true },
      decodeThreadResponseFor("thread/read"),
    );
    return new CodexEventTranslator(() => this.currentModel).history(response.thread);
  }

  async exportConversationState(): Promise<RuntimeConversationState> {
    return this.client.readThreadConversationState(this.sessionId);
  }

  async emitMcpSnapshot(): Promise<void> {
    try {
      const statuses = await this.listMcpServers();
      if (statuses.data.length === 0 && Object.keys(this.config.mcpServers ?? {}).length === 0) {
        return;
      }
      this.emit({
        ...this.eventBase(),
        type: "session.mcp_servers_loaded",
        data: {
          servers: statuses.data.map((status) => ({
            name: status.name,
            status: mcpStatus(status),
            source: "thread-config",
          })),
        },
      });
    } catch (error) {
      const failure = asError(error, "Failed to read Codex MCP status");
      log.with({ sessionId: this.sessionId }).warn("MCP status probe failed", failure.name);
      void this.callHook(
        this.config.hooks?.onErrorOccurred,
        { error: failure, errorContext: "mcp-status", recoverable: true },
        "error",
      );
    }
  }

  handleNotification(notification: CodexNotification): void {
    if (this.closed) return;
    if (this.heldNotifications) {
      this.heldNotifications.push(notification);
      return;
    }
    this.compaction.onNotification(notification);
    if (notification.method === "turn/completed") {
      const failure = this.translator.failedTurnError(notification.params);
      if (failure && isCodexUsageLimit(failure.codexErrorInfo)) {
        void this.completeUsageLimitedTurn(notification);
      } else {
        this.handleTurnCompleted(notification.params);
      }
      return;
    }
    if (notification.method === "serverRequest/resolved") {
      this.resolveServerOperation(notification);
    }

    const translated = this.translator.translate(notification.method, notification.params);
    for (const event of translated) this.emit(event);
    this.handleNotificationHooks(notification);
  }

  /**
   * A turn refused for usage limits reports when the limit resets, so a goal
   * can wait for it. The reset time needs one rate-limit read; the completion
   * and anything after it are held until then to keep event order.
   */
  private async completeUsageLimitedTurn(notification: CodexNotification): Promise<void> {
    this.heldNotifications = [];
    try {
      const params = requireRecord(notification.params, "params", notification.method);
      const turn = requireRecord(params["turn"], "params.turn", notification.method);
      const turnId = requireString(turn, "id", "params.turn", notification.method);
      const retryAt = await this.client.usageLimitRetryAt();
      if (retryAt !== undefined) this.translator.noteUsageLimitReset(turnId, retryAt);
    } finally {
      const held = this.heldNotifications ?? [];
      this.heldNotifications = null;
      if (!this.closed) {
        this.handleTurnCompleted(notification.params);
        for (const next of held) this.handleNotification(next);
      }
    }
  }

  showRateLimitStatus(status: string): void {
    if (this.closed || !this.activeTurnId) return;
    this.emit({ ...this.eventBase(), type: "session.status", data: { status } });
  }

  private resolveServerOperation(notification: CodexNotification): void {
    const params = requireRecord(notification.params, "params", notification.method);
    const rawId = params["requestId"];
    if (typeof rawId === "string" || (typeof rawId === "number" && Number.isSafeInteger(rawId))) {
      const operation = this.pendingServerOperations.get(requestIdKey(rawId));
      operation?.controller.abort();
      this.pendingServerOperations.delete(requestIdKey(rawId));
    }
  }

  private handleTurnCompleted(rawParams: unknown): void {
    const method = "turn/completed";
    const params = requireRecord(rawParams, "params", method);
    const turn = requireRecord(params["turn"], "params.turn", method);
    const turnId = requireString(turn, "id", "params.turn", method);
    if (this.locallyInterruptedTurns.delete(turnId)) return;
    const translated = this.translator.translate(method, rawParams);
    for (const event of translated) this.emit(event);
    this.handleNotificationHooks({ method, params: rawParams });

    this.completedTurns.add(turnId);
    this.trimCompletedState();
    this.hookDeniedTurns.delete(turnId);
    this.abortPendingOperations(turnId);
    if (this.activeTurnId === turnId) this.activeTurnId = null;
    const turnWaiters = this.waiters.get(turnId);
    if (turnWaiters) {
      this.waiters.delete(turnId);
      for (const waiter of turnWaiters) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve(this.completedMessages.get(turnId));
      }
    }
    this.translator.completeTurn(turnId);
  }

  noteAuthRefreshRefused(): void {
    if (this.activeTurnId) this.translator.noteAuthRefreshRefused(this.activeTurnId);
  }

  isClosed(): boolean {
    return this.closed;
  }

  handleTransportError(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.compaction.fail(error);
    const turnInFlight = this.activeTurnId !== null || this.turnStartController !== null;
    this.turnStartController?.abort();
    this.abortPendingOperations();
    // Idle sessions recover silently on their next send (the backend resumes
    // the thread on a fresh app-server); only an interrupted turn is reported.
    if (turnInFlight) {
      this.emit({
        ...this.eventBase(),
        type: "session.error",
        data: { message: CODEX_PROCESS_LOST_MESSAGE, errorType: "connection_lost" },
      });
    }
    this.rejectWaiters(error);
    void this.callHook(
      this.config.hooks?.onErrorOccurred,
      { error, errorContext: "transport", recoverable: false },
      "error",
    );
  }

  /** A notification from a native sub-agent thread this session spawned. */
  handleChildNotification(notification: CodexNotification): void {
    if (this.closed) return;
    switch (notification.method) {
      case "serverRequest/resolved":
        this.resolveServerOperation(notification);
        return;
      case "item/started":
      case "item/completed": {
        // Approval handlers read item details (e.g. file-change paths), and the
        // host pre-tool gate applies to sub-agent tools as to the root's.
        this.translator.rememberItem(notification.method, notification.params);
        const params = requireRecord(notification.params, "params", notification.method);
        this.handleNotificationHooks(
          notification,
          requireString(params, "threadId", "params", notification.method),
        );
        return;
      }
      case "turn/completed": {
        const params = requireRecord(notification.params, "params", notification.method);
        const turn = requireRecord(params["turn"], "params.turn", notification.method);
        const turnId = requireString(turn, "id", "params.turn", notification.method);
        this.translator.completeTurn(turnId);
        this.hookDeniedTurns.delete(turnId);
        return;
      }
      default:
        return;
    }
  }

  async handleServerRequest(
    request: CodexServerRequest,
    options: { fromChildThread?: boolean } = {},
  ): Promise<unknown> {
    if (this.closed) {
      throw new CodexProtocolError("server request targets a closed session", request.method);
    }
    const params = requireRecord(request.params, "params", request.method);
    const controller = new AbortController();
    const key = requestIdKey(request.id);
    this.pendingServerOperations.set(key, {
      controller,
      // A child thread's turn ids are not this session's; tie its requests to
      // the root turn so aborting or finishing that turn cancels them too.
      turnId: options.fromChildThread
        ? (this.activeTurnId ?? undefined)
        : optionalString(params, "turnId", "params", request.method),
    });
    try {
      switch (request.method) {
        case "item/tool/call":
          return await this.handleDynamicToolCall(request, controller);
        case "item/commandExecution/requestApproval":
          return await this.handleCommandApproval(request, controller.signal);
        case "item/fileChange/requestApproval":
          return await this.handleFileApproval(request, controller.signal);
        case "mcpServer/elicitation/request":
          return await this.handleMcpElicitation(request, controller.signal);
        case "item/permissions/requestApproval":
          return await this.handlePermissionsApproval(request, controller.signal);
        case "execCommandApproval":
          return await this.handleLegacyCommandApproval(request, controller.signal);
        case "applyPatchApproval":
          return await this.handleLegacyPatchApproval(request, controller.signal);
        case "item/tool/requestUserInput":
          return { answers: {} };
        default:
          throw new CodexProtocolError("unsupported server request", request.method);
      }
    } finally {
      this.pendingServerOperations.delete(key);
    }
  }

  async prepareClientStop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.turnStartController?.abort();
    this.abortPendingOperations();
    this.rejectWaiters(new Error("[codex-app-server] client stopped"));
    await this.callSessionEnd("client-stop");
  }

  async markDeleted(): Promise<void> {
    this.closed = true;
    this.turnStartController?.abort();
    this.abortPendingOperations();
    this.rejectWaiters(new Error("[codex-app-server] session deleted"));
    await this.callSessionEnd("delete");
  }

  /**
   * Overlapping sends (goal continuations racing a user message, queued
   * automation prompts) run one after another: the next one starts once the
   * previous turn/start or turn/steer has settled, and so steers into the turn
   * it started instead of failing.
   */
  private startTurn(options: RuntimeSendOptions): Promise<string> {
    const generation = this.abortGeneration;
    const run = this.turnStartTail.then(() => {
      if (generation !== this.abortGeneration && !this.closed) {
        throw this.turnStartAbortError();
      }
      return this.startTurnNow(options);
    });
    this.turnStartTail = run.catch(() => undefined);
    return run;
  }

  private async startTurnNow(options: RuntimeSendOptions): Promise<string> {
    if (this.closed) throw new Error("[codex-app-server] session is closed");
    const controller = new AbortController();
    this.turnStartController = controller;
    try {
      const hookResult = await this.abortableTurnStartOperation(
        this.callHook(
          this.config.hooks?.onUserPromptSubmitted,
          { prompt: options.prompt },
          "user-prompt",
        ),
        controller,
      );
      if (controller.signal.aborted || this.closed) {
        throw this.turnStartAbortError();
      }
      const effectiveOptions = {
        ...options,
        prompt: modifiedPrompt(hookResult) ?? options.prompt,
      };

      // A busy session steers the message into the active turn (turn/steer)
      // instead of failing with "turn is already active". The message is never
      // delivered by interrupting and restarting — that would lose the running
      // turn's work.
      const steerTarget = this.activeTurnId;
      if (steerTarget) {
        try {
          const steered = await this.abortableTurnStartOperation(
            this.connection.request(
              "turn/steer",
              toCodexSteerParams(this.sessionId, effectiveOptions, steerTarget, randomUUID()),
              decodeTurnSteerResponse,
            ),
            controller,
          );
          return steered.turnId;
        } catch (error) {
          // Fall through to a fresh turn/start only when the target turn
          // completed while the steer was in flight — the message still has to
          // be delivered. Any other failure (abort, turn still active,
          // protocol error) propagates so a caller retry cannot double-send.
          if (controller.signal.aborted || this.closed || this.activeTurnId) {
            throw error;
          }
        }
      }

      const clientUserMessageId = randomUUID();
      const response = await this.awaitTurnStartResponse(
        this.connection.request(
          "turn/start",
          toCodexTurnParams(
            this.sessionId,
            effectiveOptions,
            this.config,
            { model: this.currentModel, effort: this.currentEffort },
            clientUserMessageId,
          ),
          decodeTurnStartResponse,
        ),
        controller,
      );
      if (controller.signal.aborted || this.closed) {
        await this.connection.request(
          "turn/interrupt",
          { threadId: this.sessionId, turnId: response.turn.id },
          decodeEmptyResponse,
        );
        throw this.turnStartAbortError();
      }
      if (!this.completedTurns.has(response.turn.id)) {
        this.activeTurnId = response.turn.id;
      }
      return response.turn.id;
    } finally {
      if (this.turnStartController === controller) this.turnStartController = null;
    }
  }

  private async listMcpServers(): Promise<{
    data: CodexMcpServerStatus[];
    nextCursor: null;
  }> {
    const data: CodexMcpServerStatus[] = [];
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    do {
      // oxlint-disable-next-line no-await-in-loop -- cursor pagination is inherently sequential
      const page: CodexMcpStatusListResponse = await this.connection.request(
        "mcpServerStatus/list",
        { threadId: this.sessionId, cursor, limit: 100, detail: "full" },
        decodeMcpStatusListResponse,
      );
      data.push(...page.data);
      cursor = page.nextCursor;
      if (cursor !== null && seenCursors.has(cursor)) {
        throw new CodexProtocolError("mcpServerStatus/list returned a repeated pagination cursor");
      }
      if (cursor !== null) seenCursors.add(cursor);
    } while (cursor !== null);
    return { data, nextCursor: null };
  }

  private async handleDynamicToolCall(
    request: CodexServerRequest,
    controller: AbortController,
  ): Promise<unknown> {
    const params = requireRecord(request.params, "params", request.method);
    const turnId = requireString(params, "turnId", "params", request.method);
    const callId = requireString(params, "callId", "params", request.method);
    const namespace = nullableString(params, "namespace", "params", request.method);
    const toolName = requireString(params, "tool", "params", request.method);
    const args = params["arguments"];
    const tool =
      namespace === null || namespace === CODEX_DEFERRED_TOOL_NAMESPACE
        ? this.tools.get(toolName)
        : undefined;
    if (!tool) {
      return {
        contentItems: [
          {
            type: "inputText",
            text: `Host tool "${namespace ? `${namespace}.` : ""}${toolName}" is unavailable.`,
          },
        ],
        success: false,
      };
    }

    try {
      const preResult = await this.raceServerOperation(
        this.callHook(
          this.config.hooks?.onPreToolUse,
          {
            toolName,
            toolArgs: args,
            cwd: this.config.workingDirectory ?? this.config.cwd,
            toolCallId: callId,
          },
          "pre-tool",
        ),
        controller.signal,
      );
      const denial = deniedHookReason(preResult);
      if (denial) {
        return {
          contentItems: [{ type: "inputText", text: denial }],
          success: false,
        };
      }
      if (controller.signal.aborted || this.closed) {
        return {
          contentItems: [{ type: "inputText", text: cancellationMessage() }],
          success: false,
        };
      }
      const permission = await this.requestPermission(
        {
          kind: "custom-tool",
          toolCallId: callId,
          requestId: request.id,
          turnId,
          toolName,
          toolDescription: tool.description,
          toolArgs: isRecord(args) ? args : {},
        },
        controller.signal,
      );
      if (!permissionApproved(permission)) {
        return {
          contentItems: [
            {
              type: "inputText",
              text:
                permission.kind === "reject"
                  ? (permission.feedback ?? "Host tool use was denied")
                  : "Host tool use is unavailable without user approval",
            },
          ],
          success: false,
        };
      }
      if (controller.signal.aborted || this.closed) {
        return {
          contentItems: [{ type: "inputText", text: cancellationMessage() }],
          success: false,
        };
      }
      const result = await tool.handler(args, {
        sessionId: this.sessionId,
        toolCallId: callId,
        toolName,
        arguments: args,
        ...(tool.supportsAbortSignal ? { signal: controller.signal } : {}),
      });
      if (controller.signal.aborted || this.closed) {
        return {
          contentItems: [{ type: "inputText", text: cancellationMessage() }],
          success: false,
        };
      }
      await this.callHook(
        this.config.hooks?.onPostToolUse,
        {
          toolName,
          toolArgs: args,
          cwd: this.config.workingDirectory ?? this.config.cwd,
          toolCallId: callId,
          toolResult: result,
        },
        "post-tool",
      );
      return {
        contentItems: [{ type: "inputText", text: result }],
        success: true,
      };
    } catch (error) {
      const failure = asError(error, "Host tool failed");
      if (failure.name === "AbortError") {
        return {
          contentItems: [{ type: "inputText", text: cancellationMessage() }],
          success: false,
        };
      }
      await this.callHook(
        this.config.hooks?.onPostToolUseFailure,
        {
          toolName,
          toolArgs: args,
          cwd: this.config.workingDirectory ?? this.config.cwd,
          toolCallId: callId,
          error: failure,
        },
        "post-tool-failure",
      );
      return {
        contentItems: [{ type: "inputText", text: failure.message }],
        success: false,
      };
    }
  }

  private async handleCommandApproval(
    request: CodexServerRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    const params = requireRecord(request.params, "params", request.method);
    const itemId = requireString(params, "itemId", "params", request.method);
    const preHookDenial = await this.raceServerOperation(
      this.nativePreToolDecision(itemId, params),
      signal,
    ).catch(() => "request cancelled");
    if (preHookDenial) return { decision: "decline" };
    // Strip the login-shell wrapper so the shared policy sees the command that
    // actually runs — otherwise pattern extraction cannot persist any allow
    // rule and every equivalent invocation re-prompts (see shell-wrapper.ts).
    const command = unwrapLoginShellCommandText(
      optionalString(params, "command", "params", request.method) ?? "",
    );
    const result = await this.requestPermission(
      {
        kind: "shell",
        toolCallId: itemId,
        requestId: request.id,
        turnId: requireString(params, "turnId", "params", request.method),
        approvalId: nullableString(params, "approvalId", "params", request.method),
        command,
        fullCommandText: command,
        cwd: nullableString(params, "cwd", "params", request.method),
        reason: nullableString(params, "reason", "params", request.method),
        commandActions: params["commandActions"],
        additionalPermissions: params["additionalPermissions"],
        environmentId: nullableString(params, "environmentId", "params", request.method),
      },
      signal,
    );
    if (!permissionApproved(result)) return { decision: "decline" };
    const additionalPermissions = params["additionalPermissions"];
    const networkApprovalContext = params["networkApprovalContext"];
    if (
      (additionalPermissions !== undefined && additionalPermissions !== null) ||
      (networkApprovalContext !== undefined && networkApprovalContext !== null)
    ) {
      const additional = {
        additionalPermissions,
        networkApprovalContext,
        environmentId: nullableString(params, "environmentId", "params", request.method),
        cwd: nullableString(params, "cwd", "params", request.method),
        reason: nullableString(params, "reason", "params", request.method),
      };
      const capabilityResult = await this.requestPermission(
        {
          kind: "custom-tool",
          toolCallId: itemId,
          requestId: request.id,
          turnId: requireString(params, "turnId", "params", request.method),
          toolName: permissionProfileToolName(additional),
          toolDescription:
            "Codex requests additional filesystem or network access for this command.",
          toolArgs: additional,
        },
        signal,
      );
      if (!permissionApproved(capabilityResult)) return { decision: "decline" };
    }
    return { decision: "accept" };
  }

  private async handleFileApproval(
    request: CodexServerRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    const params = requireRecord(request.params, "params", request.method);
    const itemId = requireString(params, "itemId", "params", request.method);
    const item = this.translator.getItem(itemId);
    const preHookDenial = await this.raceServerOperation(
      this.nativePreToolDecision(itemId, params),
      signal,
    ).catch(() => "request cancelled");
    if (preHookDenial) return { decision: "decline" };
    const grantRoot = nullableString(params, "grantRoot", "params", request.method);
    const paths = [...new Set([...(grantRoot ? [grantRoot] : []), ...itemChangePaths(item)])];
    const approved = await this.authorizeWritePaths({
      paths,
      toolCallId: itemId,
      requestId: request.id,
      turnId: requireString(params, "turnId", "params", request.method),
      diff: item?.["changes"] ?? null,
      reason: nullableString(params, "reason", "params", request.method),
      signal,
    });
    return { decision: approved ? "accept" : "decline" };
  }

  private async handleMcpElicitation(
    request: CodexServerRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    const params = requireRecord(request.params, "params", request.method);
    const mode = requireString(params, "mode", "params", request.method);
    const meta = optionalRecord(params, "_meta", "params", request.method);
    const approvalKind = meta
      ? optionalString(meta, "codex_approval_kind", "params._meta", request.method)
      : undefined;
    const serverName = requireString(params, "serverName", "params", request.method);
    const exactToolName =
      (meta ? optionalString(meta, "tool_name", "params._meta", request.method) : undefined) ??
      (approvalKind === "mcp_tool_call" ? "mcp_tool_call" : "elicitation");
    const activeItem = this.translator.findActiveMcpItem(
      serverName,
      exactToolName === "mcp_tool_call" ? undefined : exactToolName,
    );
    if (activeItem) {
      const preHookDenial = await this.raceServerOperation(
        this.nativePreToolDecision(activeItem.id, activeItem),
        signal,
      ).catch(() => "request cancelled");
      if (preHookDenial) {
        return { action: "decline", content: null, _meta: null };
      }
    }
    const toolParams = meta && isRecord(meta["tool_params"]) ? meta["tool_params"] : {};
    const result = await this.requestPermission(
      {
        kind: "mcp",
        requestId: request.id,
        turnId: nullableString(params, "turnId", "params", request.method),
        serverName,
        toolName: exactToolName,
        toolTitle: meta
          ? optionalString(meta, "tool_title", "params._meta", request.method)
          : undefined,
        toolDescription: meta
          ? optionalString(meta, "tool_description", "params._meta", request.method)
          : undefined,
        toolArgs: toolParams,
        message: requireString(params, "message", "params", request.method),
        mode,
        url: optionalString(params, "url", "params", request.method),
        requestedSchema: params["requestedSchema"],
        meta,
      },
      signal,
    );
    const canAcceptWithoutStructuredContent = mode === "url" || approvalKind === "mcp_tool_call";
    if (permissionApproved(result) && canAcceptWithoutStructuredContent) {
      return { action: "accept", content: null, _meta: null };
    }
    return {
      action: result.kind === "reject" ? "decline" : "cancel",
      content: null,
      _meta: null,
    };
  }

  private async handlePermissionsApproval(
    request: CodexServerRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    const params = requireRecord(request.params, "params", request.method);
    const requested = requireRecord(params["permissions"], "params.permissions", request.method);
    const permissionArgs = {
      cwd: requireString(params, "cwd", "params", request.method),
      reason: nullableString(params, "reason", "params", request.method),
      environmentId: nullableString(params, "environmentId", "params", request.method),
      permissions: requested,
    };
    const result = await this.requestPermission(
      {
        kind: "custom-tool",
        toolCallId: requireString(params, "itemId", "params", request.method),
        requestId: request.id,
        turnId: requireString(params, "turnId", "params", request.method),
        toolName: permissionProfileToolName(permissionArgs),
        toolDescription: "Codex requests additional filesystem or network access for this turn.",
        toolArgs: permissionArgs,
      },
      signal,
    );
    return {
      permissions: permissionApproved(result) ? requested : {},
      scope: "turn",
    };
  }

  private async handleLegacyCommandApproval(
    request: CodexServerRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    const params = requireRecord(request.params, "params", request.method);
    const argv = requireArray(params, "command", "params", request.method).map((part) =>
      typeof part === "string" ? part : "",
    );
    const command = unwrapLoginShellArgv(argv) ?? argv.join(" ");
    const result = await this.requestPermission(
      {
        kind: "shell",
        toolCallId: requireString(params, "callId", "params", request.method),
        requestId: request.id,
        approvalId: nullableString(params, "approvalId", "params", request.method),
        command,
        fullCommandText: command,
        cwd: requireString(params, "cwd", "params", request.method),
        reason: nullableString(params, "reason", "params", request.method),
        commandActions: params["parsedCmd"],
      },
      signal,
    );
    return {
      decision: permissionApproved(result)
        ? "approved"
        : {
            denied: {
              rejection:
                result.kind === "reject"
                  ? (result.feedback ?? "Denied by user")
                  : "User unavailable",
            },
          },
    };
  }

  private async handleLegacyPatchApproval(
    request: CodexServerRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    const params = requireRecord(request.params, "params", request.method);
    const fileChanges = requireRecord(params["fileChanges"], "params.fileChanges", request.method);
    const grantRoot = nullableString(params, "grantRoot", "params", request.method);
    const approved = await this.authorizeWritePaths({
      paths: [...new Set([...(grantRoot ? [grantRoot] : []), ...Object.keys(fileChanges)])],
      toolCallId: requireString(params, "callId", "params", request.method),
      requestId: request.id,
      diff: fileChanges,
      reason: nullableString(params, "reason", "params", request.method),
      signal,
    });
    return {
      decision: approved
        ? "approved"
        : {
            denied: {
              rejection: "One or more file changes were denied",
            },
          },
    };
  }

  private async authorizeWritePaths(options: {
    paths: readonly string[];
    toolCallId: string;
    requestId: CodexRequestId;
    turnId?: string;
    diff: unknown;
    reason: string | null;
    signal: AbortSignal;
  }): Promise<boolean> {
    const paths = options.paths.length > 0 ? options.paths : ["*"];
    for (const path of paths) {
      // oxlint-disable-next-line no-await-in-loop -- each path is an independent user authorization gate
      const result = await this.requestPermission(
        {
          kind: "write",
          toolCallId: options.toolCallId,
          requestId: options.requestId,
          ...(options.turnId ? { turnId: options.turnId } : {}),
          path,
          diff: options.diff,
          reason: options.reason,
        },
        options.signal,
      );
      if (!permissionApproved(result)) return false;
    }
    return true;
  }

  private async requestPermission(
    request: RuntimePermissionRequest,
    signal?: AbortSignal,
  ): Promise<RuntimePermissionResult> {
    const handler = this.config.onPermissionRequest;
    if (!handler) return { kind: "user-not-available" };
    try {
      const permission = Promise.resolve(handler(request, { sessionId: this.sessionId }));
      return signal ? await this.raceServerOperation(permission, signal) : await permission;
    } catch (error) {
      if (asError(error, "Permission request failed").name === "AbortError") {
        return { kind: "user-not-available" };
      }
      this.handleHookError(error, "permission");
      return { kind: "user-not-available" };
    }
  }

  /** `childThreadId` marks a native sub-agent's item: only the pre-tool gate applies to it. */
  private handleNotificationHooks(notification: CodexNotification, childThreadId?: string): void {
    if (notification.method === "error") {
      const params = requireRecord(notification.params, "params", notification.method);
      const error = requireRecord(params["error"], "params.error", notification.method);
      // A terminal error is reported once, by the failed `turn/completed`.
      if (params["willRetry"] !== true) return;
      void this.callHook(
        this.config.hooks?.onErrorOccurred,
        {
          error,
          errorContext: "codex-turn",
          recoverable: true,
        },
        "error",
      );
      return;
    }
    if (notification.method !== "item/started" && notification.method !== "item/completed") {
      return;
    }
    const params = requireRecord(notification.params, "params", notification.method);
    const item = requireRecord(params["item"], "params.item", notification.method);
    const type = requireString(item, "type", "params.item", notification.method);
    if (type === "dynamicToolCall") return;
    const toolName = this.notificationToolName(item);
    if (!toolName) return;
    const toolCallId = requireString(item, "id", "params.item", notification.method);
    const common = {
      toolName,
      toolArgs: item["arguments"] ?? item,
      cwd:
        optionalString(item, "cwd", "params.item", notification.method) ??
        this.config.workingDirectory ??
        this.config.cwd,
      toolCallId,
      serverName: optionalString(item, "server", "params.item", notification.method),
    };
    if (notification.method === "item/started") {
      const decision = this.ensureNativePreToolDecision(toolCallId, common);
      const turnId = requireString(params, "turnId", "params", notification.method);
      void decision.then((denial) => {
        if (denial) {
          void this.interruptTurnAfterHookDenial(turnId, denial, childThreadId);
        }
      });
      return;
    }
    const preDecision = this.nativePreToolDecisions.get(toolCallId) ?? Promise.resolve(null);
    if (childThreadId) {
      void preDecision.finally(() => this.nativePreToolDecisions.delete(toolCallId));
      return;
    }
    const status = optionalString(item, "status", "params.item", notification.method);
    void preDecision.finally(() => {
      this.nativePreToolDecisions.delete(toolCallId);
      if (status === "failed" || status === "declined") {
        return this.callHook(
          this.config.hooks?.onPostToolUseFailure,
          { ...common, error: item["error"] ?? status },
          "post-tool-failure-observe",
        );
      }
      return this.callHook(
        this.config.hooks?.onPostToolUse,
        { ...common, toolResult: item["result"] ?? item["aggregatedOutput"] ?? item },
        "post-tool-observe",
      );
    });
  }

  private notificationToolName(item: UnknownRecord): string | null {
    const type = optionalString(item, "type", "item");
    switch (type) {
      case "commandExecution":
        return "shell";
      case "fileChange":
        return "apply_patch";
      case "mcpToolCall":
      case "collabAgentToolCall":
        return optionalString(item, "tool", "item") ?? type;
      case "webSearch":
        return "web_search";
      case "imageView":
        return "view_image";
      case "sleep":
        return "sleep";
      default:
        return null;
    }
  }

  private nativePreToolDecision(itemId: string, fallback: UnknownRecord): Promise<string | null> {
    const existing = this.nativePreToolDecisions.get(itemId);
    if (existing) return existing;
    const item = this.translator.getItem(itemId);
    const common = item
      ? this.nativeToolHookInput(item)
      : {
          toolName: "codex_tool",
          toolArgs: fallback,
          cwd:
            optionalString(fallback, "cwd", "approval params") ??
            this.config.workingDirectory ??
            this.config.cwd,
          toolCallId: itemId,
          serverName: optionalString(fallback, "serverName", "approval params"),
        };
    return this.ensureNativePreToolDecision(itemId, common);
  }

  private nativeToolHookInput(item: CodexThreadItem): {
    toolName: string;
    toolArgs: unknown;
    cwd?: string;
    toolCallId: string;
    serverName?: string;
  } {
    return {
      toolName: this.notificationToolName(item) ?? item.type,
      toolArgs: item["arguments"] ?? item,
      cwd: optionalString(item, "cwd", "item") ?? this.config.workingDirectory ?? this.config.cwd,
      toolCallId: item.id,
      serverName: optionalString(item, "server", "item"),
    };
  }

  private ensureNativePreToolDecision(
    itemId: string,
    input: {
      toolName: string;
      toolArgs: unknown;
      cwd?: string;
      toolCallId: string;
      serverName?: string;
    },
  ): Promise<string | null> {
    const existing = this.nativePreToolDecisions.get(itemId);
    if (existing) return existing;
    const decision = this.callHook(this.config.hooks?.onPreToolUse, input, "pre-tool-observe").then(
      deniedHookReason,
    );
    this.nativePreToolDecisions.set(itemId, decision);
    return decision;
  }

  private async interruptTurnAfterHookDenial(
    turnId: string,
    reason: string,
    threadId: string = this.sessionId,
  ): Promise<void> {
    if (this.hookDeniedTurns.has(turnId) || this.completedTurns.has(turnId)) return;
    this.hookDeniedTurns.add(turnId);
    log.with({ sessionId: this.sessionId }).warn("Interrupting turn after host hook denial", {
      turnId,
      reason,
      childThread: threadId !== this.sessionId,
    });
    try {
      await this.connection.request("turn/interrupt", { threadId, turnId }, decodeEmptyResponse);
    } catch (error) {
      this.handleHookError(error, "pre-tool-interrupt");
    }
  }

  private async callHook<TInput>(
    hook: ((input: TInput, invocation: { sessionId: string }) => unknown) | undefined,
    input: TInput,
    context: string,
  ): Promise<unknown> {
    if (!hook) return undefined;
    try {
      return await hook(input, { sessionId: this.sessionId });
    } catch (error) {
      this.handleHookError(error, context);
      return undefined;
    }
  }

  private handleHookError(error: unknown, context: string): void {
    const failure = asError(error, "Codex runtime hook failed");
    log.with({ sessionId: this.sessionId }).warn("Runtime callback failed", context, failure.name);
    if (context === "error") return;
    void this.callHook(
      this.config.hooks?.onErrorOccurred,
      { error: failure, errorContext: context, recoverable: true },
      "error",
    );
  }

  private async callSessionEnd(reason: string): Promise<void> {
    if (this.sessionEndCalled) return;
    this.sessionEndCalled = true;
    const hook = this.callHook(this.config.hooks?.onSessionEnd, { reason }, "session-end");
    const completed = await Promise.race([
      hook.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), SESSION_END_HOOK_TIMEOUT_MS),
      ),
    ]);
    if (!completed) {
      log.with({ sessionId: this.sessionId }).warn("Session-end hook timed out");
    }
  }

  private turnStartAbortError(): Error {
    const error = new Error("[codex-app-server] turn start was aborted");
    error.name = "AbortError";
    return error;
  }

  private raceServerOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(this.serverRequestAbortError());
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(this.serverRequestAbortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      operation.then(
        (value) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  private serverRequestAbortError(): Error {
    const error = new Error("[codex-app-server] server request was cancelled");
    error.name = "AbortError";
    return error;
  }

  private abortableTurnStartOperation<T>(
    operation: Promise<T>,
    controller: AbortController,
  ): Promise<T> {
    if (controller.signal.aborted) return Promise.reject(this.turnStartAbortError());
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(this.turnStartAbortError());
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      operation.then(
        (value) => {
          if (settled) return;
          settled = true;
          controller.signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          controller.signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  private awaitTurnStartResponse(
    operation: Promise<CodexTurnStartResponse>,
    controller: AbortController,
  ): Promise<CodexTurnStartResponse> {
    if (controller.signal.aborted) {
      void this.interruptLateTurnStart(operation);
      return Promise.reject(this.turnStartAbortError());
    }
    return new Promise<CodexTurnStartResponse>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        void this.interruptLateTurnStart(operation);
        reject(this.turnStartAbortError());
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      operation.then(
        (response) => {
          if (settled) return;
          settled = true;
          controller.signal.removeEventListener("abort", onAbort);
          resolve(response);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          controller.signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  private async interruptLateTurnStart(operation: Promise<CodexTurnStartResponse>): Promise<void> {
    try {
      const response = await operation;
      await this.connection.request(
        "turn/interrupt",
        { threadId: this.sessionId, turnId: response.turn.id },
        decodeEmptyResponse,
      );
    } catch (error) {
      if (!this.closed) this.handleHookError(error, "turn-start-abort");
    }
  }

  private emit(event: RuntimeSessionEvent): void {
    if (event.type === "assistant.message" && event.parentId) {
      this.completedMessages.set(event.parentId, event);
      this.trimCompletedState();
    }
    if (this.handlers.size === 0) {
      this.pendingEvents.push(event);
      if (this.pendingEvents.length > MAX_PENDING_EVENTS) this.pendingEvents.shift();
      return;
    }
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (error) {
        this.handleHookError(error, "event-handler");
      }
    }
  }

  private eventBase(): {
    id: string;
    timestamp: string;
    parentId: null;
  } {
    return { id: randomUUID(), timestamp: new Date().toISOString(), parentId: null };
  }

  private abortPendingOperations(turnId?: string): void {
    for (const [key, operation] of this.pendingServerOperations) {
      if (turnId && operation.turnId !== turnId) continue;
      operation.controller.abort();
      this.pendingServerOperations.delete(key);
    }
  }

  private rejectWaiters(error: Error): void {
    for (const turnWaiters of this.waiters.values()) {
      for (const waiter of turnWaiters) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.waiters.clear();
  }

  private trimCompletedState(): void {
    while (this.completedTurns.size > MAX_COMPLETED_TURNS) {
      const oldest = this.completedTurns.values().next().value;
      if (typeof oldest !== "string") break;
      this.completedTurns.delete(oldest);
      this.completedMessages.delete(oldest);
    }
    while (this.completedMessages.size > MAX_COMPLETED_TURNS) {
      const oldest = this.completedMessages.keys().next().value;
      if (typeof oldest !== "string") break;
      this.completedMessages.delete(oldest);
      this.completedTurns.delete(oldest);
    }
  }
}
