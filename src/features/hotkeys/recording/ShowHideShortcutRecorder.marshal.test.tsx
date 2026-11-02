// marshal-owned renderer test
import { describe, expect, it, vi, beforeEach } from "vitest";

import { HotkeysRoot } from "@/features/hotkeys";
import { installMockAPIs, render, screen, userEvent, within } from "@/test-utils";
import type { MSettings, SettingsAPI } from "@/types/electron";

import { ShowHideShortcutRecorder } from "./ShowHideShortcutRecorder";

const baseSettings: MSettings = {
  autoApprove: { global: false, perServer: {} },
  showHideShortcutEnabled: true,
};

function renderRecorder(settings: MSettings = baseSettings) {
  const onSaveSettings = vi.fn<(settings: MSettings) => void>();
  render(
    <HotkeysRoot>
      <ShowHideShortcutRecorder settings={settings} onSaveSettings={onSaveSettings} />
    </HotkeysRoot>,
  );
  return { onSaveSettings };
}

describe("ShowHideShortcutRecorder", () => {
  beforeEach(() => {
    installMockAPIs();
    Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true });
  });

  it("displays the current show/hide shortcut", () => {
    renderRecorder({ ...baseSettings, showHideShortcut: "CommandOrControl+Shift+K" });

    const shortcut = screen.getByRole("img", { name: "Ctrl+Shift+K" });
    expect(shortcut).toBeInTheDocument();
    expect(shortcut).toHaveAttribute("data-slot", "kbd-group");
    expect(within(shortcut).getByText("Ctrl")).toHaveAttribute("data-slot", "kbd");
    expect(within(shortcut).getByText("Shift")).toHaveAttribute("data-slot", "kbd");
    expect(within(shortcut).getByText("K")).toHaveAttribute("data-slot", "kbd");
  });

  it("falls back to the default display and shows an error for an invalid persisted shortcut", () => {
    const { onSaveSettings } = renderRecorder({ ...baseSettings, showHideShortcut: "Control+A+B" });

    expect(screen.getByRole("img", { name: "Ctrl+Alt+␣" })).toHaveAttribute(
      "data-slot",
      "kbd-group",
    );
    expect(
      screen.getByText("Saved shortcut is invalid. Record a new shortcut or reset to default."),
    ).toBeInTheDocument();
    expect(onSaveSettings).not.toHaveBeenCalled();
  });

  it("saves a recorded modifier shortcut as a normalized Electron accelerator", async () => {
    const user = userEvent.setup();
    const { onSaveSettings } = renderRecorder();

    await user.click(screen.getByRole("button", { name: "Record shortcut" }));
    expect(
      screen.getByRole("button", { name: "Recording shortcut, press keys now" }),
    ).toHaveTextContent("Press shortcut...");
    await user.keyboard("{Control>}{Shift>}k{/Shift}{/Control}");

    expect(onSaveSettings).toHaveBeenCalledWith({
      ...baseSettings,
      showHideShortcut: "CommandOrControl+Shift+K",
    });
  });

  it("shows validation and does not save for a single printable key", async () => {
    const user = userEvent.setup();
    const { onSaveSettings } = renderRecorder();

    await user.click(screen.getByRole("button", { name: "Record shortcut" }));
    await user.keyboard("k");

    expect(
      screen.getByText("Use at least one modifier for the global show/hide shortcut."),
    ).toBeInTheDocument();
    expect(onSaveSettings).not.toHaveBeenCalled();
  });

  it("announces validation errors to screen readers", async () => {
    const user = userEvent.setup();
    renderRecorder();

    await user.click(screen.getByRole("button", { name: "Record shortcut" }));
    await user.keyboard("k");

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Use at least one modifier for the global show/hide shortcut.",
    );
  });

  it("shows failed registration status for the saved shortcut", async () => {
    installMockAPIs({
      settingsAPI: {
        getShowHideShortcutStatus: vi
          .fn<SettingsAPI["getShowHideShortcutStatus"]>()
          .mockResolvedValue({
            success: true,
            status: {
              enabled: true,
              accelerator: "CommandOrControl+Shift+K",
              registered: false,
              error: "Failed to register CommandOrControl+Shift+K",
            },
          }),
      },
    });

    renderRecorder({ ...baseSettings, showHideShortcut: "CommandOrControl+Shift+K" });

    expect(
      await screen.findByText("Failed to register CommandOrControl+Shift+K"),
    ).toBeInTheDocument();
  });

  it("keeps local validation errors ahead of registration status errors", async () => {
    const user = userEvent.setup();
    installMockAPIs({
      settingsAPI: {
        getShowHideShortcutStatus: vi
          .fn<SettingsAPI["getShowHideShortcutStatus"]>()
          .mockResolvedValue({
            success: true,
            status: {
              enabled: true,
              accelerator: "CommandOrControl+Shift+K",
              registered: false,
              error: "Failed to register CommandOrControl+Shift+K",
            },
          }),
      },
    });
    renderRecorder({ ...baseSettings, showHideShortcut: "CommandOrControl+Shift+K" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed to register CommandOrControl+Shift+K",
    );

    await user.click(screen.getByRole("button", { name: "Record shortcut" }));
    await user.keyboard("k");

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Use at least one modifier for the global show/hide shortcut.",
    );
  });

  it("explains that saved shortcuts stay inactive while the global shortcut is disabled", () => {
    renderRecorder({ ...baseSettings, showHideShortcutEnabled: false });

    expect(
      screen.getByText("Shortcut is saved but inactive until global show/hide is enabled."),
    ).toBeInTheDocument();
  });

  it("clears stale validation errors when recording is started again", async () => {
    const user = userEvent.setup();
    renderRecorder();

    await user.click(screen.getByRole("button", { name: "Record shortcut" }));
    await user.keyboard("k");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Use at least one modifier for the global show/hide shortcut.",
    );

    await user.click(screen.getByRole("button", { name: "Record shortcut" }));

    expect(
      screen.queryByText("Use at least one modifier for the global show/hide shortcut."),
    ).not.toBeInTheDocument();
  });

  it("resets to the default shortcut when recording is cleared", async () => {
    const user = userEvent.setup();
    const { onSaveSettings } = renderRecorder({
      ...baseSettings,
      showHideShortcut: "CommandOrControl+Shift+K",
    });

    await user.click(screen.getByRole("button", { name: "Record shortcut" }));
    await user.keyboard("{Backspace}");

    expect(onSaveSettings).toHaveBeenCalledWith({
      ...baseSettings,
      showHideShortcut: "Control+Alt+Space",
    });
  });
});
