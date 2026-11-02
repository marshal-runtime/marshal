/// <reference types="vite-plugin-electron/electron-env" />
// `?raw` typing for the built-in runtimeShowUi component sources
// (electron/marshal-runtime/show-ui-components.ts) — vite-plugin-electron's
// own env types don't include vite/client's ambient module declarations.
/// <reference types="vite/client" />

declare const __EXPECTED_WINDOWS_SIGNER_SUBJECT__: string;
declare const __EXPECTED_MACOS_TEAM_ID__: string;
declare const __MARSHAL_RUNTIME_ACCEPTANCE_BUILD__: boolean;

declare namespace NodeJS {
  interface ProcessEnv {
    APP_ROOT: string;
    VITE_PUBLIC: string;
  }
}

// Window interface with non-optional API declarations for main-process code.
// Uses import() types from the single source of truth (common/marshal-ipc-contract).
interface Window {
  platform?: string;
  copilotAPI: import("../common/marshal-ipc-contract").CopilotAPI;
  sessionsAPI: import("../common/marshal-ipc-contract").SessionsAPI;
  modelsAPI: import("../common/marshal-ipc-contract").ModelsAPI;
  soulAPI: import("../common/marshal-ipc-contract").SoulAPI;
  skillsAPI: import("../common/marshal-ipc-contract").SkillsAPI;
  heartbeatAPI: import("../common/marshal-ipc-contract").HeartbeatAPI;
  automationsAPI: import("../common/marshal-ipc-contract").AutomationsAPI;
  updateAPI: import("../common/marshal-ipc-contract").UpdateAPI;
  settingsAPI: import("../common/marshal-ipc-contract").SettingsAPI;
  relayProviderSettingsAPI: import("../common/marshal-ipc-contract").RelayProviderSettingsAPI;
  devAPI: import("../common/marshal-ipc-contract").DevAPI;
  mcpsAPI: import("../common/marshal-ipc-contract").McpsAPI;
  tenantAPI?: import("../common/marshal-ipc-contract").TenantAPI;
  workspaceAPI: import("../common/marshal-ipc-contract").WorkspaceAPI;
  diagnosticsAPI?: import("../common/marshal-ipc-contract").DiagnosticsAPI;
  backgroundAPI?: import("../common/marshal-ipc-contract").BackgroundAPI;
  windowControlsAPI?: import("../common/marshal-ipc-contract").WindowControlsAPI;
  electronAPI?: import("../common/marshal-ipc-contract").ElectronAPI;
}
