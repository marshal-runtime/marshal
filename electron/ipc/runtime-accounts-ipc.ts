import { createLogger } from "../../common/marshal-logger";
import { isRuntimeAuthLoginRequest } from "../../common/runtime-auth";
import type { RuntimeAccountsManager } from "../runtime-accounts-manager";
import type { IpcDeps } from "./types";

const log = createLogger("RuntimeAccountsIPC");

function failure(action: string, error: unknown): { success: false; error: string } {
  log.error(`Runtime account ${action} failed:`, error);
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}

export function registerRuntimeAccountsHandlers({
  ipcHandle,
  runtimeAccounts,
}: Pick<IpcDeps, "ipcHandle"> & { runtimeAccounts: RuntimeAccountsManager }): void {
  ipcHandle("runtimeAccounts:list", () => {
    try {
      return { success: true, runtimes: runtimeAccounts.list() };
    } catch (error) {
      return failure("list", error);
    }
  });

  ipcHandle("runtimeAccounts:add", (_event, runtimeId, label) => {
    try {
      return { success: true, account: runtimeAccounts.add(runtimeId, label) };
    } catch (error) {
      return failure("add", error);
    }
  });

  ipcHandle("runtimeAccounts:rename", (_event, runtimeId, accountId, label) => {
    try {
      runtimeAccounts.rename(runtimeId, accountId, label);
      return { success: true };
    } catch (error) {
      return failure("rename", error);
    }
  });

  ipcHandle("runtimeAccounts:remove", async (_event, runtimeId, accountId) => {
    try {
      await runtimeAccounts.remove(runtimeId, accountId);
      return { success: true };
    } catch (error) {
      return failure("remove", error);
    }
  });

  ipcHandle("runtimeAccounts:setDefault", (_event, runtimeId, accountId) => {
    try {
      runtimeAccounts.setDefault(runtimeId, accountId);
      return { success: true };
    } catch (error) {
      return failure("default change", error);
    }
  });

  ipcHandle("runtimeAccounts:getStatus", async (_event, runtimeId, accountId) => {
    try {
      return { success: true, status: await runtimeAccounts.getStatus(runtimeId, accountId) };
    } catch (error) {
      return failure("status check", error);
    }
  });

  ipcHandle("runtimeAccounts:getUsage", async (_event, runtimeId, accountId, options) => {
    try {
      return {
        success: true,
        usage: await runtimeAccounts.getUsage(runtimeId, accountId, {
          force: options?.force === true,
        }),
      };
    } catch (error) {
      return failure("usage read", error);
    }
  });

  ipcHandle("runtimeAccounts:login", async (_event, runtimeId, accountId, request) => {
    if (!isRuntimeAuthLoginRequest(request)) {
      return { success: false, error: "Invalid runtime authentication request" };
    }
    try {
      return { success: true, state: await runtimeAccounts.login(runtimeId, accountId, request) };
    } catch (error) {
      return failure("sign-in", error);
    }
  });

  ipcHandle("runtimeAccounts:signOut", async (_event, runtimeId, accountId) => {
    try {
      await runtimeAccounts.signOut(runtimeId, accountId);
      return { success: true };
    } catch (error) {
      return failure("sign-out", error);
    }
  });
}
