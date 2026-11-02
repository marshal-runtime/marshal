import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { wireAppModeController } from "./marshal-app-mode-controller-wiring";

function setup() {
  const settingsManager = new EventEmitter();
  const applyEffectiveAppMode = vi.fn<() => void>();

  wireAppModeController({ settingsManager, applyEffectiveAppMode });

  return { settingsManager, applyEffectiveAppMode };
}

describe("wireAppModeController", () => {
  it("recomputes the effective app mode on every settings change", () => {
    const { settingsManager, applyEffectiveAppMode } = setup();

    settingsManager.emit("changed", { experiments: { cloudSync: true } });
    settingsManager.emit("changed", { experiments: { cloudSync: false } });

    expect(applyEffectiveAppMode).toHaveBeenCalledTimes(2);
  });

  it("does not recompute before any settings change", () => {
    const { applyEffectiveAppMode } = setup();

    expect(applyEffectiveAppMode).not.toHaveBeenCalled();
  });
});
