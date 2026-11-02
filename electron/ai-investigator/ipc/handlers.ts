import type { IpcDeps } from "../../ipc/types";
import type { AIInvestigatorManager } from "../ai-investigator-manager";

export interface AIInvestigatorIpcDeps extends Pick<IpcDeps, "ipcHandle"> {
  aiInvestigatorManager: AIInvestigatorManager;
}

export function registerAIInvestigatorHandlers({
  ipcHandle,
  aiInvestigatorManager,
}: AIInvestigatorIpcDeps): void {
  ipcHandle("aiInvestigator:checkAvailability", async () => {
    try {
      const result = await aiInvestigatorManager.checkAvailability();
      return { success: true, ...result };
    } catch (err) {
      return { success: false, available: false, reason: String(err) };
    }
  });

  ipcHandle("aiInvestigator:start", async (_event, input) => {
    try {
      if (!input || typeof input.userDescription !== "string") {
        return { success: false, error: "Invalid payload" };
      }
      if (!input.userDescription.trim()) {
        return { success: false, error: "Description is required" };
      }
      await aiInvestigatorManager.start({
        userDescription: input.userDescription,
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcHandle("aiInvestigator:getStatus", async () => {
    return { success: true, status: aiInvestigatorManager.getStatus() };
  });

  ipcHandle("aiInvestigator:cancel", async () => {
    try {
      await aiInvestigatorManager.cancel();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcHandle("aiInvestigator:reset", async () => {
    try {
      aiInvestigatorManager.reset();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcHandle("aiInvestigator:post", async () => {
    try {
      return await aiInvestigatorManager.post();
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
