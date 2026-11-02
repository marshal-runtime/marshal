import type { IpcHandler, IpcInvokeMap } from "../../common/marshal-ipc-contract";
import {
  runtimeUiScopeOf,
  type RuntimeUiApplicationHostCommand,
  type RuntimeUiImageHandle,
  type RuntimeUiIpcResult,
  type RuntimeUiInstance,
} from "../../common/runtime-ui";
import type { RuntimeUiAttachmentStore } from "../marshal-runtime/runtime-ui-attachments";
import type { MarshalRuntimeUiController } from "../marshal-runtime/ui-controller";
import type { RuntimeUiApplicationCallKind } from "../marshal-runtime/ui-rate-windows";

export interface RuntimeUiImagePorts {
  ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => void;
  controller: MarshalRuntimeUiController;
  getStore(): Promise<RuntimeUiAttachmentStore>;
  isOwnerActive(instance: RuntimeUiInstance): Promise<boolean>;
  pickNativeImages(): Promise<readonly string[]>;
}

export function registerRuntimeUiImageHandlers(options: RuntimeUiImagePorts): void {
  options.ipcHandle("runtime-ui:selectImages", async (_event, request) => {
    try {
      const instance = await requireInstance(options, request, "write");
      const nativePaths = await options.pickNativeImages();
      // Native selection can outlive the application publication or its visible instance.
      await requireInstance(options, request, "write");
      if (!nativePaths.length) return { success: true, value: [] };
      return {
        success: true,
        value: await (await options.getStore()).selectImages(instance.owner, nativePaths),
      };
    } catch (error) {
      return failed(error);
    }
  });
  options.ipcHandle(
    "runtime-ui:listImages",
    async (_event, request): Promise<RuntimeUiIpcResult<RuntimeUiImageHandle[]>> => {
      try {
        const instance = await requireInstance(options, request, "read");
        return {
          success: true,
          value: await (await options.getStore()).listImages(instance.owner),
        };
      } catch (error) {
        return failed(error);
      }
    },
  );
  options.ipcHandle("runtime-ui:readImage", async (_event, request) => {
    try {
      const instance = await requireInstance(options, request, "read", true);
      return {
        success: true,
        value: await (await options.getStore()).readImage(instance.owner, request.handle),
      };
    } catch (error) {
      return failed(error);
    }
  });
  options.ipcHandle("runtime-ui:releaseImage", async (_event, request) => {
    try {
      const instance = await requireInstance(options, request, "write", true);
      await (await options.getStore()).release(instance.owner, request.handle);
      return { success: true, value: null };
    } catch (error) {
      return failed(error);
    }
  });
}

async function requireInstance(
  options: RuntimeUiImagePorts,
  request: RuntimeUiApplicationHostCommand,
  kind: RuntimeUiApplicationCallKind,
  withHandle = false,
): Promise<RuntimeUiInstance> {
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw new Error("An owned application request is required.");
  const keys = [
    "sessionId",
    "workspaceName",
    "applicationScope",
    "extensionId",
    "applicationId",
    "instanceId",
    ...(withHandle ? ["handle"] : []),
  ];
  if (Object.keys(request).some((key) => !keys.includes(key)))
    throw new Error("Unexpected image request property.");
  if (withHandle) {
    const handle = Reflect.get(request, "handle");
    if (typeof handle !== "string" || !handle.trim() || handle.length > 256)
      throw new Error("A bounded image handle is required.");
  }
  const result = await options.controller.resolveApplicationCall({
    ...runtimeUiScopeOf(request),
    extensionId: request.extensionId,
    applicationId: request.applicationId,
    instanceId: request.instanceId,
    kind,
  });
  if (!result.ok && result.error.code !== "not-found") throw new Error(result.error.message);
  const instance = result.ok ? result.value : undefined;
  if (
    !instance ||
    instance.content.kind !== "application" ||
    !(await options.isOwnerActive(instance))
  )
    throw new Error("The extension application is no longer active in this scope.");
  return instance;
}

function failed(error: unknown): RuntimeUiIpcResult<never> {
  return {
    success: false,
    error: {
      code: "permission-denied",
      message: error instanceof Error ? error.message : "Image operation failed.",
    },
  };
}
