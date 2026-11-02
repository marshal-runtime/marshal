import type { MSettings } from "../common/marshal-ipc-contract";
import type { KeepAwakeManager } from "./keep-awake";
import type { PowerManager } from "./power";

interface KeepAwakeDeps {
  isRelayConnected: () => boolean;
  isHeartbeatEnabled: () => boolean;
  powerManager: Pick<PowerManager, "preventSleep" | "allowSleep">;
  keepAwake: Pick<KeepAwakeManager, "acquire" | "release">;
  isWindows: boolean;
}

/**
 * Applies keep-awake settings reactively when the user toggles
 * `preventSleepEnabled`, `mouseWiggleEnabled`, or `alwaysKeepAwakeEnabled`
 * in the Settings UI.
 *
 * Extracted from `main.ts` `settingsManager.on("changed")` for testability.
 */
export function applyKeepAwakeSettings(settings: MSettings, deps: KeepAwakeDeps): void {
  if (settings.alwaysKeepAwakeEnabled === true) {
    deps.powerManager.preventSleep("always");
  } else {
    deps.powerManager.allowSleep("always");
  }

  const preventSleepEnabled = settings.preventSleepEnabled ?? true;
  if (preventSleepEnabled) {
    if (deps.isRelayConnected()) deps.powerManager.preventSleep("relay");
    if (deps.isHeartbeatEnabled()) deps.powerManager.preventSleep("heartbeat");
  } else {
    deps.powerManager.allowSleep("relay");
    deps.powerManager.allowSleep("heartbeat");
  }

  if (deps.isWindows) {
    if (settings.alwaysKeepAwakeEnabled === true) {
      deps.keepAwake.acquire("always");
    } else {
      deps.keepAwake.release("always");
    }

    const mouseWiggleEnabled = settings.mouseWiggleEnabled ?? true;
    if (mouseWiggleEnabled) {
      if (deps.isRelayConnected()) deps.keepAwake.acquire("relay");
      if (deps.isHeartbeatEnabled()) deps.keepAwake.acquire("heartbeat");
    } else {
      deps.keepAwake.release("relay");
      deps.keepAwake.release("heartbeat");
    }
  }
}
