export interface RuntimeSessionEventBase {
  id: string;
  timestamp: string;
  parentId: string | null;
}

export interface RuntimeSessionEventDataMap {
  "session.history_snapshot": { messages: import("./marshal-ipc-contract").SessionMessage[] };
  "user.message": { content: string };
  "session.context_checkpoint": {
    state: import("./runtime-conversation-state").RuntimeConversationState;
  };
  "assistant.message_delta": {
    messageId?: string;
    deltaContent: string;
  };
  "assistant.message": {
    messageId?: string;
    content: string;
    reasoningText?: string;
  };
  "assistant.reasoning_delta": {
    reasoningId?: string;
    deltaContent: string;
  };
  "assistant.usage": {
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    cost?: number;
    duration?: number;
    ttftMs?: number;
    interTokenLatencyMs?: number;
    initiator?: string;
    apiCallId?: string;
    providerCallId?: string;
  };
  "tool.execution_start": {
    toolName: string;
    toolCallId: string;
    arguments?: unknown;
    mcpServerName?: string;
    mcpToolName?: string;
    shellToolInfo?: unknown;
  };
  "tool.execution_complete": {
    toolCallId: string;
    success: boolean;
    result?: unknown;
    error?: string | { message?: string };
  };
  "tool.execution_end": {
    toolCallId?: string;
    success?: boolean;
    result?: unknown;
    error?: unknown;
  };
  "session.idle": Record<string, never>;
  "session.compaction_complete": { success?: boolean; summaryContent?: string };
  "session.error": {
    message?: string;
    errorType?: string;
    /** Epoch milliseconds when a usage limit (`errorType: "usage_limit"`) resets. */
    retryAt?: number;
  };
  "session.usage_info": {
    currentTokens: number;
    tokenLimit: number;
  };
  "session.model_change": {
    newModel?: string;
  };
  "session.metadata_updated": {
    newModel?: string;
  };
  "session.status": {
    status?: string | null;
    message?: string | null;
  };
  "session.mcp_servers_loaded": {
    servers?: Array<{
      name?: string;
      status?: string;
      error?: string;
      source?: string;
    }>;
  };
  "session.mcp_server_status_changed": {
    serverName?: string;
    status?: string;
    error?: string;
  };
  "mcp.oauth_required": {
    requestId?: string;
    serverName?: string;
    serverUrl?: string;
  };
  "mcp.oauth_completed": {
    requestId?: string;
  };
  abort: Record<string, never>;
  /**
   * A backgrounded task (a Bash command or Agent subagent run with
   * `run_in_background`) changing state. Emitted only for tasks that outlive
   * their originating turn — ordinary foreground tool calls keep using
   * `tool.execution_start` / `tool.execution_complete`.
   */
  "session.background_task": {
    taskId: string;
    toolCallId?: string;
    status: "started" | "completed" | "failed" | "stopped";
    description?: string;
    summary?: string;
    /** Path to the task's full output (Claude's `output_file`), when the
     *  runtime reports one — set only on completion/failure/stop. */
    outputFile?: string;
  };
  "runtime.unknown": {
    runtimeType: string;
    payload: unknown;
  };
}

export type RuntimeSessionEventType = keyof RuntimeSessionEventDataMap;

export type RuntimeSessionEvent = {
  [K in RuntimeSessionEventType]: RuntimeSessionEventBase & {
    type: K;
    data: RuntimeSessionEventDataMap[K];
  };
}[RuntimeSessionEventType];

export type RuntimeAssistantMessageEvent = Extract<
  RuntimeSessionEvent,
  { type: "assistant.message" }
>;
