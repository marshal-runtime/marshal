import { randomUUID } from "node:crypto";

import {
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityDescriptor,
  type CapabilityProvider,
  type InvocationContext,
} from "@marshal/runtime";

import type { RuntimeUiScope } from "../../common/runtime-ui";
import {
  isRuntimeUiPlacementName,
  RUNTIME_UI_PLACEMENT_NAMES,
  surfaceForPlacement,
} from "../../common/runtime-ui-layout";
import type { RuntimeApplicationAuthority } from "./application-authority";
import { MARSHAL_RUNTIME_PERMISSION } from "./contracts";
import { invalidRuntimeRequest } from "./runtime-provider-error";
import type { MarshalRuntimeUiController } from "./ui-controller";
import type { RuntimeUiViewPersistence } from "./ui-view-persistence";

const PROVIDER_ID = "marshal.runtime-ui-layout";
export const UI_LAYOUT_GET_CAPABILITY = "ui.layout.get";
export const UI_VIEW_MOVE_CAPABILITY = "ui.view.move";
const WORKSPACE_METADATA_KEY = "marshalWorkspaceName";

const PLACEMENT_HELP =
  "chat-tab (a tab beside Chat), side (the right dock), bottom (the dock under the chat), floating (a movable window), card (a permanent card in the conversation), fullscreen (a chat tab, maximized)";

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
    value: { type: "object" },
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message"],
      properties: { code: { type: "string" }, message: { type: "string" } },
    },
  },
} as const;

const DESCRIPTORS: readonly CapabilityDescriptor[] = [
  {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: UI_LAYOUT_GET_CAPABILITY,
    version: "1.0.0",
    title: "List the views attached to this session and where each one sits",
    description:
      "Returns every open view in the current session (docked tabs, conversation cards, transient cards) with its title, owner, placement, dock group, tab index, whether it is the active tab, card anchor, and transient expiry, plus the side/bottom dock sizes and floating windows. Placements the user changed by dragging are reflected here. layoutUnreported is true until a desktop client has drawn the session.",
    tags: ["marshal", "ui", "layout"],
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: RESULT_SCHEMA,
    permissions: [{ permission: MARSHAL_RUNTIME_PERMISSION.uiApplicationList, risk: "low" }],
  },
  {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: UI_VIEW_MOVE_CAPABILITY,
    version: "1.0.0",
    title: "Move an open view to another placement and bring it to the front",
    description: `Moves a view listed by ui.layout.get. placement is one of: ${PLACEMENT_HELP}. A view cannot be made transient after it opens.`,
    tags: ["marshal", "ui", "layout"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["instanceId", "placement"],
      properties: {
        instanceId: { type: "string", minLength: 1, maxLength: 128 },
        placement: {
          enum: RUNTIME_UI_PLACEMENT_NAMES.filter((name) => name !== "transient"),
        },
        idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
      },
    },
    outputSchema: RESULT_SCHEMA,
    permissions: [{ permission: MARSHAL_RUNTIME_PERMISSION.uiApplicationFocus, risk: "low" }],
  },
];

export function createRuntimeUiLayoutProvider(
  controller: MarshalRuntimeUiController,
  persistence: RuntimeUiViewPersistence,
  applications: Pick<RuntimeApplicationAuthority, "resolve">,
): CapabilityProvider {
  return {
    id: PROVIDER_ID,
    version: "1.0.0",
    list: () => DESCRIPTORS,
    get: (name) => DESCRIPTORS.find((descriptor) => descriptor.name === name),
    async invoke(name, input, context) {
      if (applications.resolve(context)) {
        throw Object.assign(
          new Error("Applications cannot read or rearrange the session layout."),
          {
            code: "permission_denied",
          },
        );
      }
      const scope = sessionScope(context);
      const value = inputRecord(input);
      if (name === UI_LAYOUT_GET_CAPABILITY) {
        const listed = await controller.list(scope, signalOf(context));
        if (!listed.ok) return { output: listed };
        return { output: { ok: true, value: persistence.report(scope) } };
      }
      if (name === UI_VIEW_MOVE_CAPABILITY) {
        const instanceId = value.instanceId;
        const placement = value.placement;
        if (typeof instanceId !== "string" || !instanceId) {
          throw invalidRuntimeRequest(new TypeError("instanceId is required."));
        }
        if (!isRuntimeUiPlacementName(placement) || placement === "transient") {
          throw invalidRuntimeRequest(
            new TypeError(`placement must be one of: ${PLACEMENT_HELP}.`),
          );
        }
        const instance = controller
          .scopeInstances(scope)
          .find((candidate) => candidate.instanceId === instanceId);
        if (!instance) {
          return {
            output: {
              ok: false,
              error: {
                code: "not-found",
                message: `No open view "${instanceId}" in this session.`,
              },
            },
          };
        }
        const idempotencyKey =
          typeof value.idempotencyKey === "string" && value.idempotencyKey
            ? value.idempotencyKey
            : `ui.view.move:${randomUUID()}`;
        return {
          output: await controller.focus(
            {
              ...instance.owner,
              instanceId,
              surface: surfaceForPlacement(placement),
              idempotencyKey,
            },
            signalOf(context),
          ),
        };
      }
      throw Object.assign(new Error(`Runtime UI layout capability not found: ${name}.`), {
        code: "not_found",
      });
    },
  };
}

function sessionScope(context: InvocationContext): RuntimeUiScope & { sessionId: string } {
  const sessionId = context.scope?.sessionId?.trim();
  const workspaceName = context.metadata?.[WORKSPACE_METADATA_KEY];
  if (!sessionId || typeof workspaceName !== "string" || !workspaceName.trim()) {
    throw invalidRuntimeRequest(
      new TypeError("The session layout is only available to a session-scoped invocation."),
    );
  }
  return { sessionId, workspaceName: workspaceName.trim() };
}

function signalOf(context: InvocationContext): AbortSignal | undefined {
  return context.signal instanceof AbortSignal ? context.signal : undefined;
}

function inputRecord(input: unknown): Record<string, unknown> {
  if (input === undefined) return {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidRuntimeRequest(new TypeError("Layout capability input must be an object."));
  }
  return Object.fromEntries(Object.entries(input));
}
