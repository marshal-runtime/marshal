import type {
  AutomationCapabilities,
  HeartbeatControllableMap,
  PermissionsControllableMap,
} from "@common/marshal-ipc-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  render,
  renderHook,
  type RenderOptions,
  type RenderHookOptions,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { vi } from "vitest";

import { TooltipProvider } from "./components/marshal-ui/marshal-tooltip";
import type {
  CopilotAPI,
  OverlayReviewAPI,
  SessionsAPI,
  ModelsAPI,
  SoulAPI,
  SkillsAPI,
  GoalAPI,
  HeartbeatAPI,
  AutomationsAPI,
  ElectronAPI,
  McpsAPI,
  WindowControlsAPI,
  ChatWindowsAPI,
  BackgroundAPI,
  UpdateAPI,
  SettingsAPI,
  RelayProviderSettingsAPI,
  ActivitiesAPI,
  EncryptionAPI,
  ShellAPI,
  PreferencesAPI,
  FileExportAPI,
  BackendAPI,
  RuntimeAuthAPI,
  RuntimeAccountsAPI,
  RuntimeExtensionsAPI,
  GatewayAuthAPI,
  GatewayNodeAPI,
  IdentityAPI,
  TelemetryAPI,
  AIInvestigatorAPI,
  PermissionsAPI,
  ContextPickerAPI,
  WorkspaceAPI,
  WorkflowsAPI,
} from "./types/electron";

/**
 * Typed copilot-flavored controllable map for renderer tests. Exported here
 * so the four duplicate object literals across `HeartbeatPanel.test.tsx`,
 * `HeartbeatPanel.telemetry.test.tsx`, and the inline mock below all stay in
 * sync — when `HeartbeatControllableMap` gains a field, only this constant
 * fails the build, not loose object literals scattered across test files.
 *
 * Production callers should NOT import this — `HeartbeatPanel.tsx` ships its
 * own typed default for the loading state (different concern, different
 * lifetime).
 */
export const ALL_CONTROLLABLE_MOCK: HeartbeatControllableMap = {
  enabled: true,
  intervalMinutes: true,
  schedule: true,
  prompt: true,
  permissions: true,
  workDays: true,
  workStartHour: true,
  workEndHour: true,
};

/**
 * Typed copilot-flavored automation-capabilities map for renderer tests.
 * Same drift-prevention idiom as `ALL_CONTROLLABLE_MOCK`: when
 * `AutomationCapabilities` gains a field, only this constant fails the
 * build, not loose object literals scattered across test files.
 */
export const ALL_AUTOMATION_CAPABILITIES_MOCK: AutomationCapabilities = {
  multiStep: true,
  workingDir: true,
  skills: true,
  perAutomationPermissions: true,
  conditionTrigger: true,
  heartbeat: true,
  heartbeatRunNow: true,
  bundleImport: true,
  exportImport: true,
  githubImport: true,
};

/**
 * Typed copilot-flavored permissions controllable map for renderer tests.
 * Same drift-prevention idiom as `ALL_CONTROLLABLE_MOCK`: when
 * `PermissionsControllableMap` gains a field, only this constant fails the
 * build, not loose object literals scattered across test files.
 */
export const ALL_PERMISSIONS_CONTROLLABLE_MOCK: PermissionsControllableMap = {
  tools: { enabled: true },
  autopilotMode: { enabled: true },
  autoApproveReadOnly: { enabled: true },
  shellAllow: { enabled: true },
  shellDeny: { enabled: true },
  serverEnabled: { enabled: true },
  serverAutoApprove: { enabled: true },
  perHeartbeatScope: { enabled: true },
};

// --- Mock factories ---

export function createMockCopilotAPI(): CopilotAPI {
  return {
    init: vi.fn().mockResolvedValue({ success: true, sessionId: "test-session-1" }),
    send: vi.fn().mockResolvedValue({ success: true }),
    steer: vi.fn().mockResolvedValue({ success: true }),
    abort: vi.fn().mockResolvedValue({ success: true }),
    destroy: vi.fn().mockResolvedValue({ success: true }),
    saveImage: vi.fn().mockResolvedValue({ success: true, path: "/tmp/test.png" }),
    checkAuth: vi.fn().mockResolvedValue({ success: true, isAuthenticated: true }),
    getVersion: vi.fn().mockResolvedValue({ success: true, version: "0.0.0" }),
    getSystemInfo: vi.fn().mockResolvedValue({
      success: true,
      version: "0.0.0",
      platform: "win32",
      arch: "x64",
      osVersion: "10.0.26200",
    }),
    login: vi.fn().mockResolvedValue({ success: true }),
    startDeviceFlow: vi.fn().mockResolvedValue({ success: true }),
    openDeviceFlowPage: vi.fn().mockResolvedValue({ success: true }),
    signOut: vi.fn().mockResolvedValue({ success: true }),
    resolvePermission: vi.fn().mockResolvedValue({ success: true }),
    onAuthError: vi.fn().mockReturnValue(() => {}),
    onLoginFailed: vi.fn().mockReturnValue(() => {}),
  };
}

export function createMockOverlayReviewAPI(): OverlayReviewAPI {
  return {
    launch: vi.fn().mockResolvedValue({ success: true }),
    claim: vi.fn().mockResolvedValue({ reviews: [] }),
    onPending: vi.fn().mockReturnValue(() => {}),
    onError: vi.fn().mockReturnValue(() => {}),
  };
}

export function createMockSessionsAPI(overrides: Partial<SessionsAPI> = {}): SessionsAPI {
  const api: SessionsAPI = {
    list: vi.fn().mockResolvedValue({ success: true, sessions: [], results: undefined }),
    listWithOptions: vi.fn().mockImplementation((options) => api.list(options?.query)),
    create: vi.fn().mockResolvedValue({
      success: true,
      session: {
        id: "new-session",
        name: "New Chat",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        hasUnread: false,
        isActive: true,
      },
    }),
    createMain: vi.fn().mockResolvedValue({
      success: true,
      session: {
        id: "new-main-session",
        name: "New Chat",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        hasUnread: false,
        isActive: true,
      },
    }),
    switch: vi.fn().mockResolvedValue({
      success: true,
      session: {
        id: "test",
        name: "Test",
        messages: [],
        createdAt: "",
        updatedAt: "",
        hasUnread: false,
        isActive: true,
      },
    }),
    delete: vi.fn().mockResolvedValue({ success: true, newActiveId: null }),
    deleteAll: vi.fn().mockResolvedValue({ success: true }),
    rename: vi.fn().mockResolvedValue({ success: true }),
    markRead: vi.fn().mockResolvedValue({ success: true }),
    setPinned: vi.fn().mockResolvedValue({ success: true }),
    get: vi.fn().mockResolvedValue({ success: true, session: null }),
    getMessages: vi.fn().mockResolvedValue({ success: true, messages: [], hasMore: false }),
    getToolCallDetails: vi.fn().mockResolvedValue({ success: false, error: "Tool call not found" }),
    getView: vi.fn().mockResolvedValue({ success: true, view: undefined }),
    subscribeView: vi.fn().mockResolvedValue({ success: true, snapshot: undefined }),
    unsubscribeView: vi.fn().mockResolvedValue({ success: true }),
    ackView: vi.fn().mockResolvedValue({ success: true, accepted: true }),
    resyncView: vi.fn().mockResolvedValue({ success: true, snapshot: undefined }),
    setModel: vi.fn().mockResolvedValue({ success: true }),
    patchQuestionSelection: vi.fn().mockResolvedValue({ success: true }),
    messageSubagent: vi.fn().mockResolvedValue({ success: true, status: "sent" }),
    sendReviewComments: vi.fn().mockResolvedValue({ success: true, status: "sent" }),
    createOrReuseEmpty: vi.fn().mockResolvedValue({
      success: true,
      session: {
        id: "new-session",
        name: "New Chat",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        hasUnread: false,
        isActive: true,
      },
      reused: false,
    }),
    compact: vi.fn().mockResolvedValue({ success: true }),
    onSwitchTo: vi.fn().mockReturnValue(() => {}),
    onViewEvent: vi.fn().mockReturnValue(() => {}),
    onStatusDelta: vi.fn().mockReturnValue(() => {}),
    onMetadataChanged: vi.fn().mockReturnValue(() => {}),
    onListChanged: vi.fn().mockReturnValue(() => {}),
    onHydrationChanged: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
  return api;
}

export function createMockModelsAPI(overrides: Partial<ModelsAPI> = {}): ModelsAPI {
  return {
    list: vi.fn().mockResolvedValue({
      success: true,
      models: [
        { id: "gpt-4o", name: "GPT-4o" },
        { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
      ],
    }),
    getDefault: vi.fn().mockResolvedValue({ success: true, model: "gpt-4o" }),
    setDefault: vi.fn().mockResolvedValue({ success: true }),
    getDefaultReasoningEffort: vi.fn().mockResolvedValue({ success: true }),
    setDefaultReasoningEffort: vi.fn().mockResolvedValue({ success: true }),
    getDefaultContextTier: vi.fn().mockResolvedValue({ success: true }),
    setDefaultContextTier: vi.fn().mockResolvedValue({ success: true }),
    getSessionModel: vi.fn().mockResolvedValue({ success: true, model: "gpt-4o" }),
    getSessionReasoningEffort: vi.fn().mockResolvedValue({ success: true }),
    setSessionReasoningEffort: vi.fn().mockResolvedValue({ success: true }),
    getSessionContextTier: vi.fn().mockResolvedValue({ success: true }),
    setSessionContextTier: vi.fn().mockResolvedValue({ success: true }),
    getTierDefaults: vi.fn().mockResolvedValue({ success: true, defaults: {} }),
    setTierDefaultModel: vi.fn().mockResolvedValue({ success: true }),
    setTierDefaultReasoningEffort: vi.fn().mockResolvedValue({ success: true }),
    setTierDefaultContextTier: vi.fn().mockResolvedValue({ success: true }),
    onChanged: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

export function createMockSoulAPI(overrides: Partial<SoulAPI> = {}): SoulAPI {
  return {
    list: vi.fn().mockResolvedValue({
      success: true,
      souls: [
        {
          id: "default",
          name: "Default",
          description: "Standard assistant",
          systemPrompt: "",
          greeting: "",
        },
        {
          id: "operator",
          name: "Operator",
          description: "Terse, execution-first",
          systemPrompt: "",
          greeting: "Hey there.",
        },
      ],
    }),
    getDefault: vi.fn().mockResolvedValue({ success: true, soul: "default" }),
    setDefault: vi.fn().mockResolvedValue({ success: true }),
    getGreeting: vi.fn().mockResolvedValue({ success: true, greeting: null }),
    getSessionSoul: vi.fn().mockResolvedValue({ success: true, soul: "default" }),
    ...overrides,
  };
}

export function createMockSkillsAPI(overrides: Partial<SkillsAPI> = {}): SkillsAPI {
  return {
    list: vi.fn().mockResolvedValue({ success: true, skills: [] }),
    add: vi.fn().mockResolvedValue({
      success: true,
      skill: {
        id: "new-skill",
        name: "Test",
        description: "A test skill",
        instructions: "Test skill instructions",
        enabled: true,
        createdAt: new Date().toISOString(),
        scope: "local",
      },
    }),
    update: vi.fn().mockResolvedValue({ success: true }),
    delete: vi.fn().mockResolvedValue({ success: true }),
    export: vi.fn().mockResolvedValue({ success: true }),
    importFile: vi.fn().mockResolvedValue({
      success: true,
      skill: {
        id: "imported",
        name: "imported",
        description: "imported skill",
        enabled: true,
      },
    }),
    importPath: vi.fn().mockResolvedValue({
      success: true,
      skill: {
        id: "imported-path",
        name: "imported-path",
        description: "imported from path",
        enabled: true,
      },
    }),
    importContents: vi.fn().mockResolvedValue({
      success: true,
      succeeded: [{ name: "imported-content" }],
      errors: [],
    }),
    importUrl: vi.fn().mockResolvedValue({
      success: true,
      skill: {
        id: "imported-url",
        name: "imported-url",
        description: "imported from url",
        enabled: true,
      },
    }),
    importBundle: vi.fn().mockResolvedValue({
      success: true,
      skill: {
        id: "imported-bundle",
        name: "imported-bundle",
        description: "imported from bundle",
        enabled: true,
        bundleDirs: ["scripts", "references"],
      },
      bundleDirs: ["scripts", "references"],
    }),
    openFile: vi.fn().mockResolvedValue({ success: true }),
    onChanged: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

export function createMockHeartbeatAPI(overrides: Partial<HeartbeatAPI> = {}): HeartbeatAPI {
  return {
    status: vi.fn().mockResolvedValue({
      success: true,
      status: { supported: true, enabled: false, lastRun: null, nextRun: null, running: false },
    }),
    toggle: vi.fn().mockResolvedValue({ success: true }),
    getSettings: vi.fn().mockResolvedValue({
      success: true,
      settings: {
        supported: true,
        enabled: false,
        intervalMinutes: 30,
        schedule: "work-hours",
        prompt: "",
        // Default to copilot-flavored all-true so renderer tests see the full
        // editable surface unless a test explicitly overrides this.
        controllable: ALL_CONTROLLABLE_MOCK,
      },
    }),
    saveSettings: vi.fn().mockResolvedValue({ success: true }),
    getLogs: vi.fn().mockResolvedValue({ success: true, logs: [] }),
    runNow: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

export function createRelayProviderListResult(available: boolean) {
  return {
    success: true,
    providers: [
      {
        providerKey: "whatsapp",
        runtimeProviderId: "whatsapp-baileys",
        available,
        connection: { state: available ? "disconnected" : "unavailable" },
        capabilities: {
          inbound: available,
          quotedReplies: false,
          attachments: false,
          voice: false,
          managedGroups: false,
          communities: false,
          renameConversation: false,
          retireConversation: false,
          remotePermissionApproval: false,
        },
      },
    ],
  };
}

export function createAvailableRelayProviderSettingsAPI(): RelayProviderSettingsAPI {
  return createMockRelayProviderSettingsAPI({
    list: vi.fn().mockResolvedValue(createRelayProviderListResult(true)),
  });
}

export function createMockRelayProviderSettingsAPI(
  overrides: Partial<RelayProviderSettingsAPI> = {},
): RelayProviderSettingsAPI {
  return {
    list: vi.fn().mockResolvedValue(createRelayProviderListResult(false)),
    connect: vi.fn().mockResolvedValue({ success: false, error: "Runtime integration pending" }),
    disconnect: vi.fn().mockResolvedValue({ success: false, error: "Runtime integration pending" }),
    reset: vi.fn().mockResolvedValue({ success: false, error: "Runtime integration pending" }),
    relink: vi.fn().mockResolvedValue({ success: false, error: "Runtime integration pending" }),
    provision: vi.fn().mockResolvedValue({ success: false, error: "Runtime integration pending" }),
    onChanged: vi.fn().mockReturnValue(() => undefined),
    onSetupChanged: vi.fn().mockReturnValue(() => undefined),
    ...overrides,
  };
}

export function createMockBackgroundAPI(overrides: Partial<BackgroundAPI> = {}): BackgroundAPI {
  return {
    getSettings: vi.fn().mockResolvedValue({
      success: true,
      settings: { enabled: false, runOnStartup: false, hideOnLaunch: false },
    }),
    saveSettings: vi.fn().mockResolvedValue({
      success: true,
      settings: { enabled: false, runOnStartup: false, hideOnLaunch: false },
    }),
    ...overrides,
  };
}

export function createMockWindowControlsAPI(
  overrides: Partial<WindowControlsAPI> = {},
): WindowControlsAPI {
  return {
    getState: vi.fn().mockResolvedValue({
      success: true,
      isMaximized: false,
      isFullScreen: false,
    }),
    minimize: vi.fn().mockResolvedValue({ success: true }),
    toggleMaximize: vi.fn().mockResolvedValue({ success: true, isMaximized: true }),
    close: vi.fn().mockResolvedValue({ success: true }),
    onMaximizeChanged: vi.fn().mockReturnValue(() => {}),
    onFullScreenChanged: vi.fn().mockReturnValue(() => {}),
    setWidth: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

export function createMockChatWindowsAPI(overrides: Partial<ChatWindowsAPI> = {}): ChatWindowsAPI {
  return {
    open: vi.fn().mockResolvedValue({ success: true, alreadyOpen: false }),
    ...overrides,
  };
}

export function createMockAutomationsAPI(overrides: Partial<AutomationsAPI> = {}): AutomationsAPI {
  return {
    list: vi.fn().mockResolvedValue({ success: true, automations: [] }),
    create: vi.fn().mockResolvedValue({
      success: true,
      automation: {
        id: "wf-1",
        name: "Test",
        steps: [],
        schedule: { naturalLanguage: "", days: [], hour: 0, minute: 0 },
        enabled: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    }),
    update: vi.fn().mockResolvedValue({ success: true }),
    delete: vi.fn().mockResolvedValue({ success: true }),
    toggle: vi.fn().mockResolvedValue({ success: true }),
    runNow: vi.fn().mockResolvedValue({ success: true, run: null }),
    getHistory: vi.fn().mockResolvedValue({ success: true, runs: [] }),
    getAllHistory: vi.fn().mockResolvedValue({ success: true, runs: [] }),
    getCurrentRun: vi.fn().mockResolvedValue({ success: true, run: null }),
    getConditionStatus: vi
      .fn()
      .mockResolvedValue({ success: true, lastCheck: null, nextCheck: null }),
    exportAutomation: vi.fn().mockResolvedValue({ success: true, json: "{}" }),
    importAutomation: vi.fn().mockResolvedValue({ success: true, automations: [] }),
    importBundle: vi
      .fn()
      .mockResolvedValue({ success: true, skillsInstalled: [], automations: [] }),
    importFromGithub: vi
      .fn()
      .mockResolvedValue({ success: true, skillsInstalled: [], automations: [] }),
    onChanged: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

export function createMockUpdateAPI(overrides: Partial<UpdateAPI> = {}): UpdateAPI {
  return {
    auth: vi.fn().mockResolvedValue({ success: true, authenticated: true }),
    clearToken: vi.fn().mockResolvedValue({ success: true }),
    check: vi.fn().mockResolvedValue({
      success: true,
      upToDate: true,
      currentVersion: "0.0.0",
      channel: "stable",
    }),
    download: vi.fn().mockResolvedValue({ success: true, filePath: "/tmp/test.dmg" }),
    install: vi.fn().mockResolvedValue({ success: true }),
    restart: vi.fn().mockResolvedValue({ success: true }),
    onProgress: vi.fn().mockReturnValue(() => {}),
    onDeviceFlow: vi.fn().mockReturnValue(() => {}),
    onTriggerCheck: vi.fn().mockReturnValue(() => {}),
    checkMinimum: vi.fn().mockResolvedValue({ success: true, blocked: false }),
    ...overrides,
  };
}

export function createMockElectronAPI(): ElectronAPI {
  return {
    spawnPty: vi.fn().mockResolvedValue({ pid: 12345 }),
    writePty: vi.fn(),
    resizePty: vi.fn(),
    killPty: vi.fn(),
    onPtyData: vi.fn(),
    onPtyExit: vi.fn(),
    removePtyListeners: vi.fn(),
  };
}

export function createMockActivitiesAPI(overrides: Partial<ActivitiesAPI> = {}): ActivitiesAPI {
  return {
    getAll: vi.fn().mockResolvedValue({
      success: true,
      heartbeatStatus: null,
      heartbeatSettings: null,
      heartbeatLogs: [],
      automations: [],
      allAutomationRuns: [],
      conditionStatuses: {},
    }),
    ...overrides,
  };
}

export function createMockEncryptionAPI(overrides: Partial<EncryptionAPI> = {}): EncryptionAPI {
  return {
    wasKeyReset: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

export function createMockShellAPI(overrides: Partial<ShellAPI> = {}): ShellAPI {
  return {
    openExternal: vi.fn().mockResolvedValue({ success: true }),
    quitApp: vi.fn().mockResolvedValue({ success: true }),
    onFileOpenError: vi.fn<(cb: (error: string) => void) => () => void>().mockReturnValue(() => {}),
    ...overrides,
  };
}

export function createMockPreferencesAPI(overrides: Partial<PreferencesAPI> = {}): PreferencesAPI {
  return {
    get: vi.fn().mockResolvedValue({ success: true, value: null }),
    set: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

export function createMockFileExportAPI(overrides: Partial<FileExportAPI> = {}): FileExportAPI {
  return {
    saveJson: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

export function createMockBackendAPI(overrides: Partial<BackendAPI> = {}): BackendAPI {
  return {
    capabilities: vi.fn().mockResolvedValue({
      taskList: false,
      cronExpressions: false,
      retryPolicy: false,
      policyEditor: false,
      heartbeatIsolated: false,
      modelFallback: false,
      connectionStatus: false,
      sessionCompaction: true,
      // Default to copilot-flavored all-true so renderer tests see the full
      // feature set unless a test explicitly overrides this.
      automations: {
        multiStep: true,
        workingDir: true,
        skills: true,
        perAutomationPermissions: true,
        conditionTrigger: true,
        heartbeat: true,
        heartbeatRunNow: true,
        bundleImport: true,
        exportImport: true,
        githubImport: true,
      },
      desktopCapabilities: {
        localTools: false,
        notifications: false,
      },
    }),
    ...overrides,
  };
}

export function createMockRuntimeAuthAPI(overrides: Partial<RuntimeAuthAPI> = {}): RuntimeAuthAPI {
  return {
    getStatus: vi.fn().mockResolvedValue({
      success: true,
      status: { isAuthenticated: true },
    }),
    login: vi.fn().mockResolvedValue({
      success: true,
      state: { status: "authenticated" },
    }),
    signOut: vi.fn().mockResolvedValue({ success: true }),
    onAuthError: vi.fn().mockReturnValue(() => {}),
    onLoginFailed: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

export function createMockRuntimeAccountsAPI(
  overrides: Partial<RuntimeAccountsAPI> = {},
): RuntimeAccountsAPI {
  return {
    list: vi.fn().mockResolvedValue({ success: true, runtimes: [] }),
    add: vi.fn().mockResolvedValue({ success: true }),
    rename: vi.fn().mockResolvedValue({ success: true }),
    remove: vi.fn().mockResolvedValue({ success: true }),
    setDefault: vi.fn().mockResolvedValue({ success: true }),
    getStatus: vi.fn().mockResolvedValue({ success: true, status: { isAuthenticated: false } }),
    getUsage: vi.fn().mockResolvedValue({
      success: true,
      usage: { available: false, reason: "not_applicable", fetchedAt: 0 },
    }),
    login: vi.fn().mockResolvedValue({ success: true, state: { status: "authenticated" } }),
    signOut: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

export function createMockGatewayAuthAPI(overrides: Partial<GatewayAuthAPI> = {}): GatewayAuthAPI {
  return {
    getState: vi.fn().mockResolvedValue({ success: true, state: { status: "picking" } }),
    signIn: vi.fn().mockResolvedValue({ success: true }),
    signOut: vi.fn().mockResolvedValue({ success: true }),
    cancelPairing: vi.fn().mockResolvedValue({ success: true }),
    // Default to "non-local" so the device-approval panel stays hidden in
    // every test that doesn't explicitly opt in. Renderer tests targeting the
    // panel re-mock with `success: true` + a populated `pending` array.
    listPendingDevices: vi
      .fn()
      .mockResolvedValue({ success: false, error: "not-supported-non-local" }),
    approveDevice: vi.fn().mockResolvedValue({ success: false, error: "not-supported-non-local" }),
    onStateChange: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

export function createMockGatewayNodeAPI(overrides: Partial<GatewayNodeAPI> = {}): GatewayNodeAPI {
  return {
    getActivity: vi.fn().mockResolvedValue({ success: true, entries: [] }),
    onActivity: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

export function createMockIdentityAPI(overrides: Partial<IdentityAPI> = {}): IdentityAPI {
  return {
    get: vi.fn().mockResolvedValue({
      success: true,
      identity: {
        isAuthenticated: false,
        displayName: "Test User",
        subtitle: null,
        accountName: null,
        avatarUrl: null,
        statusColor: "muted",
        statusText: "",
        integrations: [],
        signOut: {
          title: "Sign out?",
          description: "",
          confirmLabel: "Sign out",
        },
      },
    }),
    onChange: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

export function createMockTelemetryAPI(overrides: Partial<TelemetryAPI> = {}): TelemetryAPI {
  return {
    writeLocalEvent: vi.fn<TelemetryAPI["writeLocalEvent"]>().mockResolvedValue({ success: true }),
    deleteLocalData: vi.fn<TelemetryAPI["deleteLocalData"]>().mockResolvedValue({
      success: true,
      deletedFiles: 0,
      deletedBytes: 0,
      remainingFiles: 0,
      remainingBytes: 0,
      failedFiles: 0,
    }),
    onLogError: vi.fn<TelemetryAPI["onLogError"]>().mockReturnValue(() => {}),
    onLogEvent: vi.fn<TelemetryAPI["onLogEvent"]>().mockReturnValue(() => {}),
    onFinalize: vi.fn<TelemetryAPI["onFinalize"]>().mockReturnValue(() => {}),
    rendererFinalized: vi
      .fn<TelemetryAPI["rendererFinalized"]>()
      .mockResolvedValue({ success: true }),
    ...overrides,
  };
}

export function createMockAIInvestigatorAPI(
  overrides: Partial<AIInvestigatorAPI> = {},
): AIInvestigatorAPI {
  return {
    checkAvailability: vi.fn().mockResolvedValue({ success: true, available: true }),
    start: vi.fn().mockResolvedValue({ success: true }),
    getStatus: vi.fn().mockResolvedValue({
      success: true,
      status: { state: "idle", userDescription: "", log: [] },
    }),
    cancel: vi.fn().mockResolvedValue({ success: true }),
    reset: vi.fn().mockResolvedValue({ success: true }),
    post: vi.fn().mockResolvedValue({ success: true, url: "https://example/issues/1" }),
    onEvent: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

// --- Install all mocks on window ---

export function createMockSettingsAPI(overrides: Partial<SettingsAPI> = {}): SettingsAPI {
  return {
    get: vi.fn().mockResolvedValue({
      success: true,
      settings: {
        autoApprove: { global: false, perServer: {} },
      },
    }),
    getRuntimeSelection: vi.fn().mockResolvedValue({
      success: true,
      selection: {
        requestedRuntimeId: "copilot",
        runtimeId: "copilot",
      },
    }),
    switchRuntime: vi.fn().mockImplementation(async (runtimeId: string) => ({
      success: true,
      result: {
        selection: {
          requestedRuntimeId: runtimeId,
          runtimeId,
        },
        requiresRestart: false,
      },
    })),
    save: vi.fn().mockResolvedValue({ success: true }),
    getShowHideShortcutStatus: vi.fn().mockResolvedValue({
      success: true,
      status: {
        enabled: false,
        accelerator: "Control+Alt+Space",
        registered: false,
        error: null,
      },
    }),
    pickWorkspaceDir: vi
      .fn()
      .mockResolvedValue({ success: true, folderPath: "C:/Users/test/Documents/Marshal" }),
    pickWorktreeDir: vi
      .fn()
      .mockResolvedValue({ success: true, folderPath: "Q:/Marshal/worktrees" }),
    openFile: vi.fn().mockResolvedValue({ success: true }),
    onToggle: vi.fn().mockReturnValue(() => {}),
    onChanged: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

export function installMockClipboard() {
  const clipboard = {
    writeText: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
  };

  try {
    Object.defineProperty(navigator, "clipboard", {
      value: clipboard,
      configurable: true,
      writable: true,
    });
  } catch {
    if (navigator.clipboard) {
      Object.defineProperty(navigator.clipboard, "writeText", {
        value: clipboard.writeText,
        configurable: true,
        writable: true,
      });
    } else {
      throw new Error("Unable to install mock clipboard");
    }
  }

  return navigator.clipboard;
}

export function createMockGoalAPI(overrides: Partial<GoalAPI> = {}): GoalAPI {
  const api = {
    get: vi.fn().mockResolvedValue({ success: true, snapshot: null }),
    set: vi.fn().mockRejectedValue(new Error("Goal set mock is not configured")),
    updateDefinition: vi
      .fn()
      .mockRejectedValue(new Error("Goal definition update mock is not configured")),
    updateContext: vi
      .fn()
      .mockRejectedValue(new Error("Goal context update mock is not configured")),
    pause: vi.fn().mockRejectedValue(new Error("Goal pause mock is not configured")),
    resume: vi.fn().mockRejectedValue(new Error("Goal resume mock is not configured")),
    steer: vi.fn().mockRejectedValue(new Error("Goal steer mock is not configured")),
    stop: vi.fn().mockRejectedValue(new Error("Goal stop mock is not configured")),
    onChanged: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
  return api as GoalAPI;
}

export function installMockAPIs(
  overrides: {
    copilotAPI?: Partial<CopilotAPI>;
    overlayReviewAPI?: Partial<OverlayReviewAPI>;
    sessionsAPI?: Partial<SessionsAPI>;
    modelsAPI?: Partial<ModelsAPI>;
    soulAPI?: Partial<SoulAPI>;
    skillsAPI?: Partial<SkillsAPI>;
    goalAPI?: Partial<GoalAPI>;
    heartbeatAPI?: Partial<HeartbeatAPI>;
    relayProviderSettingsAPI?: Partial<RelayProviderSettingsAPI>;
    automationsAPI?: Partial<AutomationsAPI>;
    updateAPI?: Partial<UpdateAPI>;
    settingsAPI?: Partial<SettingsAPI>;
    electronAPI?: Partial<ElectronAPI>;
    encryptionAPI?: Partial<EncryptionAPI>;
    backgroundAPI?: Partial<BackgroundAPI>;
    windowControlsAPI?: Partial<WindowControlsAPI>;
    chatWindowsAPI?: Partial<ChatWindowsAPI>;
    activitiesAPI?: Partial<ActivitiesAPI>;
    shellAPI?: Partial<ShellAPI>;
    preferencesAPI?: Partial<PreferencesAPI>;
    fileExportAPI?: Partial<FileExportAPI>;
    backendAPI?: Partial<BackendAPI>;
    runtimeAuthAPI?: Partial<RuntimeAuthAPI>;
    runtimeAccountsAPI?: Partial<RuntimeAccountsAPI>;
    runtimeExtensionsAPI?: Partial<RuntimeExtensionsAPI>;
    gatewayAuthAPI?: Partial<GatewayAuthAPI>;
    gatewayNodeAPI?: Partial<GatewayNodeAPI>;
    identityAPI?: Partial<IdentityAPI>;
    telemetryAPI?: Partial<TelemetryAPI>;
    aiInvestigatorAPI?: Partial<AIInvestigatorAPI>;
    permissionsAPI?: Partial<PermissionsAPI>;
    contextPickerAPI?: Partial<ContextPickerAPI>;
    workspaceAPI?: Partial<WorkspaceAPI>;
    workflowsAPI?: Partial<WorkflowsAPI>;
  } = {},
) {
  window.platform = "win32";
  window.appModeAPI = { getLatest: () => "release", onModeChanged: () => () => {} };
  window.copilotAPI = createMockCopilotAPI();
  window.overlayReviewAPI = {
    ...createMockOverlayReviewAPI(),
    ...overrides.overlayReviewAPI,
  };
  window.sessionsAPI = createMockSessionsAPI(overrides.sessionsAPI);
  window.modelsAPI = createMockModelsAPI(overrides.modelsAPI);
  window.soulAPI = createMockSoulAPI(overrides.soulAPI);
  window.skillsAPI = createMockSkillsAPI(overrides.skillsAPI);
  window.goalAPI = createMockGoalAPI(overrides.goalAPI);
  window.heartbeatAPI = createMockHeartbeatAPI(overrides.heartbeatAPI);
  window.relayProviderSettingsAPI = createMockRelayProviderSettingsAPI(
    overrides.relayProviderSettingsAPI,
  );
  window.automationsAPI = createMockAutomationsAPI(overrides.automationsAPI);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- renderer tests provide only the workflow methods under assertion
  window.workflowsAPI = overrides.workflowsAPI as WorkflowsAPI | undefined;
  window.updateAPI = createMockUpdateAPI(overrides.updateAPI);
  window.encryptionAPI = createMockEncryptionAPI(overrides.encryptionAPI);
  window.settingsAPI = createMockSettingsAPI(overrides.settingsAPI);
  window.runtimeExtensionsAPI = {
    search: vi.fn<RuntimeExtensionsAPI["search"]>().mockResolvedValue({
      success: true,
      value: { query: "", matches: [] },
    }),
    status: vi.fn<RuntimeExtensionsAPI["status"]>().mockImplementation(async (scope) => ({
      success: true,
      value: {
        ...scope,
        revision: 0,
        scannedAt: new Date(0).toISOString(),
        discoveryStatus: "unavailable",
        items: [],
        diagnostics: [],
      },
    })),
    install: vi.fn<RuntimeExtensionsAPI["install"]>(),
    installLocal: vi.fn<RuntimeExtensionsAPI["installLocal"]>(),
    update: vi.fn<RuntimeExtensionsAPI["update"]>(),
    enable: vi.fn<RuntimeExtensionsAPI["enable"]>(),
    disable: vi.fn<RuntimeExtensionsAPI["disable"]>(),
    configure: vi.fn<RuntimeExtensionsAPI["configure"]>(),
    setProvider: vi.fn<RuntimeExtensionsAPI["setProvider"]>(),
    clearProvider: vi.fn<RuntimeExtensionsAPI["clearProvider"]>(),
    repairContractConflict: vi.fn<RuntimeExtensionsAPI["repairContractConflict"]>(),
    remove: vi.fn<RuntimeExtensionsAPI["remove"]>(),
    onChanged: vi.fn<RuntimeExtensionsAPI["onChanged"]>().mockReturnValue(() => undefined),
    ...overrides.runtimeExtensionsAPI,
  };
  window.appAPI = {
    getDefaultWorkspaceDir: vi.fn().mockResolvedValue({
      success: true,
      defaultWorkspaceDir: "C:/Users/test/Documents/Marshal",
    }),
  };
  window.backgroundAPI = createMockBackgroundAPI(overrides.backgroundAPI);
  window.windowControlsAPI = createMockWindowControlsAPI(overrides.windowControlsAPI);
  window.chatWindowsAPI = createMockChatWindowsAPI(overrides.chatWindowsAPI);
  window.devAPI = {
    getMockMode: vi.fn().mockResolvedValue({ success: true, enabled: false }),
    setMockMode: vi.fn().mockResolvedValue({ success: true }),
    testMiniModeNotification: vi.fn().mockResolvedValue({ success: true }),
  };
  window.mcpsAPI = {
    initiateOAuth: vi.fn<McpsAPI["initiateOAuth"]>().mockResolvedValue({ status: "success" }),
    signOut: vi.fn<McpsAPI["signOut"]>().mockResolvedValue({ status: "success" }),
    list: vi.fn().mockResolvedValue({ success: true, servers: [] }),
    add: vi.fn().mockResolvedValue({ success: true, name: "test-server" }),
    installCatalog: vi.fn().mockResolvedValue({ success: true }),
    remove: vi.fn().mockResolvedValue({ success: true }),
    updateConfig: vi.fn().mockResolvedValue({ success: true }),
    openFile: vi.fn().mockResolvedValue({ success: true }),
    rediscover: vi.fn().mockResolvedValue({ success: true }),
    setExposeAsGatewayNodeCommand: vi.fn().mockResolvedValue({ success: true }),
    openEnvFile: vi.fn<McpsAPI["openEnvFile"]>().mockResolvedValue({ success: true }),
    onToolsUpdated: vi.fn().mockReturnValue(vi.fn()),
    onServerStatus: vi.fn().mockReturnValue(vi.fn()),
    onOAuthRequired: vi.fn().mockReturnValue(vi.fn()),
    onOAuthCompleted: vi.fn().mockReturnValue(vi.fn()),
  };
  window.tenantAPI = {
    getStatus: vi.fn().mockResolvedValue({
      success: true,
      managed: false,
      disabledServers: [],
      disabledPermissionKinds: [],
      forcePrompt: false,
      disabledModels: [],
      disableHeartbeat: false,
      disableAutomations: false,
      disabledProviders: [],
      restrictToWorkspace: false,
      browserEgressBlockedOrigins: [],
    }),
  };
  window.permissionsAPI = {
    getCards: vi.fn().mockResolvedValue({ success: true, cards: [] }),
    clearCards: vi.fn().mockResolvedValue({ success: true }),
    listTools: vi.fn().mockResolvedValue({ success: true, categories: [] }),
    getConfig: vi.fn().mockResolvedValue({
      success: true,
      envelope: {
        supported: true,
        permissions: { autoApproveReadOnly: true, allow: [], tools: {}, servers: {} },
        controllable: ALL_PERMISSIONS_CONTROLLABLE_MOCK,
      },
    }),
    saveConfig: vi.fn().mockResolvedValue({ success: true }),
    onCardsChanged: vi.fn().mockReturnValue(() => {}),
    ...overrides.permissionsAPI,
  };
  window.contextPickerAPI = {
    search: vi.fn().mockResolvedValue({ success: true, entities: [] }),
    ...overrides.contextPickerAPI,
  };
  window.workspaceAPI = {
    getRoot: vi.fn().mockResolvedValue({ success: true, root: "/tmp/workspace" }),
    listDir: vi.fn().mockResolvedValue({ success: true, entries: [] }),
    searchFiles: vi.fn().mockResolvedValue({ success: true, files: [] }),
    readFile: vi.fn().mockResolvedValue({ success: true, type: "text", content: "" }),
    revealInFileManager: vi.fn().mockResolvedValue({ success: true }),
    onWorkspaceChange: vi.fn().mockReturnValue(() => {}),
    onWorkspaceRegistryChange: vi.fn().mockReturnValue(() => {}),
    listWorkspaces: vi.fn().mockResolvedValue({ success: true, workspaces: ["Scratchpad"] }),
    listRepositoryAgents: vi.fn().mockResolvedValue({ success: true, agents: [] }),
    createWorkspace: vi.fn().mockResolvedValue({ success: true }),
    renameWorkspace: vi.fn().mockResolvedValue({ success: true }),
    deleteWorkspace: vi.fn().mockResolvedValue({ success: true }),
    getWorkspaceContents: vi
      .fn()
      .mockResolvedValue({ success: true, fileCount: 0, folderCount: 0 }),
    createFolder: vi.fn().mockResolvedValue({ success: true }),
    renameItem: vi.fn().mockResolvedValue({ success: true, newPath: "/tmp/workspace/new" }),
    deleteItem: vi.fn().mockResolvedValue({ success: true }),
    moveItem: vi.fn().mockResolvedValue({
      success: true,
      newPath: "/tmp/workspace/dest/item",
    }),
    duplicateItem: vi.fn().mockResolvedValue({
      success: true,
      newPath: "/tmp/workspace/file copy.txt",
    }),
    copyExternalFiles: vi.fn().mockResolvedValue({ success: true, copied: 1 }),
    getPathForFile: vi.fn().mockReturnValue("/mock/path/file.txt"),
    writeFile: vi.fn().mockResolvedValue({ success: true }),
    openFile: vi.fn().mockResolvedValue({ success: true }),
    pickFolder: vi.fn().mockResolvedValue({
      success: true,
      folderPath: "/tmp/selected-folder",
      folderToken: "token",
    }),
    getUIState: vi.fn().mockResolvedValue({
      success: true,
      state: { activeWorkspace: "Scratchpad", expandedPaths: {}, selectedFiles: {} },
    }),
    setActiveWorkspace: vi.fn().mockResolvedValue({ success: true }),
    setExpandedPaths: vi.fn().mockResolvedValue({ success: true }),
    setSelectedFile: vi.fn().mockResolvedValue({ success: true }),
    ...overrides.workspaceAPI,
  };
  window.diagnosticsAPI = {
    rendererHeartbeat: vi.fn().mockResolvedValue({ success: true }),
    log: vi.fn<() => Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),
    getLogPath: vi.fn<() => Promise<{ success: boolean; path?: string }>>().mockResolvedValue({
      success: true,
      path: "/Users/testuser/.marshal/marshal-diagnostics.jsonl",
    }),
    revealLogFolder: vi
      .fn<() => Promise<{ success: boolean }>>()
      .mockResolvedValue({ success: true }),
    sanitize: vi
      .fn<(text: string) => Promise<{ success: boolean; sanitized: string }>>()
      .mockImplementation(async (text: string) => ({
        success: true,
        sanitized: text
          .replace(/\/Users\/[^\s/\\)]+/g, "~")
          .replace(/[A-Za-z]:[/\\]Users[/\\][^\s/\\)]+/g, "~"),
      })),
  };
  window.electronAPI = createMockElectronAPI();
  window.activitiesAPI = createMockActivitiesAPI(overrides.activitiesAPI);
  window.shellAPI = createMockShellAPI(overrides.shellAPI);
  window.preferencesAPI = createMockPreferencesAPI(overrides.preferencesAPI);
  window.fileExportAPI = createMockFileExportAPI(overrides.fileExportAPI);
  window.backendAPI = createMockBackendAPI(overrides.backendAPI);
  window.runtimeAuthAPI = createMockRuntimeAuthAPI(overrides.runtimeAuthAPI);
  window.runtimeAccountsAPI = createMockRuntimeAccountsAPI(overrides.runtimeAccountsAPI);
  window.gatewayAuthAPI = createMockGatewayAuthAPI(overrides.gatewayAuthAPI);
  window.gatewayNodeAPI = createMockGatewayNodeAPI(overrides.gatewayNodeAPI);
  window.identityAPI = createMockIdentityAPI(overrides.identityAPI);
  window.telemetryAPI = createMockTelemetryAPI(overrides.telemetryAPI);
  window.aiInvestigatorAPI = createMockAIInvestigatorAPI(overrides.aiInvestigatorAPI);

  if (overrides.copilotAPI) {
    Object.assign(window.copilotAPI, overrides.copilotAPI);
  }
  if (overrides.electronAPI && window.electronAPI) {
    Object.assign(window.electronAPI, overrides.electronAPI);
  }
}

// --- Custom render with QueryClientProvider ---

function createTestQueryClient() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return qc;
}

type CustomRenderOptions = Omit<RenderOptions, "wrapper"> & {
  /** Pre-built QueryClient — pass one in when the test needs to seed the
   *  cache before render (e.g. asserting cache-prime → no-flicker outcomes). */
  queryClient?: QueryClient;
};

function customRender(ui: ReactElement, options?: CustomRenderOptions) {
  const { queryClient: providedQc, ...renderOptions } = options ?? {};
  const qc = providedQc ?? createTestQueryClient();
  // eslint-disable-next-line react/only-export-components -- test wrapper, not subject to fast refresh
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
  return render(ui, { wrapper: Wrapper, ...renderOptions });
}

function customRenderHook<Result, Props>(
  hook: (props: Props) => Result,
  options?: RenderHookOptions<Props>,
) {
  const qc = createTestQueryClient();
  // eslint-disable-next-line react/only-export-components -- test wrapper, not subject to fast refresh
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
  return renderHook(hook, { wrapper: Wrapper, ...options });
}

export { customRender as render, customRenderHook as renderHook };
export { default as userEvent } from "@testing-library/user-event";
export { screen, waitFor, within, act } from "@testing-library/react";
