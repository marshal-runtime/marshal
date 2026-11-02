import { describe, expect, it } from "vitest";

import { getAppModeAssetMode, getAppModeBadgeText, getAppModeLabel } from "./app-mode-presentation";

describe("app mode branding", () => {
  it("maps each mode to its own icon assets", () => {
    expect(getAppModeAssetMode("dev")).toBe("dev");
    expect(getAppModeAssetMode("beta")).toBe("beta");
    expect(getAppModeAssetMode("release")).toBe("release");
  });

  it("returns display labels and badge text", () => {
    expect(getAppModeLabel("dev")).toBe("Dev");
    expect(getAppModeBadgeText("dev")).toBe("DEV");
    expect(getAppModeLabel("beta")).toBe("Beta");
    expect(getAppModeBadgeText("beta")).toBe("BETA");
    expect(getAppModeBadgeText("release")).toBe("");
    expect(getAppModeLabel("release")).toBe("");
  });
});
