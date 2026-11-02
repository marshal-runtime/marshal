import { createHash } from "node:crypto";

import { RUNTIME_UI_SURFACES, runtimeUiScopeKey, runtimeUiScopeOf } from "../../common/runtime-ui";
import type {
  RuntimeUiError,
  RuntimeUiEvent,
  RuntimeUiOwner,
  RuntimeUiScope,
  RuntimeUiSurface,
} from "../../common/runtime-ui";

const MAX_ERROR_MESSAGE_LENGTH = 16_384;

export type RuntimeUiEventInput = RuntimeUiEvent extends infer Event
  ? Event extends RuntimeUiEvent
    ? Omit<Event, "sequence" | "occurredAt">
    : never
  : never;

export class RuntimeUiControllerError extends Error {
  constructor(
    readonly code: RuntimeUiError["code"],
    message: string,
  ) {
    super(message);
    this.name = "RuntimeUiControllerError";
  }
}

export function failure(code: RuntimeUiError["code"], message: string): RuntimeUiControllerError {
  return new RuntimeUiControllerError(code, message);
}

export function normalizeError(error: unknown): RuntimeUiError {
  if (error instanceof RuntimeUiControllerError) {
    return immutable({ code: error.code, message: error.message });
  }
  return immutable({
    code: "operation-failed",
    message:
      error instanceof Error && error.message.trim()
        ? error.message.trim().slice(0, MAX_ERROR_MESSAGE_LENGTH)
        : "Runtime UI operation failed.",
  });
}

export function normalizeSurface(surface: RuntimeUiSurface): RuntimeUiSurface {
  if (!RUNTIME_UI_SURFACES.includes(surface)) {
    throw failure("invalid-request", "Runtime UI surface is invalid.");
  }
  return surface;
}

export function assertOnlyKeys(value: object, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw failure("invalid-request", `Runtime UI content key "${key}" is not allowed.`);
    }
  }
}

export function ownerOf(owner: RuntimeUiOwner): RuntimeUiOwner {
  return immutable({
    ...scopeOf(owner),
    extensionId: owner.extensionId,
    applicationId: owner.applicationId,
  });
}

export function scopeOf(scope: RuntimeUiScope): RuntimeUiScope {
  return immutable(runtimeUiScopeOf(scope));
}

export function scopeKey(scope: RuntimeUiScope): string {
  return deterministicId("runtime-ui-scope", scopeOf(scope));
}

export function sameScope(left: RuntimeUiScope, right: RuntimeUiScope): boolean {
  return runtimeUiScopeKey(left) === runtimeUiScopeKey(right);
}

export function sameOwner(left: RuntimeUiOwner, right: RuntimeUiOwner): boolean {
  return (
    sameScope(left, right) &&
    left.extensionId === right.extensionId &&
    left.applicationId === right.applicationId
  );
}

export function immutable<T>(value: T): T {
  const clone = structuredClone(value);
  freezeDeep(clone);
  return clone;
}

function freezeDeep(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeDeep(child);
  Object.freeze(value);
}

export function deterministicId(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update("\0").update(stableJson(value)).digest("hex");
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

export function isoTime(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw failure("aborted", "Runtime UI operation was aborted.");
}

export async function awaitAbortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    listener = () => reject(failure("aborted", "Runtime UI operation was aborted."));
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (listener) signal.removeEventListener("abort", listener);
  }
}
