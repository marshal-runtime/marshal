import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs } from "@/test-utils";

import { PowerManagementSection } from "./PowerManagementSection";

describe("PowerManagementSection", () => {
  const defaultSettings = {
    autoApprove: { global: false, perServer: {} },
    preventSleepEnabled: true,
    mouseWiggleEnabled: true,
    alwaysKeepAwakeEnabled: false,
  };

  beforeEach(() => {
    installMockAPIs();
  });

  it("renders prevent-sleep switch", () => {
    render(
      <PowerManagementSection
        settings={defaultSettings}
        onSaveSettings={vi.fn<() => void>()}
        showMouseWiggle={true}
      />,
    );

    expect(screen.getByText("Prevent sleep")).toBeInTheDocument();
  });

  it("renders mouse-wiggle switch on Windows when allowed", () => {
    window.platform = "win32";
    render(
      <PowerManagementSection
        settings={defaultSettings}
        onSaveSettings={vi.fn<() => void>()}
        showMouseWiggle={true}
      />,
    );

    expect(screen.getByText("Mouse wiggle")).toBeInTheDocument();
  });

  it("renders always-keep-awake switch", () => {
    render(
      <PowerManagementSection
        settings={defaultSettings}
        onSaveSettings={vi.fn<() => void>()}
        showMouseWiggle={true}
      />,
    );

    expect(screen.getByText("Always keep awake")).toBeInTheDocument();
  });

  it("does not render mouse-wiggle switch on non-Windows", () => {
    window.platform = "darwin";
    render(
      <PowerManagementSection
        settings={defaultSettings}
        onSaveSettings={vi.fn<() => void>()}
        showMouseWiggle={true}
      />,
    );

    expect(screen.queryByText("Mouse wiggle")).not.toBeInTheDocument();
  });

  it("does not render mouse-wiggle switch on Windows when not allowed", () => {
    window.platform = "win32";
    render(
      <PowerManagementSection
        settings={defaultSettings}
        onSaveSettings={vi.fn<() => void>()}
        showMouseWiggle={false}
      />,
    );

    expect(screen.queryByText("Mouse wiggle")).not.toBeInTheDocument();
  });

  it("persists prevent-sleep toggle with correct value", async () => {
    const onSave = vi.fn<() => void>();
    const user = userEvent.setup();
    render(
      <PowerManagementSection
        settings={defaultSettings}
        onSaveSettings={onSave}
        showMouseWiggle={true}
      />,
    );

    await user.click(screen.getByText("Prevent sleep"));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ preventSleepEnabled: false }));
    });
  });

  it("persists mouse-wiggle toggle with correct value", async () => {
    window.platform = "win32";
    const onSave = vi.fn<() => void>();
    const user = userEvent.setup();
    render(
      <PowerManagementSection
        settings={defaultSettings}
        onSaveSettings={onSave}
        showMouseWiggle={true}
      />,
    );

    await user.click(screen.getByText("Mouse wiggle"));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ mouseWiggleEnabled: false }));
    });
  });

  it("persists always-keep-awake toggle with correct value", async () => {
    const onSave = vi.fn<() => void>();
    const user = userEvent.setup();
    render(
      <PowerManagementSection
        settings={defaultSettings}
        onSaveSettings={onSave}
        showMouseWiggle={true}
      />,
    );

    await user.click(screen.getByText("Always keep awake"));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ alwaysKeepAwakeEnabled: true }),
      );
    });
  });

  it("defaults switches to checked when settings are undefined", () => {
    render(
      <PowerManagementSection
        settings={{ autoApprove: { global: false, perServer: {} } }}
        onSaveSettings={vi.fn<() => void>()}
        showMouseWiggle={true}
      />,
    );

    const preventSleepSwitch = screen.getByRole("switch", { name: "Prevent sleep" });
    expect(preventSleepSwitch).toHaveAttribute("data-state", "checked");
    const alwaysKeepAwakeSwitch = screen.getByRole("switch", { name: "Always keep awake" });
    expect(alwaysKeepAwakeSwitch).toHaveAttribute("data-state", "unchecked");
  });
});
