import {
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityDescriptor,
  type CapabilityProvider,
  type InvocationContext,
} from "@marshal/runtime";

import type { MemoryCategory, MemoryEntry } from "../../common/marshal-ipc-contract";
import type { IMemoryManager } from "../backend/ports";
import { MARSHAL_RUNTIME_PERMISSION, type MarshalRuntimeScope } from "./contracts";
import { wrapUntrustedMemoryFact } from "./memory/prompt-provenance";
import { invalidRuntimeRequest } from "./runtime-provider-error";

const PROVIDER_ID = "marshal.memory";
const SOURCE_PREFIX = "marshal-runtime:v1";
const MEMORY_CATEGORIES = ["preference", "fact", "decision", "context"] as const;
const MAX_SCOPE_FIELD_LENGTH = 256;
const MAX_MEMORY_FACT_LENGTH = 500;
const MAX_MEMORY_QUERY_LENGTH = 500;
const MAX_MEMORY_RESULTS = 20;
const MAX_MEMORY_SCAN_RESULTS = 100;
const MAX_MEMORY_ID_LENGTH = 256;
const MAX_WRAPPED_MEMORY_FACT_LENGTH = 1024;
const MAX_MEMORY_SOURCE_LENGTH = 4096;
const MAX_TIMESTAMP_LENGTH = 64;

export const MARSHAL_RUNTIME_MEMORY_VISIBILITY = "exact-runtime-scope" as const;

export interface MarshalRuntimeMemoryValue {
  readonly id: string;
  readonly fact: string;
  readonly category: MemoryCategory;
  readonly source: string;
  readonly createdAt: string;
  readonly lastAccessedAt: string;
  readonly accessCount: number;
}

export interface MarshalRuntimeMemoryStoreResult {
  readonly memory: MarshalRuntimeMemoryValue;
  readonly deduplicated: boolean;
  readonly visibility: typeof MARSHAL_RUNTIME_MEMORY_VISIBILITY;
}

export interface MarshalRuntimeMemoryRecallResult {
  readonly memories: readonly MarshalRuntimeMemoryValue[];
  readonly visibility: typeof MARSHAL_RUNTIME_MEMORY_VISIBILITY;
}

export interface MarshalRuntimeMemoryPort {
  store(
    scope: MarshalRuntimeScope,
    fact: string,
    category: MemoryCategory,
    signal?: AbortSignal,
  ): Promise<MarshalRuntimeMemoryStoreResult>;
  recall(
    scope: MarshalRuntimeScope,
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<MarshalRuntimeMemoryRecallResult>;
}

export interface MarshalRuntimeMemoryAdapterOptions {
  readonly resolveScope?: (
    scope: MarshalRuntimeScope,
    signal?: AbortSignal,
  ) => Promise<MarshalRuntimeScope | null>;
  readonly onStored?: () => void;
}

function runtimeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw runtimeError("aborted", "Marshal Runtime memory operation was aborted.");
  }
}

function boundedText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) {
    throw invalidRuntimeRequest(new TypeError(`${label} must be a non-empty string.`));
  }
  if (normalized.length > maxLength) {
    throw invalidRuntimeRequest(
      new RangeError(`${label} must be at most ${maxLength} characters.`),
    );
  }
  return normalized;
}

function sourceForScope(scope: MarshalRuntimeScope): string {
  const workspaceName = boundedText(scope.workspaceName, "Workspace name", MAX_SCOPE_FIELD_LENGTH);
  const sessionId = boundedText(scope.sessionId, "Session ID", MAX_SCOPE_FIELD_LENGTH);
  return `${SOURCE_PREFIX}:workspace=${encodeURIComponent(workspaceName)};session=${encodeURIComponent(sessionId)}`;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function toRuntimeMemory(entry: MemoryEntry): MarshalRuntimeMemoryValue {
  const fact = truncate(entry.fact.trim(), MAX_MEMORY_FACT_LENGTH);
  const accessCount =
    Number.isSafeInteger(entry.accessCount) && entry.accessCount >= 0
      ? entry.accessCount
      : Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(entry.accessCount) || 0));
  return {
    id: truncate(entry.id, MAX_MEMORY_ID_LENGTH),
    fact: wrapUntrustedMemoryFact(fact),
    category: MEMORY_CATEGORIES.includes(entry.category) ? entry.category : "fact",
    source: truncate(entry.source, MAX_MEMORY_SOURCE_LENGTH),
    createdAt: truncate(entry.createdAt, MAX_TIMESTAMP_LENGTH),
    lastAccessedAt: truncate(entry.lastAccessedAt, MAX_TIMESTAMP_LENGTH),
    accessCount,
  };
}

async function waitWithCancellation<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(runtimeError("aborted", "Marshal Runtime memory recall was aborted."));
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

export class MarshalRuntimeMemoryAdapter implements MarshalRuntimeMemoryPort {
  constructor(
    private readonly memoryManager: IMemoryManager,
    private readonly options: MarshalRuntimeMemoryAdapterOptions = {},
  ) {}

  async store(
    scope: MarshalRuntimeScope,
    fact: string,
    memoryCategory: MemoryCategory,
    signal?: AbortSignal,
  ): Promise<MarshalRuntimeMemoryStoreResult> {
    throwIfAborted(signal);
    const normalizedFact = boundedText(fact, "Memory fact", MAX_MEMORY_FACT_LENGTH);
    if (!MEMORY_CATEGORIES.includes(memoryCategory)) {
      throw invalidRuntimeRequest(new TypeError("Memory category is invalid."));
    }
    const authoritativeScope = await this.resolveScope(scope, signal);
    const source = sourceForScope(authoritativeScope);
    const existing = this.memoryManager
      .list()
      .find((entry) => entry.fact.trim().toLowerCase() === normalizedFact.toLowerCase());
    if (existing && existing.source !== source) {
      throw runtimeError(
        "operation_failed",
        "Memory cannot be stored with authoritative Marshal Runtime scope attribution because the backend already has the same fact from another source.",
      );
    }

    const entry = await this.memoryManager.add(normalizedFact, memoryCategory, source);
    if (!entry) {
      throw runtimeError("operation_failed", "Marshal memory rejected the memory fact.");
    }
    if (entry.source !== source) {
      throw runtimeError(
        "operation_failed",
        "Memory was not stored with authoritative Marshal Runtime scope attribution.",
      );
    }

    this.options.onStored?.();
    return {
      memory: toRuntimeMemory(entry),
      deduplicated: existing !== undefined,
      visibility: MARSHAL_RUNTIME_MEMORY_VISIBILITY,
    };
  }

  async recall(
    scope: MarshalRuntimeScope,
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<MarshalRuntimeMemoryRecallResult> {
    throwIfAborted(signal);
    const normalizedQuery = boundedText(query, "Memory query", MAX_MEMORY_QUERY_LENGTH);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MEMORY_RESULTS) {
      throw invalidRuntimeRequest(
        new RangeError(`Memory recall limit must be between 1 and ${MAX_MEMORY_RESULTS}.`),
      );
    }
    const authoritativeScope = await this.resolveScope(scope, signal);
    const source = sourceForScope(authoritativeScope);
    const memories = await waitWithCancellation(
      this.memoryManager.recall(normalizedQuery, MAX_MEMORY_SCAN_RESULTS, source),
      signal,
    );
    return {
      memories: memories
        .filter((entry) => entry.source === source)
        .slice(0, limit)
        .map(toRuntimeMemory),
      visibility: MARSHAL_RUNTIME_MEMORY_VISIBILITY,
    };
  }

  private async resolveScope(
    scope: MarshalRuntimeScope,
    signal?: AbortSignal,
  ): Promise<MarshalRuntimeScope> {
    const resolved = this.options.resolveScope
      ? await this.options.resolveScope(scope, signal)
      : scope;
    throwIfAborted(signal);
    if (!resolved) {
      throw runtimeError(
        "permission_denied",
        "Marshal Runtime memory session or workspace scope was denied.",
      );
    }
    return resolved;
  }
}

const MEMORY_VALUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "fact", "category", "source", "createdAt", "lastAccessedAt", "accessCount"],
  properties: {
    id: { type: "string", maxLength: MAX_MEMORY_ID_LENGTH },
    fact: { type: "string", maxLength: MAX_WRAPPED_MEMORY_FACT_LENGTH },
    category: { enum: MEMORY_CATEGORIES },
    source: { type: "string", maxLength: MAX_MEMORY_SOURCE_LENGTH },
    createdAt: { type: "string", maxLength: MAX_TIMESTAMP_LENGTH },
    lastAccessedAt: { type: "string", maxLength: MAX_TIMESTAMP_LENGTH },
    accessCount: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  },
} as const;

const DESCRIPTORS: readonly CapabilityDescriptor[] = [
  {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: "marshal.memory.store",
    version: "1.0.0",
    title: "Store scoped Marshal memory",
    description:
      "Stores one memory in Marshal's configured memory provider with authoritative attribution to the exact invoking workspace and session.",
    // Agents use the remember/recall host tools; these stay invokable by exact name.
    tags: ["marshal", "memory", "store", "internal"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["fact"],
      properties: {
        fact: {
          type: "string",
          minLength: 1,
          maxLength: MAX_MEMORY_FACT_LENGTH,
        },
        category: { enum: MEMORY_CATEGORIES },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["memory", "deduplicated", "visibility"],
      properties: {
        memory: MEMORY_VALUE_SCHEMA,
        deduplicated: { type: "boolean" },
        visibility: { const: MARSHAL_RUNTIME_MEMORY_VISIBILITY },
      },
    },
    permissions: [{ permission: MARSHAL_RUNTIME_PERMISSION.memoryStore, risk: "medium" }],
  },
  {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: "marshal.memory.recall",
    version: "1.0.0",
    title: "Recall scoped Marshal memory",
    description:
      "Searches Marshal's configured memory provider and returns only memories attributed to the exact invoking workspace and session. Global and other-scope memories are excluded.",
    tags: ["marshal", "memory", "recall", "search", "internal"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: MAX_MEMORY_QUERY_LENGTH,
        },
        limit: { type: "integer", minimum: 1, maximum: MAX_MEMORY_RESULTS },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["memories", "visibility"],
      properties: {
        memories: {
          type: "array",
          maxItems: MAX_MEMORY_RESULTS,
          items: MEMORY_VALUE_SCHEMA,
        },
        visibility: { const: MARSHAL_RUNTIME_MEMORY_VISIBILITY },
      },
    },
    permissions: [{ permission: MARSHAL_RUNTIME_PERMISSION.memoryRecall, risk: "low" }],
  },
];

export function createRuntimeMemoryProvider(port: MarshalRuntimeMemoryPort): CapabilityProvider {
  return {
    id: PROVIDER_ID,
    version: "1.0.0",
    list: () => DESCRIPTORS,
    get: (name) => DESCRIPTORS.find((descriptor) => descriptor.name === name),
    async invoke(name, input, context) {
      const value = inputRecord(input);
      const scope = contextScope(context);
      const signal = abortSignal(context);
      if (name === "marshal.memory.store") {
        assertKeys(value, ["fact", "category"]);
        return {
          output: await port.store(
            scope,
            text(value, "fact", MAX_MEMORY_FACT_LENGTH),
            parseCategory(value.category),
            signal,
          ),
        };
      }
      if (name === "marshal.memory.recall") {
        assertKeys(value, ["query", "limit"]);
        return {
          output: await port.recall(
            scope,
            text(value, "query", MAX_MEMORY_QUERY_LENGTH),
            optionalLimit(value.limit),
            signal,
          ),
        };
      }
      throw Object.assign(new Error(`Marshal memory capability not found: ${name}.`), {
        code: "not_found",
      });
    },
  };
}

function contextScope(context: InvocationContext): MarshalRuntimeScope {
  const sessionId = context.scope?.sessionId;
  const workspaceName = context.metadata?.marshalWorkspaceName;
  if (typeof sessionId !== "string" || typeof workspaceName !== "string") {
    throw runtimeError(
      "permission_denied",
      "Marshal memory invocation requires a session and workspace scope.",
    );
  }
  return {
    sessionId: boundedText(sessionId, "Session ID", MAX_SCOPE_FIELD_LENGTH),
    workspaceName: boundedText(workspaceName, "Workspace name", MAX_SCOPE_FIELD_LENGTH),
  };
}

function abortSignal(context: InvocationContext): AbortSignal | undefined {
  return context.signal instanceof AbortSignal ? context.signal : undefined;
}

function inputRecord(input: unknown): Record<string, unknown> {
  if (input === undefined) return {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidRuntimeRequest(
      new TypeError("Marshal memory capability input must be an object."),
    );
  }
  return Object.fromEntries(Object.entries(input));
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected) {
    throw invalidRuntimeRequest(
      new TypeError(`Unexpected Marshal memory input property: ${unexpected}.`),
    );
  }
}

function text(value: Record<string, unknown>, key: string, maxLength: number): string {
  const candidate = value[key];
  if (typeof candidate !== "string") {
    throw invalidRuntimeRequest(new TypeError(`${key} must be a string.`));
  }
  return boundedText(candidate, key, maxLength);
}

function parseCategory(value: unknown): MemoryCategory {
  switch (value) {
    case undefined:
    case "fact":
      return "fact";
    case "preference":
      return "preference";
    case "decision":
      return "decision";
    case "context":
      return "context";
    default:
      throw invalidRuntimeRequest(new TypeError("category must be a supported memory category."));
  }
}

function optionalLimit(value: unknown): number {
  if (value === undefined) return 10;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_MEMORY_RESULTS
  ) {
    throw invalidRuntimeRequest(
      new RangeError(`limit must be between 1 and ${MAX_MEMORY_RESULTS}.`),
    );
  }
  return value;
}
