import { sharedIpcHandle } from "../../../remote-access/shared-handlers";
import type { IpcDeps } from "../../types";

export function registerBackendCapabilitiesHandler({
  sessionManager,
  ipcHandle,
}: Pick<IpcDeps, "sessionManager" | "ipcHandle">) {
  sharedIpcHandle(ipcHandle)("backend:capabilities", () => {
    return sessionManager.getBackendCapabilities();
  });
}
