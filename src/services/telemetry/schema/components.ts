import { telemetryComponents } from "./contract";

/**
 * Component path providers. Nesting them builds the `path` and `moduleName`
 * fields on every emitted UserAction; `measures.ts` records the nesting each
 * measure expects.
 */
const components = telemetryComponents(
  "Activities",
  "Activity",
  "App",
  "Automation",
  "AutomationRun",
  "Automations",
  "Briefing",
  "Chat",
  "CoCreate",
  "Details",
  "Editor",
  "EntityCard",
  "ExtensionMcpServer",
  "ExtensionSkill",
  "Extensions",
  "Feedback",
  "FeedbackDialog",
  "File",
  "FileTree",
  "Header",
  "Heartbeat",
  "History",
  "Input",
  "Integrations",
  "List",
  "MarkAsDone",
  "McpTab",
  "Message",
  "Messages",
  "Model",
  "Nav",
  "NavSessionItem",
  "OnboardingOptIn",
  "PermissionCard",
  "Permissions",
  "Prompt",
  "Relay",
  "Session",
  "Settings",
  "SkillsTab",
  "Sources",
  "Update",
  "WelcomeState",
  "Workspace",
);

export type ComponentName = keyof typeof components;

export const TelemetryPath_Activities = components.Activities;
export const TelemetryPath_Activity = components.Activity;
export const TelemetryPath_App = components.App;
export const TelemetryPath_Automation = components.Automation;
export const TelemetryPath_AutomationRun = components.AutomationRun;
export const TelemetryPath_Automations = components.Automations;
export const TelemetryPath_Briefing = components.Briefing;
export const TelemetryPath_Chat = components.Chat;
export const TelemetryPath_CoCreate = components.CoCreate;
export const TelemetryPath_Details = components.Details;
export const TelemetryPath_Editor = components.Editor;
export const TelemetryPath_EntityCard = components.EntityCard;
export const TelemetryPath_ExtensionMcpServer = components.ExtensionMcpServer;
export const TelemetryPath_ExtensionSkill = components.ExtensionSkill;
export const TelemetryPath_Extensions = components.Extensions;
export const TelemetryPath_Feedback = components.Feedback;
export const TelemetryPath_FeedbackDialog = components.FeedbackDialog;
export const TelemetryPath_File = components.File;
export const TelemetryPath_FileTree = components.FileTree;
export const TelemetryPath_Header = components.Header;
export const TelemetryPath_Heartbeat = components.Heartbeat;
export const TelemetryPath_History = components.History;
export const TelemetryPath_Input = components.Input;
export const TelemetryPath_Integrations = components.Integrations;
export const TelemetryPath_List = components.List;
export const TelemetryPath_MarkAsDone = components.MarkAsDone;
export const TelemetryPath_McpTab = components.McpTab;
export const TelemetryPath_Message = components.Message;
export const TelemetryPath_Messages = components.Messages;
export const TelemetryPath_Model = components.Model;
export const TelemetryPath_Nav = components.Nav;
export const TelemetryPath_NavSessionItem = components.NavSessionItem;
export const TelemetryPath_OnboardingOptIn = components.OnboardingOptIn;
export const TelemetryPath_PermissionCard = components.PermissionCard;
export const TelemetryPath_Permissions = components.Permissions;
export const TelemetryPath_Prompt = components.Prompt;
export const TelemetryPath_Relay = components.Relay;
export const TelemetryPath_Session = components.Session;
export const TelemetryPath_Settings = components.Settings;
export const TelemetryPath_SkillsTab = components.SkillsTab;
export const TelemetryPath_Sources = components.Sources;
export const TelemetryPath_Update = components.Update;
export const TelemetryPath_WelcomeState = components.WelcomeState;
export const TelemetryPath_Workspace = components.Workspace;
