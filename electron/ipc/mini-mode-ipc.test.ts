import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PermissionAction } from "../../common/marshal-constants";

vi.mock("electron", () => ({
  ipcMain: { on: vi.fn<() => void>() },
  shell: { openExternal: vi.fn<() => Promise<void>>(() => Promise.resolve()) },
}));

vi.mock("../open-external", () => ({
  openExternalSafe: vi.fn<() => void>(),
}));

vi.mock("../app-paths", () => ({
  isDevMode: vi.fn<() => boolean>(() => false),
}));

import type { MiniModeManager } from "../mini-mode";
import { openExternalSafe } from "../open-external";
import type { PermissionCardManager } from "../permission-card-manager";
import { testDouble } from "../testing/harness";
import type { TrayManager } from "../tray";
import { registerMiniModeHandlers } from "./mini-mode-ipc";

type RegisteredHandler = (...args: unknown[]) => unknown;

async function registerHandlers() {
  const handlers = new Map<string, RegisteredHandler>();
  const ipcHandle = vi.fn<(channel: string, handler: RegisteredHandler) => void>(
    (channel: string, handler: RegisteredHandler) => {
      handlers.set(channel, handler);
    },
  );

  // Capture ipcMain.on handlers too (used by setInteractive)
  const permissionCardManager = {
    resolve: vi.fn<(requestId: string, action: PermissionAction) => { success: boolean }>(() => ({
      success: true,
    })),
  };

  const miniModeManager = {
    getSnapshot: vi.fn<() => void>(),
    getAsset: vi.fn<() => void>(),
    setInteractive: vi.fn<() => void>(),
    dismissApprovalFromMiniMode: vi.fn<() => void>(),
    hideNotification: vi.fn<() => void>(),
  };

  registerMiniModeHandlers({
    getWindow: () => null,
    ipcHandle: testDouble<import("./types").IpcDeps["ipcHandle"]>(ipcHandle),
    miniModeManager: testDouble<MiniModeManager>(miniModeManager),
    trayManager: testDouble<TrayManager>({ showWindow: vi.fn<() => void>() }),
    permissionCardManager: testDouble<PermissionCardManager>(permissionCardManager),
  });

  // Extract ipcMain.on handler for setInteractive from mock calls
  const { ipcMain } = await import("electron");
  const onCalls = vi.mocked(ipcMain.on).mock.calls;
  const setInteractiveCall = onCalls.find(([ch]) => ch === "mini-mode:setInteractive");
  const setInteractiveHandler = setInteractiveCall?.[1];

  return { handlers, permissionCardManager, miniModeManager, setInteractiveHandler };
}

describe("mini-mode-ipc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("mini-mode:openUrl handler", () => {
    it("calls openExternalSafe with the provided URL", async () => {
      const { handlers } = await registerHandlers();
      const handler = handlers.get("mini-mode:openUrl")!;

      const result = handler({}, "https://example.com");

      expect(openExternalSafe).toHaveBeenCalledWith("https://example.com");
      expect(result).toEqual({ success: true });
    });

    it("does not call openExternalSafe when url is empty", async () => {
      const { handlers } = await registerHandlers();
      const handler = handlers.get("mini-mode:openUrl")!;

      const result = handler({}, "");

      expect(openExternalSafe).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    it("does not call openExternalSafe when url is not a string", async () => {
      const { handlers } = await registerHandlers();
      const handler = handlers.get("mini-mode:openUrl")!;

      const result = handler({}, null);

      expect(openExternalSafe).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });
  });

  describe("copilot:resolvePermission handler", () => {
    it("delegates to permissionCardManager.resolve()", async () => {
      const { handlers, permissionCardManager } = await registerHandlers();
      const handler = handlers.get("copilot:resolvePermission")!;

      const result = handler({}, "perm-1", "allow");

      expect(permissionCardManager.resolve).toHaveBeenCalledWith("perm-1", "allow", undefined);
      expect(result).toEqual({ success: true });
    });

    it("threads overridePattern to permissionCardManager.resolve()", async () => {
      const { handlers, permissionCardManager } = await registerHandlers();
      const handler = handlers.get("copilot:resolvePermission")!;

      const result = handler({}, "perm-1", "always-allow", "npm install *");

      expect(permissionCardManager.resolve).toHaveBeenCalledWith(
        "perm-1",
        "always-allow",
        "npm install *",
      );
      expect(result).toEqual({ success: true });
    });

    it("rejects non-string overridePattern as undefined", async () => {
      const { handlers, permissionCardManager } = await registerHandlers();
      const handler = handlers.get("copilot:resolvePermission")!;

      handler({}, "perm-1", "always-allow", 42);

      expect(permissionCardManager.resolve).toHaveBeenCalledWith(
        "perm-1",
        "always-allow",
        undefined,
      );
    });

    it("returns {success: false} for invalid parameters", async () => {
      const { handlers, permissionCardManager } = await registerHandlers();
      const handler = handlers.get("copilot:resolvePermission")!;

      const result = handler({}, 123, "allow");

      expect(permissionCardManager.resolve).not.toHaveBeenCalled();
      expect(result).toEqual({ success: false, error: "Invalid parameters" });
    });
  });

  describe("mini-mode:setInteractive handler", () => {
    it("calls miniModeManager.setInteractive", async () => {
      const { setInteractiveHandler, miniModeManager } = await registerHandlers();
      expect(setInteractiveHandler).toBeDefined();

      setInteractiveHandler!(testDouble<import("electron").IpcMainEvent>({}), true);

      expect(miniModeManager.setInteractive).toHaveBeenCalledWith(true);
    });

    it("does not crash when setInteractive throws", async () => {
      const { setInteractiveHandler, miniModeManager } = await registerHandlers();
      expect(setInteractiveHandler).toBeDefined();

      vi.mocked(miniModeManager.setInteractive).mockImplementation(() => {
        throw new Error("window destroyed");
      });

      expect(() =>
        setInteractiveHandler!(testDouble<import("electron").IpcMainEvent>({}), false),
      ).not.toThrow();
    });
  });
});
