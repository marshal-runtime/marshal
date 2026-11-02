import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityDescriptor,
  type CapabilityInvocationResult,
  type CapabilityProvider,
  type InvocationContext,
  type RuntimeServiceContainer,
} from "@marshal/runtime";
import {
  RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE,
  type RuntimeExtensionUiPublishedApplication,
} from "@marshal/runtime/extensions";

import type {
  RuntimeUiApplicationContent,
  RuntimeUiCommandResult,
  RuntimeUiContent,
  RuntimeUiJsonValue,
  RuntimeUiOwnerIdentity,
  RuntimeUiOwner,
  RuntimeUiResult,
  RuntimeUiSurface,
} from "../../common/runtime-ui";
import { RUNTIME_UI_SURFACES, runtimeUiScopeOf } from "../../common/runtime-ui";
import { MARSHAL_RUNTIME_PERMISSION } from "./contracts";
import { DOCUMENT_EXTRAS_PROPERTIES, normalizeDocumentExtras } from "./document-annotations";
import type { MarshalRuntimeUiController } from "./ui-controller";
import {
  parsePlacementInput,
  PLACEMENT_DESCRIPTION,
  PLACEMENT_PROPERTY,
  VIEW_OPTION_PROPERTIES,
} from "./ui-placement-input";

const PROVIDER_ID = "marshal.runtime-ui";
/** Reserved publication owner for agent-authored React renders. Placement for
 *  this owner resolves EXCLUSIVELY through the runtime's public
 *  `ui.applications.list` projection — never through extension publications —
 *  so no extension manifest claiming this identity can shadow or spoof
 *  authored renders. Matches REACT_UI_PUBLICATION_OWNER_ID in
 *  @marshal/agent-runtime-ui (documented public contract). */
export const RESERVED_AUTHORED_UI_OWNER_ID = "marshal.react-ui";

/** Same-context bridge to the runtime's public `ui.applications.list`
 *  capability; wired by the host from the kernel's registered provider so
 *  scope and permissions propagate unchanged. */
export type ListAuthoredUiApplications = (
  context: InvocationContext,
) => Promise<readonly RuntimeExtensionUiPublishedApplication[]>;
const WORKSPACE_METADATA_KEY = "marshalWorkspaceName";
const SURFACES = RUNTIME_UI_SURFACES;

const OWNER_PROPERTIES = {
  extensionId: { type: "string", minLength: 1, maxLength: 256 },
  applicationId: { type: "string", minLength: 1, maxLength: 256 },
} as const;
const IDEMPOTENCY_PROPERTY = {
  idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
} as const;
const STATE_PROPERTY = {
  state: { type: "object", additionalProperties: true },
} as const;
const TEXT_CONTENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "text"],
  properties: {
    kind: { const: "text" },
    text: { type: "string", minLength: 1, maxLength: 16_384 },
  },
} as const;
const MARKDOWN_CONTENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "markdown"],
  properties: {
    kind: { const: "markdown" },
    markdown: { type: "string", minLength: 1, maxLength: 16_384 },
  },
} as const;
const RECEIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["receiptId", "action", "status", "completedAt", "revision"],
  properties: {
    receiptId: { type: "string" },
    action: {
      enum: [
        "open",
        "update",
        "focus",
        "close",
        "list",
        "notification.show",
        "chat.message.post",
        "chat.card.show",
      ],
    },
    status: { enum: ["applied", "deduplicated"] },
    completedAt: { type: "string" },
    revision: { type: "number" },
    instanceId: { type: "string" },
    deliveryId: { type: "string" },
  },
} as const;
const OWNER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["workspaceName", "extensionId", "applicationId"],
  anyOf: [{ required: ["sessionId"] }, { required: ["applicationScope"] }],
  properties: {
    sessionId: { type: "string" },
    applicationScope: { enum: ["user", "workspace"] },
    workspaceName: { type: "string" },
    ...OWNER_PROPERTIES,
  },
} as const;
const CONTENT_SCHEMA = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "path"],
      properties: {
        kind: { const: "file" },
        path: { type: "string", minLength: 1, maxLength: 4096 },
        readCapability: { type: "string", minLength: 1 },
        ...DOCUMENT_EXTRAS_PROPERTIES,
      },
    },
    TEXT_CONTENT_SCHEMA,
    MARKDOWN_CONTENT_SCHEMA,
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "renderId", "resource", "descriptor"],
      properties: {
        kind: { const: "application" },
        renderId: { type: "string" },
        resource: {
          type: "object",
          additionalProperties: false,
          required: ["uri", "mimeType"],
          properties: {
            uri: { type: "string" },
            mimeType: { type: "string" },
            name: { type: "string" },
          },
        },
        descriptor: { type: "object" },
        ...STATE_PROPERTY,
      },
    },
  ],
} as const;
const INSTANCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "instanceId",
    "owner",
    "surface",
    "content",
    "idempotencyKey",
    "revision",
    "openedAt",
    "updatedAt",
    "focusedAt",
  ],
  properties: {
    instanceId: { type: "string" },
    owner: OWNER_SCHEMA,
    surface: { enum: SURFACES },
    content: CONTENT_SCHEMA,
    idempotencyKey: { type: "string" },
    revision: { type: "number" },
    openedAt: { type: "string" },
    updatedAt: { type: "string" },
    focusedAt: { type: "string" },
    focusedBy: { enum: ["desktop", "remote"] },
    title: { type: "string" },
    transient: {
      type: "object",
      additionalProperties: false,
      properties: { expiresAt: { type: "string" } },
    },
    anchor: {
      type: "object",
      additionalProperties: false,
      properties: { slot: { type: "string" }, afterMessageId: { type: "string" } },
    },
  },
} as const;
const COMMAND_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["receipt"],
  properties: {
    receipt: RECEIPT_SCHEMA,
    instance: INSTANCE_SCHEMA,
    instances: { type: "array", items: INSTANCE_SCHEMA },
  },
} as const;
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
    value: COMMAND_RESULT_SCHEMA,
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message"],
      properties: {
        code: {
          enum: [
            "aborted",
            "cancelled",
            "approval-required",
            "idempotency-capacity",
            "idempotency-conflict",
            "invalid-request",
            "not-found",
            "operation-failed",
            "permission-denied",
            "runtime-unavailable",
          ],
        },
        message: { type: "string" },
      },
    },
  },
} as const;

const DESCRIPTORS: readonly CapabilityDescriptor[] = [
  buildDescriptor(
    "ui.document.open",
    "Open a local file in Marshal's editor in the shared evidence panel. Pass an absolute path; no HTML generation, registered application, or UI compilation is needed. Optional revealLine scrolls to a 1-based line; optional annotations mark line ranges with a gutter tone, a short inline label, and hover detail.",
    {
      type: "object",
      additionalProperties: false,
      required: ["path", "idempotencyKey"],
      properties: {
        path: { type: "string", minLength: 1, maxLength: 4096 },
        ...DOCUMENT_EXTRAS_PROPERTIES,
        ...IDEMPOTENCY_PROPERTY,
      },
    },
    MARSHAL_RUNTIME_PERMISSION.uiApplicationOpen,
  ),
  buildDescriptor(
    "ui.document.annotate",
    "Replace the annotations (and optionally the reveal line) of a document already opened with ui.document.open, in place. Pass the instanceId and path from the open result; omitted annotations clear them.",
    {
      type: "object",
      additionalProperties: false,
      required: ["instanceId", "path", "idempotencyKey"],
      properties: {
        instanceId: { type: "string", minLength: 1, maxLength: 128 },
        path: { type: "string", minLength: 1, maxLength: 4096 },
        ...DOCUMENT_EXTRAS_PROPERTIES,
        ...IDEMPOTENCY_PROPERTY,
      },
    },
    MARSHAL_RUNTIME_PERMISSION.uiApplicationUpdate,
  ),
  buildDescriptor(
    "ui.notification.show",
    "Show a Marshal notification",
    {
      type: "object",
      additionalProperties: false,
      required: ["extensionId", "applicationId", "title", "message", "idempotencyKey"],
      properties: {
        ...OWNER_PROPERTIES,
        title: { type: "string", minLength: 1, maxLength: 512 },
        message: { type: "string", minLength: 1, maxLength: 16_384 },
        ...IDEMPOTENCY_PROPERTY,
      },
    },
    MARSHAL_RUNTIME_PERMISSION.uiNotificationShow,
  ),
  buildDescriptor(
    "ui.chat.message.post",
    "Post a message to the current Marshal chat",
    {
      type: "object",
      additionalProperties: false,
      required: ["extensionId", "applicationId", "content", "idempotencyKey"],
      properties: {
        ...OWNER_PROPERTIES,
        content: { anyOf: [TEXT_CONTENT_SCHEMA, MARKDOWN_CONTENT_SCHEMA] },
        ...IDEMPOTENCY_PROPERTY,
      },
    },
    MARSHAL_RUNTIME_PERMISSION.uiChatMessagePost,
  ),
  buildDescriptor(
    "ui.chat.card.show",
    "Show a registered Marshal Runtime application as a card in the current chat. By default the card is transient: it floats above the conversation, is not saved with the session, and closes when you close it, the user dismisses it, or timeoutMs passes (use it for sign-ins, API keys, confirmations). Pass placement: card for a permanent card saved in the conversation, optionally with slot (fills a <!--ui:<slot>--> marker you wrote in your message) or afterMessageId.",
    applicationCommandSchema(false),
    MARSHAL_RUNTIME_PERMISSION.uiChatCardShow,
  ),
  buildDescriptor(
    "ui.application.open",
    `Open a registered Marshal Runtime application. ${PLACEMENT_DESCRIPTION} Pass replaceInstanceId to swap the content of a view you already opened (for example after fixing a broken render) while keeping its id and exact placement.`,
    applicationCommandSchema(true),
    MARSHAL_RUNTIME_PERMISSION.uiApplicationOpen,
  ),
  buildDescriptor(
    "ui.application.update",
    "Update an open Marshal Runtime application",
    {
      type: "object",
      additionalProperties: false,
      required: ["extensionId", "applicationId", "instanceId", "idempotencyKey"],
      properties: {
        ...OWNER_PROPERTIES,
        instanceId: { type: "string", minLength: 1, maxLength: 128 },
        ...STATE_PROPERTY,
        ...IDEMPOTENCY_PROPERTY,
      },
    },
    MARSHAL_RUNTIME_PERMISSION.uiApplicationUpdate,
  ),
  buildDescriptor(
    "ui.application.focus",
    "Focus an open Marshal Runtime application; pass surface to move it there (for example into the bottom panel)",
    instanceCommandSchema(true),
    MARSHAL_RUNTIME_PERMISSION.uiApplicationFocus,
  ),
  buildDescriptor(
    "ui.application.close",
    "Close an open Marshal Runtime application",
    instanceCommandSchema(),
    MARSHAL_RUNTIME_PERMISSION.uiApplicationClose,
  ),
  buildDescriptor(
    "ui.application.list",
    "List Marshal Runtime applications open in the current scope",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ...OWNER_PROPERTIES,
        surface: { enum: SURFACES },
      },
    },
    MARSHAL_RUNTIME_PERMISSION.uiApplicationList,
  ),
];

interface RuntimeUiCapabilityProvider extends CapabilityProvider {
  invoke(
    name: string,
    input: unknown,
    context: InvocationContext,
  ): Promise<CapabilityInvocationResult<RuntimeUiResult<RuntimeUiCommandResult>>>;
}

export function createRuntimeUiProvider(
  controller: MarshalRuntimeUiController,
  services: RuntimeServiceContainer,
  resolveApplicationOwner?: (context: InvocationContext) => RuntimeUiOwner | undefined,
  listAuthoredApplications?: ListAuthoredUiApplications,
): RuntimeUiCapabilityProvider {
  const resolveApplication: ResolvePublishedApplication = (owner, context) =>
    resolvePublishedApplication(owner, services, context, listAuthoredApplications);
  return {
    id: PROVIDER_ID,
    version: "1.0.0",
    list: () => DESCRIPTORS,
    get: (name) => DESCRIPTORS.find((candidate) => candidate.name === name),
    async invoke(name, input, context) {
      const trustedOwner = resolveApplicationOwner?.(context);
      let scope = trustedOwner ? runtimeUiScopeOf(trustedOwner) : contextScope(context);
      const value = record(input);
      if (trustedOwner && name === "ui.document.open") {
        // The invocation authority supplies the selected session and its root.
        // A persistent application's own UI scope is not filesystem authority.
        scope = contextScope(context);
        const workspacePath = context.scope?.workspacePath;
        if (typeof workspacePath !== "string" || !workspacePath)
          throw new Error("Select an execution session with a workspace to open documents.");
        if (
          ["sessionId", "workspaceName", "applicationScope", "extensionId", "applicationId"].some(
            (key) => value[key] !== undefined,
          )
        )
          throw new Error("Document opening cannot override the selected session or owner.");
        const requested = text(value, "path");
        if (!path.isAbsolute(requested)) throw new Error("Document path must be absolute.");
        const [root, target] = await Promise.all([realpath(workspacePath), realpath(requested)]);
        const relative = path.relative(root, target);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
          throw new Error("Document path is outside the selected workspace.");
        value.path = target;
      } else if (trustedOwner) {
        if (!/^ui\.application\.(open|update|focus|close|list)$/.test(name)) {
          throw Object.assign(
            new Error("Application authority permits only its own application UI operations."),
            { code: "permission-denied" },
          );
        }
        if (
          (value.extensionId !== undefined && value.extensionId !== trustedOwner.extensionId) ||
          (value.applicationId !== undefined &&
            value.applicationId !== trustedOwner.applicationId) ||
          value.sessionId !== undefined ||
          value.workspaceName !== undefined ||
          value.applicationScope !== undefined
        ) {
          throw Object.assign(
            new Error("Application UI operations cannot target a different owner or scope."),
            { code: "permission-denied" },
          );
        }
        value.extensionId = trustedOwner.extensionId;
        value.applicationId = trustedOwner.applicationId;
      }
      const signal = abortSignal(context);
      if (name === "ui.document.open") {
        return {
          output: await controller.open(
            {
              ...scope,
              ...documentOwner(value),
              surface: "panel",
              content: documentContent(value),
              idempotencyKey: text(value, "idempotencyKey"),
            },
            signal,
          ),
        };
      }
      if (name === "ui.document.annotate") {
        return {
          output: await controller.update(
            {
              ...scope,
              ...documentOwner(value),
              instanceId: text(value, "instanceId"),
              content: documentContent(value),
              idempotencyKey: text(value, "idempotencyKey"),
            },
            signal,
          ),
        };
      }
      if (name === "ui.notification.show") {
        return {
          output: await controller.showNotification(
            {
              ...scope,
              ...readOwner(value),
              title: text(value, "title"),
              message: text(value, "message"),
              idempotencyKey: text(value, "idempotencyKey"),
            },
            signal,
          ),
        };
      }
      if (name === "ui.chat.message.post") {
        return {
          output: await controller.postChatMessage(
            {
              ...scope,
              ...readOwner(value),
              content: chatContent(value.content),
              idempotencyKey: text(value, "idempotencyKey"),
            },
            signal,
          ),
        };
      }
      if (name === "ui.chat.card.show") {
        const applicationOwner = readOwner(value);
        if (
          value.placement !== undefined &&
          value.placement !== "card" &&
          value.placement !== "transient"
        ) {
          throw new TypeError("ui.chat.card.show placement must be card or transient.");
        }
        const card = parsePlacementInput(value, {
          fallbackSurface: "inline-card",
          fallbackTransient: true,
        });
        return {
          output: await controller.showChatCard(
            {
              ...scope,
              ...applicationOwner,
              ...card.options,
              content: await applicationContent(
                value,
                applicationOwner,
                resolveApplication,
                context,
              ),
              idempotencyKey: text(value, "idempotencyKey"),
            },
            signal,
          ),
        };
      }
      if (name === "ui.application.open") {
        const applicationOwner = readOwner(value);
        const replaceInstanceId = optionalText(value, "replaceInstanceId");
        const placed = parsePlacementInput(value, { fallbackTransient: false });
        return {
          output: await controller.open(
            {
              ...scope,
              ...applicationOwner,
              surface: placed.surface,
              ...placed.options,
              ...(replaceInstanceId ? { replaceInstanceId } : {}),
              content: await applicationContent(
                value,
                applicationOwner,
                resolveApplication,
                context,
              ),
              idempotencyKey: text(value, "idempotencyKey"),
            },
            signal,
          ),
        };
      }
      if (name === "ui.application.update") {
        const applicationOwner = readOwner(value);
        return {
          output: await controller.update(
            {
              ...scope,
              ...applicationOwner,
              instanceId: text(value, "instanceId"),
              content: await applicationContent(
                value,
                applicationOwner,
                resolveApplication,
                context,
              ),
              idempotencyKey: text(value, "idempotencyKey"),
            },
            signal,
          ),
        };
      }
      if (name === "ui.application.focus" || name === "ui.application.close") {
        const applicationOwner = readOwner(value);
        await resolveApplication(applicationOwner, context);
        const command = {
          ...scope,
          ...applicationOwner,
          instanceId: text(value, "instanceId"),
          idempotencyKey: text(value, "idempotencyKey"),
          ...(name === "ui.application.focus" && value.surface !== undefined
            ? { surface: surface(value.surface) }
            : {}),
        };
        return {
          output:
            name === "ui.application.focus"
              ? await controller.focus(command, signal)
              : await controller.close(command, signal),
        };
      }
      if (name === "ui.application.list") {
        const applicationOwner = optionalOwner(value);
        if (applicationOwner) await resolveApplication(applicationOwner, context);
        return {
          output: await controller.list(
            {
              ...scope,
              ...(applicationOwner ? { owner: applicationOwner } : {}),
              ...(value.surface === undefined ? {} : { surface: surface(value.surface) }),
            },
            signal,
          ),
        };
      }
      throw Object.assign(new Error(`Runtime UI capability not found: ${name}.`), {
        code: "not_found",
      });
    },
  };
}

function documentOwner(value: Record<string, unknown>): RuntimeUiOwnerIdentity {
  return { extensionId: "marshal.documents", applicationId: text(value, "path").slice(-256) };
}

function documentContent(value: Record<string, unknown>): RuntimeUiContent {
  return {
    kind: "file",
    path: text(value, "path"),
    ...normalizeDocumentExtras(value, (message) => new TypeError(message)),
  };
}

function buildDescriptor(
  name: string,
  title: string,
  inputSchema: CapabilityDescriptor["inputSchema"],
  permission: string,
): CapabilityDescriptor {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name,
    version: "1.0.0",
    title,
    description: title,
    tags: ["marshal", "ui"],
    inputSchema,
    outputSchema: OUTPUT_SCHEMA,
    permissions: [{ permission, risk: "medium" }],
  };
}

function applicationCommandSchema(includeSurface: boolean): CapabilityDescriptor["inputSchema"] {
  return {
    type: "object",
    additionalProperties: false,
    required: ["extensionId", "applicationId", "idempotencyKey"],
    properties: {
      ...OWNER_PROPERTIES,
      ...(includeSurface
        ? {
            surface: { enum: SURFACES },
            ...PLACEMENT_PROPERTY,
            replaceInstanceId: { type: "string", minLength: 1, maxLength: 128 },
          }
        : { placement: { enum: ["card", "transient"] } }),
      ...VIEW_OPTION_PROPERTIES,
      ...STATE_PROPERTY,
      ...IDEMPOTENCY_PROPERTY,
    },
  };
}

function instanceCommandSchema(includeSurface = false): CapabilityDescriptor["inputSchema"] {
  return {
    type: "object",
    additionalProperties: false,
    required: ["extensionId", "applicationId", "instanceId", "idempotencyKey"],
    properties: {
      ...OWNER_PROPERTIES,
      instanceId: { type: "string", minLength: 1, maxLength: 128 },
      ...(includeSurface ? { surface: { enum: SURFACES } } : {}),
      ...IDEMPOTENCY_PROPERTY,
    },
  };
}

function contextScope(context: InvocationContext): {
  readonly sessionId: string;
  readonly workspaceName: string;
} {
  const sessionId = context.scope?.sessionId?.trim();
  const workspaceName = context.metadata?.[WORKSPACE_METADATA_KEY];
  if (!sessionId || typeof workspaceName !== "string" || !workspaceName.trim()) {
    throw new TypeError("Runtime UI invocation requires a session and workspace scope.");
  }
  return { sessionId, workspaceName: workspaceName.trim() };
}

function abortSignal(context: InvocationContext): AbortSignal | undefined {
  return context.signal instanceof AbortSignal ? context.signal : undefined;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Runtime UI capability input must be an object.");
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) result[key] = Reflect.get(value, key);
  return result;
}

function readOwner(value: Record<string, unknown>): RuntimeUiOwnerIdentity {
  return {
    extensionId: text(value, "extensionId"),
    applicationId: text(value, "applicationId"),
  };
}

function optionalOwner(value: Record<string, unknown>): RuntimeUiOwnerIdentity | undefined {
  const extensionId = optionalText(value, "extensionId");
  const applicationId = optionalText(value, "applicationId");
  if (!extensionId && !applicationId) return undefined;
  if (!extensionId || !applicationId) {
    throw new TypeError("Runtime UI extensionId and applicationId must be provided together.");
  }
  return { extensionId, applicationId };
}

function text(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field.trim()) {
    throw new TypeError(`Runtime UI ${key} must be a non-empty string.`);
  }
  return field;
}

function optionalText(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string" || !field.trim()) {
    throw new TypeError(`Runtime UI ${key} must be a non-empty string.`);
  }
  return field;
}

function surface(value: unknown): RuntimeUiSurface {
  const known = SURFACES.find((candidate) => candidate === value);
  if (known) return known;
  throw new TypeError("Runtime UI surface is invalid.");
}

function chatContent(value: unknown): Extract<RuntimeUiContent, { kind: "text" | "markdown" }> {
  const content = record(value);
  if (content.kind === "text") {
    assertOnlyKeys(content, ["kind", "text"]);
    return { kind: "text", text: text(content, "text") };
  }
  if (content.kind === "markdown") {
    assertOnlyKeys(content, ["kind", "markdown"]);
    return { kind: "markdown", markdown: text(content, "markdown") };
  }
  throw new TypeError("Runtime UI chat content must be text or markdown.");
}

async function applicationContent(
  value: Record<string, unknown>,
  applicationOwner: RuntimeUiOwnerIdentity,
  resolveApplication: ResolvePublishedApplication,
  context: InvocationContext,
): Promise<RuntimeUiApplicationContent> {
  const application = await resolveApplication(applicationOwner, context);
  return {
    kind: "application",
    renderId: application.renderId,
    resource: {
      uri: application.resource.uri,
      mimeType: application.resource.mimeType ?? "text/plain",
      name: application.title,
    },
    descriptor: application.application,
    ...(value.state === undefined ? {} : { state: jsonObject(value.state, "state") }),
  };
}

type ResolvePublishedApplication = (
  applicationOwner: RuntimeUiOwnerIdentity,
  context: InvocationContext,
) => Promise<RuntimeExtensionUiPublishedApplication>;

async function resolvePublishedApplication(
  applicationOwner: RuntimeUiOwnerIdentity,
  services: RuntimeServiceContainer,
  context: InvocationContext,
  listAuthoredApplications: ListAuthoredUiApplications | undefined,
): Promise<RuntimeExtensionUiPublishedApplication> {
  if (applicationOwner.extensionId === RESERVED_AUTHORED_UI_OWNER_ID) {
    if (!listAuthoredApplications) {
      throw Object.assign(
        new Error("Authored-render placement requires a runtime exposing ui.applications.list."),
        { code: "runtime-unavailable" },
      );
    }
    const authored = await listAuthoredApplications(context);
    const application = authored.find(
      (candidate) =>
        candidate.ownerId === RESERVED_AUTHORED_UI_OWNER_ID &&
        candidate.id === applicationOwner.applicationId,
    );
    if (application) return application;
    throw Object.assign(
      new Error(
        `Authored render not found: ${RESERVED_AUTHORED_UI_OWNER_ID}/${applicationOwner.applicationId}.`,
      ),
      { code: "not_found" },
    );
  }
  const applications = await services
    .get(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE)
    .listApplications(context);
  const application = applications.find(
    (candidate) =>
      // The reserved authored-render owner never resolves from extension
      // publications, so a manifest claiming the identity cannot shadow it.
      candidate.ownerId !== RESERVED_AUTHORED_UI_OWNER_ID &&
      candidate.ownerId === applicationOwner.extensionId &&
      candidate.id === applicationOwner.applicationId,
  );
  if (application) return application;
  throw Object.assign(
    new Error(
      `Runtime UI application not found: ${applicationOwner.extensionId}/${applicationOwner.applicationId}.`,
    ),
    { code: "not_found" },
  );
}

function jsonObject(value: unknown, label: string): { readonly [key: string]: RuntimeUiJsonValue } {
  const source = record(value);
  const result: Record<string, RuntimeUiJsonValue> = {};
  for (const [key, field] of Object.entries(source)) {
    result[key] = jsonValue(field, `${label}.${key}`);
  }
  return result;
}

function jsonValue(value: unknown, label: string): RuntimeUiJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value))
    return value.map((item, index) => jsonValue(item, `${label}[${index}]`));
  if (typeof value === "object") return jsonObject(value, label);
  throw new TypeError(`Runtime UI ${label} must contain only JSON values.`);
}

function assertOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError("Runtime UI content contains unsupported properties.");
  }
}
