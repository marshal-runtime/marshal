import { randomUUID } from "node:crypto";

import type {
  McpServerConfig,
  Query,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { createLogger } from "../../../common/marshal-logger";
import type {
  RuntimeAssistantMessageEvent,
  RuntimeSessionEvent,
} from "../../../common/runtime-events";
import type {
  RuntimeClientSession,
  RuntimeSendOptions,
  RuntimeSessionConfig,
  RuntimeSessionRpc,
} from "../runtime-contract";
import { AsyncInputQueue } from "./async-input";
import { buildClaudeUserMessage } from "./attachments";
import { type ClaudeClientConfiguration, toClaudeQueryOptions } from "./config";
import { readClaudeConversationState } from "./conversation-state";
import { ClaudeEventTranslator, isUserStoppedToolResult } from "./events";
import { CLAUDE_MCP_OAUTH_UNSUPPORTED_MESSAGE } from "./mcp-config";
import type { ClaudeSdkFacade } from "./sdk-facade";
import { ClaudeToolInvocationRegistry } from "./tool-invocations";
import { createClaudeRuntimeToolServer } from "./tools";
import { claudeRateLimitEvents } from "./usage";

const log = createLogger("ClaudeRuntimeSession");
export const CLAUDE_QUERY_CONTROL_TIMEOUT_MS = 3_000;

interface PendingTurn {
  id: string;
  resolve?: (event: RuntimeAssistantMessageEvent | undefined) => void;
  reject?: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  interrupted?: boolean;
  compaction?: { completed: boolean; error?: string };
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function optionServerName(options: unknown): string {
  if (typeof options !== "object" || options === null) return "";
  for (const key of ["serverName", "name"]) {
    const value = Reflect.get(options, key);
    if (typeof value === "string") return value;
  }
  return "";
}

function optionTaskId(options: unknown): string {
  if (typeof options !== "object" || options === null) return "";
  const value = Reflect.get(options, "taskId");
  return typeof value === "string" ? value : "";
}

function transcriptEventKey(event: RuntimeSessionEvent): string | undefined {
  switch (event.type) {
    case "assistant.message":
      return `assistant:${event.data.messageId ?? event.id}`;
    case "tool.execution_start":
      return `tool-start:${event.data.toolCallId}`;
    case "tool.execution_complete":
      return `tool-complete:${event.data.toolCallId}`;
    default:
      return undefined;
  }
}

export class ClaudeRuntimeSession implements RuntimeClientSession {
  readonly sessionId: string;
  readonly rpc: RuntimeSessionRpc;

  private readonly input = new AsyncInputQueue<SDKUserMessage>();
  private readonly translator = new ClaudeEventTranslator();
  private readonly invocations = new ClaudeToolInvocationRegistry();
  private readonly handlers = new Set<(event: RuntimeSessionEvent) => void>();
  private readonly emittedEvents: RuntimeSessionEvent[] = [];
  private readonly preSubscriptionEvents: RuntimeSessionEvent[] = [];
  private readonly pendingTurns: PendingTurn[] = [];
  private inputTail: Promise<void> = Promise.resolve();
  private readonly query: Query;
  private readonly pumpPromise: Promise<void>;
  private readonly cwd: string;
  private readonly configDir: string | undefined;
  private readonly mcpServers: Record<string, McpServerConfig>;
  private closed = false;
  private hasSubscribed = false;

  constructor(
    private readonly sdk: ClaudeSdkFacade,
    clientConfiguration: ClaudeClientConfiguration,
    private readonly config: RuntimeSessionConfig,
    sessionId: string,
    resume: boolean,
    private readonly onClosed: (sessionId: string) => void,
    private readonly forceKillOwnedProcess: (sessionId: string) => Error[],
  ) {
    this.sessionId = sessionId;
    this.cwd = config.cwd ?? config.workingDirectory ?? clientConfiguration.workspaceDir;
    this.configDir = clientConfiguration.configDir;
    const allowedToolNames =
      config.availableTools === undefined ? undefined : new Set(config.availableTools);
    const runtimeTools =
      allowedToolNames === undefined
        ? config.tools
        : config.tools?.filter((tool) => allowedToolNames.has(tool.name));
    const toolServer = createClaudeRuntimeToolServer(
      sdk,
      runtimeTools,
      sessionId,
      this.invocations,
    );
    const options = toClaudeQueryOptions({
      client: clientConfiguration,
      config,
      sessionId,
      resume,
      hostServer: toolServer.server,
      toolAliases: toolServer.aliases,
      invocations: this.invocations,
    });
    this.mcpServers = options.mcpServers ?? {};
    this.query = sdk.query({ prompt: this.input, options });
    this.rpc = this.createRpc();
    this.pumpPromise = this.pump();
  }

  get workingDirectory(): string {
    return this.cwd;
  }

  isClosed(): boolean {
    return this.closed;
  }

  on(handler: (event: RuntimeSessionEvent) => void): () => void {
    this.handlers.add(handler);
    if (!this.hasSubscribed) {
      this.hasSubscribed = true;
      for (const runtimeEvent of this.preSubscriptionEvents.splice(0)) {
        this.dispatch(handler, runtimeEvent);
      }
    }
    return () => this.handlers.delete(handler);
  }

  async initialize(): Promise<void> {
    await this.query.initializationResult();
  }

  async send(options: RuntimeSendOptions): Promise<string> {
    return (await this.enqueue(options)).id;
  }

  async sendAndWait(
    options: RuntimeSendOptions,
    timeout?: number,
  ): Promise<RuntimeAssistantMessageEvent | undefined> {
    return new Promise<RuntimeAssistantMessageEvent | undefined>((resolve, reject) => {
      void this.enqueue(options, resolve, reject).then((turn) => {
        if (timeout !== undefined && timeout > 0) {
          turn.timer = setTimeout(() => {
            turn.resolve = undefined;
            turn.reject = undefined;
            reject(new Error(`Claude turn timed out after ${timeout}ms`));
          }, timeout);
        }
      }, reject);
    });
  }

  async destroy(): Promise<void> {
    await this.close();
  }

  async disconnect(): Promise<void> {
    await this.close();
  }

  async abort(): Promise<void> {
    this.assertOpen();
    const activeTurn = this.pendingTurns.find((turn) => !turn.interrupted);
    if (activeTurn) activeTurn.interrupted = true;
    const interrupted = await settlesWithin(
      Promise.resolve().then(() => this.query.interrupt()),
      CLAUDE_QUERY_CONTROL_TIMEOUT_MS,
    );
    if (!interrupted) {
      const error = new Error(
        `Claude interrupt did not settle within ${CLAUDE_QUERY_CONTROL_TIMEOUT_MS}ms`,
      );
      this.forceClose(error, "interrupt");
      throw error;
    }
    this.invocations.clear();
    this.emit({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      parentId: null,
      type: "abort",
      data: {},
    });
    await this.config.hooks?.onSessionEnd?.({ reason: "abort" }, { sessionId: this.sessionId });
  }

  async setModel(
    model: string,
    options?: { reasoningEffort?: RuntimeSessionConfig["reasoningEffort"] },
  ): Promise<void> {
    this.assertOpen();
    await this.query.setModel(model);
    if (options?.reasoningEffort) {
      await this.query.applyFlagSettings({ effortLevel: options.reasoningEffort });
    }
    this.emit({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      parentId: null,
      type: "session.model_change",
      data: { newModel: model },
    });
  }

  async getMessages(): Promise<RuntimeSessionEvent[]> {
    const persisted = await this.sdk.getSessionMessages(this.sessionId, {
      dir: this.cwd,
      includeSystemMessages: true,
    });
    const translated = this.translator.translateHistory(persisted);
    const seenIds = new Set(translated.map((item) => item.id));
    const seenTranscriptEvents = new Set(
      translated.map(transcriptEventKey).filter((key): key is string => key !== undefined),
    );
    return [
      ...translated,
      ...this.emittedEvents.filter((item) => {
        if (seenIds.has(item.id)) return false;
        const key = transcriptEventKey(item);
        return key === undefined || !seenTranscriptEvents.has(key);
      }),
    ];
  }

  async exportConversationState(): Promise<
    import("../../../common/runtime-conversation-state").RuntimeConversationState
  > {
    return readClaudeConversationState(this.sdk, this.sessionId, this.cwd);
  }

  private enqueue(
    options: RuntimeSendOptions,
    resolve?: PendingTurn["resolve"],
    reject?: PendingTurn["reject"],
    compact = false,
  ): Promise<PendingTurn> {
    const operation = this.inputTail.then(async () => {
      this.assertOpen();
      if (
        (compact && this.pendingTurns.length > 0) ||
        this.pendingTurns.some((turn) => turn.compaction)
      ) {
        throw new Error("Wait for the current response or compaction to finish.");
      }
      const message = await buildClaudeUserMessage(options, this.cwd);
      this.assertOpen();
      const id = randomUUID();
      const turn: PendingTurn = {
        id,
        resolve,
        reject,
        ...(compact ? { compaction: { completed: false } } : {}),
      };
      this.pendingTurns.push(turn);
      this.input.push({
        type: "user",
        message,
        parent_tool_use_id: null,
        // options.origin === "system" marks a host-composed prompt (e.g. a
        // background-task completion wake, see SessionManager.
        // tryWakeSessionForBackgroundTask) — stamped as the SDK's own
        // 'task-notification' origin, not 'human', so the CLI treats it
        // correctly: excluded from edit-and-retry (refused_user_message_uuid
        // stays null), and UserPromptSubmit hooks see source: 'system'.
        // client_composed marks the text as not what a human typed (skips
        // @path/slash-command expansion, matching how it wasn't typed).
        origin: options.origin === "system" ? { kind: "task-notification" } : { kind: "human" },
        ...(options.origin === "system" ? { client_composed: true as const } : {}),
        timestamp: new Date().toISOString(),
        uuid: id,
        session_id: this.sessionId,
      });
      return turn;
    });
    this.inputTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async pump(): Promise<void> {
    try {
      for await (const message of this.query) {
        const compaction = this.pendingTurns[0]?.compaction;
        if (compaction && message.type === "system") {
          if (message.subtype === "compact_boundary") compaction.completed = true;
          if (message.subtype === "status") {
            if (message.compact_result === "success") compaction.completed = true;
            if (message.compact_result === "failed")
              compaction.error = message.compact_error ?? "Claude session compaction failed";
          }
        }
        // interrupt() acknowledges the request before its terminal result can arrive.
        // Keep that old boundary from ending a newly steered turn on the same query.
        const interruptedResult =
          message.type === "result" && this.pendingTurns[0]?.interrupted === true;
        const expectedInterrupt =
          interruptedResult &&
          message.subtype !== "success" &&
          message.errors.length > 0 &&
          message.errors.every(
            (error) =>
              error.includes("[ede_diagnostic]") &&
              error.includes("result_type=user") &&
              /stop_reason=(?:null|tool_use)(?:\s|$)/.test(error),
          );
        if (message.type === "rate_limit_event" && this.configDir) {
          claudeRateLimitEvents.record(this.configDir, message.rate_limit_info);
        }
        const translated = this.translator.translate(message);
        const events = expectedInterrupt
          ? translated.filter(
              (event) =>
                event.type !== "session.error" &&
                event.type !== "session.idle" &&
                event.type !== "assistant.message",
            )
          : translated;

        for (const runtimeEvent of events) this.emit(runtimeEvent);
        if (message.type === "result") {
          this.settleTurn(message, events, expectedInterrupt);
          if (message.subtype === "success") {
            await this.emitContextUsage(message.uuid);
          } else if (!expectedInterrupt && !isUserStoppedToolResult(message)) {
            const translatedError = events.find(
              (runtimeEvent) => runtimeEvent.type === "session.error",
            );
            await this.notifyRuntimeError(
              new Error(
                translatedError?.data.message ||
                  message.errors.join("\n") ||
                  `Claude turn ended with ${message.subtype}`,
              ),
              "claude-result",
            );
          }
        }
      }
      if (!this.closed) {
        await this.failSession(new Error("Claude query ended unexpectedly"));
      }
    } catch (error) {
      if (!this.closed) await this.failSession(errorFromUnknown(error));
    }
  }

  private settleTurn(
    message: SDKResultMessage,
    events: RuntimeSessionEvent[],
    expectedInterrupt = false,
  ): void {
    const requestedId =
      message.subtype === "success" && typeof message.user_message_uuid === "string"
        ? message.user_message_uuid
        : undefined;
    const index = requestedId ? this.pendingTurns.findIndex((turn) => turn.id === requestedId) : 0;
    const [turn] = index >= 0 ? this.pendingTurns.splice(index, 1) : [];
    if (!turn) return;
    if (turn.timer) clearTimeout(turn.timer);

    if (message.subtype !== "success" && !expectedInterrupt && !isUserStoppedToolResult(message)) {
      const translatedError = events.find((runtimeEvent) => runtimeEvent.type === "session.error");
      turn.reject?.(
        new Error(
          translatedError?.data.message ||
            message.errors.join("\n") ||
            `Claude turn ended with ${message.subtype}`,
        ),
      );
      return;
    }
    if (turn.compaction && (turn.compaction.error || !turn.compaction.completed)) {
      turn.reject?.(
        new Error(turn.compaction.error ?? "Claude did not confirm session compaction."),
      );
      return;
    }
    const assistant = events.find(
      (runtimeEvent): runtimeEvent is RuntimeAssistantMessageEvent =>
        runtimeEvent.type === "assistant.message",
    );
    turn.resolve?.(assistant);
  }

  private emit(runtimeEvent: RuntimeSessionEvent): void {
    this.emittedEvents.push(runtimeEvent);
    if (!this.hasSubscribed) {
      this.preSubscriptionEvents.push(runtimeEvent);
      return;
    }
    for (const handler of this.handlers) {
      this.dispatch(handler, runtimeEvent);
    }
  }

  private dispatch(
    handler: (event: RuntimeSessionEvent) => void,
    runtimeEvent: RuntimeSessionEvent,
  ): void {
    try {
      handler(runtimeEvent);
    } catch (error) {
      log.warn("Claude runtime event subscriber failed", {
        eventType: runtimeEvent.type,
        error: errorFromUnknown(error).message,
      });
    }
  }

  private async handleFatalError(error: Error): Promise<void> {
    this.emit({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      parentId: null,
      type: "session.error",
      data: { message: error.message, errorType: error.name },
    });
    await this.notifyRuntimeError(error, "claude-query");
    for (const turn of this.pendingTurns.splice(0)) {
      if (turn.timer) clearTimeout(turn.timer);
      turn.reject?.(error);
    }
  }

  private async failSession(error: Error): Promise<void> {
    await this.handleFatalError(error);
    this.closed = true;
    this.input.fail(error);
    this.invocations.clear();
    this.handlers.clear();
    this.onClosed(this.sessionId);
  }

  private async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.input.close();
    this.invocations.clear();
    try {
      this.query.close();
      const stopped = await settlesWithin(this.pumpPromise, CLAUDE_QUERY_CONTROL_TIMEOUT_MS);
      if (!stopped) {
        this.forceKill("close");
      }
    } finally {
      for (const turn of this.pendingTurns.splice(0)) {
        if (turn.timer) clearTimeout(turn.timer);
        turn.reject?.(new Error("Claude session closed before the turn completed"));
      }
      this.handlers.clear();
      this.preSubscriptionEvents.length = 0;
      this.onClosed(this.sessionId);
    }
  }

  private forceClose(error: Error, operation: string): void {
    if (this.closed) return;
    this.closed = true;
    this.input.fail(error);
    this.invocations.clear();
    try {
      this.query.close();
    } catch (closeError) {
      log.warn("Claude query close failed during forced cleanup", {
        operation,
        error: errorFromUnknown(closeError).message,
      });
    }
    this.forceKill(operation);
    for (const turn of this.pendingTurns.splice(0)) {
      if (turn.timer) clearTimeout(turn.timer);
      turn.reject?.(error);
    }
    this.handlers.clear();
    this.preSubscriptionEvents.length = 0;
    this.onClosed(this.sessionId);
  }

  private forceKill(operation: string): void {
    const errors = this.forceKillOwnedProcess(this.sessionId);
    log.warn("Force-killed an unresponsive Claude session process", {
      sessionId: this.sessionId,
      operation,
      errors: errors.map((error) => error.message),
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`Claude session ${this.sessionId} is closed`);
  }

  private async notifyRuntimeError(error: Error, errorContext: string): Promise<void> {
    try {
      await this.config.hooks?.onErrorOccurred?.(
        {
          error,
          errorContext,
          recoverable: false,
        },
        { sessionId: this.sessionId },
      );
    } catch (hookError) {
      log.warn("Claude runtime error hook failed", {
        error: errorFromUnknown(hookError).message,
      });
    }
  }

  private async emitContextUsage(parentId: string): Promise<void> {
    try {
      const usage = await this.query.getContextUsage();
      this.emit({
        id: `${parentId}:context-usage`,
        timestamp: new Date().toISOString(),
        parentId,
        type: "session.usage_info",
        data: {
          currentTokens: usage.totalTokens,
          tokenLimit: usage.maxTokens,
        },
      });
    } catch (error) {
      log.warn("Failed to read Claude context usage", {
        error: errorFromUnknown(error).message,
      });
    }
  }

  private createRpc(): RuntimeSessionRpc {
    return {
      history: {
        compact: () =>
          new Promise<void>((resolve, reject) => {
            void this.enqueue({ prompt: "/compact" }, () => resolve(), reject, true).catch(reject);
          }),
      },
      mcp: {
        list: () => this.query.mcpServerStatus(),
        enable: async (options) => {
          const serverName = optionServerName(options);
          if (!serverName) throw new Error("Claude MCP enable requires serverName");
          await this.query.toggleMcpServer(serverName, true);
          return { success: true };
        },
        disable: async (options) => {
          const serverName = optionServerName(options);
          if (!serverName) throw new Error("Claude MCP disable requires serverName");
          await this.query.toggleMcpServer(serverName, false);
          return { success: true };
        },
        reload: () => this.query.setMcpServers(this.mcpServers),
        oauth: {
          login: async () => {
            throw new Error(CLAUDE_MCP_OAUTH_UNSUPPORTED_MESSAGE);
          },
        },
      },
      auth: {
        getStatus: async () => {
          const account = await this.query.accountInfo();
          return { ...account };
        },
      },
      tasks: {
        stop: async (options) => {
          const taskId = optionTaskId(options);
          if (!taskId) throw new Error("Claude task stop requires taskId");
          await this.query.stopTask(taskId);
          return { success: true };
        },
      },
    };
  }
}

function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    void promise.then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
