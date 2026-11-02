import type { MSettings, RuntimeStartupSelection } from "../../common/marshal-ipc-contract";
import {
  COPILOT_RUNTIME_ID,
  getRuntimeMetadata,
  normalizeRuntimeId,
} from "../../common/runtime-config";

export function resolveRuntimeStartupSelection(
  settings: Pick<MSettings, "runtimeId">,
  options: { mockMode: boolean; gatewayE2E: boolean },
): RuntimeStartupSelection {
  const requestedRuntimeId = normalizeRuntimeId(settings.runtimeId);
  const availableRuntimeId = getRuntimeMetadata(requestedRuntimeId).selectable
    ? requestedRuntimeId
    : COPILOT_RUNTIME_ID;
  return {
    requestedRuntimeId,
    runtimeId: options.mockMode && !options.gatewayE2E ? COPILOT_RUNTIME_ID : availableRuntimeId,
  };
}
