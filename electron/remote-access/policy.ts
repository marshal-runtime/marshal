import { z } from "zod";

import { RemotePushPrefsSchema } from "../../common/remote-push";
const id = z.string().min(1).max(512);
const text = z.string().max(1_000_000);
const optional = <T extends z.ZodType>(schema: T) =>
  schema.nullish().transform((v) => v ?? undefined);
const none = z.tuple([]);
const one = z.tuple([id]);
const page = optional(
  z
    .object({
      messageLimit: z.number().int().min(0).max(200).optional(),
      beforeMessageId: id.optional(),
      limit: z.number().int().min(1).max(200).optional(),
    })
    .strict(),
);
const attachments = optional(
  z
    .array(
      z
        .object({ type: z.literal("file"), path: id, displayName: z.string().max(512).optional() })
        .strict(),
    )
    .max(20),
);
export const remoteSchemas: Record<string, z.ZodTuple> = {
  "sessions:list": z.tuple([optional(z.string().max(500))]),
  "sessions:listWithOptions": z.tuple([
    optional(
      z
        .object({
          query: z.string().max(500).optional(),
          limit: z.number().int().min(1).max(200).optional(),
          beforeSessionId: id.optional(),
        })
        .strict(),
    ),
  ]),
  "sessions:create": z.tuple([
    optional(id),
    optional(id),
    z
      .object({
        source: z.literal("user"),
        setActive: z.literal(false),
        name: z.string().max(200).optional(),
        workspaceName: id.optional(),
      })
      .strict(),
  ]),
  "sessions:get": z.tuple([id, page]),
  "sessions:getMessages": z.tuple([id, page]),
  "sessions:getToolCallDetails": z.tuple([id, id, z.number().int().min(0)]),
  "sessions:getView": one,
  "sessions:subscribeView": one,
  "sessions:unsubscribeView": one,
  "sessions:resyncView": one,
  "sessions:ackView": z.tuple([id, id, z.number().int().min(0)]),
  "sessions:compact": one,
  "sessions:mark-read": one,
  "sessions:rename": z.tuple([id, z.string().min(1).max(200), optional(z.boolean())]),
  "sessions:setPinned": z.tuple([id, z.boolean()]),
  "sessions:setModel": z.tuple([id, id]),
  "sessions:patchQuestionSelection": z.tuple([id, id, text]),
  "copilot:init": none,
  "copilot:checkAuth": none,
  "copilot:getVersion": none,
  "copilot:send": z.tuple([text, id, attachments, id]),
  "copilot:steer": z.tuple([text, id, attachments, id]),
  "copilot:abort": one,
  "copilot:saveImage": z.tuple([
    z.string().max(14_000_000),
    z.enum(["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"]),
  ]),
  "copilot:resolvePermission": z.tuple([
    id,
    z.enum(["allow", "allow-session", "always-allow", "allow-type", "allow-all", "deny"]),
    optional(z.string().max(4096)),
  ]),
  "models:list": none,
  "models:getDefault": none,
  "models:getSessionModel": one,
  "models:getSessionReasoningEffort": one,
  "models:getSessionContextTier": one,
  "models:getDefaultReasoningEffort": one,
  "models:getDefaultContextTier": one,
  "models:setSessionReasoningEffort": z.tuple([
    id,
    optional(z.enum(["low", "medium", "high", "xhigh", "max"])),
  ]),
  "models:setSessionContextTier": z.tuple([id, optional(z.enum(["default", "long_context"]))]),
  "settings:get": none,
  "permissions:get-cards": one,
  "permissions:clear-cards": one,
  "permissions:get-config": none,
  "soul:list": none,
  "soul:getDefault": none,
  "soul:getSessionSoul": one,
  "soul:getGreeting": one,
  "runtimeAuth:getStatus": none,
  "identity:get": none,
  "workspace:listWorkspaces": none,
  "workspace:searchFiles": z.tuple([optional(id), z.string().max(1024)]),
  "backend:capabilities": none,
  ...runtimeUiSchemas(),
  ...pushSchemas(),
};

// Phone-only methods served by the remote controller itself (no desktop IPC twin).
function pushSchemas(): Record<string, z.ZodTuple> {
  const endpoint = z.string().url().max(2048);
  return {
    "remote:presence": z.tuple([z.boolean()]),
    "remote:push-status": z.tuple([optional(endpoint)]),
    "remote:push-subscribe": z.tuple([
      z.object({
        endpoint,
        keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
      }),
      RemotePushPrefsSchema,
    ]),
    "remote:push-unsubscribe": z.tuple([endpoint]),
  };
}

// Runtime-extension UI on the phone: list published applications, open them
// through placement activation, and run the packaged-UI bridge (capability
// invokes, resource reads, live instance events). The handlers re-validate
// scope and instance ownership exactly as they do for the desktop renderer;
// these schemas only bound the shapes at the network boundary. Raw surface
// mutation (runtime-ui:open / runtime-ui:update) and the evidence surface
// deliberately stay desktop-only.
function runtimeUiSchemas(): Record<string, z.ZodTuple> {
  const workspaceName = z.string().min(1).max(200);
  const applicationScope = z.enum(["user", "workspace"]);
  const uiScope = z
    .object({
      sessionId: id.optional(),
      workspaceName,
      applicationScope: applicationScope.optional(),
    })
    .strict();
  const uiOwner = uiScope.extend({ extensionId: id, applicationId: id }).strict();
  const uiInstance = uiOwner.extend({ instanceId: id, idempotencyKey: id }).strict();
  return {
    "runtime-ui:getPlacements": z.tuple([uiScope]),
    "runtime-ui:getSnapshot": z.tuple([uiScope]),
    "runtime-ui:subscribe": z.tuple([uiScope]),
    "runtime-ui:unsubscribe": z.tuple([optional(uiScope)]),
    "runtime-ui:list": z.tuple([
      uiScope
        .extend({
          owner: z.object({ extensionId: id, applicationId: id }).strict().optional(),
        })
        .strict(),
    ]),
    "runtime-ui:activatePlacement": z.tuple([
      uiOwner
        .extend({
          idempotencyKey: id,
          placementId: z.string().max(200).optional(),
          input: z.record(z.string(), z.unknown()).optional(),
        })
        .strict(),
    ]),
    // A surface moves the view (the phone's long-press "Move to…"); same authority as focus.
    "runtime-ui:focus": z.tuple([
      uiInstance
        .extend({
          surface: z
            .enum(["inline-card", "fullscreen", "tab", "panel", "bottom-panel", "floating"])
            .optional(),
        })
        .strict(),
    ]),
    "runtime-ui:close": z.tuple([uiInstance]),
    "runtime-ui:invokeCapability": z.tuple([
      uiInstance
        .extend({
          capability: z.string().min(1).max(500),
          publicationRevisionId: z.string().max(500).optional(),
          input: z.unknown().optional(),
        })
        .strict(),
    ]),
    "runtime-ui:cancelCapability": z.tuple([uiInstance]),
    "runtime-ui:readResource": z.tuple([
      uiOwner.extend({ instanceId: id, uri: z.string().min(1).max(2048) }).strict(),
    ]),
    "runtime-ui:getSelectedSession": z.tuple([uiOwner.extend({ instanceId: id }).strict()]),
    "runtime-ui:selectSession": z.tuple([
      uiOwner.extend({ instanceId: id, targetSessionId: id.optional() }).strict(),
    ]),
    "runtime-ui:searchSessions": z.tuple([
      uiOwner
        .extend({
          instanceId: id,
          query: z.string().max(500),
          limit: z.number().int().min(1).max(50).optional(),
        })
        .strict(),
    ]),
  };
}
export function validateRemoteArgs(method: string, args: unknown[]): unknown[] {
  const schema = remoteSchemas[method];
  if (!schema) throw new Error("This action is available only on the Mac.");
  // IPC optional trailing parameters can be omitted; JSON turns explicit undefined into null.
  const tuple = schema;
  const padded = [...args];
  while (padded.length < tuple.def.items.length) padded.push(undefined);
  const result = schema.safeParse(padded);
  if (!result.success) throw new Error(`Invalid arguments for ${method}`);
  return result.data;
}
export const remoteEvents = new Set([
  "session:view",
  "sessions:status-delta",
  "sessions:list-changed",
  "session:metadata-changed",
  "sessions:hydration-changed",
  "permissions:cards-changed",
  "settings:changed",
  "identity:change",
  "copilot:authError",
  "runtimeAuth:authError",
  // Invalidation signal for the published-application list on the phone.
  // runtime-ui:event is NOT broadcast: it is delivered per-socket through the
  // scoped subscription path in runtime-ui-ipc.
  "runtime-extensions:changed",
]);
