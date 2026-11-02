// Marshal-owned test
import { describe, expect, it, vi } from "vitest";

import { type AppMode } from "../common/marshal-constants";
import { createAppModeController } from "./app-mode-controller";

function makeController(state: { baseMode: AppMode } = { baseMode: "release" }) {
  const setPreloadMode = vi.fn<(mode: AppMode) => void>();
  const applyNativeBranding = vi.fn<(mode: AppMode) => void>();
  const applyPopoutBranding = vi.fn<() => void>();
  const broadcastRendererMode = vi.fn<(mode: AppMode) => void>();

  const controller = createAppModeController({
    getBaseMode: () => state.baseMode,
    setPreloadMode,
    applyNativeBranding,
    applyPopoutBranding,
    broadcastRendererMode,
  });

  return {
    state,
    controller,
    setPreloadMode,
    applyNativeBranding,
    applyPopoutBranding,
    broadcastRendererMode,
  };
}

describe("createAppModeController", () => {
  it("applies the base mode to preload, native, popout, and renderer branding", () => {
    const h = makeController({ baseMode: "release" });

    expect(h.controller.applyEffectiveAppMode()).toBe("release");

    expect(h.setPreloadMode).toHaveBeenCalledWith("release");
    expect(h.applyNativeBranding).toHaveBeenCalledWith("release");
    expect(h.applyPopoutBranding).toHaveBeenCalledOnce();
    expect(h.broadcastRendererMode).toHaveBeenCalledWith("release");
  });

  it("does not reapply native or renderer branding when the effective mode has not changed", () => {
    const h = makeController({ baseMode: "release" });

    h.controller.applyEffectiveAppMode();
    h.controller.applyEffectiveAppMode();

    expect(h.setPreloadMode).toHaveBeenCalledTimes(2);
    expect(h.applyNativeBranding).toHaveBeenCalledOnce();
    expect(h.applyPopoutBranding).toHaveBeenCalledOnce();
    expect(h.broadcastRendererMode).toHaveBeenCalledOnce();
  });

  it("reapplies branding when the base mode changes", () => {
    const h = makeController({ baseMode: "dev" });
    expect(h.controller.applyEffectiveAppMode()).toBe("dev");

    h.state.baseMode = "beta";
    expect(h.controller.applyEffectiveAppMode()).toBe("beta");

    expect(h.applyNativeBranding).toHaveBeenNthCalledWith(1, "dev");
    expect(h.applyNativeBranding).toHaveBeenNthCalledWith(2, "beta");
  });
});
