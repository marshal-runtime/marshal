import type {
  CopilotClient,
  CopilotSession,
  MCPServerConfig,
  PermissionRequestResult,
  SessionConfig,
  SessionEvent,
  Tool,
  ToolInvocation,
} from "@github/copilot-sdk";

import { createLogger } from "../../../common/marshal-logger";
import type { RuntimeSessionEvent } from "../../../common/runtime-events";
import { stateFromEvents } from "../conversation-state";
import type {
  RuntimeClient,
  RuntimeClientSession,
  RuntimeSendOptions,
  RuntimeMcpServerConfig,
  RuntimeModelInfo,
  RuntimePermissionRequest,
  RuntimePermissionResult,
  RuntimeProcessHandle,
  RuntimeSessionConfig,
  RuntimeTool,
  RuntimeToolInvocation,
} from "../runtime-contract";

const log = createLogger("CopilotSdkAdapter");

const KNOWN_RUNTIME_EVENT_TYPES: ReadonlySet<string> = new Set([
  "assistant.message_delta",
  "assistant.message",
  "user.message",
  "assistant.reasoning_delta",
  "assistant.usage",
  "tool.execution_start",
  "tool.execution_complete",
  "tool.execution_end",
  "session.idle",
  "session.compaction_complete",
  "session.error",
  "session.usage_info",
  "session.model_change",
  "session.metadata_updated",
  "session.status",
  "session.mcp_servers_loaded",
  "session.mcp_server_status_changed",
  "mcp.oauth_required",
  "mcp.oauth_completed",
  "abort",
]);

type CopilotAssistantMessageEvent = Extract<SessionEvent, { type: "assistant.message" }>;

function findTerminalAssistantMessage(
  events: readonly SessionEvent[],
): CopilotAssistantMessageEvent | undefined {
  const currentTurnStart = events.findLastIndex((event) => event.type === "user.message");
  return events
    .slice(currentTurnStart < 0 ? 0 : currentTurnStart)
    .findLast((event): event is CopilotAssistantMessageEvent => event.type === "assistant.message");
}

function toRuntimeEvent(event: SessionEvent): RuntimeSessionEvent {
  const runtimeType: string = event.type;
  const base = {
    id: event.id,
    timestamp: event.timestamp,
    parentId: event.parentId,
  };
  if (KNOWN_RUNTIME_EVENT_TYPES.has(runtimeType)) {
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the adapter preserves the SDK event payload at the single declared SDK boundary
    return {
      ...base,
      type: runtimeType,
      data: "data" in event ? event.data : {},
    } as RuntimeSessionEvent;
  }
  return {
    ...base,
    type: "runtime.unknown",
    data: {
      runtimeType,
      payload: "data" in event ? event.data : undefined,
    },
  };
}

function toRuntimeInvocation(invocation: ToolInvocation): RuntimeToolInvocation {
  return {
    sessionId: invocation.sessionId,
    toolCallId: invocation.toolCallId,
    toolName: invocation.toolName,
    arguments: invocation.arguments,
    traceparent: invocation.traceparent,
    tracestate: invocation.tracestate,
  };
}

function toCopilotTool(tool: RuntimeTool): Tool {
  const handler = tool.handler;
  const adapted = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    overridesBuiltInTool: tool.overridesBuiltInTool,
    ...(handler
      ? {
          handler: (args: unknown, invocation: ToolInvocation) =>
            handler(args, toRuntimeInvocation(invocation)),
        }
      : {}),
  };
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- RuntimeTool is the host-owned structural projection of the SDK Tool contract
  return adapted as Tool;
}

function toCopilotMcpConfig(
  servers: Record<string, RuntimeMcpServerConfig> | undefined,
): Record<string, MCPServerConfig> | undefined {
  if (!servers) return undefined;
  return Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [
      name,
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime-neutral MCP config mirrors the SDK transport fields
      { ...config } as MCPServerConfig,
    ]),
  );
}

function toCopilotPermissionResult(result: RuntimePermissionResult): PermissionRequestResult {
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the neutral result union is the supported SDK decision subset
  return result as PermissionRequestResult;
}

function toRuntimePermissionRequest(request: unknown): RuntimePermissionRequest {
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- SDK permission requests are copied into the neutral boundary shape
  return { ...(request as Record<string, unknown>) } as RuntimePermissionRequest;
}

export function toCopilotSessionConfig(
  config: RuntimeSessionConfig,
): SessionConfig & Record<string, unknown> {
  const {
    tools,
    mcpServers,
    onPermissionRequest,
    hooks,
    systemMessage,
    projectContext,
    conversationState: _conversationState,
    ...rest
  } = config;
  const sdkConfig = {
    ...rest,
    // Copilot's replace mode drops the SDK guardrail prompt, so Marshal text always appends.
    ...(systemMessage
      ? {
          systemMessage:
            systemMessage.mode === "replace" ? { content: systemMessage.content } : systemMessage,
        }
      : {}),
    ...(projectContext === false
      ? { skipCustomInstructions: true, enableSkills: false, memory: { enabled: false } }
      : {}),
    ...(tools ? { tools: tools.map(toCopilotTool) } : {}),
    ...(mcpServers ? { mcpServers: toCopilotMcpConfig(mcpServers) } : {}),
    ...(hooks
      ? {
          // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- hook payloads are structurally projected by runtime-contract.ts
          hooks: hooks as NonNullable<SessionConfig["hooks"]>,
        }
      : {}),
    ...(onPermissionRequest
      ? {
          onPermissionRequest: async (request: unknown, invocation: { sessionId: string }) =>
            toCopilotPermissionResult(
              await onPermissionRequest(toRuntimePermissionRequest(request), invocation),
            ),
        }
      : {}),
  };
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- CLI 1.0.69 accepts `max`; SDK 1.0.6's generated ReasoningEffort union is stale
  return sdkConfig as SessionConfig & Record<string, unknown>;
}

class CopilotSdkSessionAdapter implements RuntimeClientSession {
  readonly sessionId: string;
  readonly rpc: RuntimeClientSession["rpc"];

  constructor(private readonly session: CopilotSession) {
    this.sessionId = session.sessionId;
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- RPC methods are exposed through the neutral subset consumed by the host
    this.rpc = session.rpc as unknown as RuntimeClientSession["rpc"];
  }

  on(handler: (event: RuntimeSessionEvent) => void): () => void {
    let active = true;
    const assistantMessageContents = new Map<string, Set<string>>();
    const emit = (event: SessionEvent) => {
      if (!active) return;
      if (event.type === "assistant.message") {
        const emittedContents = assistantMessageContents.get(event.id);
        if (emittedContents?.has(event.data.content)) return;
        if (emittedContents) {
          emittedContents.add(event.data.content);
        } else {
          assistantMessageContents.set(event.id, new Set([event.data.content]));
        }
      }
      handler(toRuntimeEvent(event));
    };
    const unsubscribe = this.session.on((event) => {
      if (event.type !== "session.idle") {
        emit(event);
        return;
      }

      // The SDK can publish the live final message after idle; terminal history is authoritative.
      void this.session.getEvents().then(
        (events) => {
          const finalAssistantMessage = findTerminalAssistantMessage(events);
          if (finalAssistantMessage) emit(finalAssistantMessage);
          emit(event);
        },
        (error: unknown) => {
          log.warn("Failed to reconcile terminal Copilot assistant message:", error);
          emit(event);
        },
      );
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }

  send(options: RuntimeSendOptions): Promise<string> {
    return this.session.send(options);
  }

  async sendAndWait(
    options: RuntimeSendOptions,
    timeout?: number,
  ): Promise<Extract<RuntimeSessionEvent, { type: "assistant.message" }> | undefined> {
    const result = await this.session.sendAndWait(options, timeout);
    if (!result) return undefined;
    const event = toRuntimeEvent(result);
    return event.type === "assistant.message" ? event : undefined;
  }

  destroy(): Promise<void> {
    const extended = this.session as CopilotSession & { destroy?: () => Promise<void> };
    return extended.destroy?.() ?? this.session.disconnect();
  }

  disconnect(): Promise<void> {
    return this.session.disconnect();
  }

  abort(): Promise<void> {
    return this.session.abort();
  }

  setModel(
    model: string,
    options?: { reasoningEffort?: RuntimeSessionConfig["reasoningEffort"] },
  ): Promise<void> {
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- same CLI/SDK reasoning-effort version skew handled in session config
    return this.session.setModel(model, options as Parameters<CopilotSession["setModel"]>[1]);
  }

  async getMessages(): Promise<RuntimeSessionEvent[]> {
    return (await this.session.getEvents()).map(toRuntimeEvent);
  }

  async exportConversationState(): Promise<
    import("../../../common/runtime-conversation-state").RuntimeConversationState
  > {
    return stateFromEvents("copilot", await this.getMessages());
  }
}

export class CopilotSdkClientAdapter implements RuntimeClient {
  constructor(private readonly client: CopilotClient) {}

  get process(): RuntimeProcessHandle | undefined {
    const process = Reflect.get(this.client, "cliProcess");
    if (typeof process !== "object" || process === null) return undefined;
    const pid = Reflect.get(process, "pid");
    const exitCode = Reflect.get(process, "exitCode");
    const killed = Reflect.get(process, "killed");
    const kill = Reflect.get(process, "kill");
    return {
      pid: typeof pid === "number" ? pid : undefined,
      exitCode: typeof exitCode === "number" || exitCode === null ? exitCode : null,
      killed: killed === true,
      kill: (signal?: string) =>
        typeof kill === "function" && Reflect.apply(kill, process, [signal]) === true,
    };
  }

  markForceStopping(): void {
    Reflect.set(this.client, "forceStopping", true);
  }

  stop(): Promise<Error[]> {
    return this.client.stop();
  }

  deleteSession(id: string): Promise<void> {
    return this.client.deleteSession(id);
  }

  getAuthStatus(): RuntimeClient["getAuthStatus"] extends (...args: never[]) => infer R
    ? R
    : never {
    return this.client.getAuthStatus();
  }

  async listModels(): Promise<RuntimeModelInfo[]> {
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- RuntimeModelInfo is the host-owned projection with CLI version-skew fields
    return (await this.client.listModels()) as RuntimeModelInfo[];
  }

  async createSession(config: RuntimeSessionConfig): Promise<RuntimeClientSession> {
    return new CopilotSdkSessionAdapter(
      await this.client.createSession(toCopilotSessionConfig(config)),
    );
  }

  async resumeSession(id: string, config: RuntimeSessionConfig): Promise<RuntimeClientSession> {
    return new CopilotSdkSessionAdapter(
      await this.client.resumeSession(id, toCopilotSessionConfig(config)),
    );
  }
}
