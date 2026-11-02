import { describe, expect, it, vi } from "vitest";

import { ensureMacDockPresence, shouldSkipTaskbarForHiddenWindow } from "./window-taskbar";

describe("ensureMacDockPresence", () => {
  it("uses the regular macOS activation policy", () => {
    const app = { setActivationPolicy: vi.fn<(policy: "regular") => void>() };

    ensureMacDockPresence(app, "darwin");

    expect(app.setActivationPolicy).toHaveBeenCalledWith("regular");
  });

  it.each(["win32", "linux"] as const)("leaves the %s activation policy unchanged", (platform) => {
    const app = { setActivationPolicy: vi.fn<(policy: "regular") => void>() };

    ensureMacDockPresence(app, platform);

    expect(app.setActivationPolicy).not.toHaveBeenCalled();
  });
});

describe("shouldSkipTaskbarForHiddenWindow", () => {
  it("keeps hidden macOS windows represented in the Dock", () => {
    expect(shouldSkipTaskbarForHiddenWindow("darwin")).toBe(false);
  });

  it.each(["win32", "linux"] as const)("hides windows from the %s taskbar", (platform) => {
    expect(shouldSkipTaskbarForHiddenWindow(platform)).toBe(true);
  });
});
