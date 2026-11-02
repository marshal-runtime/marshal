/**
 * Re-exports from the single source of truth: common/marshal-ipc-contract.ts
 * This file exists so that existing `import type { ... } from "../types/electron"`
 * imports across src/ continue to work without path changes.
 */
export type {
  FileExportAPI,
  // Domain types
  RuntimeEvent,
  RuntimeEventWrapper,
  RuntimeAuthLoginRequest,
  RuntimeAuthLoginState,
  RuntimeAuthStatus,
  TurnEvent,
  TurnState,
  MessageToolCall,
  SessionView,
  SessionViewDelivery,
  SessionViewEvent,
  SessionViewSnapshot,
  SessionStatusBatch,
  SessionStatusDelta,
  SessionViewStatus,
  CopilotAttachment,
  OverlayReviewAttachmentKind,
  OverlayReviewLaunchRequest,
  OverlayReviewTarget,
  OverlayReviewComposerAttachment,
  OverlayReviewSubmittedEvent,
  OverlayReviewErrorEvent,
  SessionMessage,
  SessionListPage,
  SessionMetadata,
  SessionRepositoryAgent,
  WorkspaceInstanceIdentity,
  MainSessionWorkspaceBinding,
  MainSessionContextSelection,
  SessionPermissionMode,
  ReviewerSessionPermissionMode,
  ReviewerSessionCapabilities,
  ReviewerSessionPermissionScope,
  ReviewerValidationArtifactRef,
  ReviewerValidationAuthorizationResult,
  ReviewerValidationAuthorized,
  ReviewerValidationCommandSpec,
  ReviewerValidationDenied,
  ReviewerValidationPermissionRequest,
  ReviewerValidationReceipt,
  ReviewerValidationRequest,
  SessionSearchResult,
  SessionSource,
  StoredSession,
  PermissionCardData,
  PermissionKind,
  Skill,
  ModelInfo,
  ReasoningEffort,
  ContextTier,
  ModelTier,
  SoulPreset,
  HeartbeatStatus,
  HeartbeatStatusEnvelope,
  HeartbeatSettings,
  HeartbeatSettingsEnvelope,
  HeartbeatControllableMap,
  HeartbeatLogEntry,
  AutomationStep,
  AutomationSchedule,
  AutomationData,
  AutomationCreateInput,
  AutomationStepResult,
  AutomationRunData,
  MServerPermissions,
  McpToolInfo,
  McpServerInfo,
  CustomMcpServer,
  MSettings,
  PermissionsConfig,
  PermissionsControllableMap,
  ServerPermission,
  ToolInfo,
  ToolGroup,
  ToolCategory,
  BackgroundServiceSettings,
  GatewayAuthMode,
  GatewayAuthIdentity,
  GatewayAuthStatus,
  GatewayAuthState,
  TenantPolicyStatus,
  WorkspaceDirEntry,
  QuestionAnswer,
  MessageQuestion,
  // Goal feature
  GoalState,
  GoalStatus,
  GoalAPI,
  ElectronAPI,
  // IPC maps
  IpcInvokeMap,
  IpcEventMap,
  IpcHandler,
  // Namespace APIs
  CopilotAPI,
  OverlayReviewAPI,
  SessionsAPI,
  ModelsAPI,
  SoulAPI,
  SkillsAPI,
  TranscribeAPI,
  SettingsAPI,
  RelayProviderSettingsAPI,
  EncryptionAPI,
  DiagnosticsAPI,
  WhatsAppSettings,
  WhatsAppStatus,
  WhatsAppAccountSummary,
  WhatsAppProvisioningStatus,
  HeartbeatAPI,
  AutomationsAPI,
  UpdateAPI,
  BackgroundAPI,
  WindowControlsAPI,
  ChatWindowsAPI,
  McpsAPI,
  ContextPickerAPI,
  GatewayAuthAPI,
  GatewayNodeAPI,
  IdentityAPI,
  WorkspaceAPI,
  PermissionsAPI,
  DevAPI,
  ActivitiesAPI,
  ShellAPI,
  PreferencesAPI,
  BackendAPI,
  RuntimeAuthAPI,
  RuntimeAccountsAPI,
  RuntimeAccountsView,
  RuntimeAccountView,
  RuntimeUiAPI,
  RuntimeExtensionsAPI,
  TelemetryAPI,
  AIInvestigatorAPI,
  AIInvestigatorState,
  AIInvestigatorStatus,
  AIInvestigatorEvent,
  AIInvestigatorProgressLogEntry,
  AddMcpServerInput,
  InstallCatalogMcpInput,
  SaveMcpConfigInput,
  ConditionStatusRecord,
  ActivitiesAggregatedResult,
  ContextEntityType,
  ContextEntity,
  ContextPersonEntity,
  ContextFileEntity,
  SessionHydrationEvent,
  // Workflows V1
  WorkflowsAPI,
  WorkflowSummary,
  WorkflowRunStatus,
  WorkflowSource,
  WorkflowJSONSchema,
  RunSnapshot,
  RunHistoryEntry,
  StepView,
  StepStatus,
  FanOutUnit,
  ExecutionUnitStatus,
  AgentHandleSummary,
  ArtifactRef,
  RunActions,
  RunCapacitySnapshot,
  RunError,
  WorkflowEvent,
  WorkflowEventType,
  WorkflowRunEventBatch,
  WorkflowRunStatusEvent,
  WorkflowRunTickEvent,
  WorkflowPermissionRequestEvent,
  WorkflowPermissionResponse,
  CommandCenterAPI,
  CommandCenterSessionActivityDetails,
  CommandCenterSessionActivityFileChange,
  CommandCenterSessionActivitySource,
  CommandCenterSnapshot,
  CommandCenterTodoStatus,
  CommandCenterTodoSummary,
} from "@common/marshal-ipc-contract";
export {
  REVIEWER_SESSION_CAPABILITIES,
  REVIEWER_SESSION_PERMISSION_MODE,
} from "@common/marshal-ipc-contract";

import type { PermissionAction } from "@common/marshal-constants";

export type { PermissionAction };

declare global {
  interface Window {
    platform?: string;
    appModeAPI?: {
      getLatest: () => import("@common/marshal-constants").AppMode;
      onModeChanged: (
        callback: (mode: import("@common/marshal-constants").AppMode) => void,
      ) => () => void;
    };
    electronAPI?: ElectronAPI;
    copilotAPI?: CopilotAPI;
    overlayReviewAPI?: OverlayReviewAPI;
    skillsAPI?: SkillsAPI;
    transcribeAPI?: TranscribeAPI;
    goalAPI?: GoalAPI;
    sessionsAPI?: SessionsAPI;
    modelsAPI?: ModelsAPI;
    soulAPI?: SoulAPI;
    heartbeatAPI?: HeartbeatAPI;
    automationsAPI?: AutomationsAPI;
    backgroundAPI?: BackgroundAPI;
    windowControlsAPI?: WindowControlsAPI;
    chatWindowsAPI?: ChatWindowsAPI;
    settingsAPI?: SettingsAPI;
    relayProviderSettingsAPI?: RelayProviderSettingsAPI;
    appAPI?: AppAPI;
    diagnosticsAPI?: DiagnosticsAPI;
    encryptionAPI?: EncryptionAPI;
    updateAPI?: UpdateAPI;
    mcpsAPI?: McpsAPI;
    tenantAPI?: TenantAPI;
    contextPickerAPI?: ContextPickerAPI;
    gatewayAuthAPI?: GatewayAuthAPI;
    gatewayNodeAPI?: GatewayNodeAPI;
    identityAPI?: IdentityAPI;
    workspaceAPI?: WorkspaceAPI;
    permissionsAPI?: PermissionsAPI;
    devAPI?: DevAPI;
    activitiesAPI?: ActivitiesAPI;
    shellAPI?: ShellAPI;
    preferencesAPI?: PreferencesAPI;
    fileExportAPI?: FileExportAPI;
    backendAPI?: BackendAPI;
    runtimeAuthAPI?: RuntimeAuthAPI;
    runtimeAccountsAPI?: RuntimeAccountsAPI;
    runtimeUiAPI?: RuntimeUiAPI;
    runtimeExtensionsAPI?: RuntimeExtensionsAPI;
    telemetryAPI?: TelemetryAPI;
    aiInvestigatorAPI?: AIInvestigatorAPI;
    workflowsAPI?: WorkflowsAPI;
    commandCenterAPI?: CommandCenterAPI;
    process?: NodeJS.Process & { versions: NodeJS.ProcessVersions & { electron?: string } };
  }
}

// Import types used in declare global (needed for module-mode .d.ts)
import type {
  ElectronAPI,
  CopilotAPI,
  OverlayReviewAPI,
  SkillsAPI,
  TranscribeAPI,
  GoalAPI,
  SessionsAPI,
  ModelsAPI,
  SoulAPI,
  HeartbeatAPI,
  AutomationsAPI,
  BackgroundAPI,
  WindowControlsAPI,
  ChatWindowsAPI,
  SettingsAPI,
  RelayProviderSettingsAPI,
  DiagnosticsAPI,
  EncryptionAPI,
  UpdateAPI,
  McpsAPI,
  TenantAPI,
  ContextPickerAPI,
  GatewayAuthAPI,
  GatewayNodeAPI,
  IdentityAPI,
  WorkspaceAPI,
  PermissionsAPI,
  DevAPI,
  ActivitiesAPI,
  ShellAPI,
  PreferencesAPI,
  FileExportAPI,
  BackendAPI,
  RuntimeAuthAPI,
  RuntimeAccountsAPI,
  RuntimeUiAPI,
  RuntimeExtensionsAPI,
  TelemetryAPI,
  AIInvestigatorAPI,
  AppAPI,
  WorkflowsAPI,
  CommandCenterAPI,
} from "@common/marshal-ipc-contract";
