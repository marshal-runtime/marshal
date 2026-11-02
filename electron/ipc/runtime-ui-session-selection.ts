import type { IpcHandler, IpcInvokeMap } from "../../common/marshal-ipc-contract";
import {
  runtimeUiScopeOf,
  type RuntimeUiApplicationHostCommand,
  type RuntimeUiInstance,
  type RuntimeUiSelectedSession,
} from "../../common/runtime-ui";
import type { MarshalRuntimeUiController } from "../marshal-runtime/ui-controller";
import type { RuntimeUiApplicationCallKind } from "../marshal-runtime/ui-rate-windows";
import { sharedIpcHandleWithSender } from "../remote-access/shared-handlers";

export interface RuntimeUiSessionSelectionPorts {
  readonly ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => void;
  readonly controller: MarshalRuntimeUiController;
  readonly selectSession: (
    instance: RuntimeUiInstance,
    targetSessionId: string | undefined,
  ) => Promise<RuntimeUiSelectedSession | null>;
  readonly getSelectedSession: (
    instance: RuntimeUiInstance,
  ) => Promise<RuntimeUiSelectedSession | null>;
  readonly searchSessions?: (
    instance: RuntimeUiInstance,
    query: string,
    limit: number,
  ) => Promise<
    readonly { readonly id: string; readonly name?: string; readonly updatedAt?: string }[]
  >;
}

export function registerRuntimeUiSessionSelectionHandlers(
  options: RuntimeUiSessionSelectionPorts,
): void {
  // Session binding for user/workspace-scoped applications is part of the
  // packaged-UI contract, so the authenticated remote client can reach it too.
  const remoteIpcHandle = sharedIpcHandleWithSender(options.ipcHandle);
  remoteIpcHandle("runtime-ui:getSelectedSession", async (_event, request) => {
    try {
      const instance = await requireInstance(options.controller, request, "read");
      return { success: true, value: await options.getSelectedSession(instance) };
    } catch (error) {
      return {
        success: false,
        error: {
          code: "permission-denied",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });
  remoteIpcHandle("runtime-ui:selectSession", async (_event, request) => {
    try {
      const instance = await requireInstance(options.controller, request, "write");
      if (
        request.targetSessionId !== undefined &&
        (typeof request.targetSessionId !== "string" ||
          !request.targetSessionId.trim() ||
          request.targetSessionId.length > 256)
      ) {
        return {
          success: false,
          error: { code: "invalid-request", message: "A valid target session is required." },
        };
      }
      return {
        success: true,
        value: await options.selectSession(instance, request.targetSessionId),
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: "permission-denied",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });
  remoteIpcHandle("runtime-ui:searchSessions", async (_event, request) => {
    try {
      const instance = await requireInstance(options.controller, request, "read");
      const query = typeof request.query === "string" ? request.query.slice(0, 256) : "";
      const limit =
        typeof request.limit === "number" && Number.isInteger(request.limit)
          ? Math.max(1, Math.min(request.limit, 20))
          : 8;
      const results = options.searchSessions
        ? await options.searchSessions(instance, query, limit)
        : [];
      return {
        success: true,
        value: results.slice(0, limit).map((result) => ({
          sessionId: result.id,
          title: result.name?.trim() || result.id,
          ...(result.updatedAt ? { updatedAt: result.updatedAt } : {}),
        })),
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: "permission-denied",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });
}

async function requireInstance(
  controller: MarshalRuntimeUiController,
  request: RuntimeUiApplicationHostCommand,
  kind: RuntimeUiApplicationCallKind,
): Promise<RuntimeUiInstance> {
  const result = await controller.resolveApplicationCall({
    ...runtimeUiScopeOf(request),
    extensionId: request.extensionId,
    applicationId: request.applicationId,
    instanceId: request.instanceId,
    kind,
  });
  if (!result.ok && result.error.code !== "not-found") throw new Error(result.error.message);
  const instance = result.ok ? result.value : undefined;
  if (!instance || instance.content.kind !== "application")
    throw new Error("The application is not owned by this scope.");
  return instance;
}
