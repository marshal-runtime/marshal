// Ownership: application-mode event wiring.

export interface AppModeWiringDeps {
  settingsManager: { on(event: "changed", cb: () => void): void };
  applyEffectiveAppMode: () => void;
}

// Route every event source that can flip the effective app mode through a single recompute.
export function wireAppModeController(deps: AppModeWiringDeps): void {
  deps.settingsManager.on("changed", () => deps.applyEffectiveAppMode());
}
