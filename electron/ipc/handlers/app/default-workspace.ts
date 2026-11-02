import type { IpcDeps } from "../../types";

export function registerDefaultWorkspaceHandler(
  { ipcHandle }: Pick<IpcDeps, "ipcHandle">,
  resolvedWorkspaceDir: string,
): void {
  ipcHandle("app:getDefaultWorkspaceDir", async () => {
    return { success: true, defaultWorkspaceDir: resolvedWorkspaceDir };
  });
}
