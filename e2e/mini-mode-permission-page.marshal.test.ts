import path from "path";
import { pathToFileURL } from "url";

import { test, expect } from "./marshal-fixtures";

declare global {
  interface Window {
    miniModeAPI: {
      getState: () => Promise<MiniModePayload>;
      getAsset: () => Promise<{ success: boolean; asset?: string }>;
      showMainWindow: () => Promise<{ success: boolean }>;
      respondPermission: (requestId: string, action: string) => Promise<{ success: boolean }>;
      dismissApproval: () => Promise<{ success: boolean }>;
      dismissNotification: () => Promise<{ success: boolean }>;
      openUrl: () => Promise<{ success: boolean }>;
      setInteractive: () => void;
      onState: (callback: (payload: { status: string }) => void) => () => void;
      onPermission: (callback: (payload: MiniModePayload) => void) => () => void;
      onTheme: (callback: (payload: MiniModeTheme) => void) => () => void;
      onNotification: (callback: (payload: { notification: null }) => void) => () => void;
    };
    __miniModeActions: Array<{ requestId: string; action: string }>;
  }
}

interface MiniModePayload {
  status: string;
  pendingPermissionCount: number;
  permissionIndex: number;
  permission: {
    id: string;
    kind: string;
    title: string;
    message: string;
    detail: string;
    buttons: string[];
  };
}

interface MiniModeTheme {
  windowBackground: string;
  surfaceBackground: string;
  borderColor: string;
  textPrimary: string;
  textSecondary: string;
  codeBackground: string;
  secondaryButtonBackground: string;
  secondaryButtonText: string;
  approvalKindBackground: string;
  approvalKindText: string;
  approvalKindBorderColor: string;
  countBackground: string;
  countText: string;
  linkColor: string;
}

const miniModePayload: MiniModePayload = {
  status: "monocle",
  pendingPermissionCount: 1,
  permissionIndex: 1,
  permission: {
    id: "perm-mini-scope",
    kind: "memory",
    title: "Remember fact",
    message: "Marshal wants to store a memory",
    detail: "Remember this repository prefers scoped permission approvals.",
    buttons: ["Allow", "Allow for session", "Always allow", "Deny"],
  },
};

const theme: MiniModeTheme = {
  windowBackground: "#1e1e1e",
  surfaceBackground: "#242424",
  borderColor: "rgba(255,255,255,0.12)",
  textPrimary: "#e8e8e8",
  textSecondary: "#a0a0a0",
  codeBackground: "#1a1a1a",
  secondaryButtonBackground: "rgba(255,255,255,0.12)",
  secondaryButtonText: "#e8e8e8",
  approvalKindBackground: "rgba(255,202,87,0.14)",
  approvalKindText: "#ffd166",
  approvalKindBorderColor: "rgba(255,202,87,0.16)",
  countBackground: "rgba(255,255,255,0.08)",
  countText: "#a0a0a0",
  linkColor: "#5bb5ff",
};

test.describe("mini-mode permission page", () => {
  test("maps scoped permission labels to resolve actions", async ({ page }) => {
    await page.addInitScript(
      ({ payload, miniTheme }) => {
        window.__miniModeActions = [];
        window.miniModeAPI = {
          getState: async () => payload,
          getAsset: async () => ({ success: false }),
          showMainWindow: async () => ({ success: true }),
          respondPermission: async (requestId: string, action: string) => {
            window.__miniModeActions.push({ requestId, action });
            return { success: true };
          },
          dismissApproval: async () => ({ success: true }),
          dismissNotification: async () => ({ success: true }),
          openUrl: async () => ({ success: true }),
          setInteractive: () => {},
          onState: () => () => {},
          onPermission: () => () => {},
          onTheme: (callback: (payload: MiniModeTheme) => void) => {
            callback(miniTheme);
            return () => {};
          },
          onNotification: () => () => {},
        };
      },
      { payload: miniModePayload, miniTheme: theme },
    );

    await page.goto(
      pathToFileURL(path.join(process.cwd(), "electron", "mini-mode-page", "index.html")).href,
    );

    const approvalCard = page.locator("#approval-card");
    await expect(approvalCard).toBeVisible();
    await expect(page.locator("#permission-kind")).toHaveText("🧠 Memory");
    await expect(page.getByRole("button", { name: "Allow for session" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Allow everywhere" })).toBeVisible();

    await page.getByRole("button", { name: "Allow for session" }).click();
    await expect
      .poll(() => page.evaluate(() => window.__miniModeActions))
      .toEqual([{ requestId: "perm-mini-scope", action: "allow-session" }]);
  });

  test("maps global permission label to always-allow", async ({ page }) => {
    await page.addInitScript(
      ({ payload, miniTheme }) => {
        window.__miniModeActions = [];
        window.miniModeAPI = {
          getState: async () => payload,
          getAsset: async () => ({ success: false }),
          showMainWindow: async () => ({ success: true }),
          respondPermission: async (requestId: string, action: string) => {
            window.__miniModeActions.push({ requestId, action });
            return { success: true };
          },
          dismissApproval: async () => ({ success: true }),
          dismissNotification: async () => ({ success: true }),
          openUrl: async () => ({ success: true }),
          setInteractive: () => {},
          onState: () => () => {},
          onPermission: () => () => {},
          onTheme: (callback: (payload: MiniModeTheme) => void) => {
            callback(miniTheme);
            return () => {};
          },
          onNotification: () => () => {},
        };
      },
      { payload: miniModePayload, miniTheme: theme },
    );

    await page.goto(
      pathToFileURL(path.join(process.cwd(), "electron", "mini-mode-page", "index.html")).href,
    );

    await page.getByRole("button", { name: "Allow everywhere" }).click();
    await expect
      .poll(() => page.evaluate(() => window.__miniModeActions))
      .toEqual([{ requestId: "perm-mini-scope", action: "always-allow" }]);
  });
});
