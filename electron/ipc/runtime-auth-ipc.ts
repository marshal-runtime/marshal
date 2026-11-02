import { createLogger } from "../../common/marshal-logger";
import { isRuntimeAuthLoginRequest } from "../../common/runtime-auth";
import { sharedIpcHandle } from "../remote-access/shared-handlers";
import type { IpcDeps } from "./types";

const log = createLogger("RuntimeAuthIPC");

export function registerRuntimeAuthHandlers({
  sessionManager,
  ipcHandle,
}: Pick<IpcDeps, "sessionManager" | "ipcHandle">): void {
  sharedIpcHandle(ipcHandle)("runtimeAuth:getStatus", async () => {
    try {
      const status = await sessionManager.checkAuthStatus();
      return {
        success: true,
        status: {
          isAuthenticated: status.isAuthenticated,
          login: status.login,
          statusMessage: status.statusMessage,
        },
      };
    } catch (error) {
      log.error("Failed to check runtime authentication:", error);
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("runtimeAuth:login", async (_event, request) => {
    if (!isRuntimeAuthLoginRequest(request)) {
      return { success: false, error: "Invalid runtime authentication request" };
    }
    try {
      const result = await sessionManager.login(request);
      const method =
        result.method ??
        (result.deviceCode ? "device-code" : result.verificationUri ? "browser" : undefined);
      return {
        success: true,
        state: method
          ? {
              status: "pending",
              method,
              verificationUri: result.verificationUri,
              userCode: result.deviceCode,
            }
          : { status: "authenticated" },
      };
    } catch (error) {
      log.error("Runtime authentication failed:", error);
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("runtimeAuth:signOut", async () => {
    try {
      await sessionManager.signOut();
      return { success: true };
    } catch (error) {
      log.error("Runtime sign-out failed:", error);
      return { success: false, error: String(error) };
    }
  });
}
