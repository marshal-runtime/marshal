import type { IBackendProvider } from "../backend/types";

const MEMORY_REASONER_SERVICE_ID = "@marshal/brain:memory-reasoner";
const MEMORY_OPERATIONS = new Set(["observe", "remember", "recall", "reflect"]);
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const MAX_SYSTEM_PROMPT_LENGTH = 100_000;
const MAX_USER_MESSAGE_LENGTH = 1_000_000;
const MAX_TOOL_COUNT = 64;
const MAX_TOOL_NAME_LENGTH = 128;
const MAX_TOOL_DESCRIPTION_LENGTH = 8_000;
const MAX_TOOL_SCHEMA_LENGTH = 64_000;
const MAX_TOOLS_PAYLOAD_LENGTH = 256_000;
const MAX_RESPONSE_LENGTH = 512_000;
const MAX_RESPONSE_CONTENT_LENGTH = 100_000;
const MAX_TOOL_CALL_COUNT = 64;
const MAX_ARGUMENT_LENGTH = 128_000;
const MAX_JSON_DEPTH = 10;
const MAX_JSON_NODES = 4_096;
const MAX_JSON_COLLECTION_LENGTH = 256;
const MAX_JSON_KEY_LENGTH = 256;
const MAX_TIMEOUT_MS = 120_000;
const MAX_REASONING_ROUNDS = 64;
const MAX_SCOPE_HANDLE_COUNT = 16;

type RuntimeServiceToken<T> = symbol & { readonly __type?: (value: T) => T };
type MemoryBrainOperation = "observe" | "remember" | "recall" | "reflect";

interface BrainToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

interface MemoryReasonerScopeHandle {
  readonly scopeId: string;
  readonly policyVersion: string;
  readonly kind: string;
}

interface MemoryReasonerIsolation {
  readonly runId: string;
  readonly principalId: string;
  readonly principalKind: string;
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
}

interface MemoryReasonerAbortSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener?(
    type: "abort",
    listener: () => void,
    options?: { readonly once?: boolean },
  ): void;
  removeEventListener?(type: "abort", listener: () => void): void;
}

interface MemoryReasonerToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

interface MemoryReasonerRequest {
  readonly operation: MemoryBrainOperation;
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly scopeHandles?: readonly MemoryReasonerScopeHandle[];
  readonly tools: readonly BrainToolDefinition[];
  readonly round: number;
  readonly timeoutMs: number;
  readonly signal?: MemoryReasonerAbortSignal;
  readonly isolation: MemoryReasonerIsolation;
  readonly executeTool?: (
    call: MemoryReasonerToolCall,
  ) => Promise<{ readonly content: string; readonly success: boolean }>;
}

interface MemoryReasonerResponse {
  readonly content: string;
  readonly toolCalls: readonly MemoryReasonerToolCall[];
}

export interface MarshalMemoryReasonerService {
  readonly descriptor: {
    readonly id: string;
    readonly provider?: string;
    readonly model?: string;
    readonly mode: "live" | "scripted" | "unavailable";
    readonly reason?: string;
  };
  reason(request: MemoryReasonerRequest): Promise<MemoryReasonerResponse>;
}

export const MARSHAL_MEMORY_REASONER_SERVICE = Symbol.for(
  MEMORY_REASONER_SERVICE_ID,
) as RuntimeServiceToken<MarshalMemoryReasonerService>;

export interface MarshalMemoryReasonerAdapterOptions {
  getBackendProvider(): Pick<IBackendProvider, "infer" | "runtimeId">;
}

function boundedString(
  value: unknown,
  label: string,
  maximumLength: number,
  allowEmpty = true,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${label} must be ${allowEmpty ? "a string" : "a non-empty string"}.`);
  }
  if (value.length > maximumLength) {
    throw new RangeError(`${label} exceeds the ${maximumLength}-character limit.`);
  }
  return value;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!isObjectRecord(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} must contain exactly: ${wanted.join(", ")}.`);
  }
}

function boundedJson(value: unknown, label: string, maximumLength: number): string {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > MAX_JSON_NODES) throw new RangeError(`${label} exceeds the JSON node limit.`);
    if (current.depth > MAX_JSON_DEPTH) {
      throw new RangeError(`${label} exceeds the JSON nesting limit.`);
    }
    if (
      current.value === null ||
      typeof current.value === "string" ||
      typeof current.value === "boolean" ||
      (typeof current.value === "number" && Number.isFinite(current.value))
    ) {
      continue;
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_JSON_COLLECTION_LENGTH) {
        throw new RangeError(`${label} contains an oversized array.`);
      }
      current.value.forEach((item) => pending.push({ value: item, depth: current.depth + 1 }));
      continue;
    }
    const object = objectValue(current.value, label);
    const entries = Object.entries(object);
    if (entries.length > MAX_JSON_COLLECTION_LENGTH) {
      throw new RangeError(`${label} contains an oversized object.`);
    }
    entries.forEach(([key, item]) => {
      boundedString(key, `${label} key`, MAX_JSON_KEY_LENGTH, false);
      pending.push({ value: item, depth: current.depth + 1 });
    });
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > maximumLength) {
    throw new RangeError(`${label} exceeds the JSON size limit.`);
  }
  return serialized;
}

function normalizeTools(tools: readonly BrainToolDefinition[]) {
  if (!Array.isArray(tools) || tools.length > MAX_TOOL_COUNT) {
    throw new RangeError(`Memory reasoner tools exceed the ${MAX_TOOL_COUNT}-tool limit.`);
  }
  const names = new Set<string>();
  const normalized = tools.map((tool, index) => {
    const object = objectValue(tool, `tools[${index}]`);
    const name = boundedString(object.name, `tools[${index}].name`, MAX_TOOL_NAME_LENGTH, false);
    if (!TOOL_NAME_PATTERN.test(name)) {
      throw new TypeError(`tools[${index}].name contains unsupported characters.`);
    }
    if (names.has(name)) throw new TypeError(`Duplicate Memory reasoner tool name: ${name}.`);
    names.add(name);
    const description = boundedString(
      object.description,
      `tools[${index}].description`,
      MAX_TOOL_DESCRIPTION_LENGTH,
    );
    const inputSchema = objectValue(object.inputSchema, `tools[${index}].inputSchema`);
    boundedJson(inputSchema, `tools[${index}].inputSchema`, MAX_TOOL_SCHEMA_LENGTH);
    return { name, description, inputSchema };
  });
  boundedJson(normalized, "Memory reasoner tool definitions", MAX_TOOLS_PAYLOAD_LENGTH);
  return { names, normalized };
}

function boundedInteger(value: number, label: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be between 1 and ${maximum}.`);
  }
  return value;
}

function optionalIdentity(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : boundedString(value, label, 256, false);
}

function normalizeIsolation(isolation: MemoryReasonerIsolation) {
  const object = objectValue(isolation, "isolation");
  const allowed = new Set([
    "runId",
    "principalId",
    "principalKind",
    "workspaceId",
    "projectId",
    "sessionId",
    "agentId",
  ]);
  const extra = Object.keys(object).find((key) => !allowed.has(key));
  if (extra) throw new TypeError(`isolation contains an unsupported field: ${extra}.`);
  const workspaceId = optionalIdentity(object.workspaceId, "isolation.workspaceId");
  const projectId = optionalIdentity(object.projectId, "isolation.projectId");
  const sessionId = optionalIdentity(object.sessionId, "isolation.sessionId");
  const agentId = optionalIdentity(object.agentId, "isolation.agentId");
  return {
    runId: boundedString(object.runId, "isolation.runId", 256, false),
    principalId: boundedString(object.principalId, "isolation.principalId", 256, false),
    principalKind: boundedString(object.principalKind, "isolation.principalKind", 128, false),
    ...(workspaceId ? { workspaceId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(agentId ? { agentId } : {}),
  };
}

function normalizeScopeHandles(scopeHandles: readonly MemoryReasonerScopeHandle[] | undefined) {
  if (scopeHandles === undefined) return undefined;
  if (!Array.isArray(scopeHandles) || scopeHandles.length > MAX_SCOPE_HANDLE_COUNT) {
    throw new RangeError(
      `Memory reasoner scopeHandles exceed the ${MAX_SCOPE_HANDLE_COUNT}-handle limit.`,
    );
  }
  return scopeHandles.map((handle, index) => {
    const object = objectValue(handle, `scopeHandles[${index}]`);
    exactKeys(object, ["scopeId", "policyVersion", "kind"], `scopeHandles[${index}]`);
    return {
      scopeId: boundedString(object.scopeId, `scopeHandles[${index}].scopeId`, 128, false),
      policyVersion: boundedString(
        object.policyVersion,
        `scopeHandles[${index}].policyVersion`,
        128,
        false,
      ),
      kind: boundedString(object.kind, `scopeHandles[${index}].kind`, 64, false),
    };
  });
}

function normalizeAbortSignal(signal: MemoryReasonerAbortSignal | undefined) {
  if (!signal) return { signal: undefined, dispose: () => undefined };
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  if (signal.aborted) abort();
  else signal.addEventListener?.("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => signal.removeEventListener?.("abort", abort),
  };
}

function inferenceMessage(
  request: MemoryReasonerRequest,
  tools: readonly BrainToolDefinition[],
): string {
  if (!MEMORY_OPERATIONS.has(request.operation)) {
    throw new TypeError(`Unsupported Memory reasoner operation: ${request.operation}.`);
  }
  const scopeHandles = normalizeScopeHandles(request.scopeHandles);
  return boundedJson(
    {
      operation: request.operation,
      round: boundedInteger(request.round, "Memory reasoner round", MAX_REASONING_ROUNDS),
      isolation: normalizeIsolation(request.isolation),
      ...(scopeHandles ? { scopeHandles } : {}),
      userMessage: boundedString(
        request.userMessage,
        "Memory reasoner userMessage",
        MAX_USER_MESSAGE_LENGTH,
      ),
      offeredTools: tools,
    },
    "Memory reasoner request",
    MAX_USER_MESSAGE_LENGTH + MAX_TOOLS_PAYLOAD_LENGTH,
  );
}

function decodeResponse(
  raw: string,
  offeredToolNames: ReadonlySet<string>,
): MemoryReasonerResponse {
  boundedString(raw, "Memory reasoner response", MAX_RESPONSE_LENGTH);
  const parsed = JSON.parse(raw) as unknown;
  const response = objectValue(parsed, "Memory reasoner response");
  exactKeys(response, ["content", "toolCalls"], "Memory reasoner response");
  if (!Array.isArray(response.toolCalls) || response.toolCalls.length > MAX_TOOL_CALL_COUNT) {
    throw new RangeError(
      `Memory reasoner response toolCalls exceeds the ${MAX_TOOL_CALL_COUNT}-call limit.`,
    );
  }
  return {
    content: boundedString(
      response.content,
      "Memory reasoner response content",
      MAX_RESPONSE_CONTENT_LENGTH,
    ),
    toolCalls: response.toolCalls.map((value, index) => {
      const call = objectValue(value, `toolCalls[${index}]`);
      exactKeys(call, ["name", "arguments"], `toolCalls[${index}]`);
      const name = boundedString(
        call.name,
        `toolCalls[${index}].name`,
        MAX_TOOL_NAME_LENGTH,
        false,
      );
      if (!offeredToolNames.has(name)) {
        throw new TypeError(`Memory reasoner returned an unknown tool: ${name}.`);
      }
      const args = objectValue(call.arguments, `toolCalls[${index}].arguments`);
      boundedJson(args, `toolCalls[${index}].arguments`, MAX_ARGUMENT_LENGTH);
      return { name, arguments: args };
    }),
  };
}

const RESPONSE_PROTOCOL = [
  "Marshal requires a strict machine-readable response for this request.",
  'Return exactly one JSON object with exactly these keys: {"content":string,"toolCalls":array}.',
  'Each toolCalls item must contain exactly {"name":string,"arguments":object}.',
  "Tool names must come from offeredTools. Do not call tools directly or add prose outside the JSON object.",
  "The portable Memory Brain, not this model, validates and executes returned tool calls.",
].join("\n");

export function createMarshalMemoryReasonerAdapter(
  options: MarshalMemoryReasonerAdapterOptions,
): MarshalMemoryReasonerService {
  return {
    get descriptor() {
      return {
        id: "marshal-backend-infer",
        provider: options.getBackendProvider().runtimeId,
        mode: "live" as const,
      };
    },
    async reason(request) {
      const backend = options.getBackendProvider();
      const { names, normalized } = normalizeTools(request.tools);
      const abort = normalizeAbortSignal(request.signal);
      try {
        abort.signal?.throwIfAborted();
        const raw = await backend.infer({
          systemPrompt: `${boundedString(
            request.systemPrompt,
            "Memory reasoner systemPrompt",
            MAX_SYSTEM_PROMPT_LENGTH,
          )}\n\n${RESPONSE_PROTOCOL}`,
          userMessage: inferenceMessage(request, normalized),
          timeoutMs: boundedInteger(request.timeoutMs, "Memory reasoner timeoutMs", MAX_TIMEOUT_MS),
          signal: abort.signal,
        });
        return decodeResponse(raw, names);
      } finally {
        abort.dispose();
      }
    },
  };
}
