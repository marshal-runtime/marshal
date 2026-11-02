import {
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityDescriptor,
  type CapabilityProvider,
  type InvocationContext,
} from "@marshal/runtime";

import type { SessionRuntimeAgentRole } from "../../common/marshal-ipc-contract";
import { LAUNCH_OVERRIDE_INPUT_PROPERTIES, launchOverrideInput } from "./agent-launch-override";
import {
  type MarshalRuntimeAgentLaunchRequest,
  type MarshalRuntimeAgentPort,
} from "./agent-orchestration";
import { MARSHAL_RUNTIME_PERMISSION, type MarshalRuntimeScope } from "./contracts";
import { invalidRuntimeRequest } from "./runtime-provider-error";

const PROVIDER_ID = "marshal.agent-orchestration";
const CAPABILITY_PREFIX = "marshal.agent.";
const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const DELIVERY_MODES = ["queue", "interrupt"] as const;
const MAX_ALLOWED_TOOLS = 64;
const ALLOWED_TOOL_NAME_SOURCE = "^[A-Za-z][A-Za-z0-9_.-]*$";
const ALLOWED_TOOL_NAME = new RegExp(ALLOWED_TOOL_NAME_SOURCE);
export const MARSHAL_RUNTIME_AGENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "state", "createdAt", "updatedAt"],
  properties: {
    sessionId: { type: "string" },
    executionId: { type: "string" },
    transcriptRef: { type: "string" },
    usage: {
      type: "object",
      properties: {
        inputTokens: { type: "number" },
        outputTokens: { type: "number" },
        cachedInputTokens: { type: "number" },
        costUsd: { type: "number" },
      },
    },
    usageByModel: {
      type: "array",
      items: {
        type: "object",
        properties: { model: { type: "string" }, usage: { type: "object" } },
      },
    },
    callIds: { type: "array", items: { type: "string" } },
    id: { type: "string" },
    name: { type: "string" },
    state: { enum: ["running", "idle"] },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    workspaceName: { type: "string" },
    repoPath: { type: "string" },
    model: { type: "string" },
    reasoningEffort: { enum: REASONING_EFFORTS },
    soul: { type: "string" },
    runtimeAgentRole: {
      enum: ["planner", "worker", "reviewer", "validator", "reconciler", "brain", "swarm"],
    },
  },
} as const;
export const MARSHAL_RUNTIME_TRANSCRIPT_MESSAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "role", "content", "timestamp"],
  properties: {
    id: { type: "string" },
    role: { enum: ["user", "assistant", "system"] },
    content: { type: "string" },
    timestamp: { type: "string" },
    error: { type: "boolean" },
  },
} as const;

const DESCRIPTORS: readonly CapabilityDescriptor[] = [
  descriptor(
    "launch",
    "Launch an ordinary Marshal child agent",
    {
      type: "object",
      additionalProperties: false,
      required: ["task", "idempotencyKey"],
      properties: {
        task: { type: "string", minLength: 1, maxLength: 32_768 },
        idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
        sessionId: { type: "string", minLength: 1, maxLength: 256 },
        name: { type: "string", minLength: 1, maxLength: 256 },
        agentName: { type: "string", minLength: 1, maxLength: 256 },
        model: { type: "string", minLength: 1, maxLength: 256 },
        runtime: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          description:
            "Execution runtime, optionally with an account: claude, cursor, codex, or claude@work. Omit to use configured defaults.",
        },
        reasoningEffort: { enum: REASONING_EFFORTS },
        soul: { type: "string", minLength: 1, maxLength: 256 },
        workspaceName: { type: "string", minLength: 1, maxLength: 256 },
        repoPath: { type: "string", minLength: 1, maxLength: 4096 },
        runtimeAgentRole: {
          enum: ["planner", "worker", "reviewer", "validator", "reconciler", "brain", "swarm"],
        },
        allowedTools: {
          type: "array",
          maxItems: MAX_ALLOWED_TOOLS,
          uniqueItems: true,
          items: { type: "string", pattern: ALLOWED_TOOL_NAME_SOURCE, maxLength: 128 },
        },
        ...LAUNCH_OVERRIDE_INPUT_PROPERTIES,
        createWorktree: { type: "boolean" },
        worktreeName: { type: "string", minLength: 1, maxLength: 256 },
        branchName: { type: "string", minLength: 1, maxLength: 256 },
        baseRef: { type: "string", minLength: 1, maxLength: 4096 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["agent"],
      properties: { agent: MARSHAL_RUNTIME_AGENT_SCHEMA },
    },
    MARSHAL_RUNTIME_PERMISSION.agentLaunch,
    "high",
  ),
  descriptor(
    "list",
    "List ordinary child agents owned by the current Marshal session",
    emptySchema(),
    {
      type: "object",
      additionalProperties: false,
      required: ["agents"],
      properties: { agents: { type: "array", items: MARSHAL_RUNTIME_AGENT_SCHEMA } },
    },
    MARSHAL_RUNTIME_PERMISSION.agentRead,
    "low",
  ),
  descriptor(
    "get",
    "Get one ordinary child agent owned by the current Marshal session",
    agentIdSchema(),
    {
      type: "object",
      additionalProperties: false,
      required: ["agent"],
      properties: {
        agent: { anyOf: [MARSHAL_RUNTIME_AGENT_SCHEMA, { type: "null" }] },
      },
    },
    MARSHAL_RUNTIME_PERMISSION.agentRead,
    "low",
  ),
  descriptor(
    "send",
    "Send a message to an ordinary child agent owned by the current Marshal session",
    {
      type: "object",
      additionalProperties: false,
      required: ["agentId", "message"],
      properties: {
        agentId: idProperty(),
        message: { type: "string", minLength: 1 },
        deliveryMode: { enum: DELIVERY_MODES },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["agent", "accepted"],
      properties: {
        agent: MARSHAL_RUNTIME_AGENT_SCHEMA,
        accepted: { const: true },
        messageId: { type: "string" },
        deliveryState: { type: "string" },
      },
    },
    MARSHAL_RUNTIME_PERMISSION.agentMessage,
    "medium",
  ),
  descriptor(
    "transcript",
    "Read a bounded transcript and latest result from an owned ordinary child agent",
    {
      type: "object",
      additionalProperties: false,
      required: ["agentId"],
      properties: {
        agentId: idProperty(),
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["agent", "messageCount", "showing", "messages"],
      properties: {
        agent: MARSHAL_RUNTIME_AGENT_SCHEMA,
        messageCount: { type: "integer", minimum: 0 },
        showing: { type: "integer", minimum: 0 },
        messages: { type: "array", items: MARSHAL_RUNTIME_TRANSCRIPT_MESSAGE_SCHEMA },
        result: { type: "string" },
      },
    },
    MARSHAL_RUNTIME_PERMISSION.agentRead,
    "low",
  ),
  descriptor(
    "wait",
    "Wait for an owned ordinary child agent to become idle or reach a bounded timeout",
    {
      type: "object",
      additionalProperties: false,
      required: ["agentId"],
      properties: {
        agentId: idProperty(),
        messageId: { type: "string", minLength: 1, maxLength: 256 },
        timeoutMs: { type: "integer", minimum: 1, maximum: 300_000 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["state", "agent"],
      properties: {
        sessionId: { type: "string" },
        executionId: { type: "string" },
        transcriptRef: { type: "string" },
        model: { type: "string" },
        reasoningEffort: { enum: REASONING_EFFORTS },
        usageByModel: {
          type: "array",
          items: {
            type: "object",
            properties: { model: { type: "string" }, usage: { type: "object" } },
          },
        },
        callIds: { type: "array", items: { type: "string" } },
        state: { enum: ["completed", "timeout"] },
        agent: MARSHAL_RUNTIME_AGENT_SCHEMA,
        result: { type: "string" },
        usage: {
          type: "object",
          additionalProperties: false,
          properties: {
            inputTokens: { type: "integer", minimum: 0 },
            outputTokens: { type: "integer", minimum: 0 },
            cachedInputTokens: { type: "integer", minimum: 0 },
            tokens: { type: "integer", minimum: 0 },
            costUsd: { type: "number", minimum: 0 },
          },
        },
      },
    },
    MARSHAL_RUNTIME_PERMISSION.agentRead,
    "low",
  ),
  descriptor(
    "cancel",
    "Cancel the current turn of an owned ordinary child agent",
    agentIdSchema(),
    {
      type: "object",
      additionalProperties: false,
      required: ["agent"],
      properties: { agent: MARSHAL_RUNTIME_AGENT_SCHEMA },
    },
    MARSHAL_RUNTIME_PERMISSION.agentCancel,
    "medium",
  ),
  descriptor(
    "setModel",
    "Switch an idle ordinary child agent owned by the current Marshal session to another model, including one that runs on another runtime; plain model ids follow the app's model runtime routing",
    {
      type: "object",
      additionalProperties: false,
      required: ["agentId", "model"],
      properties: {
        agentId: idProperty(),
        model: { type: "string", minLength: 1, maxLength: 256 },
        reasoningEffort: { enum: REASONING_EFFORTS },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["agent"],
      properties: { agent: MARSHAL_RUNTIME_AGENT_SCHEMA },
    },
    MARSHAL_RUNTIME_PERMISSION.agentMessage,
    "medium",
  ),
];

export function createRuntimeAgentProvider(port: MarshalRuntimeAgentPort): CapabilityProvider {
  return {
    id: PROVIDER_ID,
    version: "1.0.0",
    list: () => DESCRIPTORS,
    get: (name) => DESCRIPTORS.find((candidate) => candidate.name === name),
    async invoke(name, input, context) {
      const scope = contextScope(context);
      const signal = abortSignal(context);
      const value = inputRecord(input);
      if (name === `${CAPABILITY_PREFIX}launch`) {
        const controller = context.metadata?.runtimeTaskController;
        if (
          typeof controller === "string" &&
          context.metadata?.runtimeExtensionIdentity !== controller
        ) {
          throw new Error(
            "Task-managed sessions must launch work through their owning extension task operations.",
          );
        }
        assertKeys(value, [
          "task",
          "idempotencyKey",
          "sessionId",
          "name",
          "agentName",
          "model",
          "runtime",
          "reasoningEffort",
          "soul",
          "workspaceName",
          "repoPath",
          "runtimeAgentRole",
          "allowedTools",
          "systemPrompt",
          "attachments",
          "createWorktree",
          "worktreeName",
          "branchName",
          "baseRef",
        ]);
        const nameValue = optionalText(value, "name", 256);
        const sessionIdValue = optionalText(value, "sessionId", 256);
        const agentNameValue = optionalText(value, "agentName", 256);
        const modelValue = optionalText(value, "model", 256);
        const runtimeValue = optionalText(value, "runtime", 64);
        const soulValue = optionalText(value, "soul", 256);
        const workspaceNameValue = optionalText(value, "workspaceName", 256);
        const repoPathValue = optionalText(value, "repoPath", 4096);
        const worktreeNameValue = optionalText(value, "worktreeName", 256);
        const branchNameValue = optionalText(value, "branchName", 256);
        const baseRefValue = optionalText(value, "baseRef", 4096);
        const allowedToolsValue = optionalToolNames(value, "allowedTools");
        if (allowedToolsValue && sessionIdValue) {
          throw invalidRuntimeRequest(
            new TypeError("allowedTools cannot restrict an already running session."),
          );
        }
        const request: MarshalRuntimeAgentLaunchRequest = {
          scope,
          task: text(value, "task", 32_768),
          idempotencyKey: text(value, "idempotencyKey", 256),
          ...(typeof context.metadata?.marshalLaunchDelegationId === "string"
            ? { runtimeDelegationId: context.metadata.marshalLaunchDelegationId }
            : {}),
          ...(typeof context.metadata?.marshalLaunchTaskController === "string"
            ? { runtimeTaskController: context.metadata.marshalLaunchTaskController }
            : {}),
          ...(sessionIdValue ? { sessionId: sessionIdValue } : {}),
          ...(nameValue ? { name: nameValue } : {}),
          ...(agentNameValue ? { agentName: agentNameValue } : {}),
          ...(modelValue ? { model: modelValue } : {}),
          ...(runtimeValue ? { runtime: runtimeValue } : {}),
          ...(value.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: enumValue(value, "reasoningEffort", REASONING_EFFORTS) }),
          ...(soulValue ? { soul: soulValue } : {}),
          ...(workspaceNameValue ? { workspaceName: workspaceNameValue } : {}),
          ...(repoPathValue ? { repoPath: repoPathValue } : {}),
          ...(value.runtimeAgentRole === undefined
            ? {}
            : {
                runtimeAgentRole: enumValue(value, "runtimeAgentRole", [
                  "planner",
                  "worker",
                  "reviewer",
                  "validator",
                  "reconciler",
                  "brain",
                  "swarm",
                ] as const) as SessionRuntimeAgentRole,
              }),
          ...(allowedToolsValue ? { allowedTools: allowedToolsValue } : {}),
          ...launchOverrideInput(value),
          ...(value.createWorktree === undefined
            ? {}
            : { createWorktree: booleanValue(value, "createWorktree") }),
          ...(worktreeNameValue ? { worktreeName: worktreeNameValue } : {}),
          ...(branchNameValue ? { branchName: branchNameValue } : {}),
          ...(baseRefValue ? { baseRef: baseRefValue } : {}),
          ...(signal ? { signal } : {}),
        };
        return { output: { agent: await port.launch(request) } };
      }
      if (name === `${CAPABILITY_PREFIX}list`) {
        assertKeys(value, []);
        return { output: { agents: await port.list(scope, signal) } };
      }
      if (name === `${CAPABILITY_PREFIX}get`) {
        assertKeys(value, ["agentId"]);
        return { output: { agent: await port.get(scope, text(value, "agentId", 256), signal) } };
      }
      if (name === `${CAPABILITY_PREFIX}send`) {
        assertKeys(value, ["agentId", "message", "deliveryMode"]);
        return {
          output: await port.send(
            scope,
            text(value, "agentId", 256),
            text(value, "message"),
            value.deliveryMode === undefined
              ? "queue"
              : enumValue(value, "deliveryMode", DELIVERY_MODES),
            signal,
          ),
        };
      }
      if (name === `${CAPABILITY_PREFIX}transcript`) {
        assertKeys(value, ["agentId", "limit"]);
        return {
          output: await port.transcript(
            scope,
            text(value, "agentId", 256),
            optionalInteger(value, "limit", 1, 20),
            signal,
          ),
        };
      }
      if (name === `${CAPABILITY_PREFIX}wait`) {
        assertKeys(value, ["agentId", "messageId", "timeoutMs"]);
        const messageId = optionalText(value, "messageId", 256);
        const timeoutMs = optionalInteger(value, "timeoutMs", 1, 300_000);
        return {
          output: await port.wait(scope, text(value, "agentId", 256), {
            ...(messageId ? { messageId } : {}),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            ...(signal ? { signal } : {}),
          }),
        };
      }
      if (name === `${CAPABILITY_PREFIX}cancel`) {
        assertKeys(value, ["agentId"]);
        return {
          output: {
            agent: await port.cancel(scope, text(value, "agentId", 256), signal),
          },
        };
      }
      if (name === `${CAPABILITY_PREFIX}setModel`) {
        assertKeys(value, ["agentId", "model", "reasoningEffort"]);
        return {
          output: {
            agent: await port.setModel(
              scope,
              text(value, "agentId", 256),
              text(value, "model", 256),
              value.reasoningEffort === undefined
                ? undefined
                : enumValue(value, "reasoningEffort", REASONING_EFFORTS),
              signal,
            ),
          },
        };
      }
      throw Object.assign(new Error(`Marshal agent capability not found: ${name}.`), {
        code: "not_found",
      });
    },
  };
}

function descriptor(
  suffix: string,
  title: string,
  inputSchema: CapabilityDescriptor["inputSchema"],
  outputSchema: CapabilityDescriptor["outputSchema"],
  permission: string,
  risk: "low" | "medium" | "high",
): CapabilityDescriptor {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: `${CAPABILITY_PREFIX}${suffix}`,
    version: "1.0.0",
    title,
    description: title,
    tags: ["marshal", "agent", "orchestration"],
    inputSchema,
    outputSchema,
    permissions: [{ permission, risk }],
  };
}

function emptySchema(): CapabilityDescriptor["inputSchema"] {
  return { type: "object", additionalProperties: false };
}

function idProperty() {
  return { type: "string", minLength: 1, maxLength: 256 } as const;
}

function agentIdSchema(): CapabilityDescriptor["inputSchema"] {
  return {
    type: "object",
    additionalProperties: false,
    required: ["agentId"],
    properties: { agentId: idProperty() },
  };
}

function contextScope(context: InvocationContext): MarshalRuntimeScope {
  const sessionId = context.scope?.sessionId?.trim();
  const workspaceName = context.metadata?.marshalWorkspaceName;
  if (!sessionId || typeof workspaceName !== "string" || !workspaceName.trim()) {
    throw Object.assign(
      new Error("Marshal agent invocation requires a parent session and workspace scope."),
      { code: "permission_denied" },
    );
  }
  return { sessionId, workspaceName: workspaceName.trim() };
}

function abortSignal(context: InvocationContext): AbortSignal | undefined {
  return context.signal instanceof AbortSignal ? context.signal : undefined;
}

function inputRecord(input: unknown): Record<string, unknown> {
  if (input === undefined) return {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidRuntimeRequest(new TypeError("Marshal agent capability input must be an object."));
  }
  return Object.fromEntries(Object.entries(input));
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected) {
    throw invalidRuntimeRequest(
      new TypeError(`Unexpected Marshal agent input property: ${unexpected}.`),
    );
  }
}

function text(value: Record<string, unknown>, key: string, maxLength?: number): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw invalidRuntimeRequest(new TypeError(`${key} must be a non-empty string.`));
  }
  const normalized = candidate.trim();
  if (maxLength !== undefined && normalized.length > maxLength) {
    throw invalidRuntimeRequest(new RangeError(`${key} must be at most ${maxLength} characters.`));
  }
  return normalized;
}

function optionalText(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  return value[key] === undefined ? undefined : text(value, key, maxLength);
}

function optionalToolNames(
  value: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (!Array.isArray(candidate) || candidate.length > MAX_ALLOWED_TOOLS) {
    throw invalidRuntimeRequest(
      new TypeError(`${key} must be an array of at most ${MAX_ALLOWED_TOOLS} tool names.`),
    );
  }
  const names = candidate.map((entry) => {
    if (typeof entry !== "string" || entry.length > 128 || !ALLOWED_TOOL_NAME.test(entry)) {
      throw invalidRuntimeRequest(new TypeError(`${key} entries must be valid tool names.`));
    }
    return entry;
  });
  if (new Set(names).size !== names.length) {
    throw invalidRuntimeRequest(new TypeError(`${key} entries must be unique.`));
  }
  return names;
}

function booleanValue(value: Record<string, unknown>, key: string): boolean {
  if (typeof value[key] !== "boolean") {
    throw invalidRuntimeRequest(new TypeError(`${key} must be a boolean.`));
  }
  return value[key];
}

function optionalInteger(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (!Number.isInteger(candidate) || Number(candidate) < minimum || Number(candidate) > maximum) {
    throw invalidRuntimeRequest(
      new RangeError(`${key} must be an integer between ${minimum} and ${maximum}.`),
    );
  }
  return Number(candidate);
}

function enumValue<const T extends readonly string[]>(
  value: Record<string, unknown>,
  key: string,
  allowed: T,
): T[number] {
  const candidate = value[key];
  if (typeof candidate !== "string" || !allowed.includes(candidate)) {
    throw invalidRuntimeRequest(new TypeError(`${key} must be one of: ${allowed.join(", ")}.`));
  }
  return candidate;
}
