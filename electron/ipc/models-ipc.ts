import { createLogger } from "../../common/marshal-logger";
import { sharedIpcHandle } from "../remote-access/shared-handlers";
import type { IpcDeps } from "./types";

const log = createLogger("ModelsIpc");

export function registerModelsHandlers({
  sessionManager,
  ipcHandle,
}: Pick<IpcDeps, "sessionManager" | "ipcHandle">) {
  sharedIpcHandle(ipcHandle)("models:list", async () => {
    try {
      const models = await sessionManager.listModels();
      return { success: true, models };
    } catch (error) {
      log.error("Failed to list models:", error);
      return { success: false, error: String(error) };
    }
  });

  sharedIpcHandle(ipcHandle)("models:getDefault", async () => {
    try {
      const model = await sessionManager.resolveDefaultModel();
      return { success: true, model };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("models:setDefault", async (_event, model: string) => {
    try {
      const result = await sessionManager.setDefaultModel(model);
      return result;
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  sharedIpcHandle(ipcHandle)("models:getDefaultReasoningEffort", async (model: string) => {
    try {
      const effort = sessionManager.getDefaultReasoningEffort(model);
      return { success: true, effort };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("models:setDefaultReasoningEffort", async (_event, model: string, effort) => {
    try {
      const result = await sessionManager.setDefaultReasoningEffort(model, effort);
      return result;
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  sharedIpcHandle(ipcHandle)("models:getDefaultContextTier", async (model: string) => {
    try {
      const contextTier = sessionManager.getDefaultContextTier(model);
      return { success: true, contextTier };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("models:setDefaultContextTier", async (_event, model: string, contextTier) => {
    try {
      return await sessionManager.setDefaultContextTier(model, contextTier);
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  sharedIpcHandle(ipcHandle)("models:getSessionModel", async (sessionId: string) => {
    try {
      const model = sessionManager.getSessionModel(sessionId);
      return { success: true, model };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  sharedIpcHandle(ipcHandle)("models:getSessionReasoningEffort", async (sessionId: string) => {
    try {
      const effort = sessionManager.getSessionReasoningEffort(sessionId);
      return { success: true, effort };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  sharedIpcHandle(ipcHandle)(
    "models:setSessionReasoningEffort",
    async (sessionId: string, effort) => {
      try {
        await sessionManager.setSessionReasoningEffort(sessionId, effort);
        return { success: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  sharedIpcHandle(ipcHandle)("models:getSessionContextTier", async (sessionId: string) => {
    try {
      const contextTier = sessionManager.getSessionContextTier(sessionId);
      return { success: true, contextTier };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  sharedIpcHandle(ipcHandle)(
    "models:setSessionContextTier",
    async (sessionId: string, contextTier) => {
      try {
        await sessionManager.setSessionContextTier(sessionId, contextTier);
        return { success: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  ipcHandle("models:getTierDefaults", async (_event, tier) => {
    try {
      const defaults = sessionManager.getTierDefaults(tier);
      return { success: true, defaults };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("models:setTierDefaultModel", async (_event, tier, model) => {
    try {
      return await sessionManager.setTierDefaultModel(tier, model);
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("models:setTierDefaultReasoningEffort", async (_event, tier, effort) => {
    try {
      return await sessionManager.setTierDefaultReasoningEffort(tier, effort);
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("models:setTierDefaultContextTier", async (_event, tier, contextTier) => {
    try {
      return await sessionManager.setTierDefaultContextTier(tier, contextTier);
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}
