import { DEFAULT_SETTINGS } from "@common/marshal-default-settings";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { installMockAPIs } from "@/test-utils";
import type { MSettings } from "@/types/electron";

import { SessionRetentionSection } from "./SessionRetentionSection";

describe("SessionRetentionSection", () => {
  it("uses 90 days when the setting is missing", () => {
    installMockAPIs();
    const settings: MSettings = { ...DEFAULT_SETTINGS, sessionRetentionDays: undefined };
    render(<SessionRetentionSection settings={settings} onSaveSettings={vi.fn<() => void>()} />);
    expect(screen.getByRole("combobox")).toHaveTextContent("90 days");
  });

  it.each([
    ["30 days", 30],
    ["60 days", 60],
    ["90 days", 90],
    ["180 days", 180],
    ["1 year", 365],
    ["Never", 0],
  ])("converts %s to its numeric value", async (label, expectedValue) => {
    const user = userEvent.setup();
    const onSaveSettings =
      vi.fn<(updated: Parameters<typeof SessionRetentionSection>[0]["settings"]) => void>();
    installMockAPIs();
    const settings: MSettings = {
      ...DEFAULT_SETTINGS,
      sessionRetentionDays: expectedValue === 90 ? 30 : 90,
    };
    render(<SessionRetentionSection settings={settings} onSaveSettings={onSaveSettings} />);

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: label }));
    expect(onSaveSettings).toHaveBeenCalledWith({
      ...settings,
      sessionRetentionDays: expectedValue,
    });
  });
});
