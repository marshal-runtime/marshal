import type { MSettings, PermissionsConfig, ReasoningEffort } from "./marshal-ipc-contract";
import { DEFAULT_TOOL_APPROVALS } from "./marshal-tool-registry";
import { DEFAULT_SHOW_HIDE_SHORTCUT } from "./marshal/show-hide-shortcut";
import {
  DEFAULT_MEMORY_PROVIDER_ID,
  DEFAULT_SESSION_STORAGE_PROVIDER_ID,
  DEFAULT_SKILL_PROVIDER_IDS,
  DEFAULT_WORK_SERVICE_PROVIDER_IDS,
  createDefaultRelaySettings,
} from "./provider-config";
import { DEFAULT_RUNTIME_ID, normalizeRuntimeId } from "./runtime-config";

export interface RuntimeSelectionSettings {
  runtimeId?: string;
}

export function normalizeRuntimeSelectionSettings<T extends RuntimeSelectionSettings>(
  settings: T,
): T {
  return {
    ...settings,
    runtimeId: normalizeRuntimeId(settings.runtimeId),
  };
}

export const DEFAULT_SWARM_WORKER_MODEL = "gpt-5.6-luna";
export const DEFAULT_SWARM_WORKER_REASONING_EFFORT: ReasoningEffort = "medium";
export const DEFAULT_PERMISSIONS: PermissionsConfig = {
  autopilotMode: false,
  autoApproveReadOnly: false,
  allow: [],
  allowModelPermissionsChange: false,
  tools: { ...DEFAULT_TOOL_APPROVALS },
  servers: {
    filesystem: { enabled: true, autoApprove: false },
    playwright: { enabled: true, autoApprove: false },
    shell: { enabled: true, autoApprove: false },
  },
};

export const DEFAULT_SETTINGS: MSettings = {
  autoApprove: { global: false, perServer: {} },
  permissions: DEFAULT_PERMISSIONS,
  theme: "system",
  runtimeId: DEFAULT_RUNTIME_ID,
  memoryProviderId: DEFAULT_MEMORY_PROVIDER_ID,
  sessionStorageProviderId: DEFAULT_SESSION_STORAGE_PROVIDER_ID,
  skillProviderIds: [...DEFAULT_SKILL_PROVIDER_IDS],
  ...DEFAULT_WORK_SERVICE_PROVIDER_IDS,
  relay: createDefaultRelaySettings(),
  whatsapp: {
    enabled: false,
    defaultNotificationsEnabled: true,
    progressNotificationsEnabled: true,
  },
  miniModeEnabled: false,
  // Defaults to false; set to true when mini mode is first enabled via the UI.
  // Existing users who enabled mini mode before this default was added keep their
  // persisted value — they won't auto-get start-in-mini until they re-toggle.
  startInMiniModeEnabled: false,
  showHideShortcutEnabled: false,
  showHideShortcut: DEFAULT_SHOW_HIDE_SHORTCUT,
  experiments: {
    uiExtensionsSystem: false,
    promptReplacement: true,
    leanPrompt: true,
    leanRepoRules: true,
    leanCore: true,
  },
  telemetryEnabled: true,
  sessionRetentionDays: 90,
  swarmWorkerModel: DEFAULT_SWARM_WORKER_MODEL,
  swarmWorkerReasoningEffort: DEFAULT_SWARM_WORKER_REASONING_EFFORT,
  preventSleepEnabled: true,
  mouseWiggleEnabled: true,
  alwaysKeepAwakeEnabled: false,
  updateChannelBeta: false,
};
