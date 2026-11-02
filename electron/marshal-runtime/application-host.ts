import {
  RUNTIME_PROTOCOL_VERSION,
  type InvocationContext,
  type RuntimeServiceContainer,
} from "@marshal/runtime";
import {
  RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE,
  type RuntimeExtensionUiPublishedApplication,
} from "@marshal/runtime/extensions";

import {
  runtimeUiScopeOf,
  runtimeUiScopeKey,
  type RuntimeUiApplicationCapabilityInvokeCommand,
  type RuntimeUiApplicationContent,
  type RuntimeUiInstance,
  type RuntimeUiOwner,
  type RuntimeUiScope,
  type RuntimeUiSelectedSession,
} from "../../common/runtime-ui";
import { findPublishedUiApplication } from "../ipc/runtime-ui-packaged-resource";
import { RuntimeApplicationAuthority } from "./application-authority";
import type { ApplicationJobInvocation } from "./application-jobs";
import type {
  MarshalRuntimeApi,
  MarshalRuntimeApiResult,
  MarshalRuntimeInvocationValue,
} from "./contracts";
import type { MarshalRuntimeHost } from "./host";
import { RuntimeIdempotencyStore } from "./idempotency";
import { normalizeRuntimeApiError } from "./runtime-api-error";
import type { SelectedSessionDeliveryService } from "./selected-session-delivery";

type ApplicationInstance = RuntimeUiInstance & { readonly content: RuntimeUiApplicationContent };

export class RuntimeApplicationHost {
  private readonly selections = new Map<string, RuntimeUiSelectedSession>();
  private readonly selectionQueues = new Map<string, Promise<RuntimeUiSelectedSession | null>>();
  private readonly ownerSelectionPromises = new Map<string, Promise<RuntimeUiSelectedSession>>();
  private readonly idempotency = new RuntimeIdempotencyStore();

  constructor(
    private readonly options: {
      services: RuntimeServiceContainer;
      authority: RuntimeApplicationAuthority;
      runtime: MarshalRuntimeHost;
      api: MarshalRuntimeApi;
      delivery: SelectedSessionDeliveryService;
      resolveWorkspace(scope: RuntimeUiScope): Promise<string | null>;
    },
  ) {}

  async isOwnerActive(owner: RuntimeUiOwner): Promise<boolean> {
    return Boolean(
      (await this.applications(owner)).find(
        (application) =>
          application.ownerId === owner.extensionId && application.id === owner.applicationId,
      ),
    );
  }

  async isCapabilityOwned(owner: RuntimeUiOwner, capability: string): Promise<boolean> {
    const publication = (await this.applications(owner)).find(
      (candidate) =>
        candidate.ownerId === owner.extensionId && candidate.id === owner.applicationId,
    );
    return Boolean(
      publication &&
      applicationCapabilities(publication).has(capability) &&
      (await this.options.runtime.ownsExtensionCapability(owner.extensionId, capability)),
    );
  }

  async invokeJob(
    job: ApplicationJobInvocation,
    capability: string,
    input: unknown,
    caller: InvocationContext,
  ): Promise<unknown> {
    const publication = (await this.applications(job.owner)).find(
      (candidate) =>
        candidate.ownerId === job.owner.extensionId && candidate.id === job.owner.applicationId,
    );
    if (!publication || !(await job.isActive()))
      throw new Error("The application job is inactive.");
    const publishedCapabilities = applicationCapabilities(publication);
    const capabilities = new Set(
      [...job.capabilities].filter((name) => publishedCapabilities.has(name)),
    );
    if (!capabilities.has(capability))
      throw new Error("The application job capability is not published.");
    const revision = publication.revisionId;
    const workspace = await this.options.runtime.resolveScope(
      job.executionScope,
      caller.signal instanceof AbortSignal ? caller.signal : undefined,
    );
    return this.options.authority.run(
      {
        owner: job.owner,
        capabilities,
        workspacePath: workspace.workspacePath,
        executionScope: job.executionScope,
        backgroundJobInvocationId: job.invocationId,
        isActive: async () => {
          if (caller.signal?.aborted) return false;
          if (!(await job.isActive())) return false;
          return (await this.applications(job.owner)).some(
            (candidate) =>
              candidate.ownerId === job.owner.extensionId &&
              candidate.id === job.owner.applicationId &&
              candidate.revisionId === revision,
          );
        },
      },
      async (context) => {
        const response = await this.options.runtime.executeApplication(
          {
            protocolVersion: RUNTIME_PROTOCOL_VERSION,
            targetType: "operation",
            target: capability,
            input,
            requestId: job.invocationId,
          },
          {
            ...context,
            requestId: job.invocationId,
            ...(caller.signal instanceof AbortSignal ? { signal: caller.signal } : {}),
          },
        );
        if (response.status !== "success" || !response.result) {
          const error = normalizeRuntimeApiError(
            response.error ?? new Error(`Application job ended with ${response.status}.`),
          );
          throw Object.assign(new Error(error.message), { code: error.code });
        }
        return response.result.output;
      },
    );
  }

  async selectSession(
    instance: RuntimeUiInstance,
    targetSessionId?: string,
  ): Promise<RuntimeUiSelectedSession | null> {
    if (instance.owner.sessionId) {
      if (targetSessionId !== instance.owner.sessionId)
        throw new Error("A session-owned application is bound to its originating session.");
      return this.getSelectedSession(instance);
    }
    const previousOperation = this.selectionQueues.get(instance.instanceId) ?? Promise.resolve();
    const operation = previousOperation
      .catch(() => undefined)
      .then(async () => {
        if (!(await this.isOwnerActive(instance.owner)))
          throw new Error("The application is no longer active.");
        const previous = this.selections.get(instance.instanceId);
        if (previous) await this.options.delivery.revokeGrant(instance.owner, previous.grantId);
        this.selections.delete(instance.instanceId);
        if (!targetSessionId) return null;
        return this.mintSelection(instance, targetSessionId);
      });
    this.selectionQueues.set(instance.instanceId, operation);
    const release = () => {
      if (this.selectionQueues.get(instance.instanceId) === operation)
        this.selectionQueues.delete(instance.instanceId);
    };
    void operation.then(release, release);
    return operation;
  }

  async getSelectedSession(instance: RuntimeUiInstance): Promise<RuntimeUiSelectedSession | null> {
    if (!(await this.isOwnerActive(instance.owner)))
      throw new Error("The application is no longer active.");
    const selection = this.selections.get(instance.instanceId);
    if (!selection) return instance.owner.sessionId ? this.ensureOwnerSelection(instance) : null;
    try {
      const target = await this.options.delivery.resolveGrant(instance.owner, selection.grantId);
      if (
        instance.owner.sessionId &&
        (target.sessionId !== instance.owner.sessionId ||
          target.workspaceName !== instance.owner.workspaceName)
      )
        throw new Error("The originating session's workspace is unavailable.");
      return selection;
    } catch (error) {
      this.selections.delete(instance.instanceId);
      await this.options.delivery
        .revokeGrant(instance.owner, selection.grantId)
        .catch(() => undefined);
      if (instance.owner.sessionId) throw error;
      return null;
    }
  }

  /**
   * Session-owned applications are trusted to use their originating session,
   * but still need a delivery grant so capability execution carries the same
   * authorization as a user-selected target. The owner and target are checked
   * again after minting to fail closed if the session/workspace became stale.
   */
  private async ensureOwnerSelection(
    instance: RuntimeUiInstance,
  ): Promise<RuntimeUiSelectedSession> {
    const pending = this.ownerSelectionPromises.get(instance.instanceId);
    if (pending) return pending;
    const operation = this.createOwnerSelection(instance);
    this.ownerSelectionPromises.set(instance.instanceId, operation);
    void operation.then(
      () => {
        if (this.ownerSelectionPromises.get(instance.instanceId) === operation)
          this.ownerSelectionPromises.delete(instance.instanceId);
      },
      () => {
        if (this.ownerSelectionPromises.get(instance.instanceId) === operation)
          this.ownerSelectionPromises.delete(instance.instanceId);
      },
    );
    return operation;
  }

  private async createOwnerSelection(
    instance: RuntimeUiInstance,
  ): Promise<RuntimeUiSelectedSession> {
    if (!(await this.isOwnerActive(instance.owner)))
      throw new Error("The application is no longer active.");
    const sessionId = instance.owner.sessionId;
    if (!sessionId) throw new Error("The application has no originating session.");
    return this.mintSelection(instance, sessionId, true);
  }

  private async mintSelection(
    instance: RuntimeUiInstance,
    sessionId: string,
    ownerBound = false,
  ): Promise<RuntimeUiSelectedSession> {
    const grant = await this.options.delivery.grant(instance.owner, sessionId);
    try {
      const target = await this.options.delivery.resolveGrant(instance.owner, grant.grantId);
      if (
        target.sessionId !== sessionId ||
        (ownerBound && target.workspaceName !== instance.owner.workspaceName)
      )
        throw new Error("The originating session's workspace is unavailable.");
      const selection = {
        grantId: grant.grantId,
        sessionId: target.sessionId,
        workspaceName: target.workspaceName,
      };
      this.selections.set(instance.instanceId, selection);
      return selection;
    } catch (error) {
      await this.options.delivery.revokeGrant(instance.owner, grant.grantId).catch(() => undefined);
      throw error;
    }
  }

  async invoke(
    instance: ApplicationInstance,
    request: RuntimeUiApplicationCapabilityInvokeCommand,
    signal: AbortSignal,
  ): Promise<MarshalRuntimeApiResult<MarshalRuntimeInvocationValue>> {
    try {
      if (!request.idempotencyKey?.trim() || request.idempotencyKey.length > 256)
        throw new Error("A bounded idempotency key is required.");
      const publication = findPublishedUiApplication(
        instance,
        await this.applications(instance.owner),
      );
      if (!publication) {
        if (instance.owner.applicationScope || !instance.owner.sessionId)
          throw new Error("The application is no longer published.");
        return this.options.api.invoke({
          ...request,
          sessionId: instance.owner.sessionId,
          workspaceName: instance.owner.workspaceName,
          origin: "runtime-ui",
          signal,
        });
      }
      const capabilities = applicationCapabilities(publication);
      if (!capabilities.has(request.capability))
        throw new Error("Capability is not declared by the current publication.");
      const selected = await this.getSelectedSession(instance);
      const executionScope = selected
        ? await this.options.delivery.resolveGrant(instance.owner, selected.grantId)
        : instance.owner.sessionId
          ? { sessionId: instance.owner.sessionId, workspaceName: instance.owner.workspaceName }
          : undefined;
      const workspacePath = executionScope
        ? (await this.options.runtime.resolveScope(executionScope, signal)).workspacePath
        : await this.options.resolveWorkspace(instance.owner);
      if (!workspacePath) throw new Error("Application workspace is unavailable.");
      const revision = publication.revisionId;
      const isActive = async () => {
        const current = findPublishedUiApplication(
          instance,
          await this.applications(instance.owner),
        );
        if (!current || current.revisionId !== revision) return false;
        if (selected) {
          const nowSelected = await this.getSelectedSession(instance);
          return nowSelected?.grantId === selected.grantId;
        }
        return true;
      };
      const execute = (
        invocationSignal: AbortSignal,
        approval?: Readonly<Record<string, unknown>>,
      ): Promise<MarshalRuntimeApiResult<MarshalRuntimeInvocationValue>> =>
        this.options.authority.run(
          {
            owner: instance.owner,
            capabilities,
            workspacePath,
            executionScope,
            ...(selected ? { grantId: selected.grantId } : {}),
            isActive,
          },
          async (context) => {
            const response = await this.options.runtime.executeApplication(
              {
                protocolVersion: RUNTIME_PROTOCOL_VERSION,
                targetType: "operation",
                target: request.capability,
                input: request.input,
                requestId: request.idempotencyKey,
                ...(approval ? { approval } : {}),
              },
              { ...context, requestId: request.idempotencyKey, signal: invocationSignal },
            );
            if (response.status === "success" && response.result)
              return {
                ok: true,
                value: { output: response.result.output, result: response.result },
                receipts: [response.receipt],
              };
            const error = normalizeRuntimeApiError(
              response.error ?? new Error(`Application operation ended with ${response.status}.`),
            );
            return {
              ok: false,
              error: {
                code:
                  response.status === "denied"
                    ? "permission-denied"
                    : response.status === "approval_required"
                      ? "approval-required"
                      : response.status === "cancelled"
                        ? "aborted"
                        : error.code,
                message: error.message,
                ...(response.approval ? { approval: response.approval } : {}),
              },
              receipts: [response.receipt],
            };
          },
        );
      const initial = await this.idempotency.execute(
        {
          operation: "application.invoke",
          identity: `${runtimeUiScopeKey(instance.owner)}\0${instance.owner.extensionId}\0${instance.owner.applicationId}`,
          idempotencyKey: request.idempotencyKey,
          payload: {
            capability: request.capability,
            input: request.input,
            executionScope,
            revision,
          },
          signal,
        },
        (invocationSignal) => execute(invocationSignal),
      );
      if (
        !initial.ok &&
        initial.error.code === "approval-required" &&
        initial.error.approval?.approvalId
      ) {
        const approvalId = initial.error.approval.approvalId;
        if (this.options.runtime.approvalStatus(approvalId) === "approved") {
          return this.idempotency.execute(
            {
              operation: "application.approved-invoke",
              identity: `${runtimeUiScopeKey(instance.owner)}\0${instance.owner.extensionId}\0${instance.owner.applicationId}`,
              idempotencyKey: request.idempotencyKey,
              payload: {
                capability: request.capability,
                input: request.input,
                executionScope,
                revision,
                approvalId,
              },
              signal,
            },
            (invocationSignal) => execute(invocationSignal, { approvalId }),
          );
        }
      }
      return initial;
    } catch (error) {
      return { ok: false, error: normalizeRuntimeApiError(error), receipts: [] };
    }
  }

  private async applications(
    scope: RuntimeUiScope,
  ): Promise<readonly RuntimeExtensionUiPublishedApplication[]> {
    const context: InvocationContext = {
      principal: { id: "marshal-native-ui", kind: "user" },
      scope: { ...runtimeUiScopeOf(scope) },
      metadata: {
        marshalWorkspaceName: scope.workspaceName,
        ...(scope.applicationScope ? { marshalApplicationScope: scope.applicationScope } : {}),
      },
    };
    return this.options.services
      .get(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE)
      .listApplications(context);
  }
}

function applicationCapabilities(publication: RuntimeExtensionUiPublishedApplication): Set<string> {
  const names = new Set<string>();
  for (const item of [...publication.application.actions, ...publication.application.tools]) {
    if (!item || typeof item !== "object") continue;
    if ("name" in item && typeof item.name === "string") names.add(item.name);
    if (
      "target" in item &&
      item.target &&
      typeof item.target === "object" &&
      "capability" in item.target &&
      typeof item.target.capability === "string"
    )
      names.add(item.target.capability);
  }
  return names;
}
