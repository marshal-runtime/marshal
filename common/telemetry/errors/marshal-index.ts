import type { TelemetryCallbacks } from "../types";
import { authErrors, makeAuthError, registerAuthErrors } from "./marshal-auth";
import { crashErrors, makeCrashError, registerCrashErrors } from "./marshal-crash";
import { ipcErrors, makeIpcError, registerIpcErrors } from "./marshal-ipc";
import { mcpErrors, makeMcpError, registerMcpErrors } from "./marshal-mcp";
import { sessionErrors, makeSessionError, registerSessionErrors } from "./marshal-session";
import { makeUpdaterError, registerUpdaterErrors, updaterErrors } from "./marshal-updater";

export { authErrors, makeAuthError, registerAuthErrors };
export { crashErrors, makeCrashError, registerCrashErrors };
export { ipcErrors, makeIpcError, registerIpcErrors };
export { mcpErrors, makeMcpError, registerMcpErrors };
export { sessionErrors, makeSessionError, registerSessionErrors };
export { updaterErrors, makeUpdaterError, registerUpdaterErrors };

export function registerAllErrors(callbacks: TelemetryCallbacks): void {
  registerAuthErrors(callbacks);
  registerSessionErrors(callbacks);
  registerMcpErrors(callbacks);
  registerCrashErrors(callbacks);
  registerIpcErrors(callbacks);
  registerUpdaterErrors(callbacks);
}
