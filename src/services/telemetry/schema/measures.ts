import {
  CONTENT_READY,
  defineBooleanProperties,
  defineInteractiveElements,
  defineNonInteractiveElements,
  defineStringProperties,
  interactiveMonitor,
  interactiveMonitorHook,
  NO_CHECKPOINT,
  nonInteractiveMonitor,
  PRIMARY_AND_CONTENT_READY,
  simplePropertyMonitor,
} from "./contract";

/**
 * Measure tables. Each row is `[aggregation, checkpoints, expectedPaths]`.
 * `expectedPaths` is the contract for where a measure may be emitted from;
 * `schema.test.tsx` proves every one of them is buildable from `components.ts`.
 */

export const interactiveElements = defineInteractiveElements({
  Accept: ["Multi", NO_CHECKPOINT, ["/App/Chat/Messages/PermissionCard"]],
  AddMcpServer: ["Single", NO_CHECKPOINT, ["/App/Extensions/McpTab"]],
  AddSkill: ["Single", NO_CHECKPOINT, ["/App/Extensions/SkillsTab"]],
  AddToChat: ["Multi", CONTENT_READY, ["/App/CoCreate/FileTree/File"]],
  AllowForSession: ["Multi", NO_CHECKPOINT, []],
  AllowModelPermissionsChange: ["Single", CONTENT_READY, ["/App/Settings/Permissions"]],
  AlwaysAllow: ["Multi", NO_CHECKPOINT, ["/App/Chat/Messages/PermissionCard"]],
  AttachFile: ["Single", CONTENT_READY, ["/App/Chat/Input"]],
  AutoApprove: ["Single", CONTENT_READY, ["/App/Settings/Permissions"]],
  CheckForUpdates: ["Single", CONTENT_READY, ["/App/Update"]],
  Citation: ["Multi", CONTENT_READY, ["/App/Briefing"]],
  Close: ["Multi", CONTENT_READY, ["/App/Briefing/Details"]],
  Confirm: ["Multi", CONTENT_READY, ["/App/Briefing/MarkAsDone"]],
  Connect: ["Single", CONTENT_READY, ["/App/Integrations/Relay"]],
  Copy: ["Multi", NO_CHECKPOINT, ["/App/Chat/Messages/Message", "/App/Briefing/EntityCard"]],
  Create: ["Single", CONTENT_READY, ["/App/CoCreate/Workspace"]],
  CreateFolder: ["Single", CONTENT_READY, ["/App/CoCreate/FileTree"]],
  Delete: ["Multi", CONTENT_READY, ["/App/Automations/List/Automation", "/App/CoCreate/Workspace"]],
  DeleteItem: ["Multi", CONTENT_READY, ["/App/CoCreate/FileTree/File"]],
  DeleteSession: ["Multi", CONTENT_READY, ["/App/Nav/NavSessionItem"]],
  Deny: ["Multi", NO_CHECKPOINT, ["/App/Chat/Messages/PermissionCard"]],
  Disconnect: ["Single", CONTENT_READY, ["/App/Integrations/Relay"]],
  Dismiss: ["Multi", CONTENT_READY, ["/App/Briefing"]],
  Download: ["Single", CONTENT_READY, ["/App/Update"]],
  DownloadManifest: ["Single", CONTENT_READY, ["/App/Integrations/Relay"]],
  DragToPopout: ["Multi", CONTENT_READY, ["/App/Nav/NavSessionItem"]],
  DuplicateItem: ["Multi", CONTENT_READY, ["/App/CoCreate/FileTree/File"]],
  Edit: ["Multi", CONTENT_READY, ["/App/Automations/List/Automation"]],
  EditPermissions: ["Multi", NO_CHECKPOINT, ["/App/Settings/Permissions"]],
  EditSkill: ["Multi", NO_CHECKPOINT, ["/App/Extensions/SkillsTab/ExtensionSkill"]],
  Enable: ["Single", CONTENT_READY, ["/App/Heartbeat"]],
  Execute: ["Single", CONTENT_READY, ["/App/Briefing", "/App/Briefing/OnboardingOptIn"]],
  ExportSkill: ["Multi", NO_CHECKPOINT, ["/App/Extensions/SkillsTab/ExtensionSkill"]],
  Import: ["Single", CONTENT_READY, ["/App/Automations/List"]],
  ImportSkill: ["Single", NO_CHECKPOINT, ["/App/Extensions/SkillsTab"]],
  InstallMcpServer: ["Multi", NO_CHECKPOINT, ["/App/Extensions/McpTab/ExtensionMcpServer"]],
  InstallSkill: ["Multi", NO_CHECKPOINT, ["/App/Extensions/SkillsTab/ExtensionSkill"]],
  NavItem: ["Multi", PRIMARY_AND_CONTENT_READY, ["/App/Nav"]],
  New: ["Single", CONTENT_READY, ["/App/Automations/List"]],
  NewChat: ["Single", PRIMARY_AND_CONTENT_READY, ["/App/Nav"]],
  Open: ["Multi", CONTENT_READY, ["/App/Briefing/EntityCard"]],
  OpenChannel: ["Single", NO_CHECKPOINT, ["/App/Nav"]],
  RefreshMcpTools: ["Multi", NO_CHECKPOINT, ["/App/Settings/Permissions"]],
  RemoveMcpServer: ["Multi", NO_CHECKPOINT, ["/App/Extensions/McpTab/ExtensionMcpServer"]],
  RemoveSkill: ["Multi", NO_CHECKPOINT, ["/App/Extensions/SkillsTab/ExtensionSkill"]],
  Rename: ["Multi", CONTENT_READY, ["/App/CoCreate/Workspace"]],
  RenameItem: ["Multi", CONTENT_READY, ["/App/CoCreate/FileTree/File"]],
  Restart: ["Single", CONTENT_READY, ["/App/Update"]],
  Save: ["Single", CONTENT_READY, ["/App/Heartbeat"]],
  SaveMcpServerConfig: ["Multi", NO_CHECKPOINT, ["/App/Extensions/McpTab/ExtensionMcpServer"]],
  SaveSkillConfig: ["Multi", NO_CHECKPOINT, ["/App/Extensions/SkillsTab/ExtensionSkill"]],
  SelectFile: ["Multi", CONTENT_READY, ["/App/CoCreate/FileTree/File"]],
  Send: ["Single", PRIMARY_AND_CONTENT_READY, ["/App/Chat/Input"]],
  SessionItem: ["Multi", CONTENT_READY, ["/App/Nav/NavSessionItem"]],
  SetupLink: ["Single", NO_CHECKPOINT, ["/App/Briefing"]],
  SignIn: ["Single", PRIMARY_AND_CONTENT_READY, ["/App/Integrations/Sources"]],
  SignOut: ["Single", CONTENT_READY, ["/App/Integrations/Sources", "/App/Nav"]],
  Stop: ["Single", NO_CHECKPOINT, ["/App/Chat/Input"]],
  Submit: ["Multi", CONTENT_READY, ["/App/Briefing/Feedback", "/App/Briefing/Prompt"]],
  Switch: ["Single", CONTENT_READY, ["/App/Settings/Model"]],
  Trigger: ["Single", CONTENT_READY, ["/App/Heartbeat"]],
  UninstallMcpServer: ["Multi", NO_CHECKPOINT, ["/App/Extensions/McpTab/ExtensionMcpServer"]],
  UninstallSkill: ["Multi", NO_CHECKPOINT, ["/App/Extensions/SkillsTab/ExtensionSkill"]],
  UseSkill: ["Multi", NO_CHECKPOINT, ["/App/Extensions/SkillsTab/ExtensionSkill"]],
});

export const nonInteractiveElements = defineNonInteractiveElements({
  AuthStatus: ["Single", CONTENT_READY, ["/App/Integrations/Sources"]],
  Banner: ["Single", CONTENT_READY, ["/App/Update"]],
  HistoryItem: ["Multi", CONTENT_READY, ["/App/Activities/Activity"]],
  UpcomingItem: ["Multi", CONTENT_READY, ["/App/Activities/Activity"]],
});

export const booleanProperties = defineBooleanProperties({
  HasSession: ["Single", NO_CHECKPOINT, ["/App/Session"]],
  IsStreaming: ["Multi", NO_CHECKPOINT, ["/App/Chat/Messages/Message"]],
});

export const stringProperties = defineStringProperties({
  CardCount: ["Single", NO_CHECKPOINT, ["/App/Briefing"]],
  ModelName: ["Single", NO_CHECKPOINT, ["/App/Chat/Header", "/App/Settings/Model"]],
  RunId: ["Single", NO_CHECKPOINT, ["/App/Briefing"]],
  Timestamp: ["Single", NO_CHECKPOINT, ["/App/Briefing"]],
});

export const InteractiveElementMonitor_Accept = interactiveMonitor(interactiveElements.Accept);
export const InteractiveElementMonitor_AddMcpServer = interactiveMonitor(
  interactiveElements.AddMcpServer,
);
export const InteractiveElementMonitor_AddSkill = interactiveMonitor(interactiveElements.AddSkill);
export const InteractiveElementMonitor_AddToChat = interactiveMonitor(
  interactiveElements.AddToChat,
);
export const InteractiveElementMonitor_AllowForSession = interactiveMonitor(
  interactiveElements.AllowForSession,
);
export const InteractiveElementMonitor_AllowModelPermissionsChange = interactiveMonitor(
  interactiveElements.AllowModelPermissionsChange,
);
export const InteractiveElementMonitor_AlwaysAllow = interactiveMonitor(
  interactiveElements.AlwaysAllow,
);
export const InteractiveElementMonitor_AttachFile = interactiveMonitor(
  interactiveElements.AttachFile,
);
export const InteractiveElementMonitor_AutoApprove = interactiveMonitor(
  interactiveElements.AutoApprove,
);
export const InteractiveElementMonitor_CheckForUpdates = interactiveMonitor(
  interactiveElements.CheckForUpdates,
);
export const InteractiveElementMonitor_Citation = interactiveMonitor(interactiveElements.Citation);
export const InteractiveElementMonitor_Close = interactiveMonitor(interactiveElements.Close);
export const InteractiveElementMonitor_Confirm = interactiveMonitor(interactiveElements.Confirm);
export const InteractiveElementMonitor_Connect = interactiveMonitor(interactiveElements.Connect);
export const InteractiveElementMonitor_Copy = interactiveMonitor(interactiveElements.Copy);
export const InteractiveElementMonitor_Create = interactiveMonitor(interactiveElements.Create);
export const InteractiveElementMonitor_CreateFolder = interactiveMonitor(
  interactiveElements.CreateFolder,
);
export const InteractiveElementMonitor_Delete = interactiveMonitor(interactiveElements.Delete);
export const InteractiveElementMonitor_DeleteItem = interactiveMonitor(
  interactiveElements.DeleteItem,
);
export const InteractiveElementMonitor_DeleteSession = interactiveMonitor(
  interactiveElements.DeleteSession,
);
export const InteractiveElementMonitor_Deny = interactiveMonitor(interactiveElements.Deny);
export const InteractiveElementMonitor_Disconnect = interactiveMonitor(
  interactiveElements.Disconnect,
);
export const InteractiveElementMonitor_Dismiss = interactiveMonitor(interactiveElements.Dismiss);
export const InteractiveElementMonitor_Download = interactiveMonitor(interactiveElements.Download);
export const InteractiveElementMonitor_DownloadManifest = interactiveMonitor(
  interactiveElements.DownloadManifest,
);
export const InteractiveElementMonitor_DragToPopout = interactiveMonitor(
  interactiveElements.DragToPopout,
);
export const InteractiveElementMonitor_DuplicateItem = interactiveMonitor(
  interactiveElements.DuplicateItem,
);
export const InteractiveElementMonitor_Edit = interactiveMonitor(interactiveElements.Edit);
export const InteractiveElementMonitor_EditPermissions = interactiveMonitor(
  interactiveElements.EditPermissions,
);
export const InteractiveElementMonitor_EditSkill = interactiveMonitor(
  interactiveElements.EditSkill,
);
export const InteractiveElementMonitor_Enable = interactiveMonitor(interactiveElements.Enable);
export const InteractiveElementMonitor_Execute = interactiveMonitor(interactiveElements.Execute);
export const InteractiveElementMonitor_ExportSkill = interactiveMonitor(
  interactiveElements.ExportSkill,
);
export const InteractiveElementMonitor_Import = interactiveMonitor(interactiveElements.Import);
export const InteractiveElementMonitor_ImportSkill = interactiveMonitor(
  interactiveElements.ImportSkill,
);
export const InteractiveElementMonitor_InstallMcpServer = interactiveMonitor(
  interactiveElements.InstallMcpServer,
);
export const InteractiveElementMonitor_InstallSkill = interactiveMonitor(
  interactiveElements.InstallSkill,
);
export const InteractiveElementMonitor_NavItem = interactiveMonitor(interactiveElements.NavItem);
export const InteractiveElementMonitor_New = interactiveMonitor(interactiveElements.New);
export const InteractiveElementMonitor_NewChat = interactiveMonitor(interactiveElements.NewChat);
export const InteractiveElementMonitor_Open = interactiveMonitor(interactiveElements.Open);
export const InteractiveElementMonitor_OpenChannel = interactiveMonitor(
  interactiveElements.OpenChannel,
);
export const InteractiveElementMonitor_RefreshMcpTools = interactiveMonitor(
  interactiveElements.RefreshMcpTools,
);
export const InteractiveElementMonitor_RemoveMcpServer = interactiveMonitor(
  interactiveElements.RemoveMcpServer,
);
export const InteractiveElementMonitor_RemoveSkill = interactiveMonitor(
  interactiveElements.RemoveSkill,
);
export const InteractiveElementMonitor_Rename = interactiveMonitor(interactiveElements.Rename);
export const InteractiveElementMonitor_RenameItem = interactiveMonitor(
  interactiveElements.RenameItem,
);
export const InteractiveElementMonitor_Restart = interactiveMonitor(interactiveElements.Restart);
export const InteractiveElementMonitor_Save = interactiveMonitor(interactiveElements.Save);
export const InteractiveElementMonitor_SaveMcpServerConfig = interactiveMonitor(
  interactiveElements.SaveMcpServerConfig,
);
export const InteractiveElementMonitor_SaveSkillConfig = interactiveMonitor(
  interactiveElements.SaveSkillConfig,
);
export const InteractiveElementMonitor_SelectFile = interactiveMonitor(
  interactiveElements.SelectFile,
);
export const InteractiveElementMonitor_Send = interactiveMonitor(interactiveElements.Send);
export const InteractiveElementMonitor_SessionItem = interactiveMonitor(
  interactiveElements.SessionItem,
);
export const InteractiveElementMonitor_SetupLink = interactiveMonitor(
  interactiveElements.SetupLink,
);
export const InteractiveElementMonitor_SignIn = interactiveMonitor(interactiveElements.SignIn);
export const InteractiveElementMonitor_SignOut = interactiveMonitor(interactiveElements.SignOut);
export const InteractiveElementMonitor_Stop = interactiveMonitor(interactiveElements.Stop);
export const InteractiveElementMonitor_Submit = interactiveMonitor(interactiveElements.Submit);
export const InteractiveElementMonitor_Switch = interactiveMonitor(interactiveElements.Switch);
export const InteractiveElementMonitor_Trigger = interactiveMonitor(interactiveElements.Trigger);
export const InteractiveElementMonitor_UninstallMcpServer = interactiveMonitor(
  interactiveElements.UninstallMcpServer,
);
export const InteractiveElementMonitor_UninstallSkill = interactiveMonitor(
  interactiveElements.UninstallSkill,
);
export const InteractiveElementMonitor_UseSkill = interactiveMonitor(interactiveElements.UseSkill);

export const useInteractiveElementMonitor_DragToPopout = interactiveMonitorHook(
  interactiveElements.DragToPopout,
);
export const useInteractiveElementMonitor_InstallMcpServer = interactiveMonitorHook(
  interactiveElements.InstallMcpServer,
);
export const useInteractiveElementMonitor_InstallSkill = interactiveMonitorHook(
  interactiveElements.InstallSkill,
);
export const useInteractiveElementMonitor_Send = interactiveMonitorHook(interactiveElements.Send);

export const NonInteractiveElementMonitor_AuthStatus = nonInteractiveMonitor(
  nonInteractiveElements.AuthStatus,
);
export const NonInteractiveElementMonitor_Banner = nonInteractiveMonitor(
  nonInteractiveElements.Banner,
);
export const NonInteractiveElementMonitor_HistoryItem = nonInteractiveMonitor(
  nonInteractiveElements.HistoryItem,
);
export const NonInteractiveElementMonitor_UpcomingItem = nonInteractiveMonitor(
  nonInteractiveElements.UpcomingItem,
);

export const SimplePropertyMonitor_HasSession = simplePropertyMonitor(booleanProperties.HasSession);
export const SimplePropertyMonitor_IsStreaming = simplePropertyMonitor(
  booleanProperties.IsStreaming,
);
export const SimplePropertyMonitor_CardCount = simplePropertyMonitor(stringProperties.CardCount);
export const SimplePropertyMonitor_ModelName = simplePropertyMonitor(stringProperties.ModelName);
export const SimplePropertyMonitor_RunId = simplePropertyMonitor(stringProperties.RunId);
export const SimplePropertyMonitor_Timestamp = simplePropertyMonitor(stringProperties.Timestamp);
