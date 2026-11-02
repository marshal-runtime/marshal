import {
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityDescriptor,
  type CapabilityProvider,
  type InvocationContext,
} from "@marshal/runtime";

import { invalidRuntimeRequest } from "./runtime-provider-error";
import {
  normalizeSelectedSessionOwner,
  type SelectedSessionDeliveryService,
  type SelectedSessionOwner,
  type SelectedSessionReceipt,
} from "./selected-session-delivery";

export const SELECTED_SESSION_DELIVERY_PERMISSION = Object.freeze({
  send: "marshal.session.delivery.send",
  read: "marshal.session.delivery.read",
  cancel: "marshal.session.delivery.cancel",
  stop: "marshal.session.delivery.stop",
});
const PREFIX = "marshal.session.delivery.";
const id = { type: "string", minLength: 1, maxLength: 256 } as const;
const receiptSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "requestId",
    "messageId",
    "targetSessionId",
    "state",
    "response",
    "responseTruncated",
    "cursor",
    "reset",
    "events",
  ],
  properties: {
    requestId: id,
    messageId: id,
    targetSessionId: id,
    turnId: id,
    state: {
      enum: [
        "accepted",
        "pending",
        "leased",
        "backend-accepted",
        "processed",
        "dead-letter",
        "delivery-unknown",
        "cancelled",
      ],
    },
    response: { type: "string" },
    responseTruncated: { type: "boolean" },
    cursor: { type: "string" },
    reset: { type: "boolean" },
    error: { type: "string" },
    events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sequence", "type"],
        properties: {
          sequence: { type: "integer" },
          type: { enum: ["text", "status", "retry", "error"] },
          text: { type: "string" },
        },
      },
    },
  },
} as const;

const descriptors: readonly CapabilityDescriptor[] = [
  descriptor(
    "send",
    "Queue an idempotent message to a session selected in Marshal's native picker",
    {
      type: "object",
      additionalProperties: false,
      required: ["grantId", "requestId", "message"],
      properties: {
        grantId: id,
        requestId: id,
        message: { type: "string", minLength: 1, maxLength: 32_768 },
        context: { type: "string", minLength: 1, maxLength: 32_768 },
        attachmentHandles: { type: "array", maxItems: 8, items: id },
      },
    },
  ),
  descriptor(
    "read",
    "Read only this application's selected-session request, including correlated progress",
    {
      type: "object",
      additionalProperties: false,
      required: ["requestId"],
      properties: {
        requestId: id,
        afterCursor: { type: "string", maxLength: 1024 },
        timeoutMs: { type: "integer", minimum: 0, maximum: 30_000 },
      },
    },
  ),
  descriptor("cancel", "Cancel a queued selected-session request before native dispatch", {
    type: "object",
    additionalProperties: false,
    required: ["requestId"],
    properties: { requestId: id },
  }),
  descriptor("stop", "Stop this application's queued request or its own active turn", {
    type: "object",
    additionalProperties: false,
    required: ["requestId"],
    properties: { requestId: id },
  }),
];

export function createSelectedSessionDeliveryProvider(
  service: SelectedSessionDeliveryService,
  resolveOwner: (
    context: InvocationContext,
  ) => SelectedSessionOwner = selectedSessionOwnerFromContext,
  routeJob?: (
    name: string,
    input: unknown,
    context: InvocationContext,
  ) => Promise<{ output: SelectedSessionReceipt } | undefined>,
): CapabilityProvider {
  return {
    id: "marshal.selected-session-delivery",
    version: "1.0.0",
    list: () => descriptors,
    get: (name) => descriptors.find((candidate) => candidate.name === name),
    async invoke(name, input, context) {
      const jobResult = await routeJob?.(name, input, context);
      if (jobResult) return jobResult;
      const owner = normalizeSelectedSessionOwner(resolveOwner(context));
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw invalidRuntimeRequest(new Error("Delivery input must be an object."));
      const request = Object.fromEntries(Object.entries(input));
      const signal = context.signal instanceof AbortSignal ? context.signal : undefined;
      signal?.throwIfAborted();
      try {
        if (name === `${PREFIX}send`) {
          return {
            output: await service.send(owner, request, signal),
          };
        }
        if (name === `${PREFIX}read`) {
          assertKeys(request, ["requestId", "afterCursor", "timeoutMs"]);
          const requestId = requiredId(request.requestId);
          const afterCursor = request.afterCursor;
          if (
            afterCursor !== undefined &&
            (typeof afterCursor !== "string" || afterCursor.length > 1024)
          )
            throw invalidRuntimeRequest(
              new Error("afterCursor must be a string of at most 1024 characters."),
            );
          const timeoutMs = request.timeoutMs ?? 0;
          if (
            typeof timeoutMs !== "number" ||
            !Number.isInteger(timeoutMs) ||
            timeoutMs < 0 ||
            timeoutMs > 30_000
          )
            throw invalidRuntimeRequest(new Error("timeoutMs must be an integer from 0 to 30000."));
          return { output: await service.wait(owner, requestId, afterCursor, timeoutMs, signal) };
        }
        if (name === `${PREFIX}cancel`) {
          assertKeys(request, ["requestId"]);
          return { output: await service.cancel(owner, requiredId(request.requestId)) };
        }
        if (name === `${PREFIX}stop`) {
          assertKeys(request, ["requestId"]);
          return { output: await service.stop(owner, requiredId(request.requestId)) };
        }
        throw Object.assign(new Error("Selected-session capability not found."), {
          code: "not_found",
        });
      } catch (error) {
        if (error instanceof Error && Reflect.get(error, "code") === "invalid_input")
          throw invalidRuntimeRequest(error);
        throw error;
      }
    },
  };
}

export function selectedSessionOwnerFromContext(context: InvocationContext): SelectedSessionOwner {
  const metadata = context.metadata;
  const applicationScope = metadata?.runtimeApplicationScope;
  try {
    return normalizeSelectedSessionOwner({
      extensionId: metadata?.runtimeExtensionIdentity,
      applicationId: metadata?.runtimeApplicationId,
      workspaceName: metadata?.marshalWorkspaceName,
      ...(applicationScope !== undefined
        ? { applicationScope }
        : { sessionId: context.scope?.sessionId }),
    });
  } catch {
    throw Object.assign(
      new Error(
        "Selected-session delivery requires a host-authenticated extension application owner.",
      ),
      { code: "permission_denied" },
    );
  }
}

function descriptor(
  name: keyof typeof SELECTED_SESSION_DELIVERY_PERMISSION,
  title: string,
  inputSchema: CapabilityDescriptor["inputSchema"],
): CapabilityDescriptor {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: `${PREFIX}${name}`,
    version: "1.0.0",
    title,
    description: title,
    tags: ["marshal", "session", "delivery"],
    inputSchema,
    outputSchema: receiptSchema,
    permissions: [
      {
        permission: SELECTED_SESSION_DELIVERY_PERMISSION[name],
        risk: name === "send" ? "high" : name === "cancel" || name === "stop" ? "medium" : "low",
      },
    ],
  };
}
function requiredId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256)
    throw invalidRuntimeRequest(new Error("requestId must contain 1 to 256 characters."));
  return value;
}
function assertKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw invalidRuntimeRequest(new Error("Unexpected delivery input property."));
}
