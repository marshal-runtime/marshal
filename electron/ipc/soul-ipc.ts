import { sharedIpcHandle } from "../remote-access/shared-handlers";
import { coerceToKnownSoul, getSoulPresets, isKnownSoul } from "../souls";
import type { IpcDeps } from "./types";

export function registerSoulHandlers({
  sessionManager,
  ipcHandle,
}: Pick<IpcDeps, "sessionManager" | "ipcHandle">) {
  sharedIpcHandle(ipcHandle)("soul:list", async () => {
    return { success: true, souls: getSoulPresets() };
  });

  sharedIpcHandle(ipcHandle)("soul:getDefault", async () => {
    try {
      return {
        success: true,
        soul: coerceToKnownSoul(sessionManager.getDefaultSoul()),
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("soul:setDefault", async (_event, soul: string) => {
    try {
      if (!isKnownSoul(soul)) {
        return { success: false, error: "Soul not available" };
      }
      await sessionManager.setDefaultSoul(soul);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  sharedIpcHandle(ipcHandle)("soul:getGreeting", async (soulId: string) => {
    try {
      const greeting = sessionManager.getSoulGreeting(coerceToKnownSoul(soulId));
      return { success: true, greeting };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  sharedIpcHandle(ipcHandle)("soul:getSessionSoul", async (sessionId: string) => {
    try {
      const soul = sessionManager.getSessionSoul(sessionId);
      if (soul === undefined) return { success: true, soul };
      return { success: true, soul: coerceToKnownSoul(soul) };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}
