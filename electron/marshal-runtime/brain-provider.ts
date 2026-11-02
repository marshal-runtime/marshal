import {
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityDescriptor,
  type CapabilityProvider,
  type InvocationContext,
} from "@marshal/runtime";

import type { ReasoningEffort } from "../../common/marshal-ipc-contract";
import { resolveSessionRuntimeId } from "../../common/runtime-config";
import {
  type MarshalRuntimeAgentMessageResult,
  type MarshalRuntimeAgentPort,
  type MarshalRuntimeAgentSummary,
  type MarshalRuntimeAgentTranscript,
  type MarshalRuntimeAgentWaitResult,
} from "./agent-orchestration";
import {
  MARSHAL_RUNTIME_AGENT_SCHEMA,
  MARSHAL_RUNTIME_TRANSCRIPT_MESSAGE_SCHEMA,
} from "./agent-provider";
import { MARSHAL_RUNTIME_PERMISSION, type MarshalRuntimeScope } from "./contracts";

const PROVIDER_ID = "marshal.brain";
const CAPABILITY_PREFIX = "marshal.brain.";
const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const DELIVERY_MODES = ["queue", "interrupt"] as const;
const BRAIN_LAUNCH_IDEMPOTENCY_KEY = "marshal.brain.v1";
const BRAIN_LAUNCHES = new Map<string, Promise<MarshalRuntimeBrainSummary>>();
type MarshalRuntimeBrainIdentity = {
  readonly runtimeId?: string;
  readonly backendOrigin?: "copilot" | "gateway";
};
type MarshalRuntimeBrainScope = MarshalRuntimeScope & MarshalRuntimeBrainIdentity;

export const MARSHAL_RUNTIME_BRAIN_DEFAULT_NAME = "Brain";
export const MARSHAL_RUNTIME_BRAIN_DEFAULT_TASK =
  "Serve as the dedicated Brain second agent for this Marshal session. Work as an ordinary child session: investigate, reason, and report through normal session messages.";

export type MarshalRuntimeBrainSummary = MarshalRuntimeAgentSummary & {
  readonly runtimeAgentRole: "brain";
};

export type MarshalRuntimeBrainMessageResult = Omit<MarshalRuntimeAgentMessageResult, "agent"> & {
  readonly agent: MarshalRuntimeBrainSummary;
};

export type MarshalRuntimeBrainTranscript = Omit<MarshalRuntimeAgentTranscript, "agent"> & {
  readonly agent: MarshalRuntimeBrainSummary;
};

export type MarshalRuntimeBrainWaitResult = Omit<MarshalRuntimeAgentWaitResult, "agent"> & {
  readonly agent: MarshalRuntimeBrainSummary;
};

export interface MarshalRuntimeBrainLaunchRequest {
  readonly scope: MarshalRuntimeScope;
  readonly task?: string;
  readonly name?: string;
  readonly agentName?: string;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly soul?: string;
  readonly signal?: AbortSignal;
}

export interface MarshalRuntimeBrainPort {
  launch(request: MarshalRuntimeBrainLaunchRequest): Promise<MarshalRuntimeBrainSummary>;
  get(scope: MarshalRuntimeScope, signal?: AbortSignal): Promise<MarshalRuntimeBrainSummary | null>;
  send(
    scope: MarshalRuntimeScope,
    message: string,
    deliveryMode: "queue" | "interrupt",
    signal?: AbortSignal,
  ): Promise<MarshalRuntimeBrainMessageResult>;
  transcript(
    scope: MarshalRuntimeScope,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<MarshalRuntimeBrainTranscript>;
  wait(
    scope: MarshalRuntimeScope,
    options?: {
      readonly messageId?: string;
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<MarshalRuntimeBrainWaitResult>;
  cancel(scope: MarshalRuntimeScope, signal?: AbortSignal): Promise<MarshalRuntimeBrainSummary>;
}

export class MarshalRuntimeBrainAdapter implements MarshalRuntimeBrainPort {
  constructor(private readonly agents: MarshalRuntimeAgentPort) {}

  async launch(request: MarshalRuntimeBrainLaunchRequest): Promise<MarshalRuntimeBrainSummary> {
    throwIfAborted(request.signal);
    const scope = brainScope(request.scope);
    const key = scopeKey(scope);
    let launch = BRAIN_LAUNCHES.get(key);
    if (!launch) {
      launch = this.launchOrRecover({ ...request, scope });
      BRAIN_LAUNCHES.set(key, launch);
      void launch.then(
        () => {
          if (BRAIN_LAUNCHES.get(key) === launch) BRAIN_LAUNCHES.delete(key);
        },
        () => {
          if (BRAIN_LAUNCHES.get(key) === launch) BRAIN_LAUNCHES.delete(key);
        },
      );
    }
    return awaitAbortable(launch, request.signal);
  }

  get(
    scope: MarshalRuntimeScope,
    signal?: AbortSignal,
  ): Promise<MarshalRuntimeBrainSummary | null> {
    return this.findBrain(scope, signal);
  }

  async send(
    scope: MarshalRuntimeScope,
    message: string,
    deliveryMode: "queue" | "interrupt",
    signal?: AbortSignal,
  ): Promise<MarshalRuntimeBrainMessageResult> {
    const brainScopeValue = brainScope(scope);
    const brain = await this.requireBrain(brainScopeValue, signal);
    const result = await this.agents.send(brainScopeValue, brain.id, message, deliveryMode, signal);
    return { ...result, agent: requireBrainSummary(result.agent) };
  }

  async transcript(
    scope: MarshalRuntimeScope,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<MarshalRuntimeBrainTranscript> {
    const brainScopeValue = brainScope(scope);
    const brain = await this.requireBrain(brainScopeValue, signal);
    const transcript = await this.agents.transcript(brainScopeValue, brain.id, limit, signal);
    return { ...transcript, agent: requireBrainSummary(transcript.agent) };
  }

  async wait(
    scope: MarshalRuntimeScope,
    options: {
      readonly messageId?: string;
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<MarshalRuntimeBrainWaitResult> {
    const brainScopeValue = brainScope(scope);
    const brain = await this.requireBrain(brainScopeValue, options.signal);
    const result = await this.agents.wait(brainScopeValue, brain.id, options);
    return { ...result, agent: requireBrainSummary(result.agent) };
  }

  async cancel(
    scope: MarshalRuntimeScope,
    signal?: AbortSignal,
  ): Promise<MarshalRuntimeBrainSummary> {
    const brainScopeValue = brainScope(scope);
    const brain = await this.requireBrain(brainScopeValue, signal);
    return requireBrainSummary(await this.agents.cancel(brainScopeValue, brain.id, signal));
  }

  private async launchOrRecover(
    request: MarshalRuntimeBrainLaunchRequest,
  ): Promise<MarshalRuntimeBrainSummary> {
    const scope = brainScope(request.scope);
    const existing = await this.findBrain(scope);
    if (existing) return existing;
    const launched = requireBrainSummary(
      await this.agents.launch({
        scope,
        task: request.task?.trim() || MARSHAL_RUNTIME_BRAIN_DEFAULT_TASK,
        idempotencyKey: BRAIN_LAUNCH_IDEMPOTENCY_KEY,
        name: request.name?.trim() || MARSHAL_RUNTIME_BRAIN_DEFAULT_NAME,
        agentName: request.agentName,
        model: request.model,
        reasoningEffort: request.reasoningEffort,
        soul: request.soul,
        runtimeAgentRole: "brain",
      }),
    );
    const discovered = await this.findBrain(scope);
    if (!discovered || discovered.id !== launched.id) {
      throw runtimeError(
        "operation_failed",
        "Marshal launched Brain but could not recover the same durable role-tagged session.",
      );
    }
    return discovered;
  }

  private async findBrain(
    scope: MarshalRuntimeScope,
    signal?: AbortSignal,
  ): Promise<MarshalRuntimeBrainSummary | null> {
    const brainScopeValue = brainScope(scope);
    const brains = (await this.agents.list(brainScopeValue, signal)).filter(isBrainSummary);
    if (brains.length > 1) {
      throw runtimeError(
        "operation_failed",
        "Multiple Brain sessions exist for this parent session and workspace.",
      );
    }
    return brains[0] ?? null;
  }

  private async requireBrain(
    scope: MarshalRuntimeScope,
    signal?: AbortSignal,
  ): Promise<MarshalRuntimeBrainSummary> {
    const brain = await this.findBrain(brainScope(scope), signal);
    if (!brain) {
      throw runtimeError("not_found", "Brain has not been launched for this session.");
    }
    return brain;
  }
}

const BRAIN_AGENT_SCHEMA = {
  ...MARSHAL_RUNTIME_AGENT_SCHEMA,
  required: [...MARSHAL_RUNTIME_AGENT_SCHEMA.required, "runtimeAgentRole"],
  properties: {
    ...MARSHAL_RUNTIME_AGENT_SCHEMA.properties,
    runtimeAgentRole: { const: "brain" },
  },
} as const;

const DESCRIPTORS: readonly CapabilityDescriptor[] = [
  descriptor(
    "launch",
    "Launch or recover the Brain child agent for the current Marshal session",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        task: { type: "string", minLength: 1, maxLength: 32_768 },
        name: { type: "string", minLength: 1, maxLength: 256 },
        agentName: { type: "string", minLength: 1, maxLength: 256 },
        model: { type: "string", minLength: 1, maxLength: 256 },
        reasoningEffort: { enum: REASONING_EFFORTS },
        soul: { type: "string", minLength: 1, maxLength: 256 },
      },
    },
    agentOutputSchema(true),
    MARSHAL_RUNTIME_PERMISSION.brainLaunch,
    "high",
  ),
  descriptor(
    "get",
    "Get the Brain child agent for the current Marshal session",
    emptySchema(),
    agentOutputSchema(false),
    MARSHAL_RUNTIME_PERMISSION.brainRead,
    "low",
  ),
  descriptor(
    "send",
    "Send a message to the Brain child agent",
    {
      type: "object",
      additionalProperties: false,
      required: ["message"],
      properties: {
        message: { type: "string", minLength: 1, maxLength: 32_768 },
        deliveryMode: { enum: DELIVERY_MODES },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["agent", "accepted"],
      properties: {
        agent: BRAIN_AGENT_SCHEMA,
        accepted: { const: true },
        messageId: { type: "string" },
        deliveryState: { type: "string" },
      },
    },
    MARSHAL_RUNTIME_PERMISSION.brainMessage,
    "medium",
  ),
  descriptor(
    "transcript",
    "Read a bounded transcript and latest result from the Brain child agent",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["agent", "messageCount", "showing", "messages"],
      properties: {
        agent: BRAIN_AGENT_SCHEMA,
        messageCount: { type: "integer", minimum: 0 },
        showing: { type: "integer", minimum: 0 },
        messages: { type: "array", items: MARSHAL_RUNTIME_TRANSCRIPT_MESSAGE_SCHEMA },
        result: { type: "string" },
      },
    },
    MARSHAL_RUNTIME_PERMISSION.brainRead,
    "low",
  ),
  descriptor(
    "wait",
    "Wait for the Brain child agent to become idle or reach a bounded timeout",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        messageId: { type: "string", minLength: 1, maxLength: 256 },
        timeoutMs: { type: "integer", minimum: 1, maximum: 300_000 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["state", "agent"],
      properties: {
        state: { enum: ["completed", "timeout"] },
        agent: BRAIN_AGENT_SCHEMA,
        result: { type: "string" },
      },
    },
    MARSHAL_RUNTIME_PERMISSION.brainRead,
    "low",
  ),
  descriptor(
    "cancel",
    "Cancel the current turn of the Brain child agent",
    emptySchema(),
    agentOutputSchema(true),
    MARSHAL_RUNTIME_PERMISSION.brainCancel,
    "medium",
  ),
];

export function createRuntimeBrainProvider(port: MarshalRuntimeBrainPort): CapabilityProvider {
  return {
    id: PROVIDER_ID,
    version: "1.0.0",
    list: () => DESCRIPTORS,
    get: (name) => DESCRIPTORS.find((candidate) => candidate.name === name),
    async invoke(name, input, context) {
      const runtimeIdentity = invocationRuntimeIdentity(context);
      const scope = brainScope(contextScope(context), runtimeIdentity);
      const signal = abortSignal(context);
      const value = inputRecord(input);
      if (name === `${CAPABILITY_PREFIX}launch`) {
        assertKeys(value, ["task", "name", "agentName", "model", "reasoningEffort", "soul"]);
        return {
          output: {
            agent: await port.launch({
              scope,
              ...optionalTextProperty(value, "task", 32_768),
              ...optionalTextProperty(value, "name", 256),
              ...optionalTextProperty(value, "agentName", 256),
              ...optionalTextProperty(value, "model", 256),
              ...(value.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: enumValue(value, "reasoningEffort", REASONING_EFFORTS) }),
              ...optionalTextProperty(value, "soul", 256),
              ...(signal ? { signal } : {}),
            }),
          },
        };
      }
      if (name === `${CAPABILITY_PREFIX}get`) {
        assertKeys(value, []);
        return { output: { agent: await port.get(scope, signal) } };
      }
      if (name === `${CAPABILITY_PREFIX}send`) {
        assertKeys(value, ["message", "deliveryMode"]);
        return {
          output: await port.send(
            scope,
            text(value, "message", 32_768),
            value.deliveryMode === undefined
              ? "queue"
              : enumValue(value, "deliveryMode", DELIVERY_MODES),
            signal,
          ),
        };
      }
      if (name === `${CAPABILITY_PREFIX}transcript`) {
        assertKeys(value, ["limit"]);
        return {
          output: await port.transcript(scope, optionalInteger(value, "limit", 1, 20), signal),
        };
      }
      if (name === `${CAPABILITY_PREFIX}wait`) {
        assertKeys(value, ["messageId", "timeoutMs"]);
        const messageId = optionalText(value, "messageId", 256);
        const timeoutMs = optionalInteger(value, "timeoutMs", 1, 300_000);
        return {
          output: await port.wait(scope, {
            ...(messageId ? { messageId } : {}),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            ...(signal ? { signal } : {}),
          }),
        };
      }
      if (name === `${CAPABILITY_PREFIX}cancel`) {
        assertKeys(value, []);
        return { output: { agent: await port.cancel(scope, signal) } };
      }
      throw Object.assign(new Error(`Marshal Brain capability not found: ${name}.`), {
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
    tags: ["marshal", "brain", "agent"],
    inputSchema,
    outputSchema,
    permissions: [{ permission, risk }],
  };
}

function agentOutputSchema(required: boolean): CapabilityDescriptor["outputSchema"] {
  return {
    type: "object",
    additionalProperties: false,
    required: ["agent"],
    properties: {
      agent: required ? BRAIN_AGENT_SCHEMA : { anyOf: [BRAIN_AGENT_SCHEMA, { type: "null" }] },
    },
  };
}

function emptySchema(): CapabilityDescriptor["inputSchema"] {
  return { type: "object", additionalProperties: false };
}

function contextScope(context: InvocationContext): MarshalRuntimeScope {
  const sessionId = context.scope?.sessionId?.trim();
  const workspaceName = context.metadata?.marshalWorkspaceName;
  if (!sessionId || typeof workspaceName !== "string" || !workspaceName.trim()) {
    throw runtimeError(
      "permission_denied",
      "Marshal Brain invocation requires a parent session and workspace scope.",
    );
  }
  return { sessionId, workspaceName: workspaceName.trim() };
}

function invocationRuntimeIdentity(context: InvocationContext): MarshalRuntimeBrainIdentity {
  const runtimeIdentity = context as InvocationContext &
    MarshalRuntimeBrainIdentity & {
      readonly scope?: MarshalRuntimeBrainIdentity;
      readonly metadata?: MarshalRuntimeBrainIdentity;
    };
  const backendOrigin =
    runtimeIdentity.backendOrigin ??
    runtimeIdentity.scope?.backendOrigin ??
    runtimeIdentity.metadata?.backendOrigin;
  return {
    runtimeId: resolveSessionRuntimeId({
      runtimeId:
        runtimeIdentity.runtimeId ??
        runtimeIdentity.scope?.runtimeId ??
        runtimeIdentity.metadata?.runtimeId,
      backendOrigin,
    }),
    ...(backendOrigin ? { backendOrigin } : {}),
  };
}

function abortSignal(context: InvocationContext): AbortSignal | undefined {
  return context.signal instanceof AbortSignal ? context.signal : undefined;
}

function inputRecord(input: unknown): Record<string, unknown> {
  if (input === undefined) return {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Marshal Brain capability input must be an object.");
  }
  return Object.fromEntries(Object.entries(input));
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected) throw new TypeError(`Unexpected Marshal Brain input property: ${unexpected}.`);
}

function text(value: Record<string, unknown>, key: string, maxLength: number): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new TypeError(`${key} must be a non-empty string.`);
  }
  const normalized = candidate.trim();
  if (normalized.length > maxLength) {
    throw new RangeError(`${key} must be at most ${maxLength} characters.`);
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

function optionalTextProperty(
  value: Record<string, unknown>,
  key: "task" | "name" | "agentName" | "model" | "soul",
  maxLength: number,
): Partial<Record<typeof key, string>> {
  const candidate = optionalText(value, key, maxLength);
  return candidate ? { [key]: candidate } : {};
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
    throw new RangeError(`${key} must be an integer between ${minimum} and ${maximum}.`);
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
    throw new TypeError(`${key} must be one of: ${allowed.join(", ")}.`);
  }
  return candidate;
}

function scopeKey(scope: MarshalRuntimeScope): string {
  return `${resolveSessionRuntimeId(runtimeBrainIdentity(scope))}\0${scope.sessionId.trim()}\0${scope.workspaceName.trim().toLowerCase()}`;
}

function brainScope(
  scope: MarshalRuntimeScope,
  identity: MarshalRuntimeBrainIdentity = runtimeBrainIdentity(scope),
): MarshalRuntimeBrainScope {
  const canonicalRuntimeId =
    identity.runtimeId?.trim() ||
    resolveSessionRuntimeId({
      runtimeId: Reflect.get(scope, "runtimeId"),
      backendOrigin: identity.backendOrigin ?? Reflect.get(scope, "backendOrigin"),
    });
  const backendOrigin = identity.backendOrigin ?? Reflect.get(scope, "backendOrigin");
  const brainScopeValue = {
    sessionId: scope.sessionId,
    workspaceName: scope.workspaceName,
  } satisfies MarshalRuntimeScope;
  Object.defineProperty(brainScopeValue, "runtimeId", {
    value: canonicalRuntimeId,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  if (backendOrigin === "copilot" || backendOrigin === "gateway") {
    Object.defineProperty(brainScopeValue, "backendOrigin", {
      value: backendOrigin,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  }
  return brainScopeValue as MarshalRuntimeBrainScope;
}

function runtimeBrainIdentity(scope: MarshalRuntimeScope): MarshalRuntimeBrainIdentity {
  const runtimeId: unknown = Reflect.get(scope, "runtimeId");
  const backendOrigin: unknown = Reflect.get(scope, "backendOrigin");
  return {
    ...(typeof runtimeId === "string" ? { runtimeId } : {}),
    ...(backendOrigin === "copilot" || backendOrigin === "gateway" ? { backendOrigin } : {}),
  };
}

function isBrainSummary(agent: MarshalRuntimeAgentSummary): agent is MarshalRuntimeBrainSummary {
  return agent.runtimeAgentRole === "brain";
}

function requireBrainSummary(agent: MarshalRuntimeAgentSummary): MarshalRuntimeBrainSummary {
  if (!isBrainSummary(agent)) {
    throw runtimeError(
      "operation_failed",
      "Marshal launched or returned an untagged Brain session.",
    );
  }
  return agent;
}

function runtimeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw runtimeError("aborted", "Marshal Brain operation was aborted.");
  }
}

async function awaitAbortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(runtimeError("aborted", "Marshal Brain operation was aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
