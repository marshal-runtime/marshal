import type {
  ContextTier,
  ModelInfo,
  PermissionKind,
  ReasoningEffort,
  SessionSandboxConfig,
} from "../../common/marshal-ipc-contract";
import type { RuntimeAccountUsage } from "../../common/runtime-account-usage";
import type { RuntimeAuthLoginRequest } from "../../common/runtime-auth";
import type {
  RuntimeAssistantMessageEvent,
  RuntimeSessionEvent,
} from "../../common/runtime-events";

export type { RuntimeAuthLoginRequest } from "../../common/runtime-auth";

export interface RuntimeToolInvocation {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  signal?: AbortSignal;
  traceparent?: string;
  tracestate?: string;
}

export type RuntimeToolHandler<TArgs = unknown> = {
  bivarianceHack(args: TArgs, invocation: RuntimeToolInvocation): Promise<string>;
}["bivarianceHack"];

export interface RuntimeTool<TArgs = unknown> {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  handler: RuntimeToolHandler<TArgs>;
  overridesBuiltInTool?: boolean;
  supportsAbortSignal?: boolean;
  /**
   * Keep this tool's schema loaded from the first turn instead of deferring it
   * behind the runtime's tool discovery. Runtimes that never defer ignore it.
   */
  eagerLoad?: boolean;
  /**
   * A full-power scripting environment (e.g. full-Node TypeScript). Runtime
   * adapters may steer script-shaped shell commands toward it.
   */
  scriptingTool?: boolean;
  /**
   * Context a runtime adapter may attach before another tool call runs,
   * pointing work this tool handles better at it. A `denyReason` result blocks that one call.
   */
  toolCallHint?: RuntimeToolCallHint;
  /** Context a runtime adapter adds to every subagent the session starts (Claude Agent tool). */
  subagentStartContext?: RuntimeSubagentStartContext;
}

export type RuntimeToolCallHintResult = string | { readonly denyReason: string };

export type RuntimeToolCallHint = (call: {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly sessionId: string;
  /** Set when the call comes from a subagent of the session; absent on the main thread. */
  readonly agentId?: string;
  /** This tool's name as the runtime exposes it to the model. */
  readonly scriptingToolName: string;
}) => Promise<RuntimeToolCallHintResult | undefined>;

export type RuntimeSubagentStartContext = (call: {
  readonly sessionId: string;
  readonly scriptingToolName: string;
}) => Promise<string | undefined>;

export interface RuntimeToolResultObject {
  textResultForLlm: string;
  resultType: "success" | "failure";
  error?: string;
}

interface RuntimeMcpServerConfigBase {
  tools?: string[];
  timeout?: number;
}

export interface RuntimeMcpStdioServerConfig extends RuntimeMcpServerConfigBase {
  type?: "local" | "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  workingDirectory?: string;
}

export interface RuntimeMcpHttpServerConfig extends RuntimeMcpServerConfigBase {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export type RuntimeMcpServerConfig = RuntimeMcpStdioServerConfig | RuntimeMcpHttpServerConfig;

export type RuntimePermissionRequest = {
  kind: PermissionKind;
  toolCallId?: string;
} & Record<string, unknown>;

export type RuntimePermissionResult =
  | { kind: "approve-once" }
  | { kind: "reject"; feedback?: string }
  | { kind: "user-not-available" }
  | { kind: "no-result" };

export type RuntimePermissionHandler = (
  request: RuntimePermissionRequest,
  invocation: { sessionId: string },
) => Promise<RuntimePermissionResult> | RuntimePermissionResult;

export interface RuntimePreToolUseHookInput {
  toolName: string;
  toolArgs?: unknown;
  timestamp?: number;
  cwd?: string;
  toolCallId?: string;
  serverName?: string;
}

export interface RuntimePostToolUseHookInput extends RuntimePreToolUseHookInput {
  toolResult?: unknown;
}

export interface RuntimePostToolUseFailureHookInput extends RuntimePreToolUseHookInput {
  error?: unknown;
}

export interface RuntimeErrorOccurredHookInput {
  error: unknown;
  errorContext?: string;
  recoverable?: boolean;
}

export interface RuntimeUserPromptSubmittedHookInput {
  prompt: string;
  /**
   * Who authored/injected this prompt, when the backend reports it (only
   * Claude's SDK does, as of this writing). Generic string rather than a
   * closed union so shared code never has to special-case a backend-specific
   * value set — see CLAUDE.md backend-abstraction rule 3.
   */
  source?: string;
  /**
   * True when the backend's own runtime injected this prompt itself, as its
   * own continuation after a backgrounded task finished — independent of,
   * and potentially racing, any explicit wake the host sends for the same
   * completion (see SessionManager.tryWakeSessionForBackgroundTask). Only
   * Claude's SDK reports this (its own `<task-notification>`-framed
   * UserPromptSubmit); other backends leave it undefined/false — interface
   * symmetry per CLAUDE.md backend-abstraction rule 3.
   */
  isBackgroundTaskAutoContinuation?: boolean;
}

export interface RuntimeSessionHooks {
  onPreToolUse?: (input: RuntimePreToolUseHookInput, invocation: { sessionId: string }) => unknown;
  onPostToolUse?: (
    input: RuntimePostToolUseHookInput,
    invocation: { sessionId: string },
  ) => unknown;
  onPostToolUseFailure?: (
    input: RuntimePostToolUseFailureHookInput,
    invocation: { sessionId: string },
  ) => unknown;
  onSessionEnd?: (input: { reason?: string }, invocation: { sessionId: string }) => unknown;
  onUserPromptSubmitted?: (
    input: RuntimeUserPromptSubmittedHookInput,
    invocation: { sessionId: string },
  ) => unknown;
  onErrorOccurred?: (
    input: RuntimeErrorOccurredHookInput,
    invocation: { sessionId: string },
  ) => unknown;
}

export interface RuntimeSessionConfig {
  conversationState?: import("../../common/runtime-conversation-state").RuntimeConversationState;
  clientName?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  contextTier?: ContextTier;
  streaming?: boolean;
  workingDirectory?: string;
  cwd?: string;
  includeSubAgentStreamingEvents?: boolean;
  mcpServers?: Record<string, RuntimeMcpServerConfig>;
  hooks?: RuntimeSessionHooks;
  tools?: RuntimeTool[];
  availableTools?: string[];
  /** Built-in tools removed from the model's context while the rest stay available; adapters without such tools ignore it. */
  disabledBuiltInTools?: string[];
  /** Runtime-neutral custom agents discovered from repository conventions. */
  agents?: Record<string, RuntimeAgentDefinition>;
  systemMessage?: { content: string; mode?: "append" | "replace" };
  /** False keeps repository rules, skills, memory and agents out of the session; undefined = loaded. */
  projectContext?: boolean;
  /** Explicit sandbox override; adapters without an OS sandbox ignore it. */
  sandbox?: SessionSandboxConfig;
  /**
   * One-shot inference thread: the adapter need not persist the native session
   * and it can never be resumed. Adapters that always persist ignore it.
   */
  ephemeral?: boolean;
  onPermissionRequest?: RuntimePermissionHandler;
}

export interface RuntimeAgentDefinition {
  description: string;
  prompt: string;
  model?: string;
}

export interface RuntimeAttachment {
  type: "file" | "directory";
  path: string;
  displayName?: string;
}

export interface RuntimeSendOptions {
  prompt: string;
  attachments?: RuntimeAttachment[];
  /**
   * Best-effort provenance hint: "system" marks a prompt the host composed
   * itself rather than one a human typed (e.g. a background-task completion
   * wake). Runtimes that can express this natively (Claude: SDKUserMessage's
   * `origin`/`client_composed`) should; runtimes that cannot are free to
   * ignore it — interface symmetry per CLAUDE.md rule 3. Omitted/"human" is
   * the existing default behavior for every backend.
   */
  origin?: "human" | "system";
}

export interface RuntimeSessionRpc {
  history?: {
    compact?(): Promise<unknown>;
  };
  mcp?: {
    list?(): Promise<unknown>;
    enable?(options: unknown): Promise<unknown>;
    disable?(options: unknown): Promise<unknown>;
    reload?(): Promise<unknown>;
    oauth?: {
      login(options: {
        serverName: string;
        forceReauth?: boolean;
        clientName?: string;
        callbackSuccessMessage?: string;
      }): Promise<{ authorizationUrl?: string }>;
    };
  };
  permissions?: {
    handlePendingPermissionRequest?(
      options: unknown,
    ): Promise<{ success: boolean; error?: string }>;
    setApproveAll(options: { enabled: boolean }): Promise<{ success: boolean; error?: string }>;
    resetSessionApprovals(): Promise<{ success: boolean; error?: string }>;
  };
  auth?: {
    getStatus(): Promise<Record<string, unknown>>;
  };
  plugins?: {
    list(): Promise<unknown>;
  };
  /** Per-task control for runtimes that support backgrounded work (backgrounded
   *  Bash commands, backgrounded Agent subagents) outliving their turn. */
  tasks?: {
    stop(options: unknown): Promise<{ success: boolean; error?: string }>;
  };
}

export interface RuntimeClientSession {
  exportConversationState?(options?: {
    allowCompaction?: boolean;
  }): Promise<import("../../common/runtime-conversation-state").RuntimeConversationState>;
  readonly sessionId: string;
  readonly rpc?: RuntimeSessionRpc;
  /**
   * Set when the runtime had to start a new native session in place of the one
   * asked to resume (its context could not be carried natively). The host
   * replays the returned state with the next prompt, exactly like a
   * cross-runtime handoff. Returns it once; undefined otherwise.
   */
  takeResumeHandoff?():
    | import("../../common/runtime-conversation-state").RuntimeConversationState
    | undefined;
  /** True once the runtime has torn this session down (e.g. its query process died) and it can no longer accept sends. */
  isClosed?(): boolean;
  on(handler: (event: RuntimeSessionEvent) => void): () => void;
  send(options: RuntimeSendOptions): Promise<string>;
  sendAndWait(
    options: RuntimeSendOptions,
    timeout?: number,
  ): Promise<RuntimeAssistantMessageEvent | undefined>;
  destroy(): Promise<void>;
  disconnect(): Promise<void>;
  abort(): Promise<void>;
  setModel(model: string, options?: { reasoningEffort?: ReasoningEffort }): Promise<void>;
  getMessages(): Promise<RuntimeSessionEvent[]>;
}

export interface RuntimeModelInfo extends Omit<ModelInfo, "capabilities"> {
  capabilities?: {
    supportsVision?: boolean;
    supports?: {
      vision?: boolean;
      reasoningEffort?: boolean;
    };
    limits?: {
      max_context_window_tokens?: number;
    };
  };
  billing?: Record<string, unknown>;
}

export type RuntimeAuthLoginResult =
  | { status: "authenticated" }
  | {
      status: "pending";
      method: "browser";
      loginId: string;
      authorizationUrl?: string;
    }
  | {
      status: "pending";
      method: "device-code";
      loginId: string;
      verificationUri?: string;
      userCode?: string;
      /** Epoch milliseconds when the pending login expires. */
      expiresAt?: number;
      /** Runtime-recommended polling interval. */
      intervalSeconds?: number;
    };

export interface RuntimeClient {
  readonly process?: RuntimeProcessHandle;
  /** True once the client's transport is gone (process exited, stream failed) and it must be replaced. */
  isClosed?(): boolean;
  markForceStopping?(): void;
  stop(): Promise<Error[]>;
  deleteSession(id: string): Promise<void>;
  getAuthStatus(): Promise<{
    isAuthenticated: boolean;
    login?: string;
    statusMessage?: string;
  }>;
  login?(request: RuntimeAuthLoginRequest): Promise<RuntimeAuthLoginResult>;
  logout?(): Promise<void>;
  /**
   * Plan usage of the account this client is signed in to, read without a live session or a
   * model turn. Null when the runtime exposes no usage data; a failure is reported as an
   * unavailable result rather than thrown.
   */
  getUsage?(): Promise<RuntimeAccountUsage | null>;
  listModels(): Promise<RuntimeModelInfo[]>;
  createSession(config: RuntimeSessionConfig): Promise<RuntimeClientSession>;
  resumeSession(id: string, config: RuntimeSessionConfig): Promise<RuntimeClientSession>;
  /** Read retained native state without binding a new execution session, when supported. */
  readConversationState?(
    id: string,
    workingDirectory: string,
    options?: { allowCompaction?: boolean },
  ): Promise<import("../../common/runtime-conversation-state").RuntimeConversationState>;
}

export type RuntimeClientFactory = (workspaceDir: string) => Promise<RuntimeClient>;

export interface RuntimeProcessHandle {
  pid?: number;
  exitCode: number | null;
  killed: boolean;
  kill(signal?: string): boolean;
}
