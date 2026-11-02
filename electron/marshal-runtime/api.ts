import {
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeExecResponse,
  type RuntimeResourceToolDescriptor,
  type RuntimeResourceToolResult,
  type RuntimeSearchResponse,
} from "@marshal/runtime";
import type { RuntimeResourceContent } from "@marshal/runtime";
import type { RuntimeExecutionReceipt } from "@marshal/runtime/core";
import type {
  RuntimeExtensionContractRepairResult,
  RuntimeExtensionInstallRequest,
  RuntimeExtensionRecord,
} from "@marshal/runtime/extensions";

import {
  MARSHAL_RUNTIME_PERMISSION,
  type MarshalRuntimeApi,
  type MarshalRuntimeApiResult,
  type MarshalRuntimeExtensionInstallRequest,
  type MarshalRuntimeLocalExtensionInstallRequest,
  type MarshalRuntimeExtensionConfigurationRequest,
  type MarshalRuntimeExtensionContractRepairRequest,
  type MarshalRuntimeExtensionProviderRequest,
  type MarshalRuntimeReadResourceRequest,
  type MarshalRuntimeExtensionListRequest,
  type MarshalRuntimeExtensionRemoval,
  type MarshalRuntimeExtensionStateRequest,
  type MarshalRuntimeExtensionUpdateRequest,
  type MarshalRuntimeInvocationValue,
  type MarshalRuntimeInvokeRequest,
  type MarshalRuntimeModuleRequest,
  type MarshalRuntimeRenderToolInvokeRequest,
  type MarshalRuntimeRenderToolListRequest,
  type MarshalRuntimeScope,
  type MarshalRuntimeSearchRequest,
  type MarshalRuntimeTypeScriptRequest,
} from "./contracts";
import { MarshalRuntimeHost } from "./host";
import { RuntimeIdempotencyStore, type RuntimeIdempotencyOptions } from "./idempotency";
import { normalizeRuntimeApiError, RuntimeApiError } from "./runtime-api-error";
import { prepareAgentTypeScriptSource } from "./typescript-agent-source";

const MAX_QUERY_LENGTH = 4_000;
const MAX_CAPABILITY_LENGTH = 512;
const MAX_SOURCE_LENGTH = 2 * 1024 * 1024;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const MAX_EXTENSION_IDENTITY_LENGTH = 214;
const MAX_EXTENSION_PACKAGE_ROOT_LENGTH = 32_768;

function normalizeRequired(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) throw new RuntimeApiError("invalid-request", `${label} is required.`);
  if (normalized.length > maxLength) {
    throw new RuntimeApiError(
      "invalid-request",
      `${label} must be at most ${maxLength} characters.`,
    );
  }
  return normalized;
}

function normalizeScope(scope: MarshalRuntimeScope): MarshalRuntimeScope {
  return {
    sessionId: normalizeRequired(scope.sessionId, "Session ID", 256),
    workspaceName: normalizeRequired(scope.workspaceName, "Workspace name", 256),
  };
}

function normalizeIdempotencyKey(value: string): string {
  return normalizeRequired(value, "Idempotency key", MAX_IDEMPOTENCY_KEY_LENGTH);
}

function normalizeApproval(
  value: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (!value) return undefined;
  const approvalId =
    typeof value.approvalId === "string"
      ? normalizeRequired(value.approvalId, "Approval ID", 256)
      : "";
  if (!approvalId) {
    throw new RuntimeApiError("invalid-request", "Approval ID is required.");
  }
  return { approvalId };
}

function context(
  scope: MarshalRuntimeScope,
  workspacePath: string,
  requestId: string | undefined,
  signal: AbortSignal | undefined,
  origin?: "runtime-ui",
  approvalPolicy?: "forbid",
) {
  return {
    sessionId: scope.sessionId,
    workspacePath,
    ...(requestId ? { requestId } : {}),
    metadata: {
      marshalWorkspaceName: scope.workspaceName,
      ...(origin === "runtime-ui" ? { marshalRuntimeUi: true } : {}),
      ...(approvalPolicy === "forbid" ? { marshalApprovalPolicy: "forbid" } : {}),
    },
    ...(signal ? { signal } : {}),
  };
}

function failure<T>(
  error: unknown,
  receipts: readonly RuntimeExecutionReceipt[] = [],
): MarshalRuntimeApiResult<T> {
  const normalized = normalizeRuntimeApiError(error);
  return {
    ok: false,
    error: { code: normalized.code, message: normalized.message },
    receipts,
  };
}

function executionResult(
  response: RuntimeExecResponse,
): MarshalRuntimeApiResult<MarshalRuntimeInvocationValue> {
  const receipts = [response.receipt];
  if (response.status === "success" && response.result) {
    return {
      ok: true,
      value: { output: response.result.output, result: response.result },
      receipts,
    };
  }
  if (response.status === "failed" && response.error) {
    const normalized = normalizeRuntimeApiError(response.error);
    return {
      ok: false,
      error: {
        code: normalized.code,
        message: normalized.message,
      },
      receipts,
    };
  }
  const code =
    response.status === "cancelled"
      ? "aborted"
      : response.status === "denied"
        ? "permission-denied"
        : response.status === "approval_required"
          ? "approval-required"
          : response.status === "not_found"
            ? "not-found"
            : "operation-failed";
  return {
    ok: false,
    error: {
      code,
      message: normalizedResponseErrorMessage(response),
      ...(response.status === "approval_required" && response.approval
        ? { approval: response.approval }
        : {}),
    },
    receipts,
  };
}

function normalizedResponseErrorMessage(response: RuntimeExecResponse): string {
  const message = response.error?.message?.trim();
  return (message || `Marshal Runtime operation ended with ${response.status}.`).slice(0, 512);
}

function success<T>(value: T): MarshalRuntimeApiResult<T> {
  return { ok: true, value, receipts: [] };
}

function extensionPackageRoot(request: { readonly packageRoot: string }): string {
  return normalizeRequired(
    request.packageRoot,
    "Extension package root",
    MAX_EXTENSION_PACKAGE_ROOT_LENGTH,
  );
}

function extensionRequest(
  packageRoot: string,
  integrity: RuntimeExtensionInstallRequest["integrity"],
): RuntimeExtensionInstallRequest {
  return {
    packageRoot: normalizeRequired(
      packageRoot,
      "Extension package root",
      MAX_EXTENSION_PACKAGE_ROOT_LENGTH,
    ),
    integrity,
  };
}

/** Discovery listings are a DISCOVERY surface, not a records dump. Catalog
 *  entries can legally carry huge metadata (the runtime-composition catalog
 *  entry ships full service/contract declarations — observed 125KB in one
 *  entry, spilling the whole tool result past the Claude CLI's MCP token cap
 *  into a tool-results file the model then has to slice-read). Project every
 *  discovery to bounded identity + a clipped description, drop `metadata`,
 *  and point at runtimeReadResource on the entry id for the full record.
 *  Matches (capabilities, incl. exact-name full schemas) pass through
 *  untouched; nothing else in the response — errors, receipts, effective
 *  detail — is altered. */
const DISCOVERY_DESCRIPTION_MAX = 280;
const DISCOVERY_TAGS_MAX = 8;

function boundSearchDiscoveries(response: RuntimeSearchResponse): RuntimeSearchResponse {
  if (!response.discoveries || response.discoveries.length === 0) return response;
  const discoveries = response.discoveries.map((match) => {
    const { entry } = match;
    const description =
      entry.description.length > DISCOVERY_DESCRIPTION_MAX
        ? `${entry.description.slice(0, DISCOVERY_DESCRIPTION_MAX - 1)}…`
        : entry.description;
    const tags = entry.tags?.slice(0, DISCOVERY_TAGS_MAX);
    const metadataOmitted = entry.metadata !== undefined && Object.keys(entry.metadata).length > 0;
    // Readback route: the entry's OWN action already names the full record's
    // resource uri when it is a resource read (verified live shape:
    // {type: "resource_read", uri: "runtime://composition/…"}); only such a
    // uri is advertised — never an invented link.
    const action = entry.action as { type?: string; kind?: string; uri?: string } | undefined;
    const readbackUri =
      typeof action?.uri === "string" &&
      (action.type === "resource_read" || action.kind === "resource_read")
        ? action.uri
        : undefined;
    return {
      ...match,
      entry: {
        id: entry.id,
        kind: entry.kind,
        title: entry.title,
        description,
        ...(tags && tags.length > 0 ? { tags } : {}),
        action: entry.action,
        ...(metadataOmitted
          ? {
              metadata: {
                omitted: true,
                fullRecord: readbackUri
                  ? `runtimeReadResource {uri: ${JSON.stringify(readbackUri)}}`
                  : 'metadata omitted from discovery listings; re-search with detail:"full" or follow the entry action',
              },
            }
          : {}),
      },
    };
  });
  return { ...response, discoveries };
}

export class ProductionMarshalRuntimeApi implements MarshalRuntimeApi {
  private readonly idempotency: RuntimeIdempotencyStore;
  private readonly approvalIds = new Set<string>();

  private readonly typeScriptExecutionMode: "brokered" | "trusted_node";

  constructor(
    private readonly host: MarshalRuntimeHost,
    idempotencyOptions?: RuntimeIdempotencyOptions,
    options?: { readonly trustedTypeScript?: boolean },
  ) {
    this.idempotency = new RuntimeIdempotencyStore(idempotencyOptions);
    this.typeScriptExecutionMode = options?.trustedTypeScript ? "trusted_node" : "brokered";
  }

  async search(
    request: MarshalRuntimeSearchRequest,
  ): Promise<MarshalRuntimeApiResult<RuntimeSearchResponse>> {
    try {
      const scope = normalizeScope(request);
      const resolved = await this.host.resolveScope(scope, request.signal);
      const response = await this.host.search(
        {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          query: request.query?.slice(0, MAX_QUERY_LENGTH) ?? "",
          name: request.name,
          detail: request.detail,
          tags: request.tags,
          limit: request.limit,
          catalogId: request.catalogId,
        },
        context(scope, resolved.workspacePath, undefined, request.signal),
      );
      // Explicitly requested detail:"full" is honored verbatim — bounding
      // applies only to default/summary listings (documented in the tool).
      return {
        ok: true,
        value: request.detail === "full" ? response : boundSearchDiscoveries(response),
        receipts: [],
      };
    } catch (error) {
      return failure(error);
    }
  }

  async invoke(
    request: MarshalRuntimeInvokeRequest,
  ): Promise<MarshalRuntimeApiResult<MarshalRuntimeInvocationValue>> {
    try {
      const scope = normalizeScope(request);
      const capability = normalizeRequired(request.capability, "Capability", MAX_CAPABILITY_LENGTH);
      const idempotencyKey = normalizeIdempotencyKey(request.idempotencyKey);
      const requestedApproval = normalizeApproval(request.approval);
      const execute = async (
        signal: AbortSignal | undefined,
        approval: Readonly<Record<string, unknown>> | undefined,
      ) => {
        const cancelApproval = () => {
          const approvalId =
            approval && typeof approval.approvalId === "string" ? approval.approvalId.trim() : "";
          if (approvalId) this.host.cancelApproval(approvalId);
          else this.host.cancelApprovalsForRequest(scope.sessionId, idempotencyKey);
        };
        signal?.addEventListener("abort", cancelApproval, { once: true });
        try {
          const resolved = await this.host.resolveScope(scope, signal);
          return executionResult(
            await this.host.execute(
              {
                protocolVersion: RUNTIME_PROTOCOL_VERSION,
                targetType: "operation",
                target: capability,
                input: request.input,
                requestId: idempotencyKey,
                ...(approval ? { approval } : {}),
              },
              context(
                scope,
                resolved.workspacePath,
                idempotencyKey,
                signal,
                request.origin,
                request.approvalPolicy,
              ),
            ),
          );
        } finally {
          signal?.removeEventListener("abort", cancelApproval);
        }
      };
      if (requestedApproval) {
        return await execute(request.signal, requestedApproval);
      }
      const initial = await this.idempotency.execute(
        {
          operation: "capability.invoke",
          identity: `${scope.sessionId}\0${scope.workspaceName}`,
          idempotencyKey,
          payload: { capability, input: request.input },
          signal: request.signal,
          abortAfterStart: capability !== "marshal.memory.store",
        },
        (signal) => execute(signal, undefined),
      );
      if (
        !initial.ok &&
        initial.error.code === "approval-required" &&
        initial.error.approval?.approvalId
      ) {
        const approvalId = initial.error.approval.approvalId;
        this.approvalIds.add(approvalId);
        const status = this.host.approvalStatus(approvalId);
        if (status === "approved") {
          return await execute(request.signal, { approvalId });
        }
        if (status === "denied" || status === "expired" || status === "missing") {
          this.approvalIds.delete(approvalId);
          return {
            ok: false,
            error: {
              code: "permission-denied",
              message: `Marshal Runtime approval was rejected (${status}).`,
            },
            receipts: initial.receipts,
          };
        }
      }
      return initial;
    } catch (error) {
      return failure(error);
    }
  }

  async executeTypeScript(
    request: MarshalRuntimeTypeScriptRequest,
  ): Promise<MarshalRuntimeApiResult<MarshalRuntimeInvocationValue>> {
    try {
      const scope = normalizeScope(request);
      if (!request.source.trim()) {
        throw new RuntimeApiError("invalid-request", "TypeScript source is required.");
      }
      if (request.source.length > MAX_SOURCE_LENGTH) {
        throw new RuntimeApiError(
          "invalid-request",
          `TypeScript source must be at most ${MAX_SOURCE_LENGTH} characters.`,
        );
      }
      const idempotencyKey = normalizeIdempotencyKey(request.idempotencyKey);
      return await this.idempotency.execute(
        {
          operation: "typescript.execute",
          identity: `${scope.sessionId}\0${scope.workspaceName}`,
          idempotencyKey,
          payload: {
            source: request.source,
            input: request.input,
            timeoutMs: request.timeoutMs,
          },
          signal: request.signal,
        },
        async (signal) => {
          const resolved = await this.host.resolveScope(scope, signal);
          const source = request.agentAuthoring
            ? prepareAgentTypeScriptSource(request.source, {
                trusted: this.typeScriptExecutionMode === "trusted_node",
                workspacePath: resolved.workspacePath,
              })
            : request.source;
          return executionResult(
            await this.host.execute(
              {
                protocolVersion: RUNTIME_PROTOCOL_VERSION,
                targetType: "inline_module",
                source,
                input: request.input,
                timeoutMs: request.timeoutMs,
                executionMode: this.typeScriptExecutionMode,
                requestId: idempotencyKey,
              },
              context(scope, resolved.workspacePath, idempotencyKey, signal),
            ),
          );
        },
      );
    } catch (error) {
      return failure(error);
    }
  }

  async executeModule(
    request: MarshalRuntimeModuleRequest,
  ): Promise<MarshalRuntimeApiResult<MarshalRuntimeInvocationValue>> {
    try {
      const scope = normalizeScope(request);
      const idempotencyKey = normalizeIdempotencyKey(request.idempotencyKey);
      return await this.idempotency.execute(
        {
          operation: "module.execute",
          identity: `${scope.sessionId}\0${scope.workspaceName}`,
          idempotencyKey,
          payload: { module: request.module, input: request.input },
          signal: request.signal,
        },
        async (signal) => {
          const resolved = await this.host.resolveScope(scope, signal);
          return executionResult(
            await this.host.execute(
              {
                protocolVersion: RUNTIME_PROTOCOL_VERSION,
                targetType: "module",
                module: request.module,
                input: request.input,
                executionMode: this.typeScriptExecutionMode,
                requestId: idempotencyKey,
              },
              context(scope, resolved.workspacePath, idempotencyKey, signal),
            ),
          );
        },
      );
    } catch (error) {
      return failure(error);
    }
  }

  async listRenderTools(
    request: MarshalRuntimeRenderToolListRequest,
  ): Promise<MarshalRuntimeApiResult<readonly RuntimeResourceToolDescriptor[]>> {
    try {
      const scope = normalizeScope(request);
      const resolved = await this.host.resolveScope(scope, request.signal);
      await this.authorizeExtension(
        scope,
        "render-tool.list",
        MARSHAL_RUNTIME_PERMISSION.extensionList,
        {},
        request.signal,
      );
      return success(
        await this.host.listRenderTools(
          context(scope, resolved.workspacePath, undefined, request.signal),
        ),
      );
    } catch (error) {
      return failure(error);
    }
  }

  async invokeRenderTool(
    request: MarshalRuntimeRenderToolInvokeRequest,
  ): Promise<MarshalRuntimeApiResult<RuntimeResourceToolResult | undefined>> {
    try {
      const scope = normalizeScope(request);
      const name = normalizeRequired(request.name, "Render tool name", MAX_CAPABILITY_LENGTH);
      const idempotencyKey = normalizeIdempotencyKey(request.idempotencyKey);
      return await this.idempotency.execute(
        {
          operation: "render-tool.invoke",
          identity: `${scope.sessionId}\0${scope.workspaceName}`,
          idempotencyKey,
          payload: { name, input: request.input },
          signal: request.signal,
        },
        async (signal) => {
          const resolved = await this.host.resolveScope(scope, signal);
          await this.authorizeExtension(
            scope,
            "render-tool.invoke",
            MARSHAL_RUNTIME_PERMISSION.extensionList,
            { name, input: request.input },
            signal,
          );
          return success(
            await this.host.invokeRenderTool(
              name,
              request.input,
              context(scope, resolved.workspacePath, idempotencyKey, signal),
            ),
          );
        },
      );
    } catch (error) {
      return failure(error);
    }
  }

  async readResource(
    request: MarshalRuntimeReadResourceRequest,
  ): Promise<MarshalRuntimeApiResult<RuntimeResourceContent>> {
    try {
      const scope = normalizeScope(request);
      const uri = normalizeRequired(request.uri, "Resource URI", 4_096);
      const resolved = await this.host.resolveScope(scope, request.signal);
      await this.authorizeExtension(
        scope,
        "resource.read",
        MARSHAL_RUNTIME_PERMISSION.extensionList,
        { uri },
        request.signal,
      );
      return {
        ok: true,
        value: await this.host.readResource(
          uri,
          context(scope, resolved.workspacePath, undefined, request.signal),
        ),
        receipts: [],
      };
    } catch (error) {
      return failure(error);
    }
  }

  async listExtensions(
    request: MarshalRuntimeExtensionListRequest,
  ): Promise<MarshalRuntimeApiResult<readonly RuntimeExtensionRecord[]>> {
    try {
      const scope = normalizeScope(request);
      await this.authorizeExtension(
        scope,
        "list",
        MARSHAL_RUNTIME_PERMISSION.extensionList,
        {},
        request.signal,
      );
      return success(await this.host.listExtensions(request.signal));
    } catch (error) {
      return failure(error);
    }
  }

  async installExtension(
    request: MarshalRuntimeExtensionInstallRequest,
  ): Promise<MarshalRuntimeApiResult<RuntimeExtensionRecord>> {
    try {
      const scope = normalizeScope(request);
      const packageRequest = extensionRequest(request.packageRoot, request.integrity);
      const idempotencyKey = normalizeIdempotencyKey(request.idempotencyKey);
      return await this.idempotency.execute(
        {
          operation: "extension.install",
          identity: `${scope.sessionId}\0${scope.workspaceName}`,
          idempotencyKey,
          payload: packageRequest,
          signal: request.signal,
        },
        async (signal) => {
          await this.authorizeExtension(
            scope,
            "install",
            MARSHAL_RUNTIME_PERMISSION.extensionInstall,
            packageRequest,
            signal,
          );
          return success(await this.host.installExtension(packageRequest, signal));
        },
      );
    } catch (error) {
      return failure(error);
    }
  }

  async installLocalExtension(
    request: MarshalRuntimeLocalExtensionInstallRequest,
  ): Promise<MarshalRuntimeApiResult<RuntimeExtensionRecord>> {
    try {
      const scope = normalizeScope(request);
      const packageRoot = normalizeRequired(request.packageRoot, "Extension package root", 32_768);
      const idempotencyKey = normalizeIdempotencyKey(request.idempotencyKey);
      return await this.idempotency.execute(
        {
          operation: "extension.install-local",
          identity: `${scope.sessionId}\0${scope.workspaceName}`,
          idempotencyKey,
          payload: { packageRoot },
          signal: request.signal,
        },
        async (signal) => {
          await this.authorizeExtension(
            scope,
            "install",
            MARSHAL_RUNTIME_PERMISSION.extensionInstall,
            { packageRoot },
            signal,
          );
          return success(await this.host.installLocalExtension(packageRoot, signal));
        },
      );
    } catch (error) {
      return failure(error);
    }
  }

  async configureExtension(
    request: MarshalRuntimeExtensionConfigurationRequest,
  ): Promise<MarshalRuntimeApiResult<RuntimeExtensionRecord>> {
    try {
      const scope = normalizeScope(request);
      const identity = normalizeRequired(
        request.identity,
        "Extension identity",
        MAX_EXTENSION_IDENTITY_LENGTH,
      );
      const idempotencyKey = normalizeIdempotencyKey(request.idempotencyKey);
      return await this.idempotency.execute(
        {
          operation: "extension.configure",
          identity: `${scope.sessionId}\0${scope.workspaceName}`,
          idempotencyKey,
          payload: { identity, configuration: request.configuration },
          signal: request.signal,
        },
        async (signal) => {
          await this.authorizeExtension(
            scope,
            "configure",
            MARSHAL_RUNTIME_PERMISSION.extensionConfigure,
            { identity },
            signal,
          );
          return success(
            await this.host.configureExtension(identity, request.configuration, signal),
          );
        },
      );
    } catch (error) {
      return failure(error);
    }
  }

  async setProvider(
    request: MarshalRuntimeExtensionProviderRequest & { readonly providerId: string },
  ): Promise<MarshalRuntimeApiResult<RuntimeExtensionRecord>> {
    return this.changeProvider("set", request);
  }

  async clearProvider(
    request: MarshalRuntimeExtensionProviderRequest,
  ): Promise<MarshalRuntimeApiResult<RuntimeExtensionRecord>> {
    return this.changeProvider("clear", request);
  }

  async repairContractConflict(
    request: MarshalRuntimeExtensionContractRepairRequest,
  ): Promise<MarshalRuntimeApiResult<RuntimeExtensionContractRepairResult>> {
    try {
      const scope = normalizeScope(request);
      const idempotencyKey = normalizeIdempotencyKey(request.idempotencyKey);
      return await this.idempotency.execute(
        {
          operation: "extension.contract-repair",
          identity: `${scope.sessionId}\0${scope.workspaceName}`,
          idempotencyKey,
          payload: request.request,
          signal: request.signal,
        },
        async (signal) => {
          await this.authorizeExtension(
            scope,
            "contractRepair",
            MARSHAL_RUNTIME_PERMISSION.extensionContractRepair,
            request.request,
            signal,
          );
          return success(await this.host.repairContractConflict(request.request, scope, signal));
        },
      );
    } catch (error) {
      return failure(error);
    }
  }

  async updateExtension(
    request: MarshalRuntimeExtensionUpdateRequest,
  ): Promise<MarshalRuntimeApiResult<RuntimeExtensionRecord>> {
    try {
      const scope = normalizeScope(request);
      const identity = normalizeRequired(
        request.identity,
        "Extension identity",
        MAX_EXTENSION_IDENTITY_LENGTH,
      );
      const packageRequest = request.integrity
        ? extensionRequest(request.packageRoot, request.integrity)
        : { packageRoot: extensionPackageRoot(request) };
      const idempotencyKey = normalizeIdempotencyKey(request.idempotencyKey);
      return await this.idempotency.execute(
        {
          operation: "extension.update",
          identity: `${scope.sessionId}\0${scope.workspaceName}`,
          idempotencyKey,
          payload: { identity, ...packageRequest },
          signal: request.signal,
        },
        async (signal) => {
          await this.authorizeExtension(
            scope,
            "update",
            MARSHAL_RUNTIME_PERMISSION.extensionUpdate,
            { identity, ...packageRequest },
            signal,
          );
          return success(await this.host.updateExtension(identity, packageRequest, signal));
        },
      );
    } catch (error) {
      return failure(error);
    }
  }

  async enableExtension(
    request: MarshalRuntimeExtensionStateRequest,
  ): Promise<MarshalRuntimeApiResult<RuntimeExtensionRecord>> {
    return this.changeExtensionState("enable", request);
  }

  async disableExtension(
    request: MarshalRuntimeExtensionStateRequest,
  ): Promise<MarshalRuntimeApiResult<RuntimeExtensionRecord>> {
    return this.changeExtensionState("disable", request);
  }

  async removeExtension(
    request: MarshalRuntimeExtensionStateRequest,
  ): Promise<MarshalRuntimeApiResult<MarshalRuntimeExtensionRemoval>> {
    try {
      const scope = normalizeScope(request);
      const identity = normalizeRequired(
        request.identity,
        "Extension identity",
        MAX_EXTENSION_IDENTITY_LENGTH,
      );
      const idempotencyKey = normalizeIdempotencyKey(request.idempotencyKey);
      return await this.idempotency.execute(
        {
          operation: "extension.remove",
          identity: `${scope.sessionId}\0${scope.workspaceName}`,
          idempotencyKey,
          payload: { identity },
          signal: request.signal,
        },
        async (signal) => {
          await this.authorizeExtension(
            scope,
            "remove",
            MARSHAL_RUNTIME_PERMISSION.extensionRemove,
            { identity },
            signal,
          );
          await this.host.removeExtension(identity, signal);
          return success({ identity, removed: true as const });
        },
      );
    } catch (error) {
      return failure(error);
    }
  }

  getStatus() {
    return this.host.getStatus();
  }

  dispose(): void {
    this.idempotency.dispose();
    for (const approvalId of this.approvalIds) {
      this.host.cancelApproval(approvalId);
    }
    this.approvalIds.clear();
  }

  private async changeExtensionState(
    operation: "enable" | "disable",
    request: MarshalRuntimeExtensionStateRequest,
  ): Promise<MarshalRuntimeApiResult<RuntimeExtensionRecord>> {
    try {
      const scope = normalizeScope(request);
      const identity = normalizeRequired(
        request.identity,
        "Extension identity",
        MAX_EXTENSION_IDENTITY_LENGTH,
      );
      const idempotencyKey = normalizeIdempotencyKey(request.idempotencyKey);
      const permission =
        operation === "enable"
          ? MARSHAL_RUNTIME_PERMISSION.extensionEnable
          : MARSHAL_RUNTIME_PERMISSION.extensionDisable;
      return await this.idempotency.execute(
        {
          operation: `extension.${operation}`,
          identity: `${scope.sessionId}\0${scope.workspaceName}`,
          idempotencyKey,
          payload: { identity },
          signal: request.signal,
        },
        async (signal) => {
          await this.authorizeExtension(scope, operation, permission, { identity }, signal);
          return success(
            operation === "enable"
              ? await this.host.enableExtension(identity, signal)
              : await this.host.disableExtension(identity, signal),
          );
        },
      );
    } catch (error) {
      return failure(error);
    }
  }

  private async changeProvider(
    operation: "set" | "clear",
    request: MarshalRuntimeExtensionProviderRequest & { readonly providerId?: string },
  ): Promise<MarshalRuntimeApiResult<RuntimeExtensionRecord>> {
    try {
      const scope = normalizeScope(request);
      const identity = normalizeRequired(
        request.identity,
        "Extension identity",
        MAX_EXTENSION_IDENTITY_LENGTH,
      );
      const serviceId = normalizeRequired(request.serviceId, "Service ID", 512);
      const providerId =
        operation === "set"
          ? normalizeRequired(request.providerId ?? "", "Provider ID", 512)
          : undefined;
      const idempotencyKey = normalizeIdempotencyKey(request.idempotencyKey);
      return await this.idempotency.execute(
        {
          operation: `extension.provider.${operation}`,
          identity: `${scope.sessionId}\0${scope.workspaceName}`,
          idempotencyKey,
          payload: { identity, serviceId, providerId },
          signal: request.signal,
        },
        async (signal) => {
          await this.authorizeExtension(
            scope,
            operation === "set" ? "setProvider" : "clearProvider",
            MARSHAL_RUNTIME_PERMISSION.extensionProvider,
            { identity, serviceId, providerId },
            signal,
          );
          return success(
            operation === "set"
              ? await this.host.setProvider(identity, serviceId, providerId!, signal)
              : await this.host.clearProvider(identity, serviceId, signal),
          );
        },
      );
    } catch (error) {
      return failure(error);
    }
  }

  private async authorizeExtension(
    scope: MarshalRuntimeScope,
    operation: string,
    permission: string,
    input: unknown,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    await this.host.resolveScope(scope, signal);
    const decision = await this.host.authorize({
      scope,
      capability: `marshal.extension.${operation}`,
      permissions: [permission],
      input,
      signal,
    });
    if (decision.decision === "allow") return;
    if (decision.decision === "approval") {
      throw new RuntimeApiError("approval-required", decision.reason);
    }
    throw new RuntimeApiError(
      decision.code === "aborted" ? "aborted" : "permission-denied",
      decision.reason,
    );
  }
}

/** @internal test seam */
export const __testing = { boundSearchDiscoveries };
