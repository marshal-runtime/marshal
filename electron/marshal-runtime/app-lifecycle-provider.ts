import {
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityDescriptor,
  type CapabilityProvider,
  type InvocationContext,
} from "@marshal/runtime";

import {
  MAX_RESTART_DELAY_MS,
  MAX_RESTART_REASON_LENGTH,
  type AppRestartExecutor,
  type BusySessionRef,
} from "../app-restart-executor";
import { MARSHAL_RUNTIME_PERMISSION } from "./contracts";
import { invalidRuntimeRequest } from "./runtime-provider-error";

const PROVIDER_ID = "marshal.app-lifecycle";
export const APP_RESTART_CAPABILITY = "marshal.app.restart";

const BUSY_SESSION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sessionId"],
  properties: {
    sessionId: { type: "string" },
    label: { type: "string" },
  },
} as const;

const DESCRIPTOR: CapabilityDescriptor = {
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  name: APP_RESTART_CAPABILITY,
  version: "1.0.0",
  title: "Restart the Marshal desktop app and reload",
  description:
    "Gracefully restarts the entire Marshal desktop app: flushes session and runtime state " +
    "through the normal quit path, then relaunches; sessions restore as after a manual restart. " +
    "Refused (with the blocking sessions listed) while agent sessions outside the caller's own " +
    "lineage are busy, unless force is true. The requesting agent's turn dies with the app; after " +
    "boot, a ledger-backed system notice records the restart and a wake message re-engages the " +
    "requesting session so it can continue its work.",
  tags: ["marshal", "app", "lifecycle"],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["reason"],
    properties: {
      reason: { type: "string", minLength: 1, maxLength: MAX_RESTART_REASON_LENGTH },
      force: { type: "boolean" },
      delayMs: { type: "integer", minimum: 0, maximum: MAX_RESTART_DELAY_MS },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "message"],
    properties: {
      status: { enum: ["scheduled", "refused", "already-scheduled"] },
      message: { type: "string" },
      delayMs: { type: "integer", minimum: 0, maximum: MAX_RESTART_DELAY_MS },
      ledgerEntryId: { type: "string" },
      busySessions: { type: "array", maxItems: 200, items: BUSY_SESSION_SCHEMA },
      overriddenBusySessions: { type: "array", maxItems: 200, items: BUSY_SESSION_SCHEMA },
    },
  },
  permissions: [
    {
      permission: MARSHAL_RUNTIME_PERMISSION.appRestart,
      reason: "Restarts the entire Marshal desktop app, ending every running agent turn.",
      risk: "high",
    },
  ],
};

export function createAppLifecycleProvider(executor: AppRestartExecutor): CapabilityProvider {
  return {
    id: PROVIDER_ID,
    version: "1.0.0",
    list: () => [DESCRIPTOR],
    get: (name) => (name === APP_RESTART_CAPABILITY ? DESCRIPTOR : undefined),
    async invoke(name, input, context) {
      if (name !== APP_RESTART_CAPABILITY) {
        throw Object.assign(new Error(`Marshal app-lifecycle capability not found: ${name}.`), {
          code: "not_found",
        });
      }
      const requesterSessionId = requesterSession(context);
      const value = inputRecord(input);
      assertKeys(value, ["reason", "force", "delayMs"]);
      const request = {
        requesterSessionId,
        reason: text(value, "reason", MAX_RESTART_REASON_LENGTH),
        force: value.force === undefined ? false : booleanValue(value, "force"),
        ...(value.delayMs === undefined
          ? {}
          : { delayMs: integerValue(value, "delayMs", 0, MAX_RESTART_DELAY_MS) }),
      };
      const outcome = await executor.requestRestart(request);
      if (outcome.status === "invalid") {
        throw invalidRuntimeRequest(new TypeError(outcome.message));
      }
      if (outcome.status === "refused") {
        return {
          output: {
            status: outcome.status,
            message: outcome.message,
            busySessions: outcome.busySessions.map(busyRef),
          },
        };
      }
      if (outcome.status === "already-scheduled") {
        return { output: { status: outcome.status, message: outcome.message } };
      }
      return {
        output: {
          status: outcome.status,
          message: outcome.message,
          delayMs: outcome.delayMs,
          ...(outcome.ledgerEntryId ? { ledgerEntryId: outcome.ledgerEntryId } : {}),
          overriddenBusySessions: outcome.overriddenBusySessions.map(busyRef),
        },
      };
    },
  };
}

function busyRef(ref: BusySessionRef): { sessionId: string; label?: string } {
  return { sessionId: ref.sessionId, ...(ref.label === undefined ? {} : { label: ref.label }) };
}

function requesterSession(context: InvocationContext): string {
  const sessionId = context.scope?.sessionId?.trim();
  if (!sessionId) {
    throw Object.assign(new Error("Marshal app restart requires a session-scoped invocation."), {
      code: "permission_denied",
    });
  }
  return sessionId;
}

function inputRecord(input: unknown): Record<string, unknown> {
  if (input === undefined) return {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidRuntimeRequest(
      new TypeError("Marshal app restart capability input must be an object."),
    );
  }
  return Object.fromEntries(Object.entries(input));
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw invalidRuntimeRequest(
        new TypeError(`Marshal app restart input key is not supported: ${key}.`),
      );
    }
  }
}

function text(value: Record<string, unknown>, key: string, maxLength: number): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || !candidate.trim() || candidate.length > maxLength) {
    throw invalidRuntimeRequest(
      new TypeError(`Marshal app restart input "${key}" must be a non-empty string.`),
    );
  }
  return candidate;
}

function booleanValue(value: Record<string, unknown>, key: string): boolean {
  const candidate = value[key];
  if (typeof candidate !== "boolean") {
    throw invalidRuntimeRequest(
      new TypeError(`Marshal app restart input "${key}" must be a boolean.`),
    );
  }
  return candidate;
}

function integerValue(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const candidate = value[key];
  if (
    typeof candidate !== "number" ||
    !Number.isInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw invalidRuntimeRequest(
      new TypeError(
        `Marshal app restart input "${key}" must be an integer between ${minimum} and ${maximum}.`,
      ),
    );
  }
  return candidate;
}
