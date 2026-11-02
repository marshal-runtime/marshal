import type { IpcHandler, IpcInvokeMap } from "../../common/marshal-ipc-contract";
import type { RuntimeUiError, RuntimeUiScope } from "../../common/runtime-ui";
import type { MarshalRuntimeUiController } from "../marshal-runtime/ui-controller";
import type { RuntimeUiViewPersistence } from "../marshal-runtime/ui-view-persistence";

export interface RuntimeUiLayoutPorts {
  readonly ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => void;
  readonly controller: MarshalRuntimeUiController;
  readonly persistence: RuntimeUiViewPersistence;
  readonly runtimeReady?: () => Promise<void>;
}

/**
 * Desktop-only: the phone presents its own arrangement of the same views and
 * never reads or overwrites the desktop dock layout.
 */
export function registerRuntimeUiLayoutHandlers(options: RuntimeUiLayoutPorts): void {
  // A snapshot runs the same scope authority as every other renderer read.
  const authorize = async (scope: RuntimeUiScope): Promise<RuntimeUiError | undefined> => {
    await options.runtimeReady?.();
    const result = await options.controller.snapshot(scope);
    return result.ok ? undefined : result.error;
  };

  options.ipcHandle("runtime-ui:getLayout", async (_event, scope) => {
    const denied = await authorize(scope);
    if (denied) return { success: false, error: denied };
    const desktop = options.persistence.getDesktopLayout(scope);
    return { success: true, value: { scope, ...(desktop ? { desktop } : {}) } };
  });

  options.ipcHandle("runtime-ui:saveLayout", async (_event, request) => {
    const denied = await authorize(request);
    if (denied) return { success: false, error: denied };
    try {
      await options.persistence.saveDesktopLayout(request);
      return { success: true, value: null };
    } catch (error) {
      return {
        success: false,
        error: {
          code: "invalid-request",
          message: error instanceof Error ? error.message : "The layout could not be saved.",
        },
      };
    }
  });
}
