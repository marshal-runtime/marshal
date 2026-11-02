import type { BrowserWindow } from "electron";

import type {
  IpcHandler,
  IpcInvokeMap,
  RuntimeStartupSelection,
  RuntimeSwitchResult,
} from "../../common/marshal-ipc-contract";
import type { AuditLogger } from "../audit-log";
import type { AutomationManager } from "../automations";
import type { IMemoryStore } from "../backend/ports";
import type { BackgroundServiceManager } from "../background-service-manager";
import type { HeartbeatManager } from "../heartbeat";
import type { McpStore } from "../mcp-store";
import type { PowerManager } from "../power";
import type { SessionManager } from "../sessions";
import type { SettingsManager } from "../settings-manager";
import type { ShowHideShortcutController } from "../show-hide-shortcut";
import type { IdentityController } from "./identity-ipc";

export type {
  CustomMcpServer,
  MSettings,
  PermissionsConfig,
  RuntimeStartupSelection,
} from "../../common/marshal-ipc-contract";

export interface IpcDeps {
  getWindow: () => BrowserWindow | null;
  sessionManager: SessionManager;
  memoryManager: IMemoryStore;
  heartbeatManager: HeartbeatManager;
  automationManager: AutomationManager;
  powerManager: PowerManager;
  backgroundService: BackgroundServiceManager;
  showHideShortcutController: ShowHideShortcutController;
  settingsManager: SettingsManager;
  getRuntimeSelection: () => RuntimeStartupSelection;
  switchRuntime: (runtimeId: string) => Promise<RuntimeSwitchResult>;
  mcpStore: McpStore;
  identityController: IdentityController;
  auditLogger: AuditLogger;
  resolveThemeBg: (theme?: string) => string;
  ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => void;
}
