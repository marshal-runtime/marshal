import {
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityDescriptor,
  type CapabilityProvider,
  type InvocationContext,
} from "@marshal/runtime";

import type { ApplicationSessionService } from "./application-sessions";
import { invalidRuntimeRequest } from "./runtime-provider-error";
import type { SelectedSessionOwner } from "./selected-session-delivery";

export const APPLICATION_SESSION_PERMISSION = Object.freeze({
  start: "marshal.session.start",
  resume: "marshal.session.resume",
  reply: "marshal.session.reply",
});
const id = { type: "string", minLength: 1, maxLength: 256 } as const;
const text = { type: "string", minLength: 1, maxLength: 32_768 } as const;
const grantSchema = {
  type: "object",
  additionalProperties: false,
  required: ["grantId", "targetSessionId", "expiresAt"],
  properties: { grantId: id, targetSessionId: id, expiresAt: { type: "string" } },
} as const;

const descriptors: readonly CapabilityDescriptor[] = [
  {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: APPLICATION_SESSION_PERMISSION.start,
    version: "1.0.0",
    title: "Start a Marshal session from an extension application",
    description:
      "Start a normal top-level Marshal session with default permissions and queue its first message. " +
      "Only a live native application UI invocation may call it. Retrying the same requestId reuses the session. " +
      "Returns a delivery grant for marshal.session.delivery.* and the first message's receipt.",
    tags: ["marshal", "session", "application"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["requestId", "task"],
      properties: {
        requestId: id,
        task: text,
        name: { type: "string", minLength: 1, maxLength: 120 },
        workspaceName: id,
        context: text,
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId", "grantId", "expiresAt", "created", "receipt"],
      properties: {
        sessionId: id,
        grantId: id,
        expiresAt: { type: "string" },
        created: { type: "boolean" },
        receipt: { type: "object" },
      },
    },
    permissions: [{ permission: APPLICATION_SESSION_PERMISSION.start, risk: "high" }],
  },
  {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: APPLICATION_SESSION_PERMISSION.resume,
    version: "1.0.0",
    title: "Route back to a session this extension application started",
    description:
      "Mint a fresh delivery grant for a session that this same application started with marshal.session.start. " +
      "Use the grant with marshal.session.delivery.send and read. Only a live native application UI invocation may call it.",
    tags: ["marshal", "session", "application"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId"],
      properties: { sessionId: id },
    },
    outputSchema: grantSchema,
    permissions: [{ permission: APPLICATION_SESSION_PERMISSION.resume, risk: "medium" }],
  },
  {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: APPLICATION_SESSION_PERMISSION.reply,
    version: "1.0.0",
    title: "Reply into one of the user's own sessions",
    description:
      "Mint a delivery grant for an existing top-level session the user started, to send the user's typed reply " +
      "with marshal.session.delivery.send. Subagent, automation and allow-all sessions are refused. " +
      "Only a live native application UI invocation may call it.",
    tags: ["marshal", "session", "application"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId"],
      properties: { sessionId: id },
    },
    outputSchema: grantSchema,
    permissions: [{ permission: APPLICATION_SESSION_PERMISSION.reply, risk: "high" }],
  },
];

export function createApplicationSessionProvider(
  service: ApplicationSessionService,
  /** Must resolve a live native UI invocation, rejecting background application tokens. */
  resolveUiOwner: (context: InvocationContext) => SelectedSessionOwner,
): CapabilityProvider {
  return {
    id: "marshal.application-sessions",
    version: "1.0.0",
    list: () => descriptors,
    get: (name) => descriptors.find((entry) => entry.name === name),
    async invoke(name, input, context) {
      const owner = resolveUiOwner(context);
      try {
        if (name === APPLICATION_SESSION_PERMISSION.start)
          return { output: await service.start(owner, input) };
        if (name === APPLICATION_SESSION_PERMISSION.resume)
          return { output: await service.resume(owner, input) };
        if (name === APPLICATION_SESSION_PERMISSION.reply)
          return { output: await service.reply(owner, input) };
      } catch (error) {
        if (error instanceof Error && Reflect.get(error, "code") === "invalid_input")
          throw invalidRuntimeRequest(error);
        throw error;
      }
      throw Object.assign(new Error("Application session capability not found."), {
        code: "not_found",
      });
    },
  };
}
