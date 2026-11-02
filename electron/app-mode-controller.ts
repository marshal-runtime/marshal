import type { AppMode } from "../common/marshal-constants";

export interface AppModeControllerDeps {
  getBaseMode: () => AppMode;
  setPreloadMode: (mode: AppMode) => void;
  applyNativeBranding: (mode: AppMode) => void;
  applyPopoutBranding: () => void;
  broadcastRendererMode: (mode: AppMode) => void;
}

export function createAppModeController(deps: AppModeControllerDeps) {
  let currentMode: AppMode | null = null;

  const getEffectiveAppMode = (): AppMode => deps.getBaseMode();

  const applyEffectiveAppMode = (): AppMode => {
    const mode = getEffectiveAppMode();
    deps.setPreloadMode(mode);
    if (mode !== currentMode) {
      currentMode = mode;
      deps.applyNativeBranding(mode);
      deps.applyPopoutBranding();
      deps.broadcastRendererMode(mode);
    }
    return mode;
  };

  return { getEffectiveAppMode, applyEffectiveAppMode };
}
