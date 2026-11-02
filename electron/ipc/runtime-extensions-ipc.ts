import { randomUUID } from "node:crypto";

import type { InvocationContext, RuntimeServiceContainer } from "@marshal/runtime";
import {
  RUNTIME_EXTENSION_CATALOG_SERVICE,
  type RuntimeExtensionCatalogEntry,
  type RuntimeExtensionCatalogService,
} from "@marshal/runtime/extensions";

import type {
  IpcHandler,
  IpcInvokeMap,
  RuntimeExtensionsIdentityRequest,
  RuntimeExtensionsLocalInstallRequest,
  RuntimeExtensionsConfigurationRequest,
  RuntimeExtensionsContractRepairRequest,
  RuntimeExtensionsMutationRequest,
  RuntimeExtensionsProviderRequest,
  RuntimeExtensionProjectedStatusItem,
  RuntimeExtensionsScope,
  RuntimeExtensionsSearchRequest,
  RuntimeExtensionsStatusSnapshot,
  RuntimeExtensionsChangedEvent,
  RuntimeExtensionsUpdateRequest,
} from "../../common/marshal-ipc-contract";
import type { MarshalRuntimeApi } from "../marshal-runtime/contracts";
import type {
  MarshalRuntimeExtensionDiscovery,
  MarshalRuntimeExtensionDiscoveryCandidate,
  MarshalRuntimeExtensionDiscoverySnapshot,
} from "../marshal-runtime/host";

function context(scope: RuntimeExtensionsScope): InvocationContext {
  return {
    principal: { id: "marshal-renderer", kind: "user" },
    scope: { sessionId: scope.sessionId },
    metadata: { marshalWorkspaceName: scope.workspaceName },
  };
}

function validScope(value: unknown): value is RuntimeExtensionsScope {
  const record = objectRecord(value);
  if (!record) return false;
  return (
    typeof record.sessionId === "string" &&
    record.sessionId.trim().length > 0 &&
    typeof record.workspaceName === "string" &&
    record.workspaceName.trim().length > 0
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validSearchRequest(value: unknown): boolean {
  if (value === undefined) return true;
  const record = objectRecord(value);
  if (!record) return false;
  if (
    Object.keys(record).some(
      (key) => !["query", "origins", "tags", "installation", "limit"].includes(key),
    )
  )
    return false;
  if (record.query !== undefined && typeof record.query !== "string") return false;
  if (
    record.origins !== undefined &&
    (!Array.isArray(record.origins) ||
      record.origins.some(
        (origin) => !["native", "dsh", "authored-typescript"].includes(String(origin)),
      ))
  )
    return false;
  if (
    record.tags !== undefined &&
    (!Array.isArray(record.tags) || record.tags.some((tag) => !nonEmptyString(tag)))
  )
    return false;
  if (
    record.installation !== undefined &&
    (typeof record.installation !== "string" ||
      !["enabled", "disabled", "not-installed"].includes(record.installation))
  )
    return false;
  return (
    record.limit === undefined ||
    (typeof record.limit === "number" &&
      Number.isInteger(record.limit) &&
      record.limit > 0 &&
      record.limit <= 100)
  );
}

function validIdentityRequest(value: unknown): value is RuntimeExtensionsIdentityRequest {
  const record = objectRecord(value);
  if (!record || !validScope(record)) return false;
  return (
    Object.keys(record).every((key) => ["sessionId", "workspaceName", "identity"].includes(key)) &&
    nonEmptyString(record.identity)
  );
}

function validConfigurationRequest(value: unknown): value is RuntimeExtensionsConfigurationRequest {
  const record = objectRecord(value);
  return (
    !!record &&
    validScope(record) &&
    Object.keys(record).every((key) =>
      ["sessionId", "workspaceName", "identity", "configuration"].includes(key),
    ) &&
    nonEmptyString(record.identity) &&
    objectRecord(record.configuration) !== null
  );
}

function validContractRepairRequest(
  value: unknown,
): value is RuntimeExtensionsContractRepairRequest {
  const record = objectRecord(value);
  const repair = record && objectRecord(record.request);
  return (
    !!record &&
    validScope(record) &&
    !!repair &&
    Object.keys(record).every((key) => ["sessionId", "workspaceName", "request"].includes(key)) &&
    nonEmptyString(repair.canonicalService) &&
    Array.isArray(repair.bindings) &&
    repair.bindings.length > 0
  );
}

function validProviderRequest(value: unknown): value is RuntimeExtensionsProviderRequest {
  const record = objectRecord(value);
  return (
    !!record &&
    validScope(record) &&
    Object.keys(record).every((key) =>
      ["sessionId", "workspaceName", "identity", "serviceId", "providerId"].includes(key),
    ) &&
    nonEmptyString(record.identity) &&
    nonEmptyString(record.serviceId) &&
    (record.providerId === undefined || nonEmptyString(record.providerId))
  );
}

function validSetProviderRequest(
  value: unknown,
): value is RuntimeExtensionsProviderRequest & { readonly providerId: string } {
  return validProviderRequest(value) && nonEmptyString(value.providerId);
}

function validMutationRequest(value: unknown): value is RuntimeExtensionsMutationRequest {
  const record = objectRecord(value);
  if (!record || !validScope(record)) return false;
  return (
    Object.keys(record).every((key) =>
      ["sessionId", "workspaceName", "catalogEntryId"].includes(key),
    ) && nonEmptyString(record.catalogEntryId)
  );
}

function validLocalInstallRequest(value: unknown): value is RuntimeExtensionsLocalInstallRequest {
  const record = objectRecord(value);
  return (
    !!record &&
    validScope(record) &&
    Object.keys(record).every((key) =>
      ["sessionId", "workspaceName", "packageRoot"].includes(key),
    ) &&
    nonEmptyString(record.packageRoot)
  );
}

function validUpdateRequest(value: unknown): value is RuntimeExtensionsUpdateRequest {
  const record = objectRecord(value);
  if (!record || !validScope(record)) return false;
  const hasCatalogEntry = nonEmptyString(record.catalogEntryId);
  const hasPackageRoot = nonEmptyString(record.packageRoot);
  return (
    Object.keys(record).every((key) =>
      ["sessionId", "workspaceName", "identity", "catalogEntryId", "packageRoot"].includes(key),
    ) &&
    nonEmptyString(record.identity) &&
    hasCatalogEntry !== hasPackageRoot
  );
}

function validSearchEnvelope(value: unknown): value is RuntimeExtensionsSearchRequest {
  const record = objectRecord(value);
  return (
    !!record &&
    validScope(record) &&
    Object.keys(record).every((key) => ["sessionId", "workspaceName", "search"].includes(key)) &&
    validSearchRequest(record.search)
  );
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]))
    : null;
}

function failure(error: unknown): { success: false; error: string } {
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

export function registerRuntimeExtensionsHandlers(options: {
  readonly ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => void;
  readonly serviceContainer: RuntimeServiceContainer;
  readonly runCatalogOperation: <T>(
    operation: (service: RuntimeExtensionCatalogService) => Promise<T>,
  ) => Promise<T>;
  readonly runtimeReady?: () => Promise<void>;
  readonly runtimeApi?: MarshalRuntimeApi;
  readonly extensionDiscovery?: () => MarshalRuntimeExtensionDiscovery | undefined;
  readonly emitChanged?: (event: RuntimeExtensionsChangedEvent) => void;
}): () => void {
  const activeInstalls = new Map<string, ActiveInstall>();
  let localRevision = 0;
  let subscribedDiscovery: MarshalRuntimeExtensionDiscovery | undefined;
  let discoverySubscription: { dispose(): void } | undefined;
  // F-001: guards against the late `runtimeReady()` callback re-subscribing after
  // the disposer below has already run — see the disposal fence on
  // `ensureDiscoverySubscription` and the `then()` callback further down.
  let disposed = false;

  const notifyChanged = (scope?: RuntimeExtensionsScope, revision?: number): void => {
    localRevision = Math.max(localRevision + 1, revision ?? 0);
    options.emitChanged?.({
      revision: localRevision,
      ...(scope ? { sessionId: scope.sessionId, workspaceName: scope.workspaceName } : {}),
    });
  };

  const ensureDiscoverySubscription = (): MarshalRuntimeExtensionDiscovery | undefined => {
    if (disposed) return undefined;
    const discovery = options.extensionDiscovery?.();
    if (!discovery || discovery === subscribedDiscovery) return discovery;
    discoverySubscription?.dispose();
    subscribedDiscovery = discovery;
    discoverySubscription = discovery.subscribe((snapshot) =>
      notifyChanged(undefined, snapshot.revision),
    );
    return discovery;
  };

  // R6: subscribe to extension discovery eagerly (not only lazily via the
  // renderer-initiated "runtime-extensions:status" handler below), so agent-path
  // installs/updates broadcast "runtime-extensions:changed" to already-open windows
  // even if the renderer never touches extensions IPC. `extensionDiscovery()` can
  // return undefined before Runtime startup completes, so also retry once
  // `runtimeReady()` resolves. Both attempts are non-blocking: registration must not
  // wait on them, and a rejected `runtimeReady()` must not crash the main process.
  // F-001: the disposer returned below may run before `runtimeReady()` resolves, so
  // this callback must not resubscribe once disposed — `ensureDiscoverySubscription`
  // itself is fenced, and the `disposed` check here avoids doing any work at all.
  ensureDiscoverySubscription();
  options.runtimeReady?.().then(
    () => {
      if (disposed) return;
      ensureDiscoverySubscription();
    },
    () => undefined,
  );

  const beginInstall = (
    request: RuntimeExtensionsScope,
    target: string,
    details: Partial<Pick<ActiveInstall, "catalogEntryId" | "packageRoot">>,
  ): ActiveInstall | undefined => {
    const key = installKey(target);
    if (activeInstalls.has(key)) return undefined;
    const operation: ActiveInstall = {
      key,
      target,
      workspaceName: request.workspaceName,
      initiatingSessionId: request.sessionId,
      startedAt: new Date().toISOString(),
      ...details,
    };
    activeInstalls.set(key, operation);
    notifyChanged(request);
    return operation;
  };

  const finishInstall = (request: RuntimeExtensionsScope, operation: ActiveInstall): void => {
    if (activeInstalls.get(operation.key) === operation) activeInstalls.delete(operation.key);
    notifyChanged(request);
  };

  const invoke = async <Request extends RuntimeExtensionsScope, T>(
    request: unknown,
    valid: (value: unknown) => value is Request,
    operation: (service: RuntimeExtensionCatalogService, request: Request) => Promise<T>,
    invalidate = false,
  ) => {
    if (!valid(request)) return failure("Invalid Runtime extension request.");
    try {
      await options.runtimeReady?.();
      const service = options.serviceContainer.get(RUNTIME_EXTENSION_CATALOG_SERVICE);
      const value = invalidate
        ? await options.runCatalogOperation((catalog) => operation(catalog, request))
        : await operation(service, request);
      if (invalidate) notifyChanged(request);
      return { success: true as const, value };
    } catch (error) {
      return failure(error);
    }
  };

  options.ipcHandle("runtime-extensions:search", (_event, request) =>
    invoke(request, validSearchEnvelope, (service, validRequest) =>
      service.search(validRequest.search ?? {}, context(validRequest)),
    ),
  );
  options.ipcHandle("runtime-extensions:status", async (_event, request) => {
    if (!validScope(request)) return failure("Invalid Runtime extension request.");
    try {
      await options.runtimeReady?.();
      const service = options.serviceContainer.get(RUNTIME_EXTENSION_CATALOG_SERVICE);
      const entries = await service.discover(context(request));
      const discovery = ensureDiscoverySubscription()?.snapshot();
      return {
        success: true as const,
        value: projectStatusSnapshot(
          request,
          entries,
          discovery,
          [...activeInstalls.values()],
          localRevision,
        ),
      };
    } catch (error) {
      return failure(error);
    }
  });
  options.ipcHandle("runtime-extensions:install", async (_event, request) => {
    if (!validMutationRequest(request)) return failure("Invalid Runtime extension request.");
    const operation = beginInstall(request, `catalog:${request.catalogEntryId}`, {
      catalogEntryId: request.catalogEntryId,
    });
    if (!operation) return failure("This Runtime extension installation is already active.");
    try {
      return await invoke(
        request,
        validMutationRequest,
        (service, validRequest) =>
          service.install(validRequest.catalogEntryId, context(validRequest)),
        true,
      );
    } finally {
      finishInstall(request, operation);
    }
  });
  options.ipcHandle("runtime-extensions:installLocal", async (_event, request) => {
    if (!validLocalInstallRequest(request)) return failure("Invalid Runtime extension request.");
    if (!options.runtimeApi) return failure("Local Runtime extension installation is unavailable.");
    const operation = beginInstall(request, `local:${request.packageRoot}`, {
      packageRoot: request.packageRoot,
    });
    if (!operation) return failure("This Runtime extension installation is already active.");
    try {
      await options.runtimeReady?.();
      const result = await options.runtimeApi.installLocalExtension({
        ...request,
        idempotencyKey: randomUUID(),
      });
      if (!result.ok) return failure(result.error.message);
      notifyChanged(request);
      return { success: true as const, value: result.value };
    } catch (error) {
      return failure(error);
    } finally {
      finishInstall(request, operation);
    }
  });
  options.ipcHandle("runtime-extensions:update", (_event, request) => {
    if (validUpdateRequest(request) && request.packageRoot) {
      const packageRoot = request.packageRoot;
      return (async () => {
        if (!options.runtimeApi) return failure("Local Runtime extension update is unavailable.");
        try {
          await options.runtimeReady?.();

          const result = await options.runtimeApi.updateExtension({
            sessionId: request.sessionId,
            workspaceName: request.workspaceName,
            identity: request.identity,
            packageRoot,
            idempotencyKey: randomUUID(),
          });
          if (!result.ok) return failure(result.error.message);

          notifyChanged(request);
          return { success: true as const, value: result.value };
        } catch (error) {
          return failure(error);
        }
      })();
    }
    return invoke(
      request,
      validUpdateRequest,
      (service, validRequest) =>
        service.update(validRequest.identity, validRequest.catalogEntryId!, context(validRequest)),
      true,
    );
  });
  options.ipcHandle("runtime-extensions:enable", (_event, request) =>
    invoke(
      request,
      validIdentityRequest,
      (service, validRequest) => service.enable(validRequest.identity, context(validRequest)),
      true,
    ),
  );
  options.ipcHandle("runtime-extensions:disable", (_event, request) =>
    invoke(
      request,
      validIdentityRequest,
      (service, validRequest) => service.disable(validRequest.identity, context(validRequest)),
      true,
    ),
  );
  options.ipcHandle("runtime-extensions:configure", async (_event, request) => {
    if (!validConfigurationRequest(request)) return failure("Invalid Runtime extension request.");
    if (!options.runtimeApi) return failure("Runtime extension configuration is unavailable.");
    try {
      await options.runtimeReady?.();

      const result = await options.runtimeApi.configureExtension({
        ...request,
        idempotencyKey: randomUUID(),
      });
      if (!result.ok) return failure(result.error.message);

      notifyChanged(request);
      return { success: true as const, value: result.value };
    } catch (error) {
      return failure(error);
    }
  });
  options.ipcHandle("runtime-extensions:setProvider", (_event, request) => {
    if (validSetProviderRequest(request) && options.runtimeApi) {
      const providerId = request.providerId;
      return (async () => {
        try {
          await options.runtimeReady?.();

          const result = await options.runtimeApi!.setProvider({
            ...request,
            providerId,
            idempotencyKey: randomUUID(),
          });
          if (!result.ok) return failure(result.error.message);

          notifyChanged(request);
          return { success: true as const, value: result.value };
        } catch (error) {
          return failure(error);
        }
      })();
    }
    return failure(
      !validSetProviderRequest(request)
        ? "Invalid Runtime extension request."
        : "Runtime provider selection is unavailable.",
    );
  });
  options.ipcHandle("runtime-extensions:clearProvider", (_event, request) =>
    validProviderRequest(request) && options.runtimeApi
      ? (async () => {
          try {
            await options.runtimeReady?.();

            const result = await options.runtimeApi!.clearProvider({
              ...request,
              idempotencyKey: randomUUID(),
            });
            if (!result.ok) return failure(result.error.message);

            notifyChanged(request);
            return { success: true as const, value: result.value };
          } catch (error) {
            return failure(error);
          }
        })()
      : failure(
          !validProviderRequest(request)
            ? "Invalid Runtime extension request."
            : "Runtime provider clearing is unavailable.",
        ),
  );
  options.ipcHandle("runtime-extensions:repairContractConflict", (_event, request) =>
    invoke(
      request,
      validContractRepairRequest,
      async (service, validRequest) => {
        if (!service.repairContractConflict) {
          throw new Error(
            "Runtime contract-conflict repair requires a newer Marshal Runtime. Update Marshal and try again.",
          );
        }
        return service.repairContractConflict(validRequest.request, context(validRequest));
      },
      true,
    ),
  );
  options.ipcHandle("runtime-extensions:remove", (_event, request) =>
    invoke(
      request,
      validIdentityRequest,
      async (service, validRequest) => {
        await service.remove(validRequest.identity, context(validRequest));
        return null;
      },
      true,
    ),
  );

  return () => {
    disposed = true;
    discoverySubscription?.dispose();
    discoverySubscription = undefined;
    subscribedDiscovery = undefined;
    activeInstalls.clear();
  };
}

interface ActiveInstall {
  readonly key: string;
  readonly target: string;
  readonly workspaceName: string;
  readonly initiatingSessionId: string;
  readonly startedAt: string;
  readonly catalogEntryId?: string;
  readonly packageRoot?: string;
}

function installKey(target: string): string {
  return target;
}

function projectStatusSnapshot(
  scope: RuntimeExtensionsScope,
  entries: readonly RuntimeExtensionCatalogEntry[],
  discovery: MarshalRuntimeExtensionDiscoverySnapshot | undefined,
  operations: readonly ActiveInstall[],
  localRevision: number,
): RuntimeExtensionsStatusSnapshot {
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const operationsByEntry = new Map(
    operations.flatMap((operation) =>
      operation.catalogEntryId ? [[operation.catalogEntryId, operation] as const] : [],
    ),
  );
  const operationsByPath = new Map(
    operations.flatMap((operation) =>
      operation.packageRoot ? [[operation.packageRoot, operation] as const] : [],
    ),
  );
  const projectedIds = new Set<string>();
  const projectedCandidates = (discovery?.candidates ?? []).map((candidate) => {
    const catalogEntryId = candidate.catalogEntry?.id;
    if (catalogEntryId) projectedIds.add(catalogEntryId);
    const entry = catalogEntryId ? entriesById.get(catalogEntryId) : undefined;
    const operation =
      (catalogEntryId ? operationsByEntry.get(catalogEntryId) : undefined) ??
      operationsByPath.get(candidate.packageRoot);
    return projectCandidateStatus(candidate, entry, operation);
  });
  // A package can be found through both the native catalog and a materialized
  // discovery root. Keep one lifecycle row per identity/version, preferring
  // the installed row, so the renderer cannot present two enabled
  // implementations of the same extension (HOST-UX-1: the dedupe must apply
  // to catalog-entry rows too — the live double-projection came from a
  // materialized candidate under catalog id A plus an unreferenced native
  // entry id B for the same enabled identity/version).
  const items: RuntimeExtensionProjectedStatusItem[] = [];
  const byIdentityVersion = new Map<string, number>();
  const pushDeduped = (item: RuntimeExtensionProjectedStatusItem): void => {
    const key = item.identity && item.version ? `${item.identity}\0${item.version}` : undefined;
    if (!key) {
      items.push(item);
      return;
    }
    const existingIndex = byIdentityVersion.get(key);
    if (existingIndex === undefined) {
      byIdentityVersion.set(key, items.length);
      items.push(item);
      return;
    }
    const existing = items[existingIndex];
    if (
      existing &&
      existing.status !== "installed-enabled" &&
      item.status === "installed-enabled"
    ) {
      items[existingIndex] = item;
    }
  };
  for (const item of projectedCandidates) pushDeduped(item);
  for (const entry of entries) {
    if (projectedIds.has(entry.id)) continue;
    const operation = operationsByEntry.get(entry.id);
    pushDeduped({
      candidateId: entry.id,
      catalogEntryId: entry.id,
      identity: entry.identity,
      version: entry.version,
      status: operation
        ? "installing"
        : entry.installation?.status === "enabled"
          ? "installed-enabled"
          : entry.installation?.status === "disabled"
            ? "installed-disabled"
            : "detected",
      diagnostics: [],
      ...(operation ? { operation: projectedOperation(operation) } : {}),
    });
  }
  for (const operation of operations) {
    if (
      items.some(
        (item) =>
          (operation.catalogEntryId && item.catalogEntryId === operation.catalogEntryId) ||
          (operation.packageRoot && item.packageRoot === operation.packageRoot),
      )
    )
      continue;
    items.push({
      candidateId: operation.target,
      ...(operation.catalogEntryId ? { catalogEntryId: operation.catalogEntryId } : {}),
      ...(operation.packageRoot ? { packageRoot: operation.packageRoot } : {}),
      status: "installing",
      diagnostics: [],
      operation: projectedOperation(operation),
    });
  }
  return {
    ...scope,
    revision: Math.max(localRevision, discovery?.revision ?? 0),
    scannedAt: discovery?.scannedAt ?? new Date().toISOString(),
    discoveryStatus: discovery?.status ?? "unavailable",
    items,
    diagnostics: discovery?.diagnostics ?? [],
  };
}

function projectCandidateStatus(
  candidate: MarshalRuntimeExtensionDiscoveryCandidate,
  entry: RuntimeExtensionCatalogEntry | undefined,
  operation: ActiveInstall | undefined,
) {
  return {
    candidateId: candidate.catalogEntry?.id ?? candidate.packageRoot,
    ...(candidate.catalogEntry ? { catalogEntryId: candidate.catalogEntry.id } : {}),
    ...(candidate.identity ? { identity: candidate.identity } : {}),
    ...(candidate.version ? { version: candidate.version } : {}),
    ...(candidate.installation ? { installation: candidate.installation } : {}),
    packageRoot: candidate.packageRoot,
    status: operation
      ? ("installing" as const)
      : entry?.installation?.status === "enabled"
        ? ("installed-enabled" as const)
        : entry?.installation?.status === "disabled"
          ? ("installed-disabled" as const)
          : candidate.status === "installable"
            ? ("detected" as const)
            : candidate.status,
    diagnostics: candidate.diagnostics,
    ...(operation ? { operation: projectedOperation(operation) } : {}),
  };
}

function projectedOperation(operation: ActiveInstall) {
  return {
    kind: "install" as const,
    startedAt: operation.startedAt,
    initiatingSessionId: operation.initiatingSessionId,
    initiatingWorkspaceName: operation.workspaceName,
  };
}
