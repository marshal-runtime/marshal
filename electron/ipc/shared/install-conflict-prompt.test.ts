import { describe, expect, it, vi } from "vitest";

const { BrowserWindowMock, showMessageBox } = vi.hoisted(() => ({
  BrowserWindowMock: vi.fn<() => void>(),
  showMessageBox:
    vi.fn<
      (
        ...args: [Electron.BrowserWindow, Electron.MessageBoxOptions] | [Electron.MessageBoxOptions]
      ) => Promise<{ response: number }>
    >(),
}));

vi.mock("electron", () => ({
  BrowserWindow: BrowserWindowMock,
  dialog: { showMessageBox },
}));

import { BrowserWindow } from "electron";

import {
  askHowToResolveInstallConflicts,
  formatInstallConflictDetails,
} from "./install-conflict-prompt";

describe("formatInstallConflictDetails", () => {
  it("formats skills and automations as separate sections", () => {
    expect(formatInstallConflictDetails(["skill-a"], ["automation-a", "automation-b"])).toBe(
      "Skills (1):\n  • skill-a\n\nAutomations (2):\n  • automation-a\n  • automation-b\n\nHow would you like to proceed?",
    );
  });

  it("omits empty conflict sections", () => {
    expect(formatInstallConflictDetails([], ["automation-a"])).toBe(
      "Automations (1):\n  • automation-a\n\nHow would you like to proceed?",
    );
  });
});

describe("askHowToResolveInstallConflicts", () => {
  it("uses the BrowserWindow overload and maps the response", async () => {
    const window = new BrowserWindow();
    showMessageBox.mockResolvedValueOnce({ response: 1 });

    await expect(askHowToResolveInstallConflicts(() => window, ["skill-a"], [])).resolves.toBe(
      "replace",
    );
    expect(showMessageBox).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        buttons: ["Skip existing", "Replace all", "Cancel"],
        defaultId: 0,
        cancelId: 2,
        detail: expect.stringContaining("Skills (1)"),
      }),
    );
  });

  it("uses the options-only overload and preserves cancel", async () => {
    showMessageBox.mockResolvedValueOnce({ response: 2 });

    await expect(askHowToResolveInstallConflicts(() => null, [], ["automation-a"])).resolves.toBe(
      "cancel",
    );
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: ["Skip existing", "Replace all", "Cancel"],
        defaultId: 0,
        cancelId: 2,
      }),
    );
  });
});
