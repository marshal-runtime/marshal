import type { InvocationContext, RuntimeServiceContainer } from "@marshal/runtime";
import {
  RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE,
  resolveRuntimeExtensionUiPlacements,
  type RuntimeExtensionUiPlacement,
  type RuntimeExtensionUiPlacementDiagnostic,
  type RuntimeExtensionUiPlacementRegistration,
  type RuntimeExtensionUiPublishedApplication,
} from "@marshal/runtime/extensions";
import type { UiApplicationManifest } from "@marshal/runtime/ui";
import type { WebContents } from "electron";

import type {
  IpcHandler,
  IpcInvokeMap,
  RuntimeUiEvent,
  RuntimeUiError,
  RuntimeUiIpcResult,
  RuntimeUiResult,
  RuntimeUiScope,
} from "../../common/marshal-ipc-contract";
import type {
  RuntimeUiApplicationCapabilityInvokeCommand,
  RuntimeUiApplicationContent,
  RuntimeUiApplicationResourceContent,
  RuntimeUiApplicationResourceReadCommand,
  RuntimeUiInstance,
  RuntimeUiCommandResult,
  RuntimeUiPlacementApplication,
  RuntimeUiPlacementInvokeRequest,
  RuntimeUiPlacementMetadata,
  RuntimeUiPlacementSnapshot,
} from "../../common/runtime-ui";
import {
  RUNTIME_UI_EXTENSION_HOST_PLACEMENTS,
  RUNTIME_UI_PLACEMENT,
  runtimeUiScopeOf,
  runtimeUiScopeKey,
  RUNTIME_UI_HOST_PLACEMENTS,
  runtimeExtensionPlacementId,
} from "../../common/runtime-ui";
import { preferredUiSurfaceFromMetadata } from "../../common/runtime-ui-preferred-surface";
import { findRuntimeUiApplicationRendererPolicy } from "../../common/runtime-ui-renderers";
import { declaredUiViewportsFromMetadata } from "../../common/runtime-ui-viewports";
import type { MarshalRuntimeUiController } from "../marshal-runtime";
import type { MarshalRuntimeApi, MarshalRuntimeScope } from "../marshal-runtime/contracts";
import { RESERVED_AUTHORED_UI_OWNER_ID } from "../marshal-runtime/ui-providers";
import { sharedIpcHandleWithSender } from "../remote-access/shared-handlers";
import { isObserverWebContents } from "../ui-observe-window";
import {
  findPublishedUiApplication,
  readPublishedUiResource,
  readAuthoredRenderViewports,
  sealAuthoredUiResource,
} from "./runtime-ui-packaged-resource";

const MAX_PAUSE_REASON_LENGTH = 2_400;
const OWNED_APPLICATION_ID_SEPARATOR = ":";
const OWNED_APPLICATION_RESOURCE_PATTERN = /^[A-Za-z0-9._-]{1,256}$/;

/**
 * The slice of WebContents these handlers actually use. The remote-access
 * server satisfies it with a socket-backed sender per authenticated device, so
 * subscriptions and in-flight invocations behave identically for both
 * surfaces (scope routing, idempotency keying, teardown on destroy).
 */
type RuntimeUiEventSink = Pick<WebContents, "id" | "isDestroyed" | "send"> & {
  once(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
};

interface Subscription {
  readonly scopes: Map<string, RuntimeUiScope>;
  readonly sender: RuntimeUiEventSink;
}

export function registerRuntimeUiHandlers(options: {
  readonly ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => void;
  readonly controller: MarshalRuntimeUiController;
  readonly serviceContainer: RuntimeServiceContainer;
  readonly runtimeReady?: () => Promise<void>;
  readonly runtimeApi?: MarshalRuntimeApi;
  readonly invokeApplicationCapability?: (
    instance: RuntimeUiInstance & { readonly content: RuntimeUiApplicationContent },
    request: RuntimeUiApplicationCapabilityInvokeCommand,
    signal: AbortSignal,
  ) => ReturnType<MarshalRuntimeApi["invoke"]>;
  readonly readResource?: (
    scope: MarshalRuntimeScope,
    uri: string,
  ) => Promise<RuntimeUiApplicationResourceContent>;
}): () => void {
  // Registrations below through remoteIpcHandle are additionally reachable by
  // the authenticated remote (mobile) client via the remote-access server —
  // the same handler, with a socket-backed event.sender. Channels registered
  // through options.ipcHandle directly stay desktop-only (raw open/update and
  // the evidence surface).
  const remoteIpcHandle = sharedIpcHandleWithSender(options.ipcHandle);
  const subscriptions = new Map<number, Subscription>();
  const pendingInvocations = new Map<
    string,
    { readonly instanceId: string; readonly controller: AbortController }
  >();
  const invocationKey = (senderId: number, instanceId: string, idempotencyKey: string) =>
    JSON.stringify([senderId, instanceId, idempotencyKey]);
  const disposeListener = options.controller.subscribe((event) => {
    if (event.type === "instance-closed") {
      for (const invocation of pendingInvocations.values()) {
        if (invocation.instanceId === event.instanceId) invocation.controller.abort();
      }
    }
    for (const [id, subscription] of subscriptions) {
      if (subscription.sender.isDestroyed()) {
        subscriptions.delete(id);
        continue;
      }
      if ([...subscription.scopes.values()].some((scope) => isVisibleToScope(event, scope))) {
        subscription.sender.send("runtime-ui:event", event);
      }
    }
  });
  // Which client surface dispatched a command: remote-access sockets carry
  // negative sender ids (see remote-access/server.ts); renderer WebContents
  // ids are positive. Server-derived — any client-claimed origin is overridden.
  const commandOrigin = (event: unknown): "desktop" | "remote" => {
    const sender =
      typeof event === "object" && event !== null && "sender" in event ? event.sender : undefined;
    const senderId =
      typeof sender === "object" && sender !== null && "id" in sender ? sender.id : undefined;
    if (typeof senderId !== "number") return "desktop";
    // Observer capture windows are real renderers but must never steal the
    // user's desktop pane — treat them like remote clients (observe-not-follow).
    return senderId < 0 || isObserverWebContents(senderId) ? "remote" : "desktop";
  };
  const awaitRuntimeReady = async (): Promise<void> => {
    await options.runtimeReady?.();
  };

  options.ipcHandle("runtime-ui:getEvidence", async (_event, scope) => {
    try {
      requireSessionUiScope(scope);
      await awaitRuntimeReady();
      const publication = options.serviceContainer.get(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE);
      const applications = await publication.listApplications(runtimeUiInvocationContext(scope));
      const entries: import("../../common/runtime-ui").RuntimeUiEvidenceEntry[] = [];
      const results = await Promise.all(
        applications.map(async (application) => {
          const capability = evidenceCapability(application, "marshal-evidence-list");
          if (!capability || !options.runtimeApi) return undefined;
          const result = await options.runtimeApi.invoke({
            ...scope,
            capability,
            input: {},
            idempotencyKey: `evidence-list:${crypto.randomUUID()}`,
            origin: "runtime-ui",
            // This runs automatically (mount / event / window focus): it must
            // never mint approval cards. A capability the policy would prompt
            // for or deny is skipped silently; the user can still reach it
            // through an explicit action, which keeps the normal approval flow.
            approvalPolicy: "forbid",
          });
          if (!result.ok) {
            if (
              result.error.code === "permission-denied" ||
              result.error.code === "approval-required"
            ) {
              return undefined;
            }
            throw new Error(result.error.message);
          }
          return { application, output: result.value.output };
        }),
      );
      for (const item of results) {
        if (!item) continue;
        const { application, output } = item;
        if (!isRecord(output) || !Array.isArray(output.entries)) continue;
        for (const entry of output.entries) {
          if (
            !isRecord(entry) ||
            typeof entry.id !== "string" ||
            typeof entry.title !== "string" ||
            typeof entry.status !== "string"
          )
            continue;
          entries.push({
            ...scope,
            extensionId: application.ownerId,
            applicationId: application.id,
            applicationTitle: application.title,
            id: entry.id,
            title: entry.title,
            status: entry.status,
          });
        }
      }
      return { success: true, value: entries };
    } catch (error) {
      return { success: false, error: runtimeUiHostError(error) };
    }
  });
  options.ipcHandle("runtime-ui:openEvidence", async (_event, request) => {
    try {
      requireSessionUiScope(request);
      if (
        (request.presentation !== undefined && request.presentation !== "embedded") ||
        typeof request.id !== "string" ||
        !request.id.trim() ||
        typeof request.idempotencyKey !== "string" ||
        !request.idempotencyKey.trim()
      )
        throw new Error("Evidence identity is required.");
      await awaitRuntimeReady();
      const publication = options.serviceContainer.get(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE);
      const applications = await publication.listApplications(runtimeUiInvocationContext(request));
      const application = applications.find(
        (candidate) =>
          candidate.ownerId === request.extensionId && candidate.id === request.applicationId,
      );
      const capability = application && evidenceCapability(application, "marshal-evidence-open");
      if (!capability || !options.runtimeApi)
        throw new Error("Evidence application is unavailable.");
      const result = await options.runtimeApi.invoke({
        sessionId: request.sessionId,
        workspaceName: request.workspaceName,
        capability,
        input: { id: request.id },
        idempotencyKey: request.idempotencyKey,
        origin: "runtime-ui",
      });
      if (!result.ok) throw new Error(result.error.message);
      return toIpcResult(
        await options.controller.list({
          sessionId: request.sessionId,
          workspaceName: request.workspaceName,
          owner: { extensionId: request.extensionId, applicationId: request.applicationId },
        }),
      );
    } catch (error) {
      return { success: false, error: runtimeUiHostError(error) };
    }
  });
  remoteIpcHandle("runtime-ui:getSnapshot", async (_event, request) => {
    await awaitRuntimeReady();
    return toIpcResult(await options.controller.snapshot(request));
  });
  remoteIpcHandle("runtime-ui:subscribe", async (event, request) => {
    await awaitRuntimeReady();
    const result = toIpcResult(await options.controller.snapshot(request));
    if (!result.success) return result;
    const sender = event.sender;
    const existing = subscriptions.get(sender.id);
    if (existing) existing.scopes.set(runtimeUiScopeKey(request), request);
    else {
      subscriptions.set(sender.id, {
        scopes: new Map([[runtimeUiScopeKey(request), request]]),
        sender,
      });
      sender.once("destroyed", () => subscriptions.delete(sender.id));
    }
    return result;
  });
  remoteIpcHandle("runtime-ui:unsubscribe", (event, scope) => {
    if (scope) {
      const subscription = subscriptions.get(event.sender.id);
      subscription?.scopes.delete(runtimeUiScopeKey(scope));
      if (subscription?.scopes.size === 0) subscriptions.delete(event.sender.id);
    } else subscriptions.delete(event.sender.id);
    return { success: true };
  });
  options.ipcHandle("runtime-ui:open", async (event, request) => {
    await awaitRuntimeReady();
    return toIpcResult(await options.controller.open({ ...request, origin: commandOrigin(event) }));
  });
  options.ipcHandle("runtime-ui:update", async (_event, request) => {
    await awaitRuntimeReady();
    return toIpcResult(await options.controller.update(request));
  });
  remoteIpcHandle("runtime-ui:focus", async (event, request) => {
    await awaitRuntimeReady();
    return toIpcResult(
      await options.controller.focus({ ...request, origin: commandOrigin(event) }),
    );
  });
  remoteIpcHandle("runtime-ui:close", async (_event, request) => {
    await awaitRuntimeReady();
    return toIpcResult(await options.controller.close(request));
  });
  remoteIpcHandle("runtime-ui:list", async (_event, request) => {
    await awaitRuntimeReady();
    return toIpcResult(await options.controller.list(request));
  });
  remoteIpcHandle("runtime-ui:getPlacements", async (_event, scope) => {
    requireRuntimeUiScope(scope);
    await awaitRuntimeReady();
    const publication = options.serviceContainer.get(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE);
    const invocationContext = runtimeUiInvocationContext(scope);
    const [state, applications] = await Promise.all([
      publication.resolvePlacementState(invocationContext),
      publication.listApplications(invocationContext),
    ]);
    const resolution = resolveRuntimeExtensionUiPlacements(
      RUNTIME_UI_EXTENSION_HOST_PLACEMENTS,
      state.placements.map(toRuntimeExtensionPlacementRegistration),
    );
    const applicationById = new Map<string, RuntimeExtensionUiPublishedApplication>(
      applications.map((application) => [
        applicationKey(application.ownerId, application.id),
        application,
      ]),
    );
    return {
      revision: 0,
      generatedAt: new Date().toISOString(),
      placements: resolution.placements.map((placement) => ({
        metadata: requireHostPlacementMetadata(placement.placementId),
        applications: placement.registrations
          .map((registration) => toDesktopPlacementApplication(registration, applicationById))
          .sort((left, right) =>
            applicationKey(left.extensionId, left.applicationId).localeCompare(
              applicationKey(right.extensionId, right.applicationId),
            ),
          ),
      })),
      diagnostics: resolution.diagnostics.map(toDesktopPlacementDiagnostic),
    } satisfies RuntimeUiPlacementSnapshot;
  });
  const activatePlacement = async (
    request: RuntimeUiPlacementInvokeRequest,
    origin: "desktop" | "remote",
  ): Promise<RuntimeUiIpcResult<RuntimeUiCommandResult>> => {
    if (!isPlacementActivationRequest(request)) {
      return {
        success: false,
        error: { code: "invalid-request", message: "Invalid placement activation request." },
      };
    }
    await awaitRuntimeReady();
    const publication = options.serviceContainer.get(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE);
    const context = runtimeUiInvocationContext(request);
    if (request.applicationScope && request.placementId !== RUNTIME_UI_PLACEMENT.NAV_PRIMARY) {
      return {
        success: false,
        error: {
          code: "permission-denied",
          message: "Persistent applications must open through a navigation contribution.",
        },
      };
    }
    if (request.placementId) {
      const state = await publication.resolvePlacementState(context);
      if (
        !state.placements.some(
          (placement) =>
            "ownerId" in placement &&
            placement.ownerId === request.extensionId &&
            placement.applicationId === request.applicationId &&
            placement.placementId === runtimeExtensionPlacementId(request.placementId!) &&
            placement.action === "augment",
        )
      ) {
        return {
          success: false,
          error: { code: "not-found", message: "Navigation contribution is no longer available." },
        };
      }
    }
    const applications = await publication.listApplications(context);
    const application = applications.find(
      (candidate) =>
        candidate.ownerId === request.extensionId && candidate.id === request.applicationId,
    );
    if (!application) {
      return {
        success: false,
        error: {
          code: "not-found",
          message: "Published Runtime UI application was not found.",
        },
      };
    }
    const policy = findRuntimeUiApplicationRendererPolicy(
      application.renderId,
      application.ownerId,
      application.id,
    );
    const capability =
      policy?.placementActivationCapability ??
      (request.input === undefined ? undefined : firstDeclaredCapability(application));
    if (capability && !request.applicationScope) {
      if (!options.runtimeApi) {
        return {
          success: false,
          error: {
            code: "runtime-unavailable",
            message: "Marshal Runtime capability invocation is unavailable.",
          },
        };
      }
      if (!declaredCapabilities(application.application).has(capability)) {
        return {
          success: false,
          error: {
            code: "permission-denied",
            message: "The application is not authorized for placement activation.",
          },
        };
      }
      const result = await options.runtimeApi.invoke({
        sessionId: request.sessionId!,
        workspaceName: request.workspaceName,
        capability,
        input: {
          sessionId: request.sessionId,
          ...(request.input ?? {}),
        },
        idempotencyKey: request.idempotencyKey,
        origin: "runtime-ui",
      });
      if (!result.ok) {
        return { success: false, error: runtimeUiHostError(result.error) };
      }
      return toIpcResult(
        await options.controller.list({
          ...runtimeUiScopeOf(request),
          owner: { extensionId: request.extensionId, applicationId: request.applicationId },
        }),
      );
    }
    const existing = await options.controller.list({
      ...runtimeUiScopeOf(request),
      owner: { extensionId: request.extensionId, applicationId: request.applicationId },
    });
    if (!existing.ok) return toIpcResult(existing);
    const instance = existing.value.instances?.[0];
    if (instance) {
      return toIpcResult(
        await options.controller.focus({
          ...instance.owner,
          instanceId: instance.instanceId,
          idempotencyKey: request.idempotencyKey,
          origin,
        }),
      );
    }
    return toIpcResult(
      await options.controller.open({
        ...runtimeUiScopeOf(request),
        origin,
        extensionId: request.extensionId,
        applicationId: request.applicationId,
        surface: request.applicationScope
          ? "tab"
          : (preferredUiSurfaceFromMetadata(application.metadata) ??
            (application.application.presentationModes.includes("fullscreen") &&
            application.application.presentationModes.length === 1
              ? "fullscreen"
              : application.application.presentationModes.includes("pip")
                ? "panel"
                : "inline-card")),
        content: {
          kind: "application",
          renderId: application.renderId,
          resource: {
            uri: application.resource.uri,
            mimeType: application.resource.mimeType ?? "text/plain",
            name: application.title,
          },
          descriptor: application.application,
        },
        idempotencyKey: request.idempotencyKey,
      }),
    );
  };
  const placementActivations = new Map<
    string,
    Promise<RuntimeUiIpcResult<RuntimeUiCommandResult>>
  >();
  remoteIpcHandle("runtime-ui:activatePlacement", (event, request) => {
    const origin = commandOrigin(event);
    if (!isPlacementActivationRequest(request)) return activatePlacement(request, origin);
    const key = JSON.stringify([
      runtimeUiScopeKey(request),
      request.extensionId,
      request.applicationId,
    ]);
    const previous = placementActivations.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => activatePlacement(request, origin));
    placementActivations.set(key, next);
    const release = () => {
      if (placementActivations.get(key) === next) placementActivations.delete(key);
    };
    void next.then(release, release);
    return next;
  });
  remoteIpcHandle("runtime-ui:invokeCapability", async (event, request) => {
    const key = invocationKey(event.sender.id, request.instanceId, request.idempotencyKey);
    if (pendingInvocations.has(key))
      return {
        success: false,
        error: {
          code: "operation-failed",
          message: "The application request is already in progress.",
        },
      };
    const cancellation = new AbortController();
    pendingInvocations.set(key, { instanceId: request.instanceId, controller: cancellation });
    const onDestroyed = () => cancellation.abort();
    event.sender.once("destroyed", onDestroyed);
    try {
      await awaitRuntimeReady();
      if (!options.runtimeApi && !options.invokeApplicationCapability)
        throw new Error("Marshal Runtime capability invocation is unavailable.");
      const instance = await requireApplicationInstance(options.controller, request);
      const policy = findRuntimeUiApplicationRendererPolicy(
        instance.content.renderId,
        instance.owner.extensionId,
        instance.owner.applicationId,
      );
      const declared = declaredCapabilities(instance.content.descriptor);
      const isPackaged = instance.content.resource.mimeType.split(";")[0].trim() === "text/html";
      const isAuthoredRender = instance.owner.extensionId === RESERVED_AUTHORED_UI_OWNER_ID;
      // Authored renders are content-addressed: the open-time descriptor came
      // from the host-resolved ui.applications.list projection and the render
      // id IS the immutable revision, so the instance itself is the
      // authoritative publication record (extension republish cannot occur).
      const published =
        !policy && isPackaged
          ? isAuthoredRender
            ? {
                revisionId: instance.content.renderId,
                application: instance.content.descriptor,
              }
            : findPublishedUiApplication(
                instance,
                await options.serviceContainer
                  .get(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE)
                  .listApplications(runtimeUiInvocationContext(instance.owner)),
              )
          : undefined;
      // Authored-render render-plane calls: the renderer template fetches its
      // compiled component, dispatches manifest-declared actions/tools, and
      // syncs render-local state through the render-tool plane. Route them
      // through the session-scoped render-tool API (extension-gated there,
      // with the runtime dispatcher enforcing the render's declared
      // actions/tools and scopes), bound to this instance's own render id so
      // an application cannot touch another render.
      if (
        isAuthoredRender &&
        isPackaged &&
        (request.capability === "marshal_get_react_payload" ||
          request.capability === "marshal_invoke_react_action" ||
          request.capability === "marshal_invoke_react_tool" ||
          request.capability === "marshal_update_react_state" ||
          request.capability === `marshal_render_react_${instance.content.renderId}`)
      ) {
        if (!options.runtimeApi || !request.sessionId) {
          throw new Error("Authored render payloads require a session-scoped runtime API.");
        }
        const inputRecord: Record<string, unknown> = isRecord(request.input)
          ? { ...request.input }
          : {};
        if (
          inputRecord.renderId !== undefined &&
          inputRecord.renderId !== instance.content.renderId
        ) {
          return {
            success: false,
            error: {
              code: "permission-denied",
              message: "Render identity does not match this application.",
            },
          };
        }
        const payload = await options.runtimeApi.invokeRenderTool({
          sessionId: request.sessionId,
          workspaceName: request.workspaceName,
          name: request.capability,
          input: { ...inputRecord, renderId: instance.content.renderId },
          idempotencyKey: request.idempotencyKey,
          signal: cancellation.signal,
        });
        return payload.ok
          ? { success: true, value: { output: payload.value } }
          : { success: false, error: runtimeUiHostError(payload.error) };
      }
      if (
        !policy &&
        isPackaged &&
        !isAuthoredRender &&
        published &&
        request.publicationRevisionId !== published.revisionId
      ) {
        return {
          success: false,
          error: {
            code: "permission-denied",
            message:
              "This application bundle is stale. Reload the current extension revision before invoking capabilities.",
          },
        };
      }
      if (
        !policy &&
        isPackaged &&
        (!published || !declaredCapabilities(published.application).has(request.capability))
      ) {
        return {
          success: false,
          error: {
            code: "permission-denied",
            message: "The active extension publication does not authorize this capability.",
          },
        };
      }
      if (
        policy
          ? !policy.capabilities.includes(request.capability)
          : !declared.has(request.capability)
      ) {
        return {
          success: false,
          error: {
            code: "permission-denied",
            message: "The application renderer is not authorized to invoke this capability.",
          },
        };
      }
      const input = normalizeOwnedApplicationInput(instance, request.input);
      if (!options.invokeApplicationCapability && !request.sessionId) {
        throw new Error(
          "This host has not configured capability execution for persistent applications.",
        );
      }
      const result = options.invokeApplicationCapability
        ? await options.invokeApplicationCapability(
            instance,
            { ...request, input },
            cancellation.signal,
          )
        : await options.runtimeApi!.invoke({
            sessionId: request.sessionId!,
            workspaceName: request.workspaceName,
            capability: request.capability,
            input,
            idempotencyKey: request.idempotencyKey,
            origin: "runtime-ui",
            signal: cancellation.signal,
          });
      return result.ok
        ? { success: true, value: { output: result.value.output } }
        : { success: false, error: runtimeUiHostError(result.error) };
    } catch (error) {
      return { success: false, error: runtimeUiHostError(error) };
    } finally {
      pendingInvocations.delete(key);
      event.sender.removeListener("destroyed", onDestroyed);
    }
  });
  remoteIpcHandle("runtime-ui:cancelCapability", async (event, request) => {
    const pending = pendingInvocations.get(
      invocationKey(event.sender.id, request.instanceId, request.idempotencyKey),
    );
    pending?.controller.abort();
    return { success: true, value: { cancelled: Boolean(pending) } };
  });
  remoteIpcHandle("runtime-ui:readResource", async (_event, request) => {
    try {
      await awaitRuntimeReady();
      const instance = await requireApplicationInstance(options.controller, request);
      const policy = findRuntimeUiApplicationRendererPolicy(
        instance.content.renderId,
        instance.owner.extensionId,
        instance.owner.applicationId,
      );
      if (!policy) {
        if (
          instance.owner.extensionId === RESERVED_AUTHORED_UI_OWNER_ID &&
          request.uri === instance.content.resource.uri
        ) {
          // Authored renders publish no inline resource text; the renderer
          // template resolves through the runtime resource port under the
          // requesting session's own scope.
          if (!options.readResource) {
            throw new Error("Marshal Runtime resource access is unavailable.");
          }
          if (!request.sessionId) {
            throw new Error("Authored render resources require a session scope.");
          }
          const scope = { sessionId: request.sessionId, workspaceName: request.workspaceName };
          const [template, viewports] = await Promise.all([
            options.readResource(scope, request.uri),
            readAuthoredRenderViewports(options.runtimeApi, scope, instance.content.renderId),
          ]);
          return {
            success: true,
            value: sealAuthoredUiResource(template, instance.content.renderId, viewports),
          };
        }
        const publication = options.serviceContainer.get(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE);
        const published = findPublishedUiApplication(
          instance,
          await publication.listApplications(runtimeUiInvocationContext(instance.owner)),
        );
        if (published && published.resource.uri === request.uri) {
          return { success: true, value: readPublishedUiResource(published, request.uri) };
        }
      }
      if (!policy?.resourceUris.includes(request.uri)) {
        return {
          success: false,
          error: {
            code: "permission-denied",
            message: "The application renderer is not authorized to read this resource.",
          },
        };
      }
      if (!options.readResource) throw new Error("Marshal Runtime resource access is unavailable.");
      if (!request.sessionId)
        throw new Error("This native renderer resource requires a session scope.");
      return {
        success: true,
        value: await options.readResource(
          { sessionId: request.sessionId, workspaceName: request.workspaceName },
          request.uri,
        ),
      };
    } catch (error) {
      return { success: false, error: runtimeUiHostError(error) };
    }
  });

  return () => {
    subscriptions.clear();
    for (const invocation of pendingInvocations.values()) invocation.controller.abort();
    pendingInvocations.clear();
    disposeListener();
  };
}

function isPlacementActivationRequest(value: unknown): value is RuntimeUiPlacementInvokeRequest {
  if (!isRecord(value)) return false;
  const required = ["workspaceName", "extensionId", "applicationId", "idempotencyKey"];
  const allowed = new Set([...required, "sessionId", "applicationScope", "placementId", "input"]);
  if (!Object.keys(value).every((key) => allowed.has(key))) return false;
  if (!required.every((key) => typeof value[key] === "string" && Boolean(value[key].trim())))
    return false;
  if (value.applicationScope !== undefined) {
    if (
      (value.applicationScope !== "user" && value.applicationScope !== "workspace") ||
      value.sessionId !== undefined
    )
      return false;
  } else if (typeof value.sessionId !== "string" || !value.sessionId.trim()) return false;
  return (
    (value.placementId === undefined || typeof value.placementId === "string") &&
    (value.input === undefined || isRecord(value.input))
  );
}

export function runtimeUiInvocationContext(scope: RuntimeUiScope): InvocationContext {
  return {
    principal: { id: "marshal-renderer", kind: "user" },
    scope: scope.applicationScope ? {} : { sessionId: scope.sessionId },
    metadata: {
      marshalWorkspaceName: scope.workspaceName,
      ...(scope.applicationScope ? { marshalApplicationScope: scope.applicationScope } : {}),
    },
  };
}

function requireRuntimeUiScope(value: unknown): asserts value is RuntimeUiScope {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["sessionId", "workspaceName", "applicationScope"]) ||
    typeof value.workspaceName !== "string" ||
    !value.workspaceName.trim()
  ) {
    throw new TypeError("Runtime UI scope requires a workspace name.");
  }
  if (value.applicationScope === "user" || value.applicationScope === "workspace") {
    if (value.sessionId !== undefined)
      throw new TypeError("Persistent application owners cannot contain a session ID.");
  } else if (
    value.applicationScope !== undefined ||
    typeof value.sessionId !== "string" ||
    !value.sessionId.trim()
  ) {
    throw new TypeError("Runtime UI scope requires an explicit session or application owner.");
  }
}

function requireSessionUiScope(
  value: RuntimeUiScope,
): asserts value is RuntimeUiScope & { readonly sessionId: string } {
  requireRuntimeUiScope(runtimeUiScopeOf(value));
  if (value.applicationScope || !value.sessionId)
    throw new TypeError("Evidence operations require a session owner.");
}

function requireHostPlacementMetadata(placementId: string): RuntimeUiPlacementMetadata {
  const placement = RUNTIME_UI_HOST_PLACEMENTS.find(
    (candidate) => runtimeExtensionPlacementId(candidate.id) === placementId,
  );
  if (!placement) throw new Error(`Runtime UI host placement is not registered: ${placementId}`);
  return placement;
}

function toRuntimeExtensionPlacementRegistration(
  placement: RuntimeExtensionUiPlacement,
): RuntimeExtensionUiPlacementRegistration {
  const extensionId =
    "ownerId" in placement && typeof placement.ownerId === "string" ? placement.ownerId.trim() : "";
  if (!extensionId) {
    throw new Error("Runtime UI publication returned a placement without an extension owner.");
  }
  return placement.action === "replace"
    ? {
        extensionId,
        placementId: placement.placementId,
        applicationId: placement.applicationId,
        action: placement.action,
        ...(placement.replacement ? { replacement: placement.replacement } : {}),
      }
    : {
        extensionId,
        placementId: placement.placementId,
        applicationId: placement.applicationId,
        action: placement.action,
      };
}

function applicationKey(extensionId: string, applicationId: string): string {
  return `${extensionId}\0${applicationId}`;
}

function toDesktopPlacementApplication(
  registration: RuntimeExtensionUiPlacementRegistration,
  applications: ReadonlyMap<string, RuntimeExtensionUiPublishedApplication>,
): RuntimeUiPlacementApplication {
  const application = applications.get(
    applicationKey(registration.extensionId, registration.applicationId),
  );
  if (!application) {
    throw new Error(
      `Runtime UI placement references an unpublished application: ${registration.extensionId}/${registration.applicationId}`,
    );
  }
  const manifest: UiApplicationManifest | undefined = application.application;
  // Deliberate declaration only: the publication's metadata record
  // (marshal.ui.viewports). Document markup is never a signal — the runtime
  // stamps a responsive viewport meta on every compiled artifact wrapper.
  const declaredViewports = declaredUiViewportsFromMetadata(application.metadata);
  return {
    extensionId: registration.extensionId,
    applicationId: registration.applicationId,
    title: application.title,
    description: application.description,
    renderId: application.renderId,
    action: registration.action,
    ...(declaredViewports ? { viewports: [...declaredViewports] } : {}),
    ...(registration.action === "replace" && registration.replacement
      ? { replacement: registration.replacement }
      : {}),
    ...(manifest ? { actions: manifest.actions, tools: manifest.tools } : {}),
    ...(application.revisionId ? { revisionId: application.revisionId } : {}),
  };
}

function toDesktopPlacementDiagnostic(
  diagnostic: RuntimeExtensionUiPlacementDiagnostic,
): RuntimeUiPlacementSnapshot["diagnostics"][number] {
  return {
    id: `${diagnostic.code}:${diagnostic.placementId}:${diagnostic.extensionId}`,
    code:
      diagnostic.code === "RUNTIME_EXTENSION_UI_PLACEMENT_EXACT_COLLISION"
        ? "exact-target-collision"
        : "target-hierarchy-collision",
    severity: "error",
    message: diagnostic.message,
    repairHint: diagnostic.repairHint,
    placementId: diagnostic.placementId,
    targets: [diagnostic.placementId, ...diagnostic.relatedIds],
    extensionIds: [diagnostic.extensionId],
    registrationIds: [],
  };
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

async function requireApplicationInstance(
  controller: MarshalRuntimeUiController,
  request: RuntimeUiApplicationCapabilityInvokeCommand | RuntimeUiApplicationResourceReadCommand,
): Promise<RuntimeUiInstance & { readonly content: RuntimeUiApplicationContent }> {
  const result = await controller.resolveApplicationCall({
    ...runtimeUiScopeOf(request),
    extensionId: request.extensionId,
    applicationId: request.applicationId,
    instanceId: request.instanceId,
    ...("capability" in request ? { capability: request.capability } : {}),
  });
  if (!result.ok && result.error.code !== "not-found") throw new Error(result.error.message);
  const instance = result.ok ? result.value : undefined;
  if (!instance || !isApplicationInstance(instance)) {
    throw new Error("Runtime UI application instance is not owned by this scope.");
  }
  return instance;
}

function isApplicationInstance(
  instance: RuntimeUiInstance,
): instance is RuntimeUiInstance & { readonly content: RuntimeUiApplicationContent } {
  return instance.content.kind === "application";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function declaredCapabilities(descriptor: {
  readonly actions: readonly unknown[];
  readonly tools: readonly unknown[];
}): Set<string> {
  const capabilities = new Set<string>();
  [...descriptor.actions, ...descriptor.tools].forEach((entry) => {
    if (!isRecord(entry)) return;
    const record = entry;
    const target = record["target"];
    if (isRecord(target)) {
      const capability = target["capability"];
      if (typeof capability === "string") capabilities.add(capability);
    }
    const name = record["name"];
    if (typeof name === "string") capabilities.add(name);
  });
  return capabilities;
}

function firstDeclaredCapability(
  application: RuntimeExtensionUiPublishedApplication,
): string | undefined {
  const declared = declaredCapabilities(application.application);
  const action = application.application.actions.find((entry) => {
    if (!isRecord(entry)) return false;
    const target = entry.target;
    return (
      isRecord(target) && typeof target.capability === "string" && declared.has(target.capability)
    );
  });
  if (!isRecord(action) || !isRecord(action.target)) return undefined;
  const capability = action.target.capability;
  return typeof capability === "string" ? capability : undefined;
}

function runtimeUiHostError(error: unknown): RuntimeUiError {
  const code = isRecord(error) ? error.code : undefined;
  const message =
    isRecord(error) && typeof error.message === "string"
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  switch (code) {
    case "aborted":
    case "cancelled":
    case "approval-required":
    case "idempotency-capacity":
    case "idempotency-conflict":
    case "invalid-request":
    case "not-found":
    case "permission-denied":
    case "runtime-unavailable":
    case "operation-failed":
      return { code, message };
    default:
      return {
        code:
          error instanceof Error && error.name === "AbortError" ? "aborted" : "operation-failed",
        message,
      };
  }
}

function toIpcResult<T>(result: RuntimeUiResult<T>): RuntimeUiIpcResult<T> {
  return result.ok
    ? { success: true, value: result.value }
    : { success: false, error: result.error };
}

function isVisibleToScope(event: RuntimeUiEvent, scope: RuntimeUiScope): boolean {
  return runtimeUiScopeKey(event.scope) === runtimeUiScopeKey(scope);
}

function normalizeOwnedApplicationInput(
  instance: RuntimeUiInstance & { readonly content: RuntimeUiApplicationContent },
  input: unknown,
): unknown {
  const separator = instance.owner.applicationId.lastIndexOf(OWNED_APPLICATION_ID_SEPARATOR);
  if (separator < 0) return input;
  const resourceId = instance.owner.applicationId.slice(separator + 1);
  if (!OWNED_APPLICATION_RESOURCE_PATTERN.test(resourceId)) {
    throw new Error("Application identity is invalid.");
  }
  if (!isRecord(input)) return input;
  const claimed =
    (typeof input.runId === "string" && input.runId) ||
    (typeof input.resourceId === "string" && input.resourceId) ||
    (typeof input.id === "string" && input.id);
  if (claimed && claimed !== resourceId) {
    throw new Error("Action is not owned by this application.");
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : undefined;
  return {
    ...input,
    ...(claimed ? { runId: resourceId } : {}),
    ...(reason ? { reason: reason.slice(0, MAX_PAUSE_REASON_LENGTH) } : {}),
  };
}

function evidenceCapability(
  application: RuntimeExtensionUiPublishedApplication,
  id: string,
): string | undefined {
  const action = application.application.actions.find(
    (entry) => isRecord(entry) && entry.id === id,
  );
  if (!isRecord(action) || !isRecord(action.target) || typeof action.target.capability !== "string")
    return undefined;
  return action.target.capability;
}
