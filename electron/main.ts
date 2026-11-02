import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createRuntimeServiceContainer,
  RuntimeCompositionRegistry,
  type InvocationContext,
} from "@marshal/runtime";
import { RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE } from "@marshal/runtime/extensions";
import {
  app,
  crashReporter,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  safeStorage,
  session,
  Menu,
  globalShortcut,
  nativeTheme,
} from "electron";

import { APP_NAME } from "../common/marshal-constants";
import type { AppMode } from "../common/marshal-constants";
import type { RuntimeSwitchResult } from "../common/marshal-ipc-contract";
import {
  REVIEWER_SESSION_CAPABILITIES,
  REVIEWER_SESSION_PERMISSION_MODE,
} from "../common/marshal-ipc-contract";
import { createLogger } from "../common/marshal-logger";
import {
  buildDisabledDisplayNameSet,
  MCP_SERVER_CONFIG_KEYS,
} from "../common/marshal-permission-servers";
import { toMcpServerKey } from "../common/mcp-server-key-normalization";
import {
  normalizeRelaySettings,
  normalizeWorkServiceProviderSettings,
} from "../common/provider-config";
import { parseRelayAccountId, parseRelayConversationId } from "../common/relay-contract";
import {
  canSwitchRuntimeLive,
  GATEWAY_RUNTIME_ID,
  getRuntimeMetadata,
  normalizeRuntimeId,
} from "../common/runtime-config";
import { resolveSessionRuntimeId } from "../common/runtime-config";
import type { RuntimeUiScope } from "../common/runtime-ui";
import { MARSHAL_RUNTIME_DEFAULT_WORKSPACE } from "../common/runtime-ui";
import { RUNTIME_UI_SANDBOX_CSP_SOURCE } from "../common/runtime-ui-sandbox";
import { declaredUiViewportsFromMetadata } from "../common/runtime-ui-viewports";
import { crashErrors, makeCrashError } from "../common/telemetry/errors/marshal-crash";
import { AgentMessageOutbox, EncryptedAgentMessageOutboxPersistence } from "./agent-message-outbox";
import { AIInvestigatorManager } from "./ai-investigator/ai-investigator-manager";
import { applyAppBadge, applyWindowIconBadge, applyWindowTitle, getAppMode } from "./app-badge";
import { createAppModeController } from "./app-mode-controller";
import {
  getAppDataDir,
  getDocumentsPathOrNull,
  initializeAppDataDir,
  resolveWorkspaceDir,
  isDevMode,
} from "./app-paths";
import { surfaceCompletedRestartsOnBoot } from "./app-restart-boot";
import { createAppRestartExecutor } from "./app-restart-executor";
import { applyKeepAwakeSettings } from "./apply-keep-awake-settings";
import { ApprovalBroker } from "./approval-broker";
import { AuditLogger, buildPreHookAuditInput } from "./audit-log";
import { AutomationManager } from "./automations";
import { createDesktopRuntimeWakes, createSessionWakePort } from "./automations/runtime-wakes";
import { fetchGitHubAvatar } from "./avatar";
import {
  inspectCloudSession,
  cloudTranscript,
  createCloudClientFactory,
} from "./backend/cloud/client";
import {
  buildGatewayBackendConfig,
  createBackend,
  createClientFactory,
} from "./backend/create-backend";
import { resolveDeviceIdentityPath } from "./backend/gateway/device-identity";
import type { ISelfToolDeps } from "./backend/ports";
import type { RuntimeTool } from "./backend/runtime-contract";
import { resolveRuntimeStartupSelection } from "./backend/startup-selection";
import type { AuthMachineryHandle, IBackendProvider } from "./backend/types";
import { BackgroundServiceManager } from "./background-service-manager";
import { verifyCertificateChain, reportPinError } from "./cert-pins";
import { ChatWindowManager } from "./chat-window-manager";
import { getSessionClientViewport } from "./client-viewport";
import { CommandCenterManager } from "./command-center/manager";
import { installCrashDiagnostics } from "./crash-diagnostics";
import { addDiagnosticLogSink } from "./diagnostic-log-sink";
import {
  rotateIfNeeded,
  flush as flushDiagnostics,
  readLogTail,
  writeDiagnosticEntrySync,
  setDiagnosticsEnabledPredicate,
} from "./diagnostic-logger";
import {
  BackgroundToolInvocationRegistryAdapter,
  createDurableExternalOperationRegistry,
  createEncryptedExternalOperationPersistence,
  createExternalOperationStore,
} from "./external-operations";
import { flushMemoryWrite } from "./filesystem-memory-store";
import { applyShellPathFix } from "./fix-path";
import {
  buildGoalConversationContext,
  fitGoalPayload,
  GOAL_CONTEXT_CHAR_BUDGET,
  type GoalContinuationContext,
} from "./goal/goal-context";
import { GoalEngine } from "./goal/goal-engine";
import { CONTINUATION_TIMEOUT_MS } from "./goal/goal-engine-support";
import { GoalManager } from "./goal/goal-manager";
import { createTransitionReviewer } from "./goal/transition-reviewer";
import { HeartbeatManager } from "./heartbeat";
import { resolveHostedRuntimeProvider } from "./hosted-runtime/current";
import { registerActivitiesHandlers } from "./ipc/activities-ipc";
import {
  makeAIInvestigatorEmitter,
  registerAIInvestigatorHandlers,
} from "./ipc/ai-investigator-ipc";
import { registerAutomationsDesktopHandlers } from "./ipc/automations-desktop-ipc";
import { registerAutomationsHandlers } from "./ipc/automations-ipc";
import { registerCommandCenterHandlers } from "./ipc/command-center-ipc";
import { registerContextPickerHandlers } from "./ipc/context-picker/context-picker-handler-registration";
import { createRuntimePeopleSearch } from "./ipc/context-picker/runtime-people-provider";
import { registerCopilotHandlers } from "./ipc/copilot-ipc";
import { registerDiagnosticsHandlers } from "./ipc/diagnostics-ipc";
import { registerGoalHandlers } from "./ipc/goal-ipc";
// IPC handler registration modules
import { registerDefaultWorkspaceHandler } from "./ipc/handlers/app/default-workspace";
import { registerBackendCapabilitiesHandler } from "./ipc/handlers/backend/capabilities";
import { registerChatWindowsHandlers } from "./ipc/handlers/chat-windows/register";
import { registerSaveJsonHandler } from "./ipc/handlers/files/save-json";
import { registerPreferencesHandlers } from "./ipc/handlers/preferences/register";
import { registerShellHandlers } from "./ipc/handlers/shell/register";
import { registerWindowControlsHandlers } from "./ipc/handlers/window-controls/register";
import { registerHeartbeatHandlers } from "./ipc/heartbeat-ipc";
import { createIdentityController, registerIdentityHandlers } from "./ipc/identity-ipc";
import {
  assertMainFrame,
  authorizeIpcWebContents,
  createIpcHandle,
  listRegisteredIpcChannels,
} from "./ipc/ipc-handle";
import { registerMcpHandlers } from "./ipc/mcp-ipc";
import { registerMcpOAuthHandlers } from "./ipc/mcp-oauth-ipc";
import { registerMiniModeHandlers } from "./ipc/mini-mode-ipc";
import { registerModelsHandlers } from "./ipc/models-ipc";
import { registerPermissionsHandlers } from "./ipc/permissions-ipc";
import { registerRelayProviderSettingsHandlers } from "./ipc/relay-provider-settings-ipc";
import { registerRuntimeAccountsHandlers } from "./ipc/runtime-accounts-ipc";
import { registerRuntimeAuthHandlers } from "./ipc/runtime-auth-ipc";
import { registerRuntimeExtensionsHandlers } from "./ipc/runtime-extensions-ipc";
import { registerRuntimeUiImageHandlers } from "./ipc/runtime-ui-images";
import { registerRuntimeUiHandlers, runtimeUiInvocationContext } from "./ipc/runtime-ui-ipc";
import { registerRuntimeUiSessionSelectionHandlers } from "./ipc/runtime-ui-session-selection";
import { registerSessionsHandlers } from "./ipc/sessions-ipc";
import { registerSettingsHandlers } from "./ipc/settings-ipc";
import { registerSkillsHandlers } from "./ipc/skills-ipc";
import { registerSoulHandlers } from "./ipc/soul-ipc";
import { registerSwarmHandlers } from "./ipc/swarm-ipc";
import { registerTelemetryHandlers } from "./ipc/telemetry-ipc";
import { registerTenantHandlers } from "./ipc/tenant-ipc";
import { registerTranscribeHandlers } from "./ipc/transcribe-ipc";
import type { IpcDeps } from "./ipc/types";
import { registerUpdateHandlers } from "./ipc/update-ipc";
import { registerWorkflowsHandlers } from "./ipc/workflows-ipc";
import { registerWorkspaceHandlers } from "./ipc/workspace-ipc";
import { resolveIssueReporterTarget } from "./issue-reporter/config";
import { createGitHubIssueReporter } from "./issue-reporter/github-provider";
import { KeepAwakeManager } from "./keep-awake";
import { LocalTelemetryStore } from "./local-telemetry-store";
import { installNativeTitleSync } from "./main-window-branding";
import { wireAppModeController } from "./marshal-app-mode-controller-wiring";
import { getFsResourceRoots } from "./marshal-fs/resource-roots";
import { MainWindowController } from "./marshal-main-window-controller";
import { makeMarshalHandler } from "./marshal-protocol";
import {
  bindRuntimeSelfToolsToSession,
  createExtensionDeclaredPermissionResolver,
  createMarshalSwarmProduction,
  createProductionMarshalRuntimePorts,
  createSwarmTerminalGoalHandoff,
  getRuntimeSelfTools,
  MarshalServiceSymbols,
  MarshalRuntimeBrainAdapter,
  MarshalRuntimeHost,
  MarshalRuntimeMemoryAdapter,
  AgenticBrowserCommandExecutor,
  ProductionMarshalRuntimeApi,
  type ExtensionDeclaredPermissionResolver,
  type RuntimeUiDeliveryPorts,
  SessionManagerRuntimeAgentAdapter,
  SwarmDriver,
} from "./marshal-runtime";
import { createAcceptanceDebuggerHostAdapter } from "./marshal-runtime/acceptance-debugger-host";
import { bindAgenticDebuggerHostAdapter } from "./marshal-runtime/agentic-debugger-runtime-host";
import { createAppLifecycleProvider } from "./marshal-runtime/app-lifecycle-provider";
import { RuntimeApplicationAuthority } from "./marshal-runtime/application-authority";
import { RuntimeApplicationHost } from "./marshal-runtime/application-host";
import { createApplicationJobProvider } from "./marshal-runtime/application-job-provider";
import { RuntimeApplicationJobs } from "./marshal-runtime/application-jobs";
import { createApplicationSessionProvider } from "./marshal-runtime/application-session-provider";
import { ApplicationSessionService } from "./marshal-runtime/application-sessions";
import { createCloudSessionProvider } from "./marshal-runtime/cloud-session-provider";
import { createRuntimeExtensionSecrets } from "./marshal-runtime/extension-secrets";
import { resolveFirstPartyExtensionCatalog } from "./marshal-runtime/first-party-extension-catalog";
import { maybeInstallPackagedMarshalCli } from "./marshal-runtime/local-source";
import {
  createMarshalMemoryReasonerAdapter,
  MARSHAL_MEMORY_REASONER_SERVICE,
} from "./marshal-runtime/memory-reasoner-adapter";
import {
  createMarshalRelayRegistrationService,
  MARSHAL_RELAY_REGISTRATION_SERVICE,
} from "./marshal-runtime/runtime-relay-registration";
import { RuntimeUiAttachmentStore } from "./marshal-runtime/runtime-ui-attachments";
import { createRuntimeUiImageProvider } from "./marshal-runtime/runtime-ui-image-provider";
import {
  SelectedSessionDeliveryService,
  type SelectedSessionOwner,
} from "./marshal-runtime/selected-session-delivery";
import { createSelectedSessionDeliveryProvider } from "./marshal-runtime/selected-session-provider";
import { SessionLifecycleDispatcher } from "./marshal-runtime/session-lifecycle-dispatch";
import { isTrustedTypeScriptEnabled } from "./marshal-runtime/trusted-typescript";
import { McpStore } from "./mcp-store";
import { buildMcpConfig, bundledNodePath, developmentNodePath } from "./mcp-tools";
import { createMemoryProvider } from "./memory-provider";
import { MiniModeManager } from "./mini-mode";
import { isMockMode, setMockMode } from "./mock-mode";
import { openExternalSafe, openLocalFileSafe } from "./open-external";
import { registerOverlayReviewHandlers } from "./overlay-review";
import { PerformanceFlightRecorder } from "./performance-flight-recorder";
import { normalizePerformanceFlightRecorderEnv } from "./performance-flight-recorder-policy";
import { PermissionCardManager } from "./permission-card-manager";
import { permissionNotificationBody } from "./permission-external-redaction";
import { PermissionPolicy, REVIEWER_ALLOWED_CUSTOM_TOOLS } from "./permission-policy";
import { excludeMDataFromBackup, secureMkdirSync, secureWriteFileSync } from "./platform-security";
import {
  addImageProtocolHeaders,
  hasImageMagicBytes,
  isImageExtension,
  isInsideDirectory,
  isInsideWorkspace,
} from "./platform/image-utils";
import { NotificationRouter } from "./platform/notification-router";
import { resolveLooseFilePath } from "./platform/preload-path";
import { PowerManager } from "./power";
import {
  installProcessExitHooks,
  stackPreview,
  summarizeError,
  writeProcessLifecycleEventSync,
} from "./process-lifecycle-diagnostics";
import { toExtensionPromptContribution } from "./prompt/extension-contributions";
import { hasCodeIntelligence } from "./prompt/sections/code-intelligence-section";
import {
  RelayExperienceCoordinator,
  type RelayNotificationTarget,
} from "./relay/experience-coordinator";
import { RelayHostInteractionBridge } from "./relay/host-interaction-bridge";
import { createDefaultRelayHostMediaAdapter } from "./relay/host-media-adapter";
import { getRelayIdleLastMessageExcerpt } from "./relay/idle-excerpt";
import { formatRelaySessionMessage } from "./relay/message-format";
import {
  createRelayProviderSettingsService,
  type RelayProviderSettingsBinding,
} from "./relay/provider-settings-service";
import { WhatsAppFixedAgentRuntime } from "./relay/providers/whatsapp/fixed-agent-runtime";
import { createLiveWhatsAppProviderComposition } from "./relay/providers/whatsapp/live-composition";
import { WhatsAppService } from "./relay/providers/whatsapp/service";
import { RelayProviderRegistry } from "./relay/registry";
import { RelayDatabase } from "./relay/relay-database";
import { getRelayRouteAlias } from "./relay/route-aliases";
import {
  createRemoteAccessController,
  remoteTargets,
  broadcastRemote,
  stopRemoteAccess,
} from "./remote-access/controller";
import { configureTailscale } from "./remote-access/tailscale";
import {
  RendererResponsivenessMonitor,
  startMainEventLoopDelayMonitor,
} from "./renderer-responsiveness-monitor";
import { RuntimeAcceptanceHarness } from "./runtime-acceptance/main";
import { RuntimeAccountsKeepAlive } from "./runtime-accounts-keepalive";
import { RuntimeAccountsManager } from "./runtime-accounts-manager";
import { getDevServerUrl, isDevServerNavigation } from "./runtime-env";
import { wireRuntimeUiViews } from "./runtime-ui-views";
import {
  finalizeSafeStorageAppName,
  prepareSafeStorageAppName,
  resolveCommandLineUserDataDir,
  userDataPath,
} from "./safe-storage-brand";
import {
  initEncryptionKeyAsync,
  loadOrCreateKey,
  wasEncryptionKeyReset,
} from "./safe-storage-file";
import { createRuntimeDocumentAccessStore } from "./security/runtime-document-access-store";
import { createSessionStorageProvider } from "./session-storage-provider";
import { SessionViewIpcBroker } from "./session-view-ipc-broker";
import { summarizeViewEventToolCalls } from "./session-view-payload";
import { SessionManager } from "./sessions";
import { SettingsManager } from "./settings-manager";
import { flushSettingsWrite } from "./settings-store";
import { ShowHideShortcutController } from "./show-hide-shortcut";
import {
  migrateSkillsIfNeeded,
  repairLocalSkillFiles,
  initBundledSkills,
  addSkill,
  updateSkill,
  deleteSkill,
} from "./skills";
import { emitWorkspaceFallbackTelemetryIfNeeded } from "./startup-telemetry";
import { sendErrorTelemetry, setTelemetryWindow } from "./telemetry-errors";
import { TenantPolicyProvider } from "./tenant-policy";
import { resolveThemeBg, useMacVibrancy } from "./theme";
import { normalizeProcessTZ } from "./timezone-utils";
import { buildStaticCategories } from "./tool-discovery";
import { TrayManager } from "./tray";
import { UI_OBSERVE_CAPTURE, createUiObserveProvider } from "./ui-observe";
import {
  createCdpTargetResolver,
  createObserverWindowOpener,
  createUiObserveRenderer,
} from "./ui-observe-window";
import {
  attachWindowStateTracking,
  getDefaultBounds,
  loadWindowState,
  MIN_HEIGHT,
  MIN_WIDTH,
  pickValidBounds,
} from "./window-state";
import { ensureMacDockPresence, shouldSkipTaskbarForHiddenWindow } from "./window-taskbar";
import { createBuiltInWorkServiceProviders } from "./work-services/factory";
import { SessionManagerSpawnAdapter } from "./workflows/spawn-adapter";
import { WorkflowRunManager } from "./workflows/workflow-run-manager";
import { listRegisteredWorkspaces } from "./workspace-store";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

normalizePerformanceFlightRecorderEnv(process.env);

// Wire structured logger → diagnostic JSONL file so all log.info/warn/error
// calls are persisted for support investigations.
// Must be registered before any createLogger() calls emit.
rotateIfNeeded();
addDiagnosticLogSink();
installProcessExitHooks();
writeProcessLifecycleEventSync("main.module.loaded", {
  isPackaged: app.isPackaged,
  version: app.getVersion(),
  argv: process.argv.slice(0, 4),
});
const crashDiagnostics = installCrashDiagnostics({ app, crashReporter });
writeProcessLifecycleEventSync("main.diagnostics.installed", { paths: crashDiagnostics.paths });
const performanceFlightRecorder = new PerformanceFlightRecorder({
  enabled: process.env.MARSHAL_PERFORMANCE_FLIGHT_RECORDER !== "0",
  profileDir: path.join(crashDiagnostics.paths.rootDir, "performance-profiles"),
});
performanceFlightRecorder.startMain();

const log = createLogger("Main");
const mainWindowLog = log.child("MainWindow");
const quitLog = log.child("Quit");
const marshalRuntimeLog = log.child("MarshalRuntime");
const mcpLog = log.child("MCP");

prepareSafeStorageAppName(app);

// Runs before any function-level spawn at app startup.
// Note: this does NOT run before module-evaluation side effects in
// statically-imported modules — do not introduce a new top-level spawn
// in another `electron/` module without sequencing it after this call.
applyShellPathFix();

// Normalize TZ before any BrowserWindow is created, so the renderer's V8
// inherits a value it can parse. Without this, enterprise hosts that export
// TZ as a Windows-format ID ("Pacific Standard Time") leak UTC into every
// chat-message and picker timestamp. See timezone-utils.ts for the policy.
normalizeProcessTZ();

// Prevent Chromium network service crash from killing the process
app.commandLine.appendSwitch("disable-features", "NetworkServiceInProcess2");
app.commandLine.appendSwitch("enable-features", "NetworkServiceInProcess");

// Debug: log path resolution for diagnosing preload issues on Windows
log.info(
  `Marshal v${app.getVersion()} (Electron ${process.versions.electron}, Node ${process.versions.node}, ${process.platform} ${process.arch})`,
);
log.info("__dirname:", __dirname);
log.info("import.meta.url:", import.meta.url);
log.info("app.getAppPath():", app.getAppPath());
log.info("process.resourcesPath:", process.resourcesPath);

// In packaged mode, __dirname is inside asar - we need to handle this
const isPackaged = app.isPackaged;

// Set AppUserModelID so Windows associates the taskbar button with our app
// identity, enabling setOverlayIcon() to render badge overlays.
// electron-builder sets this at install time for packaged builds; in dev mode
// Electron uses a default AUMID that doesn't match.
if (process.platform === "win32") {
  // Keep the taskbar and notification identity aligned with the canonical app ID.
  app.setAppUserModelId("com.marshal");
}

// Dev-mode isolation: redirect Electron's userData to a separate directory
// so the dev instance doesn't fight the installed app over GPU cache, heartbeat
// settings, and other per-user Electron state.
const requestedUserData = resolveCommandLineUserDataDir(
  app.commandLine.getSwitchValue("user-data-dir"),
);
writeProcessLifecycleEventSync("main.bootstrap.user-data.start", {
  hasCommandLineOverride: requestedUserData !== null,
});
if (isMockMode()) {
  if (requestedUserData) {
    app.setPath("userData", requestedUserData);
  }
  if (
    __MARSHAL_RUNTIME_ACCEPTANCE_BUILD__ &&
    process.env.MARSHAL_E2E === "1" &&
    process.env.MARSHAL_RUNTIME_ACCEPTANCE === "1" &&
    Boolean(process.env.MARSHAL_RUNTIME_ACCEPTANCE_TOKEN?.trim()) &&
    !requestedUserData
  ) {
    const acceptanceRunRoot = process.env.MARSHAL_RUNTIME_ACCEPTANCE_RUN_ROOT;
    if (!acceptanceRunRoot || !path.isAbsolute(acceptanceRunRoot)) {
      throw new Error("Marshal Runtime acceptance requires an absolute run root.");
    }
    app.setPath("userData", path.join(path.resolve(acceptanceRunRoot), "electron-user-data"));
  }
  log.info(`E2E MODE - isolated userData: ${app.getPath("userData")}`);
  log.info(`E2E MODE - app data: ${getAppDataDir()}`);
} else if (isDevMode()) {
  const devAppData = getAppDataDir();
  const devUserData = path.join(devAppData, "electron-data");
  app.setPath("userData", devUserData);
  log.info(`⚡ DEV MODE — isolated userData: ${devUserData}`);
  log.info(`⚡ DEV MODE — app data: ${devAppData}`);
} else if (requestedUserData) {
  app.setPath("userData", requestedUserData);
  log.info("Using absolute command-line userData override");
} else {
  const appDataDir = app.getPath("appData");
  const marshalUserData = userDataPath(appDataDir);
  app.setPath("userData", marshalUserData);
}
writeProcessLifecycleEventSync("main.bootstrap.user-data.ready");

// In mock mode, IPC handlers return stub responses from e2e-stubs.ts (lazy-loaded).
// Use ipcHandle() instead of ipcMain.handle() for handlers that need mock stubs.
const ipcHandle = createIpcHandle();

// Toggle mock mode at runtime (dev builds only — not available in packaged app)
if (!isPackaged) {
  ipcMain.handle("dev:getMockMode", (event) => {
    assertMainFrame(event, "dev:getMockMode");
    return { success: true, enabled: isMockMode() };
  });
  ipcMain.handle("dev:setMockMode", async (event, enabled: boolean) => {
    assertMainFrame(event, "dev:setMockMode");
    setMockMode(enabled);
    // Swap the client factory and reset the running client so the next
    // createSDKSession() picks up the correct mock/real implementation.
    // win.reload() only reloads the renderer — main-process module-level
    // code does NOT re-execute, so we must swap the factory explicitly.
    const newFactory = createClientFactory(
      runtimeStartupSelection.runtimeId,
      createRuntimeAdapterContext(enabled),
    );
    if (newFactory) sessionManager.setClientFactory(newFactory);
    await sessionManager.resetClient();

    // When switching to mock mode, seed the E2E temp dir with settings
    // and sample sessions so the app opens with a usable session list.
    if (enabled) {
      const { E2E_DATA_DIR } = await import("./mock-mode");
      const sessionsDir = path.join(E2E_DATA_DIR, "marshal-sessions");
      secureMkdirSync(sessionsDir, 0o700);
      secureWriteFileSync(
        path.join(E2E_DATA_DIR, "marshal-settings.json"),
        JSON.stringify({ experiments: {} }, null, 2),
      );
      const now = new Date().toISOString();
      const sessions = [
        {
          id: "mock-fresh",
          name: "New Chat",
          createdAt: now,
          updatedAt: now,
          hasUnread: false,
          isActive: true,
          messages: [],
        },
        {
          id: "mock-debug",
          name: "Python debugging session",
          createdAt: "2026-03-04T14:00:00.000Z",
          updatedAt: "2026-03-04T14:01:00.000Z",
          hasUnread: false,
          isActive: false,
          messages: [
            {
              id: "m1",
              role: "user",
              content: "My Python script crashes with a KeyError on line 42",
              timestamp: "2026-03-04T14:00:00.000Z",
            },
            {
              id: "m2",
              role: "assistant",
              content:
                "The KeyError means the dictionary key doesn't exist. Can you share the traceback?",
              timestamp: "2026-03-04T14:00:05.000Z",
            },
          ],
        },
        {
          id: "mock-api",
          name: "API design review",
          createdAt: "2026-03-03T10:00:00.000Z",
          updatedAt: "2026-03-03T10:01:00.000Z",
          hasUnread: false,
          isActive: false,
          messages: [
            {
              id: "m3",
              role: "user",
              content: "Review our REST API endpoints for the user service",
              timestamp: "2026-03-03T10:00:00.000Z",
            },
            {
              id: "m4",
              role: "assistant",
              content:
                "I'll analyze the endpoint structure. The /users resource looks well-designed with proper REST conventions.",
              timestamp: "2026-03-03T10:00:05.000Z",
            },
          ],
        },
      ];
      for (const s of sessions) {
        secureWriteFileSync(path.join(sessionsDir, `${s.id}.json`), JSON.stringify(s, null, 2));
      }
      secureWriteFileSync(
        path.join(sessionsDir, "sessions-index.json"),
        JSON.stringify({
          sessions: sessions.map((s) => ({
            id: s.id,
            name: s.name,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            hasUnread: false,
            isActive: s.id === "mock-fresh",
          })),
          activeSessionId: "mock-fresh",
        }),
      );
    }

    win?.reload();
    return { success: true };
  });
}

process.env.APP_ROOT = isPackaged ? process.resourcesPath : path.join(__dirname, "..");

// Security: the renderer URL is a trust boundary because preload.cjs injects
// privileged IPC into whatever page loads. See docs/architecture/22-marshal-security-hardening.md.
export const VITE_DEV_SERVER_URL = getDevServerUrl(isPackaged, process.env["VITE_DEV_SERVER_URL"]);
export const MAIN_DIST = path.join(__dirname);
export const RENDERER_DIST = isPackaged
  ? path.join(process.resourcesPath, "app.asar", "dist")
  : path.join(__dirname, "..", "dist");

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(__dirname, "..", "public")
  : RENDERER_DIST;

// Process-wide lifecycle flags are declared early so exit interceptors can
// report whether an exit was intentional or abrupt.
let isQuitting = false;
let mainWindowBootReady = false;
let flushing = false;

installExitCallInterceptors();

function installExitCallInterceptors(): void {
  const originalAppQuit = app.quit.bind(app);
  app.quit = (() => {
    writeProcessLifecycleEventSync("app.quit.called", {
      appReady: app.isReady(),
      isQuitting,
      flushing,
      stack: stackPreview(),
    });
    return originalAppQuit();
  }) as typeof app.quit;

  const originalAppExit = app.exit.bind(app);
  app.exit = ((code?: number) => {
    writeProcessLifecycleEventSync("app.exit.called", {
      code,
      appReady: app.isReady(),
      isQuitting,
      flushing,
      stack: stackPreview(),
    });
    return originalAppExit(code);
  }) as typeof app.exit;

  const originalProcessExit = process.exit.bind(process);
  process.exit = ((code?: string | number | null) => {
    writeProcessLifecycleEventSync("process.exit.called", {
      code,
      isQuitting,
      flushing,
      stack: stackPreview(),
    });
    return originalProcessExit(code);
  }) as typeof process.exit;

  const originalProcessKill = process.kill.bind(process);
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === process.pid) {
      writeProcessLifecycleEventSync("process.kill.self.called", {
        signal,
        isQuitting,
        flushing,
        stack: stackPreview(),
      });
    }
    return originalProcessKill(pid, signal);
  }) as typeof process.kill;
}

// Catch unhandled errors to prevent crashes
// In Electron 40+ / Node 22+, these handlers must be registered early
// to prevent MCP stream errors (ERR_STREAM_DESTROYED) from killing the process
process.on("uncaughtException", (error) => {
  // Swallow stream errors from MCP servers — they recover on their own
  if (
    (error && (error as NodeJS.ErrnoException).code === "ERR_STREAM_DESTROYED") ||
    (error as NodeJS.ErrnoException).code === "EPIPE"
  ) {
    writeProcessLifecycleEventSync("process.uncaughtException.suppressed", {
      error: summarizeError(error),
    });
    log.warn("Suppressed stream error:", error.message);
    return;
  }
  writeProcessLifecycleEventSync("process.uncaughtException", {
    error: summarizeError(error),
  });
  sendErrorTelemetry(makeCrashError(crashErrors.UNCAUGHT_EXCEPTION));
  const safeError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  log.error("Uncaught exception:", safeError);

  // Write startup crash log so silent failures are diagnosable
  try {
    const logsDir = app.isReady()
      ? app.getPath("logs")
      : path.join(app.getPath("userData"), "logs");
    secureMkdirSync(logsDir, 0o700);
    const logPath = path.join(logsDir, "startup-crash.log");
    const entry = `[${new Date().toISOString()}] ${error instanceof Error ? error.stack : safeError}\n`;
    secureWriteFileSync(logPath, entry, { mode: 0o600 });
  } catch {
    // Best-effort — don't let logging failure compound the crash
  }
});
process.on("unhandledRejection", (error) => {
  // Swallow stream errors from MCP servers
  const errCode =
    error && typeof error === "object" && "code" in error
      ? (error as { code: unknown }).code
      : undefined; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrowing error code
  if (errCode === "ERR_STREAM_DESTROYED" || errCode === "EPIPE") {
    writeProcessLifecycleEventSync("process.unhandledRejection.suppressed", {
      error: summarizeError(error),
    });
    log.warn(
      "Suppressed stream rejection:",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  writeProcessLifecycleEventSync("process.unhandledRejection", {
    error: summarizeError(error),
  });
  sendErrorTelemetry(makeCrashError(crashErrors.UNHANDLED_REJECTION));
  const safeError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  log.error("Unhandled rejection:", safeError);
});

let win: BrowserWindow | null;

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function emitWindowMaximizedState() {
  if (!win || win.isDestroyed()) {
    return;
  }

  win.webContents.send("window-controls:maximized-changed", win.isMaximized());
}

function emitWindowFullScreenState() {
  if (!win || win.isDestroyed()) {
    return;
  }

  win.webContents.send("window-controls:fullscreen-changed", win.isFullScreen());
}

// --- Settings (must be before WORKSPACE_DIR so workspaceDir override is available) ---
writeProcessLifecycleEventSync("main.bootstrap.settings.start");
const settingsManager = new SettingsManager();
writeProcessLifecycleEventSync("main.bootstrap.settings.ready");
const relayProviderRegistry = new RelayProviderRegistry();
const relayProviderSettingsBindings: RelayProviderSettingsBinding[] = [];
const whatsappRelayAccountId = parseRelayAccountId(
  settingsManager.get().relay?.providers.whatsapp?.accountId ?? "primary",
);
const whatsappService = new WhatsAppService({
  databasePath: path.join(getAppDataDir(), "relay", "whatsapp-auth.db"),
  accountId: whatsappRelayAccountId,
  launch: app.isPackaged
    ? {
        mode: "packaged",
        resourcesPath: process.resourcesPath,
        platform: process.platform,
      }
    : {
        mode: "development",
        sidecarPath: path.join(app.getAppPath(), "dist-whatsapp-sidecar", "whatsapp-sidecar.mjs"),
        nodeExecutable: process.execPath,
      },
  loadKey: loadOrCreateKey,
  getSettings: () => settingsManager.get(),
  saveSettings: (settings) => settingsManager.save(settings),
  publishStatus: () => undefined,
});
const relayHostMedia = createDefaultRelayHostMediaAdapter({
  rootDir: path.join(getAppDataDir(), "relay", "media"),
});
const whatsappProviderComposition = createLiveWhatsAppProviderComposition({
  service: whatsappService,
  hostMedia: relayHostMedia,
  accountId: whatsappRelayAccountId,
});
const unregisterWhatsAppProvider = relayProviderRegistry.register(
  whatsappProviderComposition.provider,
  whatsappProviderComposition.account.accountId,
);
relayProviderSettingsBindings.push({
  providerKey: "whatsapp",
  account: whatsappProviderComposition.account,
  setupStatus: whatsappProviderComposition.setupStatus,
  pairingControl: whatsappProviderComposition.pairingControl,
  connectionControl: whatsappProviderComposition.connectionControl,
  resetAndRelink: (request) => whatsappProviderComposition.resetAndRelink(request),
  provision: (request) => whatsappProviderComposition.retryProvisioning(request),
});
const relayProviderSettingsService = createRelayProviderSettingsService({
  registry: relayProviderRegistry,
  getBindings: () => relayProviderSettingsBindings,
});
const relayDatabase = new RelayDatabase(path.join(getAppDataDir(), "relay", "relay.db"));
const relayCoordinator = new RelayExperienceCoordinator({
  registry: relayProviderRegistry,
  database: relayDatabase,
  getNotificationTargets: (kind) => {
    const settings = settingsManager.get();
    const relay = normalizeRelaySettings(settings.relay, {
      whatsappEnabled: settings.whatsapp?.enabled,
      whatsappDefaultNotificationsEnabled: settings.whatsapp?.defaultNotificationsEnabled,
      whatsappProgressNotificationsEnabled: settings.whatsapp?.progressNotificationsEnabled,
    });
    const configured =
      kind === "progress" ? relay.progressDestinations : relay.defaultNotificationDestinations;
    const targets: RelayNotificationTarget[] = [];
    if (configured.includes("whatsapp") && relay.providers.whatsapp?.enabled) {
      const managed = whatsappService.getManagedGroupIds();
      const conversationId =
        kind === "progress" ? managed?.fixed.progress : managed?.fixed["information-control"];
      if (conversationId) {
        targets.push({
          providerKey: "whatsapp",
          address: {
            ...whatsappProviderComposition.account,
            conversationId: parseRelayConversationId(conversationId),
          },
        });
      }
    }
    return targets;
  },
  getProgressIntervalMs: () => {
    const settings = settingsManager.get();
    return (
      normalizeRelaySettings(settings.relay, {
        whatsappEnabled: settings.whatsapp?.enabled,
        whatsappDefaultNotificationsEnabled: settings.whatsapp?.defaultNotificationsEnabled,
        whatsappProgressNotificationsEnabled: settings.whatsapp?.progressNotificationsEnabled,
      }).progressIntervalMinutes * 60_000
    );
  },
  isSessionOrDescendantBusy: (sessionId) => sessionManager.isSessionOrDescendantBusy(sessionId),
  requestProgressUpdate: async (request) => {
    const accessPoints = request.context.accessPoints
      .map(
        (accessPoint) =>
          `${accessPoint.bindingId} (${accessPoint.address.providerId}/${accessPoint.address.accountId})`,
      )
      .join(", ");
    const result = await sessionManager.requestRelayProgressUpdate({
      sessionId: request.sessionId,
      idempotencyKey: request.idempotencyKey,
      message: [
        '<marshal-control kind="relay-progress">',
        `Active relay access points: ${accessPoints}.`,
        "This session or one of its descendants is still working.",
        "Decide whether there is a useful progress update for the listening user.",
        "If useful, publish it with publishRelayMessage. If nothing meaningful changed, do not publish empty heartbeat spam.",
        "</marshal-control>",
      ].join("\n"),
    });
    return result.accepted === true;
  },
});
relayCoordinator.tombstoneBindingsOutsideAccount(
  whatsappProviderComposition.account.providerId,
  whatsappProviderComposition.account.accountId,
);
writeProcessLifecycleEventSync("main.bootstrap.relay.ready");
const workServiceProviderSelection = normalizeWorkServiceProviderSettings(settingsManager.get());
let runtimeStartupSelection = resolveRuntimeStartupSelection(settingsManager.get(), {
  mockMode: isMockMode(),
  gatewayE2E: process.env.MARSHAL_GATEWAY_E2E === "1",
});
// Best-effort preload seed before async beta metadata and restored tenant state are available.
// The app-mode controller applies the final effective mode once those inputs resolve.
process.env.MARSHAL_APP_MODE = isDevMode() ? "dev" : "release";

// Workspace directory for the agent — prefers OS Documents so files are
// user-accessible, falls back to app data if Documents is inaccessible
// (macOS TCC denial, locked cloud-sync folder). Overridable via workspaceDir setting.
const configuredWorkspaceDir = settingsManager.get().workspaceDir;
writeProcessLifecycleEventSync("main.bootstrap.workspace.start", {
  hasAbsoluteOverride: !!configuredWorkspaceDir && path.isAbsolute(configuredWorkspaceDir),
});
const workspaceResolution = resolveWorkspaceDir(
  configuredWorkspaceDir && path.isAbsolute(configuredWorkspaceDir)
    ? null
    : getDocumentsPathOrNull(),
  configuredWorkspaceDir,
);
const WORKSPACE_DIR = workspaceResolution.dir;
writeProcessLifecycleEventSync("main.bootstrap.workspace.ready", {
  usedFallback: workspaceResolution.usedFallback,
});

// Migrate skills from the old app-bundle workspace to persistent ~/.marshal/marshal-skills/.
// Must use the original old path, not the new WORKSPACE_DIR.
migrateSkillsIfNeeded(path.join(process.env.APP_ROOT, "workspace"));
repairLocalSkillFiles();

// Session manager — injected with a backend provider.
// In mock mode, the factory returns a MockCopilotClient so the backend's session
// creation runs its full real code path (hooks, permissions) with scripted responses.
// mcpStore.reload() + migrate/prune/discover are deferred to the app.whenReady()
// block below: they decrypt persisted OAuth tokens via safeStorage, and the first
// safeStorage access before app.whenReady() locks the macOS keychain item name to
// "Chromium Safe Storage" (Electron #45328). The constructor seeds builtins only.
const mcpStore = new McpStore();

const gatewayDeviceIdentityPath =
  runtimeStartupSelection.runtimeId === GATEWAY_RUNTIME_ID
    ? resolveDeviceIdentityPath(app.getPath("home"))
    : undefined;
const gatewayHostedRuntime = resolveHostedRuntimeProvider();
const gatewayBackendConfig = gatewayDeviceIdentityPath
  ? buildGatewayBackendConfig({
      deviceIdentityPath: gatewayDeviceIdentityPath,
      hostedRuntime: gatewayHostedRuntime,
    })
  : undefined;
const gatewayNodeDeps = gatewayBackendConfig
  ? {
      config: gatewayBackendConfig,
      mcpStore,
      acquireGatewayToken: () => gatewayHostedRuntime.acquireAuthToken(),
    }
  : undefined;

function createRuntimeAdapterContext(mockMode: boolean) {
  return {
    workspaceDir: WORKSPACE_DIR,
    mockMode,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    gatewayE2E: process.env.MARSHAL_GATEWAY_E2E === "1",
    ...(gatewayDeviceIdentityPath ? { gatewayDeviceIdentityPath } : {}),
    ...(gatewayNodeDeps ? { gatewayNodeDeps } : {}),
  };
}

writeProcessLifecycleEventSync("main.bootstrap.backend.start", {
  runtimeId: runtimeStartupSelection.runtimeId,
});
let backend = createBackend({
  runtimeId: runtimeStartupSelection.runtimeId,
  ...createRuntimeAdapterContext(isMockMode()),
});
writeProcessLifecycleEventSync("main.bootstrap.backend.ready", {
  runtimeId: backend.runtimeId,
});
log.info(
  `Using runtime adapter "${backend.runtimeId}" (requested="${runtimeStartupSelection.requestedRuntimeId}")`,
);

const initialSettings = settingsManager.get();
writeProcessLifecycleEventSync("main.bootstrap.session-storage.start");
const sessionStorageProvider = createSessionStorageProvider({
  providerId: initialSettings.sessionStorageProviderId,
  mockMode: isMockMode(),
});
const sessionManager = new SessionManager(WORKSPACE_DIR, backend, sessionStorageProvider.store, {
  skillProviderIds: initialSettings.skillProviderIds,
});
writeProcessLifecycleEventSync("main.bootstrap.sessions.ready");
sessionManager.setRelaySessionContextProvider((sessionId) =>
  relayCoordinator.getSessionReminder(sessionId),
);
sessionManager.setRelaySessionActivityCallback((sessionId, occurredAtMs) =>
  relayCoordinator.noteSessionActivity(sessionId, occurredAtMs),
);
log.info(
  `Using session storage provider "${sessionStorageProvider.id}" (requested="${sessionStorageProvider.requestedId}")`,
);
const commandCenterManager = new CommandCenterManager();
sessionManager.setCommandCenterObserver(commandCenterManager);

// Memory store — cross-session persistent memory
const memoryProvider = createMemoryProvider({
  providerId: initialSettings.memoryProviderId,
  mockMode: isMockMode(),
});
const memoryManager = memoryProvider.store;
log.info(
  `Using memory provider "${memoryProvider.id}" (requested="${memoryProvider.requestedId}")`,
);

// Heartbeat manager — cross-platform in-app timer
const heartbeatManager = new HeartbeatManager();
heartbeatManager.setSessionManager(sessionManager);
heartbeatManager.setRelayPublisher(relayCoordinator.notifications);

// Automation manager — scheduled multi-step automations
const automationManager = new AutomationManager();
automationManager.setSessionManager(sessionManager);
automationManager.setRelayPublisher(relayCoordinator.notifications);

function buildGoalContinuationPrompt(context: GoalContinuationContext): string {
  const compacted = fitGoalPayload(context, GOAL_CONTEXT_CHAR_BUDGET, 2);
  return [
    "Continue pursuing the Marshal goal attached to THIS conversation.",
    "You are the same primary agent and sole orchestrator; do not hand ownership to another session or agent.",
    "The durable Marshal goal projection below is authoritative. Use its objective, criteria, progress, decisions, and state to choose and execute the next concrete work.",
    "You may launch and monitor Marshal swarms when the objective calls for them, but you remain responsible for planning, reconciliation, validation, and the final result.",
    "If the objective says to pause on swarm malfunction, pause the Marshal goal and report the problem instead of wasting tokens.",
    "Do real work now. Keep the durable goal context updated through Marshal's goal tools and only propose completion when the full objective is validated.",
    'If the payload below carries a "truncated" marker, the omitted entries still exist in the durable record — recover the full goal with goalGet before broad completion judgments. Empty or shortened lists below do not mean none exist.',
    "",
    compacted,
  ].join("\n");
}

const goalSessionIds = new Map<string, string>();
let revalidateDeferredGoalMessages = (_goalId: string) => {};

function indexLoadedGoalSession(sessionId: string): string | undefined {
  for (const [goalId, ownerSessionId] of goalSessionIds) {
    if (ownerSessionId === sessionId) goalSessionIds.delete(goalId);
  }
  const goal = goalManager.getGoal(sessionId);
  if (goal) goalSessionIds.set(goal.id, sessionId);
  return goal?.id;
}

// Goal manager + engine — per-conversation autonomous goal pursuit. Persistence
// shares the SessionManager's session store; continuation control prompts stay
// hidden while their structured lifecycle metadata renders in the chat timeline.
const goalManager = new GoalManager({
  store: sessionManager.getSessionStore(),
  emit: (sessionId, goal) => {
    for (const [goalId, ownerSessionId] of goalSessionIds) {
      if (ownerSessionId === sessionId && goalId !== goal?.id) goalSessionIds.delete(goalId);
    }
    if (goal?.status === "pursuing") sessionManager.resumeAfterUserStop(sessionId);
    if (!goal) return;
    goalSessionIds.set(goal.id, sessionId);
    revalidateDeferredGoalMessages(goal.id);
    win?.webContents.send("goal:changed", {
      sessionId,
      snapshot: goalManager.getRuntimeSnapshot(sessionId),
    });
  },
  seedSessionTitle: (sessionId, title) => {
    void sessionManager
      .renameSession(sessionId, title, title)
      .catch((err) => log.with({ sessionId }).error("Failed to seed goal session title:", err));
  },
  emitTimelineMessage: (sessionId, message) =>
    sessionManager.emitPersistedMessage(sessionId, message),
});
const agentMessageOutbox: AgentMessageOutbox = new AgentMessageOutbox({
  persistence: new EncryptedAgentMessageOutboxPersistence(),
  goalFenceValidator: {
    validate: (fence) => {
      const ownerSessionId = goalSessionIds.get(fence.goalId);
      if (!ownerSessionId) return { status: "unknown", reason: "Goal owner is not loaded" };
      return goalManager.isFenceCurrent(ownerSessionId, fence)
        ? { status: "current" }
        : { status: "stale", reason: "Goal fence is no longer current" };
    },
  },
  canDeliver: (message) => sessionManager.canDeliverAgentMessage(message),
  deliver: (message, context) =>
    message.kind === "selected-session"
      ? selectedSessionDelivery.deliver(message, context)
      : sessionManager.deliverAgentMessage(message, context),
});
revalidateDeferredGoalMessages = (goalId) => {
  void agentMessageOutbox
    .revalidateDeferredGoalMessages(goalId)
    .catch((error) => log.child("AgentMessageOutbox").warn("Goal revalidation failed:", error));
};
sessionManager.addHydrationListener((event) => {
  if (event.state !== "loaded") return;
  const goalId = indexLoadedGoalSession(event.sessionId);
  if (goalId) revalidateDeferredGoalMessages(goalId);
});
// lifecycle.start() called inside app.whenReady() — safeStorage is not
// available before app.ready, so the queue reads empty on Windows otherwise.
const externalOperationRegistry = createDurableExternalOperationRegistry({
  store: createExternalOperationStore(createEncryptedExternalOperationPersistence()),
});
const backgroundToolInvocationManager = new BackgroundToolInvocationRegistryAdapter({
  registry: externalOperationRegistry,
  resolveGoalFence: (request) => {
    const fence = goalManager.captureFence(request.ownerSessionId);
    return (
      fence ?? {
        goalId: `session:${request.ownerSessionId}`,
        epoch: 1,
      }
    );
  },
});
sessionManager.setExternalOperationAdapter({
  listRunningTools: () => backgroundToolInvocationManager.listRunningTools(),
  claimBackgroundToolDispatch: (request) =>
    backgroundToolInvocationManager.claimBackgroundToolDispatch(request),
  beginBackgroundToolInvocation: (args) =>
    backgroundToolInvocationManager.beginBackgroundToolInvocation(args),
  attachBackgroundToolProcess: (handle, process) =>
    backgroundToolInvocationManager.attachBackgroundToolProcess(handle, process),
  detachBackgroundToolInvocation: (handle) =>
    backgroundToolInvocationManager.detachBackgroundToolInvocation(handle),
  completeBackgroundToolInvocation: (handle, completion) =>
    backgroundToolInvocationManager.completeBackgroundToolInvocation(handle, completion),
  inspectRunningTool: (handle) => backgroundToolInvocationManager.inspectRunningTool(handle),
  requestBackgroundToolCancellation: (request) =>
    backgroundToolInvocationManager.requestBackgroundToolCancellation(request),
});
const goalEngine = new GoalEngine({
  goalManager,
  onPursuitStopped: (sessionId) => sessionManager.rearmParentReadinessWake(sessionId),
  sendContinuation: (sessionId, prompt, onEvent, timelineEvent) => {
    const source = sessionManager.getSessionStore().loadSessionData(sessionId);
    const agentSource =
      source?.source === "subagent"
        ? ("subagent" as const)
        : source?.source === "workflow-agent"
          ? ("workflow-agent" as const)
          : ("assistant" as const);
    const agentSourceLabel =
      source?.repositoryAgent?.name ??
      (agentSource === "assistant" ? "Primary agent" : source?.name);
    const continuationEvent = timelineEvent.type === "goal.continuation" ? timelineEvent : null;
    if (!continuationEvent) throw new Error("Goal continuation event is required");
    const attributedTimelineEvent = {
      ...continuationEvent,
      agent: {
        ...continuationEvent.agent,
        source: agentSource,
        ...(agentSourceLabel ? { sourceLabel: agentSourceLabel } : {}),
      },
    };
    const exchangeId = [
      "goal-continuation",
      timelineEvent.fence.goalId,
      timelineEvent.fence.epoch,
      continuationEvent.sequence,
    ].join(":");
    return sessionManager.sendAndCollect(
      prompt,
      CONTINUATION_TIMEOUT_MS,
      onEvent,
      sessionId,
      undefined,
      {
        goalContinuation: true,
        internalControl: {
          kind: "goal-continuation",
          exchangeId,
          side: "request",
        },
        goalTimelineEvent: attributedTimelineEvent,
        clientMessageId: exchangeId,
      },
    );
  },
  // Composed with the goal-loop subagent yield: besides the parent's own
  // in-flight turn, also yield while it has in-flight, just-spawned, or
  // just-idled subagents so the autonomous loop rests on its children (the
  // batched readiness scheduler signals this engine) instead of racing ahead with a
  // continuation in the <=500ms debounce after a fire-and-forget spawn. The
  // shared isSessionBusy is intentionally NOT widened (other callers rely on
  // its own-turn-only semantics).
  isBusy: (sessionId) =>
    sessionManager.isSessionBusy(sessionId) ||
    sessionManager.goalShouldYieldForSubagents(sessionId),
  isControllerOwned: (sessionId) => sessionManager.isRuntimeTaskControllerActive(sessionId),
  getRunIdentity: (sessionId) =>
    sessionManager.getSessionStore().loadSessionData(sessionId)?.runtimeDelegationId,
  isDispatchReady: (sessionId) => sessionManager.isGoalDispatchReady(sessionId),
  composeContinuation: async (context) => buildGoalContinuationPrompt(context),
  getConversationContext: (sessionId) => {
    const sessionData = sessionManager.getSessionStore().loadSessionData(sessionId);
    if (!sessionData) return "";
    return buildGoalConversationContext(sessionData);
  },
  reviewTransition: createTransitionReviewer({
    createReviewerSession: async (sourceSessionId) => {
      const source = sessionManager.getSessionStore().loadSessionData(sourceSessionId);
      const reviewer = await sessionManager.createSession(undefined, undefined, {
        name: "Goal transition reviewer",
        source: "subagent",
        parentSessionId: sourceSessionId,
        suppressParentReadinessWake: true,
        setActive: false,
        // "planner" is the tool-free role; the reviewer needs its read tools.
        runtimeAgentRole: "reviewer",
        workspaceName: source?.workspaceName,
        repoPath: source?.repoPath,
        permissionMode: REVIEWER_SESSION_PERMISSION_MODE,
        skills: [],
        mcp: [],
      });
      // Fail-closed tool scope, enforced by ReviewerToolPolicy for exactly the
      // reviewer session's lifetime: reads approved under the goal repo's
      // folder grant, the allowlisted read-only self-tools approved,
      // write/shell/network/mcp denied. Released on dispose below.
      sessionManager.registerReviewerSessionScope(reviewer.id, {
        ...REVIEWER_SESSION_CAPABILITIES,
        role: "reviewer",
        workspaceName: source?.workspaceName,
        repoPath: source?.repoPath,
        allowedTools: [...REVIEWER_ALLOWED_CUSTOM_TOOLS],
        folderGrants: { read: source?.repoPath ? [source.repoPath] : [], write: [] },
        skills: [],
        mcp: [],
        verificationRoot: source?.repoPath ?? "",
      });
      return reviewer.id;
    },
    runPrompt: (reviewerSessionId, prompt, timeoutMs) =>
      sessionManager.sendAndCollect(prompt, timeoutMs, undefined, reviewerSessionId),
    disposeSession: (reviewerSessionId) =>
      sessionManager
        .deleteSession(reviewerSessionId, { suppressChangeEvent: true, cause: "condition-check" })
        .then(() => sessionManager.releaseReviewerSessionScope(reviewerSessionId)),
  }),
  deliverCompletion: async ({ sessionId, fence, message }) => {
    await agentMessageOutbox.enqueue({
      source: `goal:${fence.goalId}`,
      target: sessionId,
      kind: "goal-terminal",
      deliveryMode: "queue",
      priority: 50,
      content: message,
      goalFence: fence,
      goalId: fence.goalId,
      goalDeliveryKind: "terminal",
      goalTerminalKind: "completed",
      goalDeliverySequence: fence.epoch,
    });
  },
  cancelActiveTurn: (sessionId) => sessionManager.cancelTurn(sessionId),
});
sessionManager.setGoalIntegration(goalManager, goalEngine);

function configureBackendManagers(target: IBackendProvider): void {
  target.setHeartbeatManager(heartbeatManager);
  target.setAutomationManager(automationManager);
  target.setSettingsManager(settingsManager);
  target.setRunActivitySubscriber((listener) => sessionManager.addEventListener(() => listener()));
  target.setOnAutomationsChangedBroadcaster(() => {
    win?.webContents.send("automations:changed");
  });
}

configureBackendManagers(backend);
if (process.env.MARSHAL_CLOUD_PUBLIC_URL && process.env.MARSHAL_CLOUD_TOKEN_FILE) {
  sessionManager.setAdditionalModelSources([
    async () => {
      const client = await createCloudClientFactory()(WORKSPACE_DIR);
      try {
        return (await client.listModels()).map((model) => ({
          id: `marshal-cloud:${model.id}`,
          name: model.name ?? model.id,
          capabilities: { supportsVision: false },
          runtime: { runtimeId: "marshal-cloud", label: "Marshal Cloud" },
        }));
      } finally {
        await client.stop();
      }
    },
  ]);
}
automationManager.setSessionCreatedCallback((sessionId: string) => {
  // Tell renderer to switch to the automation run session
  win?.webContents.send("sessions:switch-to", sessionId);
});

// Power manager — prevent system sleep during active sessions
const powerManager = new PowerManager();

// Keep-awake — prevents Windows VM hibernation via periodic SendInput
const keepAwake = new KeepAwakeManager();

// System tray — background process indicator and window toggle
const trayManager = new TrayManager();

// Background service — controls minimize-to-tray and startup registration
const backgroundService = new BackgroundServiceManager();

// --- Settings (continued) ---

const miniModeManager = new MiniModeManager({
  publicDir: process.env.VITE_PUBLIC,
  getPreloadPath: () => resolveLooseFilePath("mini-mode-preload.cjs"),
  getPagePath: () => resolveLooseFilePath("mini-mode-page/index.html"),
});
const mainEventLoopDelayMonitor = startMainEventLoopDelayMonitor(undefined, undefined, (sample) => {
  if (sample.maxMs >= 1_000) performanceFlightRecorder.captureMain("main-event-loop-stall");
});
const rendererResponsivenessMonitor = new RendererResponsivenessMonitor({
  getWindowState: (webContentsId) => {
    const target = BrowserWindow.getAllWindows().find(
      (candidate) =>
        !candidate.isDestroyed() &&
        !candidate.webContents.isDestroyed() &&
        candidate.webContents.id === webContentsId,
    );
    if (!target) return null;
    return {
      visible: target.isVisible(),
      minimized: target.isMinimized(),
      focused: target.isFocused(),
      rendererPid: target.webContents.getOSProcessId(),
    };
  },
  getEventLoopDelay: () => mainEventLoopDelayMonitor.getSnapshot(),
  onStall: (snapshot) => {
    performanceFlightRecorder.captureMain("renderer-visible-frame-stall");
    performanceFlightRecorder.captureRenderer(
      snapshot.webContentsId,
      "renderer-visible-frame-stall",
    );
  },
});
rendererResponsivenessMonitor.start();
const chatWindowManager = new ChatWindowManager({
  preloadPath: resolveLooseFilePath("preload.cjs"),
  devServerUrl: VITE_DEV_SERVER_URL,
  rendererDist: RENDERER_DIST,
  getMainWindow: () => win,
  applyWindowBranding: (target) => {
    const mode = getEffectiveAppMode();
    applyWindowTitle(mode, target);
    applyWindowIconBadge(mode, target, process.env.VITE_PUBLIC);
  },
  applyWindowTitle: (target) => applyWindowTitle(getEffectiveAppMode(), target),
});
sessionManager.setModelsChangedListener(() => chatWindowManager.broadcast("models:changed"));
const sessionViewIpcBroker = new SessionViewIpcBroker(
  () => [...chatWindowManager.getRendererTargets(), ...remoteTargets()],
  (sessionId) => sessionManager.getSessionView(sessionId).view,
);
const remoteAccessController = createRemoteAccessController({
  userData: app.getPath("userData"),
  rendererDir: RENDERER_DIST,
  broker: sessionViewIpcBroker,
  mediaRoots: () => [
    WORKSPACE_DIR,
    ...listRegisteredWorkspaces(WORKSPACE_DIR).map((workspace) => workspace.path),
    path.join(app.getPath("temp"), "copilot-images"),
  ],
  getSession: async (sessionId) =>
    (await sessionManager.listSessions()).find((candidate) => candidate.id === sessionId) ?? null,
});
ipcHandle("remote-access:setupTailscale", async () =>
  remoteAccessController.configure({ enabled: true, origin: await configureTailscale() }),
);
ipcHandle("remote-access:getState", () => remoteAccessController.getState());
ipcHandle("remote-access:configure", (_event, input) => remoteAccessController.configure(input));
chatWindowManager.setRendererClosedHandler((webContentsId) => {
  sessionViewIpcBroker.removeTarget(webContentsId);
  rendererResponsivenessMonitor.remove(webContentsId);
});

const appModeController = createAppModeController({
  getBaseMode: () => getAppMode(app.getVersion(), []),
  setPreloadMode: (mode) => {
    process.env.MARSHAL_APP_MODE = mode;
  },
  applyNativeBranding: (mode) => {
    if (win) {
      applyAppBadge(mode, win, trayManager, process.env.VITE_PUBLIC);
    }
  },
  applyPopoutBranding: () => chatWindowManager.applyWindowBrandingToPopouts(),
  broadcastRendererMode: (mode) => chatWindowManager.broadcast("app:modeChanged", mode),
});

function getEffectiveAppMode(): AppMode {
  return appModeController.getEffectiveAppMode();
}

function applyEffectiveAppMode(): void {
  appModeController.applyEffectiveAppMode();
}
const notificationRouter = new NotificationRouter(
  () => win,
  miniModeManager,
  settingsManager,
  trayManager,
);
const mainWindowController = new MainWindowController({
  backgroundService,
  isQuitting: () => isQuitting,
  miniModeManager,
  settingsManager,
});
const showHideShortcutController = new ShowHideShortcutController({
  getWindow: () => win,
  onHideRequested: () => {
    mainWindowController.hideToTray();
  },
  onShowRequested: () => {
    mainWindowController.allowShow("shortcut");
    trayManager.showWindow();
  },
  settingsManager,
});

const broadcastWorkspaceRegistryChanged = () =>
  chatWindowManager.broadcast("workspace:registry-changed");

function getRelaySessionForNotification(sessionId?: string) {
  if (!sessionId) return null;
  return sessionManager.getSession(sessionId) ?? { id: sessionId };
}

function formatRelayNotificationMessage(text: string, sessionId?: string): string {
  const relaySession = getRelaySessionForNotification(sessionId);
  return formatRelaySessionMessage(
    text,
    relaySession,
    relaySession?.id ? { routeId: getRelayRouteAlias(relaySession) } : undefined,
  );
}

const RELAY_IDLE_NOTIFICATION_COOLDOWN_MS = 5 * 60 * 1000;
const relayIdleNotifications = new Map<string, { key: string; sentAt: number }>();

function shouldSendRelayIdleNotification(sessionId: string): boolean {
  const sessionData = sessionManager.getSession(sessionId);
  if (!sessionData) return false;
  const key = `${sessionData.updatedAt}:${sessionData.messages.length}`;
  const previous = relayIdleNotifications.get(sessionId);
  const now = Date.now();
  if (previous?.key === key && now - previous.sentAt < RELAY_IDLE_NOTIFICATION_COOLDOWN_MS) {
    return false;
  }
  relayIdleNotifications.set(sessionId, { key, sentAt: now });
  return true;
}

// --- IPC Handler Registration ---
// identityController is referenced by several handler groups.
// Construct it before ipcDeps so it can ride along in the shared deps object;
// its callbacks are lazy closures that pick up `authMachinery` after it's
// assigned below (one polymorphic call, copilot's no-op returns null state).
let authMachinery: AuthMachineryHandle | null = null;
const identityController = createIdentityController(
  {
    getRuntimeId: () => backend.runtimeId,
    getGatewayAuthState: () => authMachinery?.getState() ?? null,
    getRuntimeAuthStatus: async () => {
      try {
        const status = await sessionManager.checkAuthStatus();
        return { isAuthenticated: status.isAuthenticated, login: status.login };
      } catch {
        return { isAuthenticated: false };
      }
    },
    getGitHubAvatar: async (login) => {
      try {
        return await fetchGitHubAvatar(login);
      } catch {
        return null;
      }
    },
    getRelayStatus: () => ({
      connected: relayCoordinator.notifications.hasDestinations("default"),
      displaced: false,
    }),
    getRelayAvailable: () => relayProviderSettingsBindings.length > 0,
  },
  (identity) => win?.webContents.send("identity:change", identity),
);
// Audit logger — persistent JSONL log of all permission and OAuth decisions (TC4/TC7 compliance)
const auditLogger = new AuditLogger({
  logDir: path.join(getAppDataDir(), "marshal-audit-logs"),
  enabled: !isMockMode(),
});
const ipcDeps: IpcDeps = {
  getWindow: () => win,
  sessionManager,
  memoryManager,
  heartbeatManager,
  automationManager,
  powerManager,
  backgroundService,
  showHideShortcutController,
  settingsManager,
  getRuntimeSelection: () => runtimeStartupSelection,
  switchRuntime: (runtimeId) => switchRuntimeAdapter(runtimeId),
  mcpStore,
  identityController,
  auditLogger,
  resolveThemeBg,
  ipcHandle,
};

const tenantPolicyProvider = new TenantPolicyProvider(getAppDataDir());
tenantPolicyProvider.startRefreshTimer();

tenantPolicyProvider.on("policyChanged", () => {
  win?.webContents.send("tenant:policyChanged");
});

const permissionPolicy = new PermissionPolicy({
  settingsManager,
  getPermissionMode: (sessionId: string) =>
    settingsManager.get().permissions?.autopilotMode === true
      ? "allow-all"
      : sessionManager.getPermissionMode(sessionId),
  getWorkspaceRootForSession: (sessionId: string) =>
    sessionManager.getWorkspaceRootForSession(sessionId),
  hasWorkspaceScopeForSession: (sessionId: string) =>
    sessionManager.hasWorkspaceScopeForSession(sessionId),
  // Goal-transition reviewer sessions register a fail-closed scope for their
  // lifetime; resolving it here activates ReviewerToolPolicy for them.
  getReviewerSessionPermissionScope: (sessionId: string) =>
    sessionManager.getReviewerSessionPermissionScope(sessionId),
  tenantPolicy: tenantPolicyProvider,
  // Per-session MCP scoping (R1-FIXES A13) needs to know the full MCP
  // universe to discriminate MCP tool calls from non-MCP self-tools or
  // shell commands. Built-in keys are statically known; custom
  // server keys come from `mcpStatus.getCustomMcpServers()` and are
  // normalized via `toMcpServerKey` to match the prefix that the SDK uses
  // on tool names.
  getKnownMcpKeys: () => [
    ...MCP_SERVER_CONFIG_KEYS,
    ...sessionManager.mcpStatus.getCustomMcpServers().map((s) => toMcpServerKey(s.name)),
  ],
  workspaceDir: WORKSPACE_DIR,
  getResourceFolderRoots: getFsResourceRoots,
});
let whatsappFixedAgentRuntime: WhatsAppFixedAgentRuntime | undefined;
let unregisterWhatsAppRuntime: (() => void) | undefined;

// Sync the active session's MCP config with the on-disk value at startup;
// the settings:changed listener below keeps it in sync afterwards.
sessionManager.setInterceptFileChooser(settingsManager.get().interceptFileChooser ?? false);

const hasRelayAttentionNotifications = () =>
  relayCoordinator.notifications.hasDestinations("default");

sessionManager.setRelayAttentionNotificationsProvider(hasRelayAttentionNotifications);

auditLogger.pruneOldLogs(30);
permissionPolicy.setAuditLogger(auditLogger);
sessionManager.setPermissionPolicy(permissionPolicy);
sessionManager.setTenantPolicyProvider(tenantPolicyProvider);

heartbeatManager.setPermissionPolicy(permissionPolicy);
heartbeatManager.setTenantPolicyProvider(tenantPolicyProvider);
heartbeatManager.setPowerManager(powerManager);
heartbeatManager.setKeepAwake(keepAwake);
heartbeatManager.setMouseWiggleEnabledProvider(
  () => settingsManager.get().mouseWiggleEnabled !== false,
);
heartbeatManager.setPreventSleepEnabledProvider(
  () => settingsManager.get().preventSleepEnabled !== false,
);

automationManager.setPermissionPolicy(permissionPolicy);
automationManager.setTenantPolicyProvider(tenantPolicyProvider);
// Log blocked tool calls when heartbeat runs with deny-prompt
permissionPolicy.onDenyPrompt((sessionId, kind, detail) => {
  if (heartbeatManager.isHeartbeatSession(sessionId)) {
    heartbeatManager.addLog("error", `Tool blocked (deny-prompt): ${kind} — ${detail}`);
  }
});
const approvalBroker = new ApprovalBroker();
// Set when registerCopilotHandlers wires the backend's approval router; called
// from before-quit so a stale adapter cannot fire after shutdown / sign-out.
let detachApprovalRouter: (() => void) | null = null;
const permissionCardManager = new PermissionCardManager({
  getWindow: () => win,
  sessionManager,
  workspaceDir: WORKSPACE_DIR,
  onCardsChanged: (payload) => {
    broadcastRemote("permissions:cards-changed", payload);
    remoteAccessController.observeCards(payload.sessionId, payload.cards);
  },
});
const relayHostInteractionBridge = new RelayHostInteractionBridge(relayCoordinator, sessionManager);
relayHostInteractionBridge.start();
permissionCardManager.connectBroker(approvalBroker);
permissionCardManager.connectPolicy(permissionPolicy);
permissionCardManager.start();
const getWorkServiceToolAvailability = () => ({
  notificationsAvailable: workServices.notifications?.isAvailable() === true,
});
registerPermissionsHandlers({
  ipcHandle,
  sessionManager,
  permissionCardManager,
  mcpStore,
  auditLogger,
  settingsManager,
  workServiceProviderSelection,
  getWorkServiceToolAvailability,
});

// Wire DesktopCapabilities (gateway-only). Rule-5 exemption: the composition
// root may downcast to a concrete backend to wire backend-specific machinery.
// PermissionPolicy is constructed above; pass it in so the gateway can build
// the desktop.* RPC bridge in init() (it drives executeShell's defense-in-depth
// re-check). When the backend is CopilotBackend this whole branch is skipped —
// Copilot doesn't implement DesktopCapabilities (its SDK pre-hook owns the
// same surface in-process).
//
// Polymorphic via IToolBackend.attachDesktopCapabilities — copilot is a
// no-op (its SDK pre-hook owns the same surface in-process); gateway
// constructs the desktop.* RPC bridge lazily on the next init().
//
// `onSessionOpenRequested` will be wired here once the renderer's
// active-session switch IPC contract exists. While the `notifications`
// capability flag stays `false`, the cloud never sends a `showNotification`
// with `onClickAction`, so absent click handler is equivalent to "click is
// silently ignored" — the intended behavior.
let detachDesktopCapabilities: (() => void) | null = null;
function attachDesktopCapabilities(target: IBackendProvider): void {
  detachDesktopCapabilities?.();
  detachDesktopCapabilities = target.tools.attachDesktopCapabilities({
    policy: permissionPolicy,
    toolInvocationManager: backgroundToolInvocationManager,
  });
}
attachDesktopCapabilities(backend);
// Per-session cleanup chain shared by every delete path.
const clearPerSessionRuntimeState = (sessionId: string) => {
  powerManager.markIdle(sessionId);
  permissionPolicy.clearSession(sessionId);
  miniModeManager.clearSession(sessionId);
  permissionCardManager.clearSession(sessionId);
};

const relayDeleteRetirements = new Map<
  string,
  ReturnType<typeof relayCoordinator.tombstoneSessionAccessPoints>
>();
sessionManager.registerBeforeDeleteHook(({ sessionId }) => {
  if (!relayDeleteRetirements.has(sessionId)) {
    relayDeleteRetirements.set(sessionId, relayCoordinator.tombstoneSessionAccessPoints(sessionId));
  }
});
sessionManager.registerDeleteHook(({ sessionId }) => {
  clearPerSessionRuntimeState(sessionId);
  const retirements = relayDeleteRetirements.get(sessionId) ?? [];
  relayDeleteRetirements.delete(sessionId);
  void relayCoordinator.resumeRetirements(retirements).catch((error: unknown) => {
    log
      .with({ sessionId })
      .warn("Relay access-point retirement after session deletion failed:", error);
  });
});

registerSessionsHandlers({
  ...ipcDeps,
  permissionPolicy,
  sessionViewIpcBroker,
});

const workServices = createBuiltInWorkServiceProviders(workServiceProviderSelection, {
  notifications: {
    relay: {
      get processing() {
        return false;
      },
      get displaced() {
        return false;
      },
      isConnected: () => whatsappService.getStatus().connection === "connected",
      connect: () => whatsappService.connect(),
      disconnect: () => {
        void whatsappService.disconnect();
      },
    },
    isAvailable: () => relayCoordinator.notifications.hasDestinations("default"),
    send: (text: string, sessionId?: string) =>
      relayCoordinator.notifications.publish(
        "default",
        formatRelayNotificationMessage(text, sessionId),
        sessionId,
      ),
  },
});
buildStaticCategories(workServiceProviderSelection, getWorkServiceToolAvailability());

let runtimeSelfTools: readonly RuntimeTool[] = [];
const desktopRuntimeWakes = createDesktopRuntimeWakes({
  userDataDirectory: getAppDataDir(),
  wakePort: createSessionWakePort({ sessionManager, permissionPolicy }),
});
let selfToolExtensionsChangedRevision = 0;
const selfToolDeps = {
  additionalTools: (sessionId: string | undefined) =>
    sessionId ? bindRuntimeSelfToolsToSession(runtimeSelfTools, sessionId) : runtimeSelfTools,
  heartbeatManager,
  automationManager,
  runtimeOneOffWakes: desktopRuntimeWakes,
  memoryManager,
  settingsManager,
  goalManager: sessionManager,
  broadcastWorkspaceRegistryChanged,
  codeLinkedMemoryAvailable: () => hasCodeIntelligence(extensionPromptSnapshot),
  skillsManager: {
    list: (options?: { sessionId?: string }) =>
      sessionManager.listSkillsForSession(options?.sessionId),
    add: addSkill,
    update: updateSkill,
    delete: deleteSkill,
    getInstructions: (name, _preloaded, options) =>
      sessionManager.getSkillInstructionsForSession(name, options?.sessionId),
  },
  workServices,
  relay: {
    publishSessionMessage: (input) => {
      const origin = sessionManager.getActiveRelayPublicationOrigin(input.sessionId);
      if (!origin) return relayCoordinator.publishFromSession(input);
      const bindingId = relayCoordinator.getSessionAccessPointBindingId(input.sessionId, origin);
      if (!bindingId) {
        throw new Error("The originating relay access point is no longer active");
      }
      if (
        input.accessPointIds &&
        (input.accessPointIds.length !== 1 || input.accessPointIds[0] !== bindingId)
      ) {
        throw new Error("Relay replies must stay on the access point that originated this turn");
      }
      return relayCoordinator.publishFromSession({
        ...input,
        accessPointIds: [bindingId],
      });
    },
  },
  commandCenter: {
    upsertSessionTodo: async (todo) => {
      await commandCenterManager.upsertTodo(todo);
    },
    replaceSessionGoalTodos: async (input) => {
      const result = await commandCenterManager.replaceSessionGoalTodos(input);
      return { goalId: result.goalId, goalLabel: result.goalLabel };
    },
  },
  confirmPermissionsEscalation: async (sessionId, diff) => {
    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const settingsDiff: Record<string, unknown> | undefined = isPlainRecord(diff)
      ? diff
      : undefined;
    const result = await approvalBroker.requestPrompt({
      requestId,
      sessionId,
      permissionRequest: {
        id: requestId,
        sessionId,
        toolCallId: undefined,
        kind: "settings" as const,
        diff: settingsDiff,
      },
    });
    const approved = result.outcome === "resolved" && result.action === "allow";
    auditLogger.log(
      buildPreHookAuditInput({
        sessionId,
        toolName: diff.forgetCompletely ? "forget" : "requestPermissionEscalation",
        serverName: "",
        kind: "settings",
        decision: approved ? "approved" : "denied",
        source: "user-interactive",
        sdkResult: approved ? "allow" : "deny",
      }),
    );
    return approved;
  },
} satisfies Omit<ISelfToolDeps, "sessionManager">;

const runtimeAcceptanceHarness = __MARSHAL_RUNTIME_ACCEPTANCE_BUILD__
  ? RuntimeAcceptanceHarness.create({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      userDataRoot: app.getPath("userData"),
      appDataRoot: getAppDataDir(),
      env: process.env,
    })
  : null;
const marshalRuntimeRoot = runtimeAcceptanceHarness
  ? runtimeAcceptanceHarness.paths.runtimeRoot
  : path.join(getAppDataDir(), "marshal-runtime");
const marshalRuntimeWorkspaceRoot =
  runtimeAcceptanceHarness?.paths.workspaceRoot ?? path.join(marshalRuntimeRoot, "workspace");
const marshalRuntimeProtectedResultsRoot =
  runtimeAcceptanceHarness?.paths.protectedResultsRoot ??
  path.join(marshalRuntimeRoot, "protected-results");
const marshalRuntimeWorktreeRoot =
  runtimeAcceptanceHarness?.paths.worktreeRoot ?? path.join(marshalRuntimeRoot, "worktrees");
const marshalRuntimeTrustedExtensionRoot =
  runtimeAcceptanceHarness?.paths.trustedExtensionRoot ??
  path.join(marshalRuntimeRoot, "extensions");
// Bound to a live implementation once marshalRuntimeHost exists (R5 / D2):
// only invoked from authorize(), well after startup, so the forward
// reference below is always resolved by call time.
let resolveExtensionDeclaredPermissionHook: ExtensionDeclaredPermissionResolver = () => false;
const marshalRuntimeTrustedTypeScript = isTrustedTypeScriptEnabled({ isPackaged: app.isPackaged });
const marshalRuntimePorts = createProductionMarshalRuntimePorts({
  sessionManager,
  permissionPolicy,
  approvalBroker,
  workspaceDir: WORKSPACE_DIR,
  onAuthorityDecision: (event) => runtimeAcceptanceHarness?.onAuthorityDecision(event),
  onToolsListed: (tools) => runtimeAcceptanceHarness?.onOrdinaryToolsListed(tools),
  onToolInvoked: (tool) => runtimeAcceptanceHarness?.onOrdinaryToolInvoked(tool),
  resolveExtensionDeclaredPermission: (permission, capability, scope) =>
    resolveExtensionDeclaredPermissionHook(permission, capability, scope),
  trustedTypeScript: marshalRuntimeTrustedTypeScript,
});
const marshalRuntimeServiceContainer = createRuntimeServiceContainer();
const marshalRelayRegistrationBinding = marshalRuntimeServiceContainer.bind(
  MARSHAL_RELAY_REGISTRATION_SERVICE,
  {
    useValue: createMarshalRelayRegistrationService({
      registry: relayProviderRegistry,
      coordinator: relayCoordinator,
      sessions: sessionManager,
    }),
  },
);
const marshalMemoryReasonerBinding = marshalRuntimeServiceContainer.bind(
  MARSHAL_MEMORY_REASONER_SERVICE,
  {
    useValue: createMarshalMemoryReasonerAdapter({
      getBackendProvider: () => sessionManager.getBackendProvider(),
    }),
  },
);
const marshalRuntimeCompositionRegistry = new RuntimeCompositionRegistry({
  container: marshalRuntimeServiceContainer,
});
const acceptanceDebuggerHostBinding = runtimeAcceptanceHarness
  ? bindAgenticDebuggerHostAdapter(
      marshalRuntimeCompositionRegistry,
      "@marshal/marshal:acceptance-debugger-host",
      createAcceptanceDebuggerHostAdapter(),
      { select: true },
    )
  : Promise.resolve(null);
const marshalRuntimeAgents = new SessionManagerRuntimeAgentAdapter(sessionManager);
const marshalRuntimeBrain = new MarshalRuntimeBrainAdapter(marshalRuntimeAgents);
const marshalRuntimeMemory = new MarshalRuntimeMemoryAdapter(memoryManager, {
  resolveScope: (scope, signal) => marshalRuntimePorts.authority.resolveScope(scope, signal),
  onStored: () => {
    runtimeAcceptanceHarness?.onMemoryStored();
  },
});
const runtimeUiDelivery: RuntimeUiDeliveryPorts = {
  notification: (delivery) => {
    if (delivery.owner.sessionId)
      runtimeAcceptanceHarness?.onUiNotification({
        ...delivery,
        owner: { ...delivery.owner, sessionId: delivery.owner.sessionId },
      });
    notificationRouter.notify({
      title: delivery.title,
      body: delivery.message,
      sessionId: delivery.owner.sessionId,
    });
    remoteAccessController.notify({
      deliveryId: delivery.deliveryId,
      title: delivery.title,
      message: delivery.message,
      sessionId: delivery.owner.sessionId,
    });
  },
  chatMessage: async ({ owner, content, deliveryId }) => {
    if (!owner.sessionId || owner.applicationScope)
      throw new Error("Chat delivery requires a session-owned application.");
    await runtimeAcceptanceHarness?.beforeUiChatMessagePersistence({
      owner: { ...owner, sessionId: owner.sessionId },
      deliveryId,
    });
    if (!sessionManager.getSession(owner.sessionId)) {
      throw new Error("Runtime UI chat message could not be persisted.");
    }
    const chatMessage = {
      id: deliveryId,
      role: "assistant" as const,
      content: content.kind === "text" ? content.text : content.markdown,
      timestamp: new Date().toISOString(),
    };
    const inserted = sessionManager.appendMessage(owner.sessionId, chatMessage);
    if (!inserted) {
      const existing = sessionManager
        .getSession(owner.sessionId)
        ?.messages.some((candidate) => candidate.id === deliveryId);
      if (!existing) throw new Error("Runtime UI chat message could not be persisted.");
      return;
    }
    sessionManager.emitPersistedMessage(owner.sessionId, chatMessage);
  },
  // Chat cards are durably delivered by the controller as scoped inline instances.
  chatCard: () => undefined,
};
const marshalSwarmProduction = createMarshalSwarmProduction({
  rootDirectory: path.join(marshalRuntimeRoot, "swarm"),
  sessions: sessionManager,
  serviceContainer: marshalRuntimeServiceContainer,
  getSettings: () => settingsManager.get(),
  onRunTerminalFailure: createSwarmTerminalGoalHandoff({
    loadSessionOwnership: (sessionId) => {
      const ownerSession = sessionManager.getSessionStore().loadSessionData(sessionId);
      return ownerSession
        ? {
            ...(ownerSession.runtimeTaskController !== undefined
              ? { runtimeTaskController: ownerSession.runtimeTaskController }
              : {}),
            ...(ownerSession.runtimeDelegationId !== undefined
              ? { runtimeDelegationId: ownerSession.runtimeDelegationId }
              : {}),
          }
        : null;
    },
    getGoalStatus: (sessionId) => goalManager.getGoal(sessionId)?.status,
    captureGoalFence: (sessionId) => goalManager.captureFence(sessionId),
    proposeGoalTransition: (sessionId, proposal, expectedFence) =>
      goalEngine.proposeTransition(sessionId, proposal, expectedFence),
  }),
  deliverCleanupAdvice: async ({ sessionId, workspaceName, answer }) => {
    const owner = {
      sessionId,
      workspaceName,
      extensionId: "marshal.swarm",
      applicationId: "storage-cleanup-advisor",
    };
    const context: InvocationContext = {
      principal: { id: "marshal.swarm", kind: "system" },
      scope: { sessionId, workspaceName },
      metadata: { marshalWorkspaceName: workspaceName },
    };
    await marshalRuntimeServiceContainer.get(MarshalServiceSymbols.uiDelivery).chatMessage(
      {
        deliveryId: randomUUID(),
        owner,
        content: { kind: "markdown", markdown: answer },
      },
      context,
    );
  },
});
const marshalRuntimeOwnedServiceBindings = Promise.all([
  marshalSwarmProduction.serviceBindingHandles,
  acceptanceDebuggerHostBinding,
]).then(([swarmBindings, debuggerBinding]) =>
  debuggerBinding ? [...swarmBindings, debuggerBinding] : swarmBindings,
);
const marshalRuntimeAllOwnedServiceBindings = Promise.all([
  marshalRelayRegistrationBinding,
  marshalMemoryReasonerBinding,
  marshalRuntimeOwnedServiceBindings,
]).then(([relayRegistrationBinding, memoryReasonerBinding, ownedServiceBindings]) => [
  relayRegistrationBinding,
  memoryReasonerBinding,
  ...ownedServiceBindings,
]);
registerTranscribeHandlers({ ipcHandle });
const overlayReview = registerOverlayReviewHandlers({
  ipcHandle,
  getWindow: () => win,
  appVersion: app.getVersion(),
});
const marshalRuntimeBrowserExecutor = new AgenticBrowserCommandExecutor(
  9222,
  path.join(getAppDataDir(), "agentic-browser", "profile"),
  process.platform === "darwin"
    ? path.join(process.env.HOME ?? "", "Library", "Caches", "ms-playwright", "mcp-chrome")
    : undefined,
  process.platform === "darwin" ? "Profile 1" : undefined,
);
const marshalRuntimeLocation = runtimeAcceptanceHarness?.runtimePackageLocation({
  isPackaged,
  appPath: app.getAppPath(),
  resourcesPath: process.resourcesPath,
}) ?? {
  isPackaged,
  appPath: app.getAppPath(),
  resourcesPath: process.resourcesPath,
};
const runtimeApplicationAuthority = new RuntimeApplicationAuthority();
let runtimeUiAttachmentStorePromise: Promise<RuntimeUiAttachmentStore> | undefined;
const getRuntimeUiAttachmentStore = (): Promise<RuntimeUiAttachmentStore> => {
  runtimeUiAttachmentStorePromise ??= RuntimeUiAttachmentStore.create({
    directory: path.join(app.getPath("temp"), "marshal-runtime-ui-images"),
    isOwnerActive: (owner) => runtimeApplicationHost?.isOwnerActive(owner) ?? false,
    supportsTargetImages: (target) => target.runtimeId === "codex" || target.runtimeId === "claude",
  }).catch((error: unknown) => {
    runtimeUiAttachmentStorePromise = undefined;
    throw error;
  });
  return runtimeUiAttachmentStorePromise;
};
const resolveApplicationWorkspace = async (scope: RuntimeUiScope): Promise<string | null> => {
  if (scope.applicationScope === "user")
    return scope.workspaceName === "marshal" ? marshalRuntimeWorkspaceRoot : null;
  if (scope.workspaceName === "marshal") return marshalRuntimeWorkspaceRoot;
  return (
    sessionManager
      .listWorkspacesForSelfTools()
      .find((workspace) => workspace.name === scope.workspaceName)?.path ?? null
  );
};
const selectedSessionDelivery: SelectedSessionDeliveryService = new SelectedSessionDeliveryService({
  outbox: agentMessageOutbox,
  sessions: sessionManager,
  currentRuntimeId: () => backend.runtimeId,
  getTarget: async (sessionId) => {
    const target = await sessionManager.getSessionScopeAsync(sessionId);
    return target
      ? {
          sessionId,
          workspaceName: target.workspaceName?.trim() || "marshal",
          runtimeId: resolveSessionRuntimeId(target),
        }
      : null;
  },
  isOwnerActive: (owner) => runtimeApplicationHost?.isOwnerActive(owner) ?? false,
  resolveAttachments: async (request) => (await getRuntimeUiAttachmentStore()).resolve(request),
  isJobActive: (jobId, owner, target) =>
    runtimeApplicationJobs.isDeliveryActive(jobId, owner, target),
  // CF-05 live progressive-answer push: delivery stream chunks fan out as
  // transient runtime-ui events; the packaged UI bridge forwards them only
  // into the owning application's frame. Late-bound like the other closures
  // above — marshalRuntimeHost is constructed later in this module.
  onStreamChunk: (owner, chunk) => {
    const { requestId, streamSequence, kind, text, terminal, terminalState } = chunk;
    marshalRuntimeHost?.ui?.publishDeliveryStream(
      {
        extensionId: owner.extensionId,
        applicationId: owner.applicationId,
        workspaceName: owner.workspaceName,
        ...(owner.sessionId ? { sessionId: owner.sessionId } : {}),
        ...(owner.applicationScope ? { applicationScope: owner.applicationScope } : {}),
      },
      {
        requestId,
        streamSequence,
        chunk: { kind, ...(text !== undefined ? { text } : {}) },
        terminal,
        ...(terminalState !== undefined ? { terminalState } : {}),
      },
    );
  },
});
const runtimeApplicationJobs: RuntimeApplicationJobs = new RuntimeApplicationJobs({
  automations: automationManager,
  delivery: selectedSessionDelivery,
  getSession: async (sessionId) => {
    const target = await sessionManager.getSessionScopeAsync(sessionId);
    return target
      ? {
          sessionId,
          workspaceName: target.workspaceName?.trim() || "marshal",
          runtimeId: resolveSessionRuntimeId(target),
          source: target.source,
          automationId: target.automationId,
        }
      : null;
  },
  isOwnerActive: (owner) => runtimeApplicationHost.isOwnerActive(owner),
  isCapabilityOwned: (owner, capability) =>
    runtimeApplicationHost.isCapabilityOwned(owner, capability),
  invoke: (authority, capability, input, context) =>
    runtimeApplicationHost.invokeJob(authority, capability, input, context),
});
const selectedSessionProvider = createSelectedSessionDeliveryProvider(
  selectedSessionDelivery,
  (context) => {
    const authority = runtimeApplicationAuthority.resolve(context);
    if (!authority)
      throw new Error(
        "A host-authenticated application is required for selected-session delivery.",
      );
    return authority.owner;
  },
  async (name, input, context) => {
    const invocation = runtimeApplicationAuthority.resolve(context);
    if (!invocation?.backgroundJobInvocationId) return undefined;
    if (!(await invocation.isActive()))
      throw new Error("The background application invocation is inactive.");
    return {
      output: await runtimeApplicationJobs.delivery(
        invocation.backgroundJobInvocationId,
        name,
        input,
        context.signal instanceof AbortSignal ? context.signal : undefined,
      ),
    };
  },
);
const resolveApplicationUiOwner = (context: InvocationContext): SelectedSessionOwner => {
  const authority = runtimeApplicationAuthority.resolve(context);
  if (!authority || authority.backgroundJobInvocationId)
    throw Object.assign(new Error("A native application UI invocation is required."), {
      code: "permission_denied",
    });
  return authority.owner;
};
const applicationJobProvider = createApplicationJobProvider(
  runtimeApplicationJobs,
  resolveApplicationUiOwner,
  (context) => runtimeApplicationAuthority.resolve(context)?.backgroundJobInvocationId,
);
const cloudSessionProvider = createCloudSessionProvider(resolveApplicationUiOwner, async (id) => {
  const inspected = await inspectCloudSession(id);
  try {
    const sessionId = await sessionManager.attachRuntimeSession({
      model: `marshal-cloud:${inspected.metadata.environmentId}`,
      backendId: id,
      name: inspected.metadata.title,
      messages: cloudTranscript(await inspected.session.getMessages()),
    });
    win?.webContents.send("sessions:switch-to", sessionId);
    return sessionId;
  } finally {
    await inspected.client.stop();
  }
});
const applicationSessionProvider = createApplicationSessionProvider(
  new ApplicationSessionService({
    file: path.join(marshalRuntimeRoot, "application-sessions.json"),
    delivery: selectedSessionDelivery,
    isOwnerActive: (owner) => runtimeApplicationHost.isOwnerActive(owner),
    resolveWorkspace: (name) =>
      sessionManager.listWorkspacesForSelfTools().find((workspace) => workspace.name === name)
        ?.name,
    createSession: async ({ name, workspaceName }) =>
      (
        await sessionManager.createSubagentSessionDeferred({
          name,
          workspaceName,
          source: "user",
          permissionMode: "default",
        })
      ).session.id,
    describeSession: (sessionId) => {
      const resolved = sessionManager.getSessionMetadata(sessionId)
        ? sessionId
        : sessionManager.findSessionIdByBackendId(sessionId);
      const metadata = resolved ? sessionManager.getSessionMetadata(resolved) : null;
      return metadata && resolved ? { ...metadata, sessionId: resolved } : null;
    },
  }),
  resolveApplicationUiOwner,
);
automationManager.setApplicationJobPolicy((automation) =>
  automation.applicationJob
    ? runtimeApplicationJobs.isArmed(automation.applicationJob.jobId)
    : true,
);
// Agent-requested app restart (marshal.app.restart). The executor reuses the
// normal quit path: app.relaunch() registers the OS-level relauncher, then
// app.quit() runs the full before-quit flush (settings, memory, audit,
// sessions, runtime disposal) before the process exits.
const appRestartExecutor = createAppRestartExecutor({
  app: { relaunch: () => app.relaunch(), quit: () => app.quit() },
  listSessions: async () =>
    (await sessionManager.listSessions()).map((sessionMetadata) => ({
      sessionId: sessionMetadata.id,
      busy: Boolean(sessionMetadata.isBusy),
      ...(sessionMetadata.parentSessionId
        ? { parentSessionId: sessionMetadata.parentSessionId }
        : {}),
      label: sessionMetadata.name,
    })),
  ledgerDir: getAppDataDir(),
  onImminentRestart: (entry) => {
    // Reason text stays in the ledger only — lifecycle diagnostics carry
    // metadata, not agent-authored content.
    writeProcessLifecycleEventSync("app.restart.agent-requested", {
      requesterSessionId: entry.requesterSessionId,
      ledgerEntryId: entry.id,
      force: entry.force,
    });
  },
});

const runtimeDocumentAccess = createRuntimeDocumentAccessStore();
const marshalRuntimeNodeExecutable =
  runtimeAcceptanceHarness?.nodeExecutable ??
  (isPackaged
    ? bundledNodePath(process.resourcesPath, process.platform)
    : developmentNodePath(app.getAppPath(), process.platform, process.arch));
// Code-index rebuild workers need a real Node binary: Electron-as-node keeps
// Electron's ~4 GB V8 heap cap, which a full repository rebuild can exceed.
process.env.MARSHAL_RUNTIME_NODE_EXECUTABLE ??= marshalRuntimeNodeExecutable;
const marshalRuntimeHost = new MarshalRuntimeHost({
  onApplicationInvalidated: async (owner) => {
    await Promise.all([
      runtimeApplicationJobs.revokeApplication(owner),
      selectedSessionDelivery.revokeApplication(owner),
      ...(runtimeUiAttachmentStorePromise
        ? [runtimeUiAttachmentStorePromise.then((store) => store.revokeApplication(owner))]
        : []),
    ]);
  },
  applicationAuthority: runtimeApplicationAuthority,
  extensionSecrets: createRuntimeExtensionSecrets({
    isReady: () => app.isReady(),
    encryption: safeStorage,
  }),
  resolveApplicationWorkspace,
  resolveDelegationIdentity: async (sessionId) => {
    const persistedSession = await sessionManager.getSessionScopeAsync(sessionId);
    return persistedSession?.runtimeDelegationId
      ? {
          delegationId: persistedSession.runtimeDelegationId,
          taskController: persistedSession.runtimeTaskController,
        }
      : undefined;
  },
  location: marshalRuntimeLocation,
  hostWorkspacePath: marshalRuntimeWorkspaceRoot,
  protectedLifecycleResultRoot: marshalRuntimeProtectedResultsRoot,
  worktreeRoot: marshalRuntimeWorktreeRoot,
  trustedExtensionRoot: marshalRuntimeTrustedExtensionRoot,
  trustedTypeScript: marshalRuntimeTrustedTypeScript,
  additionalProviderSources: [
    () => selectedSessionProvider,
    () => applicationJobProvider,
    () => applicationSessionProvider,
    () => cloudSessionProvider,
    () => createRuntimeUiImageProvider(getRuntimeUiAttachmentStore, runtimeApplicationAuthority),
    () => createAppLifecycleProvider(appRestartExecutor),
    () => uiObserveProvider,
    () => runtimeUiViews.layoutProvider,
    marshalSwarmProduction.delegationSource,
    ...(runtimeAcceptanceHarness?.runtimeProviderSources() ?? []),
  ],
  nodeExecutable: marshalRuntimeNodeExecutable,
  startupDelayMs: runtimeAcceptanceHarness?.launchProfile === "startup-delay" ? 15_000 : undefined,
  agenticBrowser: { executor: marshalRuntimeBrowserExecutor },
  firstPartyExtensions: resolveFirstPartyExtensionCatalog({
    location: marshalRuntimeLocation,
    runsDirectory: path.join(marshalRuntimeRoot, "swarm"),
  }),
  authority: marshalRuntimePorts.authority,
  ...(marshalRuntimePorts.approval ? { approval: marshalRuntimePorts.approval } : {}),
  catalog: marshalRuntimePorts.catalog,
  agents: marshalRuntimeAgents,
  brain: marshalRuntimeBrain,
  memory: marshalRuntimeMemory,
  memoryProviderRegistry: memoryManager,
  serviceContainer: marshalRuntimeServiceContainer,
  compositionRegistry: marshalRuntimeCompositionRegistry,
  ownedServiceBindings: marshalRuntimeAllOwnedServiceBindings,
  diagnostics: runtimeAcceptanceHarness ?? undefined,
  ui: {
    overlayReview,
    delivery: runtimeUiDelivery,
    issueDocumentAccess: (filePath) => runtimeDocumentAccess.issue(filePath),
  },
});
// R5 / D2: an extension-declared permission is one an enabled extension's live
// capability descriptor lists for the invoked capability. Disabling/removing
// the extension deregisters its capability providers from the kernel, so a
// disabled/uninstalled extension's permissions fall out of this query on their
// own — no separate installed/enabled bookkeeping needed here.
resolveExtensionDeclaredPermissionHook =
  createExtensionDeclaredPermissionResolver(marshalRuntimeHost);
const runtimeSessionLifecycle = new SessionLifecycleDispatcher({
  port: marshalRuntimeHost,
  resolveWorkspaceName: async (sessionId) =>
    (await marshalRuntimePorts.resolveScope(sessionId))?.workspaceName,
});
sessionManager.registerBackendSessionStartedHook((event) => {
  void runtimeSessionLifecycle.sessionStarted(event);
});
sessionManager.registerDeleteHook(({ sessionId, cause }) => {
  void runtimeSessionLifecycle.sessionEnded({ sessionId, outcome: `deleted:${cause}` });
});
const marshalRuntimeApi = new ProductionMarshalRuntimeApi(marshalRuntimeHost, undefined, {
  trustedTypeScript: marshalRuntimeTrustedTypeScript,
});
const runtimeApplicationHost: RuntimeApplicationHost = new RuntimeApplicationHost({
  services: marshalRuntimeServiceContainer,
  authority: runtimeApplicationAuthority,
  runtime: marshalRuntimeHost,
  api: marshalRuntimeApi,
  delivery: selectedSessionDelivery,
  resolveWorkspace: resolveApplicationWorkspace,
});
const swarmDriver = new SwarmDriver(
  marshalRuntimeApi,
  marshalSwarmProduction.onRunSettled,
  marshalSwarmProduction.onRunAbandoned,
);
registerSwarmHandlers({
  ipcHandle,
  driver: swarmDriver,
  sessions: sessionManager,
  worktreeLifecycle: marshalSwarmProduction.worktreeLifecycle,
  getSettings: () => settingsManager.get(),
});
if (!marshalRuntimeHost.ui) {
  throw new Error("Production Marshal Runtime UI controller was not configured.");
}
const runtimeUiViews = wireRuntimeUiViews({
  controller: marshalRuntimeHost.ui,
  runtimeRoot: marshalRuntimeRoot,
  applications: runtimeApplicationAuthority,
  ipcHandle,
  runtimeReady: () => marshalRuntimeHost.start(),
});
// UI observability (ui.observe.open/capture/close): hidden observer windows
// running the exact client pipeline at mobile/desktop presentation. Referenced
// by the additionalProviderSources thunk above; constructed here where the UI
// controller and audit logger exist. The CDP resolver matches only the
// observer's URL marker, so a handed-out target can never be the user's window.
const uiObserveWindowOptions = {
  preloadPath: resolveLooseFilePath("preload.cjs"),
  ...(VITE_DEV_SERVER_URL ? { devServerUrl: VITE_DEV_SERVER_URL } : {}),
  authorizeIpcWebContents,
  // Observer-created (session-scoped, M3) instances are closed with their
  // window; remote origin keeps the desktop pane from following the close.
  closeObservedInstance: async (target: {
    scope: import("../common/runtime-ui").RuntimeUiScope;
    extensionId: string;
    applicationId: string;
    instanceId: string;
  }) => {
    await marshalRuntimeHost.ui?.close({
      ...target.scope,
      extensionId: target.extensionId,
      applicationId: target.applicationId,
      instanceId: target.instanceId,
      idempotencyKey: `ui-observe-close:${target.instanceId}`,
    });
  },
};
const uiObserveDebugPort =
  Number.parseInt(app.commandLine.getSwitchValue("remote-debugging-port"), 10) || 9333;
const uiObserveProvider = createUiObserveProvider({
  findPublishedApplication: async (extensionId, applicationId, context) => {
    const workspace = context.metadata?.marshalWorkspaceName;
    const publication = marshalRuntimeServiceContainer.get(
      RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE,
    );
    const applications = await publication.listApplications(
      runtimeUiInvocationContext({
        applicationScope: "user",
        workspaceName:
          typeof workspace === "string" && workspace.trim()
            ? workspace
            : MARSHAL_RUNTIME_DEFAULT_WORKSPACE,
      }),
    );
    const application = applications.find(
      (candidate) => candidate.ownerId === extensionId && candidate.id === applicationId,
    );
    if (!application) return undefined;
    return { viewports: declaredUiViewportsFromMetadata(application.metadata) };
  },
  findScopedInstance: async (scope, instanceId) => {
    const listed = await marshalRuntimeHost.ui!.list({ ...scope });
    if (!listed.ok) return undefined;
    return listed.value.instances?.find((candidate) => candidate.instanceId === instanceId);
  },
  capture: createUiObserveRenderer(uiObserveWindowOptions),
  openWindow: createObserverWindowOpener(uiObserveWindowOptions),
  resolveCdpTargetId: createCdpTargetResolver(uiObserveDebugPort),
  audit: (entry) =>
    auditLogger.log(
      buildPreHookAuditInput({
        sessionId: entry.sessionId,
        toolName: UI_OBSERVE_CAPTURE,
        serverName: "marshal-runtime",
        kind: "ui-observe",
        decision: entry.decision,
        source: "internal-auto-approve",
        sdkResult: `${entry.reason ?? "capture"} ${entry.target}@${entry.viewport}`,
      }),
    ),
});
marshalSwarmProduction.setUiController(marshalRuntimeHost.ui);
registerRuntimeUiSessionSelectionHandlers({
  ipcHandle,
  controller: marshalRuntimeHost.ui,
  selectSession: (instance, targetSessionId) =>
    runtimeApplicationHost.selectSession(instance, targetSessionId),
  getSelectedSession: (instance) => runtimeApplicationHost.getSelectedSession(instance),
  searchSessions: async (_instance, query, limit) => sessionManager.searchSessions(query, limit),
});
registerRuntimeUiImageHandlers({
  ipcHandle,
  controller: marshalRuntimeHost.ui,
  getStore: getRuntimeUiAttachmentStore,
  isOwnerActive: (instance) => runtimeApplicationHost.isOwnerActive(instance.owner),
  pickNativeImages: async () => {
    const options: Electron.OpenDialogOptions = {
      title: "Attach images to extension application",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
    };
    const result =
      win && !win.isDestroyed()
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  },
});
registerRuntimeUiHandlers({
  ipcHandle,
  controller: marshalRuntimeHost.ui,
  serviceContainer: marshalRuntimeServiceContainer,
  runtimeReady: () => marshalRuntimeHost.start(),
  runtimeApi: marshalRuntimeApi,
  invokeApplicationCapability: (instance, request, signal) =>
    runtimeApplicationHost.invoke(instance, request, signal),
  readResource: async (scope, uri) => {
    const resolved = await marshalRuntimeHost.resolveScope(scope);
    const resource = await marshalRuntimeHost.readResource(uri, {
      sessionId: scope.sessionId,
      workspacePath: resolved.workspacePath,
      metadata: { marshalWorkspaceName: scope.workspaceName },
    });
    return {
      uri: resource.uri,
      mimeType: resource.mimeType ?? "text/plain",
      ...(resource.text ? { text: resource.text } : {}),
    };
  },
});
// Extension prompt contributions (staged prompt-replacement experiment):
// snapshot of installed extensions mapped for the assembler. Refreshed on the
// same signal that invalidates renderer extension queries; SessionManager
// applies rebuilt prompts only at safe boundaries (idle / next create/resume).
let extensionPromptSnapshot: ReturnType<typeof toExtensionPromptContribution>[] = [];
const refreshExtensionPromptSnapshot = async (): Promise<void> => {
  try {
    const records = await marshalRuntimeHost.listExtensions();
    extensionPromptSnapshot = records.map((record) => toExtensionPromptContribution(record));
    sessionManager.onExtensionPromptContributionsChanged();
  } catch (error) {
    marshalRuntimeLog.warn("Extension prompt snapshot refresh failed:", error);
  }
};
sessionManager.setExtensionPromptContributionsProvider(() => extensionPromptSnapshot);
sessionManager.setRuntimeTrustedTypeScript(marshalRuntimeTrustedTypeScript);

registerRuntimeExtensionsHandlers({
  ipcHandle,
  serviceContainer: marshalRuntimeServiceContainer,
  runtimeReady: () => marshalRuntimeHost.start(),
  runCatalogOperation: (operation) => marshalRuntimeHost.runExtensionCatalogOperation(operation),
  runtimeApi: marshalRuntimeApi,
  extensionDiscovery: () => marshalRuntimeHost.getExtensionDiscovery(),
  emitChanged: (event) => {
    chatWindowManager.broadcast("runtime-extensions:changed", event);
    void refreshExtensionPromptSnapshot();
  },
});
runtimeSelfTools = getRuntimeSelfTools({
  api: marshalRuntimeApi,
  resolveScope: marshalRuntimePorts.resolveScope,
  // ui.compile resolves entryPath against the compiler's fixed root
  // (hostWorkspacePath), not the session's workspace, so generated TSX must
  // land there for every session.
  resolveWorkspacePath: async () => marshalRuntimeWorkspaceRoot,
  trustedTypeScript: marshalRuntimeTrustedTypeScript,
  resolveClientViewport: getSessionClientViewport,
  resolveFileAccess: (sessionId) => {
    const grants = permissionPolicy.getEffectiveFolderGrants(sessionId);
    return {
      workspaceDir: sessionManager.getWorkspaceRootForSession(sessionId) ?? WORKSPACE_DIR,
      readGrants: grants.read,
      writeGrants: grants.write,
      allowedSensitivePaths: settingsManager.get().permissions?.allowedSensitivePaths ?? [],
    };
  },
  // F-DEPLOY-3: agent-path enable/disable/remove bypass the IPC handler above,
  // so broadcast "runtime-extensions:changed" here too — same channel, an
  // independent revision counter is fine since renderer listeners only use the
  // event as an invalidation signal (see src/shared/hooks/wireQueryInvalidations.ts).
  notifyExtensionsChanged: (scope) => {
    chatWindowManager.broadcast("runtime-extensions:changed", {
      revision: ++selfToolExtensionsChangedRevision,
      sessionId: scope.sessionId,
      workspaceName: scope.workspaceName,
    });
    void refreshExtensionPromptSnapshot();
  },
});
sessionManager.setSelfTools(selfToolDeps);
runtimeAcceptanceHarness?.register(ipcHandle, {
  host: marshalRuntimeHost,
  api: marshalRuntimeApi,
  sessionManager,
  memoryManager,
  agents: marshalRuntimeAgents,
  agentMessageOutbox,
  permissionPolicy,
  settingsManager,
  authority: marshalRuntimePorts.authority,
  uiController: marshalRuntimeHost.ui,
  resolveSelfTools: (sessionId) => sessionManager.listSelfToolsForSession(sessionId),
  backendIdentity: {
    runtimeId: backend.runtimeId,
    origin: backend.origin,
  },
});

let marshalRuntimeDisposed = false;
async function disposeMarshalRuntime(): Promise<void> {
  if (marshalRuntimeDisposed) return;
  marshalRuntimeDisposed = true;
  runtimeAcceptanceHarness?.onEvent({ type: "api.dispose.started" });
  marshalRuntimeApi.dispose();
  runtimeAcceptanceHarness?.onEvent({ type: "api.dispose.completed" });
  try {
    await marshalRuntimeHost.dispose();
  } catch (error) {
    runtimeAcceptanceHarness?.captureDisposalError(error);
    throw error;
  }
}

registerModelsHandlers(ipcDeps);
registerSoulHandlers(ipcDeps);

registerCopilotHandlers({
  ...ipcDeps,
  onSessionSendStart: (sessionId) => {
    if (relayCoordinator.getSessionOrigin(sessionId) == null) {
      miniModeManager.markSessionBusy(sessionId);
    }
  },
  onSessionSendFailed: (sessionId) => {
    if (relayCoordinator.getSessionOrigin(sessionId) == null) {
      miniModeManager.markSessionIdle(sessionId, false);
    }
  },
});
registerBackendCapabilitiesHandler(ipcDeps);
registerRuntimeAuthHandlers(ipcDeps);
const runtimeAccounts = new RuntimeAccountsManager({
  settings: settingsManager,
  createClientFactory: (runtimeId, accountId) =>
    createClientFactory(runtimeId, createRuntimeAdapterContext(isMockMode()), accountId),
  workspaceDir: WORKSPACE_DIR,
  onSignInChanged: () => sessionManager.invalidateRuntimeModels(),
});
registerRuntimeAccountsHandlers({ ipcHandle, runtimeAccounts });
const runtimeAccountsKeepAlive = new RuntimeAccountsKeepAlive(runtimeAccounts);
registerUpdateHandlers(ipcDeps);
registerSettingsHandlers(ipcDeps);
const disposeRelayProviderSettingsHandlers = registerRelayProviderSettingsHandlers({
  ipcHandle,
  settingsManager,
  service: relayProviderSettingsService,
  broadcast: (channel, payload) => chatWindowManager.broadcast(channel, payload),
});
registerDefaultWorkspaceHandler(ipcDeps, WORKSPACE_DIR);
registerSkillsHandlers(ipcDeps);
registerGoalHandlers({
  ipcHandle,
  goalManager,
  goalEngine,
});
registerHeartbeatHandlers({ ...ipcDeps, tenantPolicyProvider });
registerAutomationsHandlers({ ...ipcDeps, tenantPolicyProvider });
// Local runtime adapters share desktop bundle storage and GitHub import.
// Cloud runtimes omit these handlers and expose their own automation surface.
const automationCapabilities = backend.capabilities().automations;
if (automationCapabilities.bundleImport || automationCapabilities.githubImport) {
  registerAutomationsDesktopHandlers({ ...ipcDeps, tenantPolicyProvider });
}
registerWorkspaceHandlers(WORKSPACE_DIR, () => win, sessionManager, runtimeDocumentAccess);
registerMcpOAuthHandlers(ipcDeps);
registerContextPickerHandlers(ipcDeps, {
  runtimePeopleSearch: createRuntimePeopleSearch({
    host: marshalRuntimeHost,
    resolveScope: async () => {
      const sessionId = sessionManager.getCurrentSessionId();
      if (!sessionId) return null;
      const scope = await marshalRuntimePorts.resolveScope(sessionId);
      if (!scope) return null;
      const resolved = await marshalRuntimePorts.authority.resolveScope(scope);
      return resolved
        ? {
            sessionId: resolved.sessionId,
            workspaceName: resolved.workspaceName,
            workspacePath: resolved.workspacePath,
          }
        : null;
    },
  }),
});
registerDiagnosticsHandlers({ ...ipcDeps, rendererResponsivenessMonitor });
const localTelemetryStore = new LocalTelemetryStore();
let rendererTelemetryFinalizeResolver: (() => void) | null = null;

function requestRendererTelemetryFinalization(): Promise<void> {
  const targetWindow = win;
  if (!targetWindow || targetWindow.isDestroyed()) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (rendererTelemetryFinalizeResolver === finish) {
        rendererTelemetryFinalizeResolver = null;
      }
      resolve();
    };
    rendererTelemetryFinalizeResolver = finish;
    targetWindow.webContents.send("telemetry:finalize");
    setTimeout(finish, 1_000);
  });
}

registerTelemetryHandlers(
  { ipcHandle },
  localTelemetryStore,
  initialSettings.telemetryEnabled ?? true,
  {
    onRendererFinalized: () => rendererTelemetryFinalizeResolver?.(),
  },
);
setDiagnosticsEnabledPredicate(() => __MARSHAL_DEV_FEATURES__);

// AIInvestigatorManager — hidden background investigation for the "Report a bug" header button.
// The destination is a swappable provider; GitHub is the only adapter today.
const issueReporter = createGitHubIssueReporter({
  getTarget: () => resolveIssueReporterTarget(settingsManager.get().issueReporter),
});
const aiInvestigatorManager = new AIInvestigatorManager({
  sessionManager,
  permissionPolicy,
  issueReporter,
  emit: makeAIInvestigatorEmitter(() => win),
  getDiagnosticsTail: () => readLogTail(),
});
registerAIInvestigatorHandlers({ ipcHandle, aiInvestigatorManager });

// Dynamic Workflows engine — owns the workflow run lifecycle and exposes
// the workflow* tools via the workflowManager slot on selfTools.
// See r1-fixes A4 + c-runtime §3.
const workflowManager = new WorkflowRunManager({
  spawnAdapter: new SessionManagerSpawnAdapter(sessionManager),
  backendOrigin: () => backend.origin,
  workspaceResolver: (workspaceName) => {
    const match = sessionManager
      .listWorkspacesForSelfTools()
      .find((workspace) => workspace.name.toLowerCase() === workspaceName.toLowerCase());
    return match?.path;
  },
  workspaceLister: () => sessionManager.listWorkspacesForSelfTools(),
  sendWorkflowParentMessage: async ({ sessionId, message, waitForResponse, timeoutMs }) => {
    if (waitForResponse) {
      const result = await sessionManager.sendAndCollect(message, timeoutMs, undefined, sessionId);
      return {
        delivered: result.kind === "ok",
        status: "responded" as const,
        ...(result.kind === "ok" ? { response: result.text } : {}),
      };
    }
    await sessionManager.sendMessage(sessionId, message, undefined, { noSwitch: true });
    return { delivered: true, status: "sent" as const };
  },
  hostSessionFactory: async ({ runId, workflowTitle, model, reasoningEffort, permissionMode }) => {
    const meta = await sessionManager.createSession(model, undefined, {
      name: `Workflow: ${workflowTitle} (${runId.slice(0, 8)})`,
      source: "workflow-run",
      reasoningEffort,
      permissionMode,
      setActive: false,
    });
    return meta.id;
  },
  hostSessionDisposer: (sessionId) => sessionManager.pauseSession(sessionId),
  launchActionSession: async ({ title, prompt }) => {
    const actionSession = await sessionManager.createSession(undefined, undefined, {
      name: title,
      setActive: false,
    });
    await sessionManager.sendMessage(actionSession.id, prompt, undefined, { noSwitch: true });
    return { sessionId: actionSession.id, title: actionSession.name ?? title };
  },
  getActionSessionState: (sessionId) =>
    sessionManager.getSession(sessionId)
      ? sessionManager.isSessionBusy(sessionId)
        ? "busy"
        : "idle"
      : "missing",
  cancelActionSession: (sessionId) => sessionManager.cancelTurn(sessionId),
});
sessionManager.attachWorkflowManager(workflowManager);
registerWorkflowsHandlers({
  ipcHandle,
  getWindow: () => win,
  workflowManager,
  permissionCardManager,
});
registerCommandCenterHandlers({
  ipcHandle,
  getWindow: () => win,
  sessionManager,
  commandCenterManager,
});

backend.registerNodeIpcHandlers({
  ipcHandle,
  broadcast: (channel, payload) => {
    win?.webContents.send(channel, payload);
  },
});

// Polymorphic per Rule 1 — gateway wires its real controller, copilot stubs.
authMachinery = backend.attachAuthMachinery({
  ipcHandle,
  sendStateChange: (state) => {
    win?.webContents.send("gatewayAuth:stateChange", state);
    void identityController?.refresh();
  },
  onSignOut: async () => {
    sessionManager.dropLocalSessionState();
  },
});

registerIdentityHandlers({ ipcHandle }, identityController);
registerTenantHandlers({ ipcHandle, tenantPolicyProvider });
registerMiniModeHandlers({
  getWindow: () => win,
  ipcHandle,
  miniModeManager,
  trayManager,
  notificationRouter,
  permissionCardManager,
});
registerWindowControlsHandlers(ipcDeps);
registerChatWindowsHandlers({ ipcHandle, chatWindowManager });
registerMcpHandlers(ipcDeps);
registerActivitiesHandlers(ipcDeps);
registerShellHandlers(ipcDeps);
registerSaveJsonHandler(ipcDeps);
const preferencesHandle = registerPreferencesHandlers({
  ipcHandle,
  prefsPath: path.join(getAppDataDir(), "marshal-preferences.json"),
});
sessionManager.setMcpStore(mcpStore);
// setCustomMcpServers + MCP tool discovery are deferred to the app.whenReady()
// block below (they read mcpStore's decrypted servers) — see mcpStore.reload().

mcpStore.on("changed", () => {
  win?.webContents.send("mcp:tools-updated");
});

const applyCurrentKeepAwakeSettings = (settings = settingsManager.get()) => {
  applyKeepAwakeSettings(settings, {
    isRelayConnected: () => relayCoordinator.notifications.hasDestinations("default"),
    isHeartbeatEnabled: () => heartbeatManager.getStatus().enabled,
    powerManager,
    keepAwake,
    isWindows: process.platform === "win32",
  });
};

settingsManager.on("changed", (changedSettings) => {
  miniModeManager.setMiniModeEnabled(!!changedSettings.miniModeEnabled);
  miniModeManager.setTheme(changedSettings.theme);
  showHideShortcutController.sync();
  // Single fan-out point so every save path (Settings UI, updateSettings,
  // future writers) keeps the active session's MCP args in sync. The setter
  // dedupes when the value is unchanged, so this is a cheap no-op otherwise.
  sessionManager.setInterceptFileChooser(changedSettings.interceptFileChooser ?? false);
  // Notify every renderer (main + popouts) so useSettings can invalidate its
  // cache — otherwise main-process mutations (e.g. "Always allow" from a
  // permission card) leave the Settings UI showing stale data until a reload,
  // and popout chats miss settings-driven UI changes (theme, Header tagline).
  chatWindowManager.broadcast("settings:changed");
  applyEffectiveAppMode();

  applyCurrentKeepAwakeSettings(changedSettings);
});

backgroundService.on("changed", (changedSettings) => {
  miniModeManager.setBackgroundEnabled(changedSettings.enabled);
});

// --- App-Lifetime Wiring ---
// Called once from app.whenReady(). All callbacks reference the module-level
// `win` variable — they naturally no-op via win?. when no window exists.
// Separating this from createWindow() prevents listener accumulation on macOS,
// where the process survives window close and createWindow() is called again.

function initAppWiring() {
  // Main-process event listener: PowerManager, MiniModeManager, and metadata forwarding.
  // Individual TurnEvents no longer cross IPC in bulk — the renderer uses session:view instead.
  sessionManager.addEventListener((sessionId, event) => {
    switch (event.type) {
      case "turn:text-delta":
      case "turn:reasoning-updated":
      case "turn:tools-updated":
        relayIdleNotifications.delete(sessionId);
        powerManager.markBusy(sessionId);
        if (relayCoordinator.getSessionOrigin(sessionId) == null) {
          miniModeManager.markSessionBusy(sessionId);
        }
        break;
      case "turn:idle":
        powerManager.markIdle(sessionId);
        if (relayCoordinator.getSessionOrigin(sessionId) == null) {
          miniModeManager.markSessionIdle(sessionId, true);
        }
        {
          const metadata = sessionManager.getSessionMetadata(sessionId);
          const isSubagent =
            metadata?.source === "subagent" || metadata?.source === "workflow-agent";
          const shouldNotifyBecauseOfSetting = hasRelayAttentionNotifications();
          // The full transcript is only needed for readiness or the relay excerpt.
          const sessionData =
            metadata && (isSubagent || shouldNotifyBecauseOfSetting)
              ? sessionManager.getSession(sessionId)
              : null;
          if (isSubagent && sessionData) {
            void sessionManager
              .noteSubagentIdle(sessionData, Date.now(), {
                wasBusy: sessionManager.isSessionBusy(sessionId),
              })
              .catch((error) =>
                log
                  .with({
                    sessionId,
                    ...(sessionData.parentSessionId
                      ? { parentSessionId: sessionData.parentSessionId }
                      : {}),
                  })
                  .warn("Failed to notify parent that subagent is idle:", error),
              );
            break;
          }
          if (
            sessionData &&
            shouldNotifyBecauseOfSetting &&
            shouldSendRelayIdleNotification(sessionId)
          ) {
            const lastMessageExcerpt = getRelayIdleLastMessageExcerpt(sessionData);
            const lastMessageSection = lastMessageExcerpt
              ? `\n\nLast message:\n${lastMessageExcerpt}`
              : "";
            relayCoordinator.notifications
              .publish(
                "default",
                formatRelaySessionMessage(`The agent is idle.${lastMessageSection}`, sessionData, {
                  routeId: getRelayRouteAlias(sessionData),
                }),
                sessionId,
              )
              .catch(() => {});
          }
        }
        break;
      case "turn:error":
        powerManager.markIdle(sessionId);
        if (relayCoordinator.getSessionOrigin(sessionId) == null) {
          miniModeManager.markSessionIdle(sessionId, false);
        }
        if (event.retrying !== true) {
          const metadata = sessionManager.getSessionMetadata(sessionId);
          const sessionData =
            metadata?.source === "subagent" || metadata?.source === "workflow-agent"
              ? sessionManager.getSession(sessionId)
              : null;
          if (sessionData) {
            void sessionManager
              .noteSubagentIdle(sessionData, Date.now(), {
                wasBusy: sessionManager.isSessionBusy(sessionId),
                outcome: "failed",
                detail: event.error,
              })
              .catch((error) =>
                log
                  .with({
                    sessionId,
                    ...(sessionData.parentSessionId
                      ? { parentSessionId: sessionData.parentSessionId }
                      : {}),
                  })
                  .warn("Failed to notify parent that subagent failed terminally:", error),
              );
          }
        }
        break;
      case "turn:metadata-updated":
        chatWindowManager.broadcast(
          "session:metadata-changed",
          event.changes ? { sessionId, changes: event.changes } : sessionId,
        );
        break;
      default:
        break;
    }
  });

  // Route full snapshots only to renderers displaying this session. Other
  // windows receive compact status deltas through the broker at most once/sec.
  sessionManager.addViewEventListener((sessionId, viewEvent) => {
    sessionViewIpcBroker.publish(sessionId, summarizeViewEventToolCalls(viewEvent));
    remoteAccessController.observeView(sessionId, viewEvent.view.status, viewEvent.view.error);
  });

  // Forward session-list mutations (reconcile + live sessions.changed events
  // from the gateway) so the renderer invalidates its ["sessions"] query and
  // the sidebar stays in sync without polling.
  sessionManager.addSessionsListListener(() => {
    chatWindowManager.broadcast("sessions:list-changed");
  });

  sessionManager.addHydrationListener((event) => {
    chatWindowManager.broadcast("sessions:hydration-changed", event);
  });

  // Wire the MCP status pipeline:
  //   - disabled-MCP provider for buildSystemMessage (entity-scoped session
  //     permissions override the global setting; tenant-disabled servers
  //     always merge in — see buildDisabledDisplayNameSet)
  //   - MCP server status + OAuth event forwarding so users see when
  //     plugin-declared remote MCPs are connecting / need auth / have failed.
  //     The bundled CLI runs the OAuth flow itself; we only surface progress.
  sessionManager.connectMcpPipeline({
    disabledProvider: (sessionId: string) =>
      buildDisabledDisplayNameSet({
        servers:
          permissionPolicy.getSessionPermissions(sessionId)?.servers ??
          settingsManager.get().permissions?.servers,
        tenantDisabledServers: tenantPolicyProvider.get()?.disabledServers,
      }),
    statusCallback: (event) => {
      if (event.type === "mcp-server-status") {
        win?.webContents.send("mcp:server-status", {
          serverName: event.serverName,
          status: event.status,
          error: event.error,
          source: event.source,
        });
      } else if (event.type === "mcp-oauth-required") {
        win?.webContents.send("mcp:oauth-required", {
          requestId: event.requestId,
          serverName: event.serverName,
          serverUrl: event.serverUrl,
          sessionId: event.sessionId,
        });
      } else if (event.type === "mcp-oauth-completed") {
        win?.webContents.send("mcp:oauth-completed", {
          requestId: event.requestId,
        });
      }
    },
  });

  // Forward auth errors to renderer
  sessionManager.setAuthErrorCallback((error: string) => {
    log.child("Auth").warn("Auth error detected:", error);
    win?.webContents.send("copilot:authError", error);
    win?.webContents.send("runtimeAuth:authError", error);
    broadcastRemote("runtimeAuth:authError", error);
  });

  // Forward device-flow login failures (subprocess kill, 2-min cap, post-login
  // verify exhaustion) so the renderer can flip the card out of "Waiting for
  // authorization…" immediately instead of waiting on the renderer-side timer.
  sessionManager.setLoginFailedCallback((reason: string) => {
    win?.webContents.send("copilot:loginFailed", reason);
    win?.webContents.send("runtimeAuth:loginFailed", reason);
  });

  // Wire auth status changes to audit logger for identity caching
  sessionManager.setAuthStatusCallback((status) => {
    auditLogger.setUserLogin(status.login ?? "");
  });

  // Permission card callbacks → miniModeManager, notifications, relay bridge
  permissionCardManager.setCallbacks({
    onApprovalRequested: (request) => {
      miniModeManager.showPermission(request);
      const workflowRunId = request.sessionId
        ? workflowManager.getRunIdForSession(request.sessionId)
        : undefined;
      if (workflowRunId && request.sessionId) {
        win?.webContents.send("workflow:permission-request", {
          runId: workflowRunId,
          subagentSessionId: request.sessionId,
          cardPayload: request,
          receivedAt: Date.now(),
        });
      }
      try {
        // Redact memories being erased from OS notifications so private data
        // never reaches the lock screen.
        notificationRouter.notify({
          title: "Permission needed",
          body: permissionNotificationBody(request),
          sessionId: request.sessionId,
          onlyWhenUnfocused: true,
          suppressWhenMiniMode: true,
        });
      } catch {
        // Notification failure should never block the permission flow
      }
    },
    onPrompt: (title, message, detail, requestId, sessionId, _tooltips, buttons) => {
      if (sessionId && buttons) {
        relayHostInteractionBridge.presentPermission({
          requestId,
          sessionId,
          title,
          message,
          detail,
          buttons,
          resolve: (action) => {
            permissionCardManager.resolve(requestId, action);
          },
        });
      }
    },
    onPermissionResolved: (requestId) => {
      miniModeManager.hidePermission(requestId);
      relayHostInteractionBridge.permissionResolved(requestId);
    },
    // A relay-origin session mirrors its own permission cards through
    // relayHostInteractionBridge; the desktop card would be a duplicate.
    isRelayHandled: (sessionId) =>
      !!sessionId && relayCoordinator.getSessionOrigin(sessionId) != null,
  });
  attachInteractiveBackendWiring(backend);
}

function attachInteractiveBackendWiring(target: IBackendProvider): void {
  detachApprovalRouter?.();
  detachApprovalRouter = target.tools.attachApprovalRouter({
    broker: approvalBroker,
    policy: permissionPolicy,
    classifier: sessionManager,
    canShowUI: () => (!!win && !win.isDestroyed()) || remoteAccessController.getState().running,
  });
}

let runtimeSwitchInFlight: Promise<RuntimeSwitchResult> | null = null;

async function switchRuntimeAdapter(requestedRuntimeId: string): Promise<RuntimeSwitchResult> {
  if (runtimeSwitchInFlight) {
    throw new Error("A runtime switch is already in progress");
  }

  const operation = performRuntimeSwitch(requestedRuntimeId);
  runtimeSwitchInFlight = operation;
  try {
    return await operation;
  } finally {
    if (runtimeSwitchInFlight === operation) runtimeSwitchInFlight = null;
  }
}

async function performRuntimeSwitch(requestedRuntimeId: string): Promise<RuntimeSwitchResult> {
  const targetRuntimeId = normalizeRuntimeId(requestedRuntimeId);
  const targetMetadata = getRuntimeMetadata(targetRuntimeId);
  if (!targetMetadata.selectable) {
    throw new Error(`Runtime adapter "${targetRuntimeId}" is not available`);
  }

  const activeRuntimeId = runtimeStartupSelection.runtimeId;
  if (targetRuntimeId === activeRuntimeId) {
    runtimeStartupSelection = {
      ...runtimeStartupSelection,
      requestedRuntimeId: targetRuntimeId,
    };
    settingsManager.update({ runtimeId: targetRuntimeId });
    return { selection: runtimeStartupSelection, requiresRestart: false };
  }

  if (isMockMode() || !canSwitchRuntimeLive(activeRuntimeId, targetRuntimeId)) {
    runtimeStartupSelection = {
      ...runtimeStartupSelection,
      requestedRuntimeId: targetRuntimeId,
    };
    settingsManager.update({ runtimeId: targetRuntimeId });
    return { selection: runtimeStartupSelection, requiresRestart: true };
  }

  const nextSelection = resolveRuntimeStartupSelection(
    {
      ...settingsManager.get(),
      runtimeId: targetRuntimeId,
    },
    {
      mockMode: false,
      gatewayE2E: process.env.MARSHAL_GATEWAY_E2E === "1",
    },
  );
  const nextBackend = createBackend({
    runtimeId: nextSelection.runtimeId,
    ...createRuntimeAdapterContext(false),
  });
  configureBackendManagers(nextBackend);
  const previousActiveSessionIds = sessionManager.getActiveSessionIds();

  try {
    await sessionManager.switchBackend(nextBackend);
  } catch (error) {
    await nextBackend.dispose().catch(() => {});
    throw error;
  }

  backend = nextBackend;
  runtimeStartupSelection = nextSelection;
  sessionManager.invalidateRuntimeModels();
  attachDesktopCapabilities(nextBackend);
  attachInteractiveBackendWiring(nextBackend);
  for (const sessionId of previousActiveSessionIds) {
    clearPerSessionRuntimeState(sessionId);
  }
  heartbeatManager.resetRuntimeSessions();
  automationManager.resetRuntimeSessions();
  settingsManager.update({ runtimeId: targetRuntimeId });
  await identityController.refresh();
  log.info(`Switched runtime adapter to "${targetRuntimeId}" without restarting`);

  return { selection: runtimeStartupSelection, requiresRestart: false };
}

// --- Window Creation ---

function createWindow() {
  // Remove menu bar on Windows/Linux (macOS uses system menu bar)
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
  } else {
    // macOS: build app menu with Preferences (Cmd+,)
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          {
            label: "Preferences…",
            accelerator: "Cmd+,",
            click: () => {
              win?.webContents.send("settings:toggle");
            },
          },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  const preloadPath = resolveLooseFilePath(
    runtimeAcceptanceHarness ? "runtime-acceptance-preload.cjs" : "preload.cjs",
  );
  log.info("Preload path:", preloadPath);
  log.info("isPackaged:", isPackaged, "resourcesPath:", process.resourcesPath);

  const launchState = mainWindowController.getLaunchState();
  mainWindowLog.info("Launch mode", JSON.stringify(launchState));

  const savedWindowState = loadWindowState();
  const restoredBounds = pickValidBounds(savedWindowState);
  const defaultBounds = getDefaultBounds();
  win = new BrowserWindow({
    ...(restoredBounds ?? defaultBounds),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    icon: path.join(
      process.env.VITE_PUBLIC,
      process.platform === "win32" ? "marshal-app-icon.ico" : "marshal-app-icon.png",
    ),
    ...(process.platform === "win32"
      ? { frame: false, thickFrame: true }
      : {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 16, y: 17 },
        }),
    // Resizable transparent surfaces can disappear during macOS full-screen
    // transitions. Keep the native window opaque, including under vibrancy.
    transparent: false,
    backgroundColor: resolveThemeBg(settingsManager.get().theme),
    ...(useMacVibrancy
      ? {
          vibrancy: "under-window" as const,
          visualEffectState: "followWindow" as const,
        }
      : {}),
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const mainWebContentsId = win.webContents.id;
  const profiledWebContents = win.webContents;
  const attachPerformanceProfile = () =>
    performanceFlightRecorder.attachRenderer(profiledWebContents);
  profiledWebContents.once("did-finish-load", attachPerformanceProfile);
  const deauthorizeIpc = authorizeIpcWebContents(mainWebContentsId);

  const detachWindowStateTracking = attachWindowStateTracking(win);

  // CSS-only vibrancy: do not re-add a did-finish-load JS injection here.
  // The previous injection set inline `background: transparent !important` on
  // wrapper elements, which persisted across theme switches and fought
  // Light/Dark mode. See docs/architecture/14-marshal-macos-vibrancy.md.

  // ---- Content Security Policy ----
  const cspProduction = [
    "default-src 'none'",
    // `blob:` is required so the Workflows tab can load a workflow's compiled
    // custom renderer / command center (esbuild output served as a Blob URL and
    // dynamically imported). The code is first-party (the workflow's own
    // renderer.tsx / command-center.tsx, compiled by the engine).
    `script-src 'self' blob: ${RUNTIME_UI_SANDBOX_CSP_SOURCE}`,
    // Markdown/HTML preview supports sanitized inline style attributes for local content blocks.
    // Radix UI / Floating UI also rely on inline styles for positioning.
    "style-src 'self' 'unsafe-inline'",
    // https: removed — rehype-harden blocks external image URLs at the AST level,
    // and this CSP directive is the browser-level final backstop.
    "img-src 'self' data: blob: local-file:",
    "font-src 'self'",
    "connect-src 'self' local-file:",
    "frame-src 'self' local-preview:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

  const cspDev = [
    "default-src 'none'",
    // Vite's React preamble is injected as an inline script in dev mode.
    // `blob:` mirrors production so workflow custom renderers load in dev too.
    `script-src 'self' 'unsafe-eval' 'unsafe-inline' blob: ${RUNTIME_UI_SANDBOX_CSP_SOURCE}`,
    "style-src 'self' 'unsafe-inline'", // Vite HMR injects CSS via <style> elements in dev
    "img-src 'self' data: blob: local-file:", // external images blocked by rehype-harden
    "font-src 'self'",
    "connect-src 'self' local-file: ws://localhost:* http://localhost:*",
    "frame-src 'self' local-preview:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

  const csp = VITE_DEV_SERVER_URL ? cspDev : cspProduction;

  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const isMainFrame = details.resourceType === "mainFrame";
    if (!isMainFrame || details.url.startsWith("data:")) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });
  // ---- End CSP ----

  if (launchState.startHidden) {
    win.setSkipTaskbar(shouldSkipTaskbarForHiddenWindow());
  }

  win.on("maximize", emitWindowMaximizedState);
  win.on("unmaximize", emitWindowMaximizedState);
  win.on("enter-full-screen", emitWindowFullScreenState);
  win.on("leave-full-screen", emitWindowFullScreenState);
  mainWindowController.attach(win, launchState.startHidden);

  // Visibility and focus changes survive in the lifecycle log even when optional
  // diagnostic logging is disabled, so disappearing windows are distinguishable
  // from renderer crashes and ordinary app switching.
  const logWindowEvent = (event: string) => () => {
    if (!win || win.isDestroyed()) return;
    writeProcessLifecycleEventSync(`main-window.${event}`, {
      visible: win.isVisible(),
      minimized: win.isMinimized(),
      focused: win.isFocused(),
      hiddenToTray: mainWindowController.isHiddenToTray(),
    });
  };
  win.on("show", logWindowEvent("show"));
  win.on("hide", logWindowEvent("hide"));
  win.on("focus", logWindowEvent("focus"));
  win.on("blur", logWindowEvent("blur"));
  win.on("minimize", logWindowEvent("minimize"));
  win.on("restore", logWindowEvent("restore"));

  // Restore maximized state inside `ready-to-show` — calling `maximize()` on a
  // still-hidden window is unreliable on Windows/Linux (the OS may discard it).
  // `ready-to-show` fires for both visible-launch AND tray/headless-launch paths
  // (it only signals the renderer is ready; we just skip the show() call below
  // for tray), so this covers both. Listener was already wired at construction.
  // Fullscreen is intentionally not restored: macOS fullscreen has no draggable
  // title bar, and a stale saved state would leave the window stuck.
  if (savedWindowState?.isMaximized) {
    win.once("ready-to-show", () => {
      if (win && !win.isDestroyed()) win.maximize();
    });
  }

  // Show window only after content has painted — prevents white flash on cold boot
  // Skip when starting headlessly — tray is the entry point
  if (!launchState.startHidden) {
    win.once("ready-to-show", () => {
      if (mainWindowController.isHiddenToTray()) {
        mainWindowLog.info("Skipping ready-to-show because window is hidden to tray");
        return;
      }
      mainWindowController.allowShow("ready-to-show");
      mainWindowLog.info("ready-to-show -> showing window");
      win?.show();
    });
  }

  // Keep native background in sync when OS switches light↔dark while theme is 'system'
  const themeListener = () => {
    const theme = settingsManager.get().theme;
    if ((!theme || theme === "system") && win && !win.isDestroyed()) {
      win.setBackgroundColor(resolveThemeBg("system"));
    }
    miniModeManager.refreshTheme();
  };

  nativeTheme.on("updated", themeListener);

  setTelemetryWindow(win);

  win.webContents.on("render-process-gone", (_event, details) => {
    const message = `Renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`;
    writeProcessLifecycleEventSync("main-window.render-process-gone", { ...details });
    performanceFlightRecorder.removeRenderer(mainWebContentsId);
    mainWindowLog.error(message);
    writeDiagnosticEntrySync("MainWindow", message);
    if (details.reason === "clean-exit") return;

    setTimeout(() => {
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
      mainWindowLog.warn("Reloading renderer after render-process-gone");
      win.webContents.once("did-finish-load", attachPerformanceProfile);
      win.webContents.reload();
    }, 250);
  });

  win.webContents.on("unresponsive", () => {
    const message = "Renderer became unresponsive";
    writeProcessLifecycleEventSync("main-window.unresponsive");
    performanceFlightRecorder.captureMain("renderer-unresponsive");
    performanceFlightRecorder.captureRenderer(mainWebContentsId, "renderer-unresponsive");
    mainWindowLog.warn(message);
    writeDiagnosticEntrySync("MainWindow", message);
  });

  win.webContents.on("responsive", () => {
    writeProcessLifecycleEventSync("main-window.responsive");
    mainWindowLog.info("Renderer became responsive");
  });

  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      const message = `Renderer main frame failed to load: code=${errorCode} description=${errorDescription} url=${validatedURL}`;
      writeProcessLifecycleEventSync("main-window.did-fail-load", {
        errorCode,
        errorDescription,
        validatedURL,
      });
      mainWindowLog.error(message);
      writeDiagnosticEntrySync("MainWindow", message);
    },
  );

  win.on("close", (event) => {
    writeProcessLifecycleEventSync("main-window.close", {
      isQuitting,
      defaultPrevented: event.defaultPrevented,
      backgroundServiceEnabled: backgroundService.isEnabled(),
      hiddenToTray: mainWindowController.isHiddenToTray(),
    });
  });

  win.on("closed", () => {
    writeProcessLifecycleEventSync("main-window.closed", { isQuitting });
    sessionViewIpcBroker.removeTarget(mainWebContentsId);
    rendererResponsivenessMonitor.remove(mainWebContentsId);
    performanceFlightRecorder.removeRenderer(mainWebContentsId);
    deauthorizeIpc();
    win?.removeListener("maximize", emitWindowMaximizedState);
    win?.removeListener("unmaximize", emitWindowMaximizedState);
    win?.removeListener("enter-full-screen", emitWindowFullScreenState);
    win?.removeListener("leave-full-screen", emitWindowFullScreenState);
    detachWindowStateTracking();
    nativeTheme.removeListener("updated", themeListener);
    mainWindowController.detach();
    // chat popouts are owned by the main window. Closing the
    // main window must close them too — they share the main process's auth
    // and SDK state, so leaving them open after the main window is gone
    // would orphan them.
    chatWindowManager.closeAll();
    setTelemetryWindow(null);
    win = null;
  });

  function handleLinkOpen(url: string): void {
    const lower = url.toLowerCase();
    if (lower.startsWith("local-file:") || lower.startsWith("file:")) {
      openLocalFileSafe(url, WORKSPACE_DIR)
        .then((result) => {
          if (!result.success && win && !win.isDestroyed()) {
            win.webContents.send("file:openError", result.error);
          }
        })
        .catch(() => {});
    } else {
      openExternalSafe(url);
    }
  }

  // Open external links in the default browser (protocol-restricted)
  // local-file: links are opened via shell.openPath with executable-type blocking.
  win.webContents.setWindowOpenHandler(({ url }) => {
    handleLinkOpen(url);
    return { action: "deny" };
  });
  installNativeTitleSync(win, getEffectiveAppMode);

  // Prevent in-app navigation for clicked links (e.g. markdown links)
  win.webContents.on("will-navigate", (event, url) => {
    // Allow Vite dev server reloads (HMR full-reload fallback)
    if (!isPackaged && isDevServerNavigation(VITE_DEV_SERVER_URL, url)) return;
    event.preventDefault();
    handleLinkOpen(url);
  });

  // Show spellcheck suggestions and standard editing actions on right-click
  win.webContents.on("context-menu", async (_event, params) => {
    // Suppress native menu when renderer has its own custom context menu (e.g. Radix ContextMenu)
    try {
      const hasCustomMenu = await win!.webContents.executeJavaScript(
        "!!window.__customContextMenuActive",
      );
      if (hasCustomMenu) return;
    } catch {
      // If the check fails, fall through to native menu
    }
    const menuItems: Electron.MenuItemConstructorOptions[] = [];
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions) {
        menuItems.push({
          label: suggestion,
          click: () => win!.webContents.replaceMisspelling(suggestion),
        });
      }
      menuItems.push({
        label: "Add to Dictionary",
        click: () =>
          win!.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      menuItems.push({ type: "separator" });
    }
    menuItems.push(
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { role: "selectAll", enabled: params.editFlags.canSelectAll },
    );
    Menu.buildFromTemplate(menuItems).popup({ window: win! });
  });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL).catch((err) => {
      log.error("Failed to load renderer:", err);
    });
  } else {
    win.loadURL("marshal://app/index.html").catch((err) => {
      log.error("Failed to load renderer:", err);
    });
  }

  // Backend-polymorphic auto-sign-in once the renderer can receive events.
  const machinery = authMachinery;
  if (machinery) {
    win.webContents.once("did-finish-load", () => {
      // Fire-and-forget — state pushed via gatewayAuth:stateChange.
      void machinery.tryAutoSignIn();
    });
  }

  // Ctrl+Shift+F12 to toggle DevTools in any build
  globalShortcut.unregister("CommandOrControl+Shift+F12");
  globalShortcut.register("CommandOrControl+Shift+F12", () => {
    win?.webContents.toggleDevTools();
  });
  showHideShortcutController.sync();

  // Initialize system tray icon (Windows: single-click toggles; macOS: menu bar icon)
  trayManager.init(
    win,
    process.env.VITE_PUBLIC,
    () => {
      app.quit();
    },
    () => {
      mainWindowController.allowShow("tray-manager");
    },
    () => {
      mainWindowController.hideToTray();
    },
  );

  applyEffectiveAppMode();

  miniModeManager.setBackgroundEnabled(backgroundService.isEnabled());
  miniModeManager.setMiniModeEnabled(!!settingsManager.get().miniModeEnabled);
  miniModeManager.setTheme(settingsManager.get().theme);
  miniModeManager.setMainWindowVisible(!launchState.startHidden);
}

// --- App Lifecycle ---

app.on("window-all-closed", () => {
  writeProcessLifecycleEventSync("app.window-all-closed", {
    backgroundServiceEnabled: backgroundService.isEnabled(),
    platform: process.platform,
  });
  // macOS: keep app running (standard macOS behavior)
  // Windows/Linux: only quit if background service is NOT enabled
  if (process.platform !== "darwin" && !backgroundService.isEnabled()) {
    app.quit();
  }
});

app.on("activate", () => {
  writeProcessLifecycleEventSync("app.activate", {
    windowCount: BrowserWindow.getAllWindows().length,
    hasMainWindow: !!win && !win.isDestroyed(),
  });
  // macOS: clicking the dock icon shows the window even if hidden to tray.
  // Do NOT emit startup telemetry here — `emitWorkspaceFallbackTelemetryIfNeeded`
  // fires once from the `whenReady` path and is one-shot-guarded regardless.
  if (BrowserWindow.getAllWindows().length === 0) {
    // Before the whenReady boot path creates the window, an activate-created
    // window would race protocol/IPC setup and the boot path would then open
    // a second one; the boot path creates the window itself shortly.
    if (mainWindowBootReady) createWindow();
  } else if (win) {
    trayManager.showWindow();
  }
});

app.on("before-quit", (event) => {
  isQuitting = true;
  overlayReview.destroy();
  writeProcessLifecycleEventSync("app.before-quit", {
    appReady: app.isReady(),
    flushing,
    windowCount: BrowserWindow.getAllWindows().length,
  });
  rendererResponsivenessMonitor.stop();
  mainEventLoopDelayMonitor.stop();
  void performanceFlightRecorder.stop();
  if (!app.isReady()) {
    agentMessageOutbox.stop();
    void disposeMarshalRuntime().catch((error) => {
      marshalRuntimeLog.error("Pre-ready disposal failed:", error);
    });
    return;
  }

  globalShortcut.unregisterAll();
  detachApprovalRouter?.();
  detachApprovalRouter = null;
  detachDesktopCapabilities?.();
  detachDesktopCapabilities = null;
  approvalBroker.drainAll();
  relayHostInteractionBridge.stop();
  runtimeUiViews.persistence.flush();
  permissionCardManager.dispose();
  void stopRemoteAccess();
  sessionViewIpcBroker.dispose();
  disposeRelayProviderSettingsHandlers();
  miniModeManager.destroy();
  // close any open chat popouts on app quit. The main window's
  // `closed` handler already calls this for the normal close path, but the
  // forced-quit / mock-mode `app.exit(0)` path bypasses that handler.
  chatWindowManager.closeAll();
  trayManager.destroy();
  // Sync engine + lifecycle teardown is consolidated into `shutdown()` and
  // included in the Promise.all flush below — disposes the lifecycle helper,
  // tears down timers, and drains the state-store write queue in one call.
  heartbeatManager.destroy();
  automationManager.destroy();
  void desktopRuntimeWakes.service.stop();
  keepAwake.destroy();
  powerManager.destroy();
  runtimeAccountsKeepAlive.stop();
  sessionManager.destroyBrowserDaemons();
  if (!flushing) {
    flushing = true;
    if (isMockMode()) {
      event.preventDefault();
      void disposeMarshalRuntime()
        .catch((error) => marshalRuntimeLog.error("Mock-mode disposal failed:", error))
        .finally(() => {
          agentMessageOutbox.stop();
          app.exit(0);
        });
      return;
    }
    event.preventDefault();
    quitLog.info(
      "Flushing settings, memory, agent messages, audit log, diagnostics, local telemetry, sync state, and SDK sessions...",
    );
    let timedOut = false;
    // Flush any pending debounced preference write synchronously before the
    // async flushes start — preferences:set is debounced 300ms by default, so
    // a quit triggered shortly after the user changed (e.g.) Co-Create zoom
    // would otherwise discard the change.
    preferencesHandle.flush();
    Promise.race([
      Promise.all([
        flushSettingsWrite(),
        agentMessageOutbox.shutdown(),
        ...(runtimeUiAttachmentStorePromise
          ? [runtimeUiAttachmentStorePromise.then((store) => store.dispose())]
          : []),
        externalOperationRegistry.shutdown(),
        mcpStore.flush(),
        commandCenterManager.flush(),
        flushMemoryWrite(),
        auditLogger.flush(),
        flushDiagnostics(),
        requestRendererTelemetryFinalization().then(() => localTelemetryStore.flush()),
        (async () => {
          await relayCoordinator.stop();
          unregisterWhatsAppRuntime?.();
          unregisterWhatsAppRuntime = undefined;
          await whatsappFixedAgentRuntime?.dispose();
          await whatsappService.dispose();
          unregisterWhatsAppProvider();
          whatsappProviderComposition.dispose();
          relayProviderRegistry.dispose();
          relayDatabase.close();
        })(),
        disposeMarshalRuntime(),
        backend.dispose(),
        runtimeAccounts.stop(),
        sessionManager.gracefulStop(),
      ]),
      new Promise<void>((r) =>
        setTimeout(() => {
          timedOut = true;
          r();
        }, 5_000),
      ),
    ])
      .catch((err) => quitLog.error("Flush failed:", err))
      .finally(async () => {
        if (timedOut) {
          // gracefulStop() is still in flight — the CLI subprocess's piped
          // stdio will keep libuv alive past app.quit(). SIGKILL it.
          quitLog.warn("Flush exceeded 5s — force-killing backend subprocess");
          writeDiagnosticEntrySync("quit", "Flush exceeded 5s — force-killing backend subprocess");
          try {
            sessionManager.forceKill();
          } catch (err) {
            quitLog.error("forceKill failed:", err);
          }
        }
        writeProcessLifecycleEventSync("app.before-quit.flush-complete", {
          timedOut,
        });
        // SIGKILL ourselves to bypass Node.js environment teardown entirely.
        // `app.exit(0)` and `process.exit(0)` both run `node::FreeEnvironment`,
        // which invokes N-API finalizers that have self-deadlocked on
        // `uv_mutex_lock` during shutdown.
        // Settings/memory/audit/diagnostics flushes are already on disk; the SDK
        // subprocess has been destroyed (or SIGKILL'd above on the timeout path).
        process.kill(process.pid, "SIGKILL");
      });
  }
});

app.on("will-quit", (_event) => {
  writeProcessLifecycleEventSync("app.will-quit", {
    flushing,
    windowCount: BrowserWindow.getAllWindows().length,
  });
});

app.on("quit", (_event, exitCode) => {
  crashDiagnostics.stop("app.quit");
  writeProcessLifecycleEventSync("app.quit", { exitCode });
});

app.on("child-process-gone", (_event, details) => {
  writeProcessLifecycleEventSync("app.child-process-gone", { ...details });
  log.warn("Electron child process gone:", JSON.stringify(details));
});

// Register local-file: protocol for serving local images in chat.
// rehype-harden blocks file: URLs, so we use a custom scheme that bypasses the blocklist.
// Register marshal: as the renderer app protocol — grantFileProtocolExtraPrivileges:false
// strips the privileges file:// needs for asar reads on Windows; the custom scheme avoids that.
// Must be called before app.whenReady().
protocol.registerSchemesAsPrivileged([
  { scheme: "local-file", privileges: { supportFetchAPI: true, stream: true, corsEnabled: true } },
  {
    scheme: "local-preview",
    privileges: { supportFetchAPI: true, stream: true, corsEnabled: true },
  },
  {
    // Canonical packaged renderer origin. The hard identity cutover intentionally
    // starts with a fresh Chromium storage partition.
    scheme: "marshal",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

// Dev and packaged instances get separate locks via different userData paths.
writeProcessLifecycleEventSync("main.bootstrap.composition.ready");
const gotTheLock = isMockMode() || app.requestSingleInstanceLock();
log.info(`Single-instance lock: gotTheLock=${gotTheLock}, isPackaged=${app.isPackaged}`);
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // Focus existing window if someone tries to open a second instance
    if (win) {
      trayManager.showWindow();
    }
  });
  const captureMarshalRuntimeStartupFailure = (
    error: unknown,
    options: { readonly blockRetry: boolean },
  ) => {
    if (options.blockRetry) marshalRuntimeHost.blockStartup(error);
    runtimeAcceptanceHarness?.captureStartupError(error);
    const runtimeFailure = summarizeError(error);
    writeProcessLifecycleEventSync("marshal-runtime.host.failed", {
      error: runtimeFailure,
    });
    marshalRuntimeLog.error("Startup failed:", runtimeFailure);
  };
  const startMarshalRuntimeHost = async () => {
    try {
      await marshalRuntimeHost.start();
      void marshalSwarmProduction
        .recoverPersistedRuns(swarmDriver)
        .catch((error: unknown) => marshalRuntimeLog.error("Swarm recovery failed:", error));
      const runtimeStatus = marshalRuntimeHost.getStatus();
      const runtimeExtensions = await marshalRuntimeHost.listExtensions();
      const extensions = runtimeExtensions.map(({ identity, version, status }) => ({
        identity,
        version,
        status,
      }));
      void refreshExtensionPromptSnapshot();
      marshalRuntimeLog.info("Host running", {
        runtimePackage: runtimeStatus.runtimePackage,
        extensions,
      });
      writeProcessLifecycleEventSync("marshal-runtime.host.running", {
        lifecycle: runtimeStatus.lifecycle,
        runtimePackage: runtimeStatus.runtimePackage,
        extensions,
      });
    } catch (error) {
      // The host cleans up a failed attempt and explicitly supports retrying on
      // the next API operation. Do not turn a transient package read or
      // extension activation failure into a permanent process-wide block.
      captureMarshalRuntimeStartupFailure(error, { blockRetry: false });
    }
  };
  if (runtimeAcceptanceHarness?.launchProfile === "pre-ready-quit") {
    runtimeAcceptanceHarness.onEvent({ type: "acceptance.pre-ready-quit.requested" });
    app.quit();
  }
  void app.whenReady().then(async () => {
    ensureMacDockPresence(app);
    finalizeSafeStorageAppName(app, safeStorage);
    initializeAppDataDir();
    writeProcessLifecycleEventSync("app.whenReady.start", {
      crashDiagnosticsPaths: crashDiagnostics.paths,
    });
    // Registered before the Runtime host starts: host startup can take minutes
    // on large profiles, and a window created meanwhile (dock activate) must be
    // able to load marshal://app/index.html instead of failing with ERR_FAILED.
    protocol.handle("marshal", makeMarshalHandler(RENDERER_DIST));
    let runtimeDirectoriesReady = true;
    try {
      secureMkdirSync(marshalRuntimeWorkspaceRoot, 0o700);
      secureMkdirSync(marshalRuntimeProtectedResultsRoot, 0o700);
      secureMkdirSync(marshalRuntimeWorktreeRoot, 0o700);
      secureMkdirSync(marshalRuntimeTrustedExtensionRoot, 0o700);
    } catch (error) {
      runtimeDirectoriesReady = false;
      captureMarshalRuntimeStartupFailure(error, { blockRetry: true });
    }
    void maybeInstallPackagedMarshalCli({
      isPackaged,
      resourcesPath: process.resourcesPath,
      nodePath: bundledNodePath(process.resourcesPath, process.platform),
    }).catch((error: unknown) => {
      log.warn("Marshal CLI install skipped:", error);
    });
    const deferRuntimeStart = runtimeAcceptanceHarness?.launchProfile === "startup-delay";
    // Pre-warm encryption key cache on the async path. The sync path (via
    // MemoryManager constructor) may have already cached the key, in which
    // case this is a no-op. Running it here also ensures we detect keychain
    // changes early and set wasEncryptionKeyReset() before IPC handlers start.
    await initEncryptionKeyAsync();
    try {
      await agentMessageOutbox.start({ pauseDispatch: true });
      sessionManager.setAgentMessageOutbox(agentMessageOutbox);
    } catch (err) {
      log.child("AgentMessageOutbox").error("Startup failed:", err);
      captureMarshalRuntimeStartupFailure(err, { blockRetry: true });
    }
    if (runtimeDirectoriesReady && !deferRuntimeStart) await startMarshalRuntimeHost();
    if (!isMockMode()) {
      try {
        whatsappFixedAgentRuntime = new WhatsAppFixedAgentRuntime({
          databasePath: path.join(getAppDataDir(), "relay", "whatsapp-fixed-agents.db"),
          account: whatsappProviderComposition.account,
          service: whatsappService,
          sessionManager,
          permissionPolicy,
          bindings: relayCoordinator.bindings,
          media: relayHostMedia,
          topology: {
            provision: (request) =>
              whatsappProviderComposition.communityProvisioning.provision(request),
            getTopology: (account) => whatsappProviderComposition.topology.getTopology(account),
            getGroup: (address) => whatsappProviderComposition.topology.getGroup(address),
            createGroup: (request) =>
              whatsappProviderComposition.managedGroupAdministration.createGroup(request),
            renameGroup: (request) =>
              whatsappProviderComposition.managedGroupAdministration.renameGroup(request),
            retireGroup: (request) =>
              whatsappProviderComposition.managedGroupAdministration.retireGroup(request),
          },
          publication: {
            enqueue: (intent) => relayCoordinator.enqueue(intent),
            publishNow: (intent) => relayCoordinator.publishNow(intent),
          },
        });
        unregisterWhatsAppRuntime = relayCoordinator.registerAccountRuntime(
          whatsappProviderComposition.account,
          {
            start: () => whatsappFixedAgentRuntime!.initialize(),
            stop: async () => undefined,
            routeInbound: (event, context) =>
              whatsappFixedAgentRuntime!.routeInbound(event, context),
            discardInbound: (event) => whatsappFixedAgentRuntime!.discardInbound(event),
            authorizeInteractionSelection: (selection) =>
              whatsappFixedAgentRuntime!.authorizeInteractionSelection(selection),
            ensureSessionAccessPoint: (request) =>
              whatsappFixedAgentRuntime!.ensureSessionAccessPoint(request),
          },
        );
      } catch (error) {
        log.child("WhatsAppFixedAgentRuntime").error("Startup failed:", error);
      }
      await whatsappService
        .initialize()
        .catch((error: unknown) => log.child("WhatsAppService").error("Startup failed:", error));
      await relayCoordinator
        .start()
        .catch((error: unknown) =>
          log.child("RelayExperienceCoordinator").error("Startup failed:", error),
        );
    }
    if (!isMockMode()) runtimeAccountsKeepAlive.start();
    const startupGoalIds = new Set<string>();
    const startupSessions = await sessionManager.listSessions();
    for (const sessionMetadata of startupSessions) {
      const goalId = indexLoadedGoalSession(sessionMetadata.id);
      if (goalId) startupGoalIds.add(goalId);
      // Completed goals start the engine to deliver their result — the outbox
      // record is durable and deduplicated, so this is safe pre-auth. Pursuing
      // goals resume later in whenReady behind the auth check below.
      if (goalManager.getGoal(sessionMetadata.id)?.status === "completed") {
        goalEngine.start(sessionMetadata.id);
      }
    }
    await Promise.all(
      [...startupGoalIds].map((goalId) =>
        agentMessageOutbox.revalidateDeferredGoalMessages(goalId),
      ),
    ).catch((error: unknown) =>
      log.child("AgentMessageOutbox").error("Deferred goal revalidation failed:", error),
    );
    sessionManager.recoverParentReadinessWakesFromPersistence();
    // Agent-requested restart continuity: resolve pending ledger entries,
    // surface a visible system notice in the requesting session, and enqueue
    // a durable wake message so the requester actively resumes — its original
    // turn died with the old process, and without a wake the session would
    // sit idle until a human re-engaged it. Deterministic ids dedupe both
    // paths across a double boot.
    await surfaceCompletedRestartsOnBoot({
      ledgerDir: getAppDataDir(),
      appendSystemNotice: (sessionId, notice) => {
        const message = { role: "system" as const, ...notice };
        const inserted = sessionManager.appendMessage(sessionId, message, {
          preserveContextSummary: true,
        });
        if (inserted) sessionManager.emitPersistedMessage(sessionId, message);
        return inserted;
      },
      enqueueWakeMessage: (input) => agentMessageOutbox.enqueue(input),
      onLifecycleEvent: writeProcessLifecycleEventSync,
    }).catch((error) => log.warn("Agent-requested restart continuity failed:", error));
    await externalOperationRegistry
      .start()
      .catch((err) => log.child("ExternalOperationRegistry").error("Startup failed:", err));
    await workflowManager
      .bootAndReattachInflight()
      .catch((err) => log.warn("Workflow manager boot failed:", err));
    // Reload memories now that the key is guaranteed available — the constructor
    // runs before app.ready and safeStorage may return null on Windows.
    memoryManager.reload();
    writeProcessLifecycleEventSync("whenReady.memoryReloaded", {});
    commandCenterManager.refresh();
    writeProcessLifecycleEventSync("whenReady.commandCenterRefreshed", {});
    // Restart continuity for pursuing goals — deliberately after memory reload so the first resumed continuation composes against
    // loaded state, and gated on a verified signed-in backend so an offline or
    // signed-out boot defers instead of feeding the engine's error budget.
    // Deferred goals stay `pursuing` and are woken by the authenticated
    // transition recorded in a later checkAuthStatus (renderer auth polls,
    // post-login verification), a runtime switch's first verified check, or
    // opening the session. The engine itself additionally yields for
    // controller-owned sessions, inactive-runtime sessions, and non-pursuing
    // goals, which keep their exact state.
    // Fire-and-forget: the auth check (and its one bounded retry) must not
    // hold up the rest of whenReady (IPC registration, window boot).
    void (async () => {
      try {
        let startupAuth = await sessionManager.checkAuthStatus();
        if (!startupAuth.isAuthenticated) {
          // One bounded retry heals a transient early-boot check failure
          // without waiting on a renderer-driven poll; a genuinely signed-out
          // boot just performs one extra cheap check.
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          startupAuth = await sessionManager.checkAuthStatus();
        }
        if (startupAuth.isAuthenticated) {
          for (const sessionMetadata of startupSessions) {
            if (goalManager.getGoal(sessionMetadata.id)?.status === "pursuing") {
              goalEngine.start(sessionMetadata.id);
            }
          }
        } else {
          log.info("Startup goal resume deferred: backend not authenticated yet");
        }
      } catch (error) {
        log.warn("Startup goal resume deferred: auth status check failed", error);
      }
    })();
    ipcHandle("encryption:wasKeyReset", () => wasEncryptionKeyReset());
    const registeredChannels = listRegisteredIpcChannels();
    const channelBatchSize = 30;
    writeProcessLifecycleEventSync("ipc.handlers.registered", {
      count: registeredChannels.length,
      batchCount: Math.ceil(registeredChannels.length / channelBatchSize),
    });
    for (let index = 0; index < registeredChannels.length; index += channelBatchSize) {
      writeProcessLifecycleEventSync("ipc.handlers.registered.batch", {
        batchIndex: index / channelBatchSize,
        channels: registeredChannels.slice(index, index + channelBatchSize),
      });
    }

    // MCP store: load + decrypt persisted OAuth tokens, then migrate/prune/discover.
    // Deferred to here (post-app-ready) so the first safeStorage access doesn't lock
    // the macOS keychain item name to "Chromium Safe Storage" (Electron #45328).
    const initialCustomMcpServers = mcpStore.initPostReady();
    sessionManager.mcpStatus.setCustomMcpServers(initialCustomMcpServers);
    // Discover MCP tools at startup (not per-session — avoids spawning on every chat).
    void mcpStore
      .discoverTools(buildMcpConfig(WORKSPACE_DIR, initialCustomMcpServers, isPackaged))
      .catch((err) => mcpLog.warn("Tool discovery failed:", err));

    // Load background service settings before createWindow so window starts
    // in the correct show/hide state
    log.info("Loading background service settings...");
    backgroundService.load();

    // Exclude M-owned data from macOS backup (idempotent, fire-and-forget)
    excludeMDataFromBackup(getAppDataDir());

    // Install certificate pinning for high-value endpoints (SF-17 compliance).
    // Skip in E2E/mock mode — pin checks against test/mock servers would cause spurious failures.
    if (!isMockMode()) {
      session.defaultSession.setCertificateVerifyProc((request, callback) => {
        try {
          // If Chromium's default verification failed → reject (never weaken)
          if (request.verificationResult !== "net::OK") {
            callback(-2);
            return;
          }
          const pinOk = verifyCertificateChain(request.hostname, request.certificate);
          callback(pinOk ? 0 : -2);
        } catch (err) {
          // Fail-open: setCertificateVerifyProc REPLACES Chromium's verification.
          // An unhandled throw kills ALL HTTPS. Chromium's own validation already
          // passed (verificationResult === 'net::OK'), so baseline TLS holds.
          log.child("CertPin").error("Unexpected error, allowing connection:", err);
          reportPinError(request.hostname, err);
          callback(0);
        }
      });
    }

    wireAppModeController({ settingsManager, applyEffectiveAppMode });
    if (!isQuitting) agentMessageOutbox.resumeAfterRuntimeReset();

    // Serve local images via local-file: protocol.
    // Security: workspace sandbox + extension allowlist + magic bytes validation.
    // corsEnabled is set on the scheme so renderer fetch() can download images
    // (used by streamdown's inline image download button). Responses include
    // the canonical image-protocol header set so CORS checks pass.
    protocol.handle("local-file", async (request) => {
      // Only allow GET/HEAD — reject anything else (e.g. rogue OPTIONS from
      // custom-header fetches) before entering the validation pipeline.
      if (request.method !== "GET" && request.method !== "HEAD") {
        return addImageProtocolHeaders(new Response("Method Not Allowed", { status: 405 }));
      }

      const url = new URL(request.url.replace(/^local-file:/, "file:"));
      const filePath = path.resolve(
        decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, "$1"),
      );

      // Layer 1: extension allowlist
      if (!isImageExtension(filePath)) {
        return addImageProtocolHeaders(new Response("Forbidden", { status: 403 }));
      }

      // Layer 2: workspace directory sandbox — only serve files from WORKSPACE_DIR.
      // Resolve symlinks/junctions to prevent a link inside the workspace pointing outside.
      let realPath: string;
      try {
        realPath = await fs.promises.realpath(filePath);
      } catch {
        return addImageProtocolHeaders(new Response("Not Found", { status: 404 }));
      }
      if (!isInsideWorkspace(realPath, WORKSPACE_DIR)) {
        return addImageProtocolHeaders(new Response("Forbidden", { status: 403 }));
      }

      // Fetch the validated+resolved path (not the original URL) to prevent parsing divergence.
      const validatedUrl = pathToFileURL(realPath).href;

      // SVG is text-based (no magic bytes) — serve if extension + sandbox pass.
      // SECURITY: Safe ONLY because SVGs render via <img> tag (scripts blocked).
      // Never serve SVGs for <object>/<embed>/<iframe> without sanitization.
      if (path.extname(realPath).toLowerCase() === ".svg") {
        return addImageProtocolHeaders(await net.fetch(validatedUrl));
      }

      // Layer 3: magic bytes validation for binary image formats
      if (!(await hasImageMagicBytes(realPath))) {
        return addImageProtocolHeaders(new Response("Forbidden", { status: 403 }));
      }

      return addImageProtocolHeaders(await net.fetch(validatedUrl));
    });

    protocol.handle("local-preview", async (request) => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return addImageProtocolHeaders(new Response("Method Not Allowed", { status: 405 }));
      }

      const requestUrl = new URL(request.url);
      const pathnameParts = requestUrl.pathname.split("/").filter(Boolean);
      if (requestUrl.hostname !== "preview" || pathnameParts.length < 2) {
        return addImageProtocolHeaders(new Response("Forbidden", { status: 403 }));
      }

      const [rootToken, ...relativeParts] = pathnameParts;
      const decodedRoot = decodeURIComponent(rootToken);
      if (!decodedRoot || decodedRoot === "__relative__") {
        return addImageProtocolHeaders(new Response("Forbidden", { status: 403 }));
      }

      const rootDir = path.resolve(decodedRoot.replace(/^\/([A-Za-z]:)/, "$1"));
      if (!isInsideWorkspace(rootDir, WORKSPACE_DIR)) {
        return addImageProtocolHeaders(new Response("Forbidden", { status: 403 }));
      }

      const requestedPath = path.resolve(
        rootDir,
        ...relativeParts.map((part) => decodeURIComponent(part)),
      );
      if (!isInsideDirectory(requestedPath, rootDir)) {
        return addImageProtocolHeaders(new Response("Forbidden", { status: 403 }));
      }

      let realRoot: string;
      let realPath: string;
      try {
        [realRoot, realPath] = await Promise.all([
          fs.promises.realpath(rootDir),
          fs.promises.realpath(requestedPath),
        ]);
      } catch {
        return addImageProtocolHeaders(new Response("Not Found", { status: 404 }));
      }

      if (!isInsideWorkspace(realRoot, WORKSPACE_DIR) || !isInsideDirectory(realPath, realRoot)) {
        return addImageProtocolHeaders(new Response("Forbidden", { status: 403 }));
      }

      return addImageProtocolHeaders(await net.fetch(pathToFileURL(realPath).href));
    });

    log.info("Initializing app wiring...");
    writeProcessLifecycleEventSync("whenReady.beforeAppWiring", {});
    initAppWiring();
    await remoteAccessController.start();
    writeProcessLifecycleEventSync("whenReady.beforeCreateWindow", {});
    log.info("Creating main window...");
    mainWindowBootReady = true;
    createWindow();
    writeProcessLifecycleEventSync("whenReady.afterCreateWindow", {});
    log.info("Main window created");
    if (runtimeDirectoriesReady && deferRuntimeStart) void startMarshalRuntimeHost();

    emitWorkspaceFallbackTelemetryIfNeeded(workspaceResolution);

    // Initialize the memory provider before session creation (cold-start issue).
    // Remote persistence continues in the background; block here so recall cannot
    // run before the provider bootstrap completes.
    await memoryManager.initializeSessionStart().catch((err) => {
      log.child("Memory").warn("Failed to bootstrap memory cache:", err);
    });

    heartbeatManager.restore();
    applyCurrentKeepAwakeSettings();

    automationManager.restore();
    desktopRuntimeWakes.service.start();
    initBundledSkills(process.env.APP_ROOT, app.getVersion());

    // Purge sessions exceeding retention policy (default 90 days, 0 = disabled)
    const retentionDays = settingsManager.get().sessionRetentionDays ?? 90;
    sessionManager.purgeExpiredSessions(retentionDays).catch((err) => {
      log.child("SessionManager").error("Session retention cleanup failed:", err);
    });

    // In dev mode, skip auto-connecting relay and background notifications
    // to avoid interfering with the installed production instance.
    if (isDevMode()) {
      log.info(
        "⚡ DEV MODE — skipping relay auto-connect, " +
          "background service notifications. Use the UI to connect manually.",
      );
    }

    // Notify user that M is running in the background on OS startup
    if (!isDevMode() && backgroundService.isEnabled()) {
      setTimeout(() => {
        notificationRouter.notify({
          title: "Marshal is running in the background",
          body: "Automations and services are active. Click here to open.",
          suppressWhenMiniMode: true,
        });
      }, 2000);
    }

    // Wire tray status updates from heartbeat and automation managers
    heartbeatManager.setUrgentItemCallback((source, summary, url) => {
      notificationRouter.notify({
        title: `⚠️ ${APP_NAME} Heartbeat: ${source}`,
        body: summary,
        url,
        miniModeType: "heartbeat-urgent",
        miniModeStatusOverride: "heartbeat",
      });
    });
    heartbeatManager.setErrorCallback((title, body) => {
      notificationRouter.notify({
        title: `❌ ${APP_NAME}: ${title}`,
        body,
        miniModeType: "heartbeat-error",
        miniModeStatusOverride: "broken-heart",
      });
    });
    heartbeatManager.setStatusCallback((running, success, label) => {
      trayManager.setStatus(running ? "running" : "idle", label);
      const didSucceed = success !== false;
      miniModeManager.setHeartbeatRunning(running, didSucceed);
    });

    automationManager.setRunUpdateCallback((run) => {
      if (run.status === "running") {
        trayManager.setStatus("running", "Automation running...");
        miniModeManager.setAutomationRunning(true, false);
      } else {
        trayManager.setStatus("idle", "Idle");
        miniModeManager.setAutomationRunning(false, run.status === "completed");
        if (run.status === "completed") {
          const wf = automationManager.list().find((w) => w.id === run.automationId);
          const summary = run.finalOutput?.slice(0, 120) ?? "Completed successfully";
          notificationRouter.notify({
            title: `✓ ${wf?.name ?? "Automation"} complete`,
            body: summary,
            sessionId: run.sessionId,
            miniModeType: "automation-complete",
            miniModeStatusOverride: "party",
          });
        } else if (run.status === "failed") {
          const wf = automationManager.list().find((w) => w.id === run.automationId);
          const errMsg =
            run.stepResults.find((s) => s.status === "failed")?.error?.slice(0, 120) ??
            "A step failed";
          notificationRouter.notify({
            title: `✗ ${wf?.name ?? "Automation"} failed`,
            body: errMsg,
            sessionId: run.sessionId,
            miniModeType: "automation-failed",
            miniModeStatusOverride: "crying",
          });
        }
      }
    });

    // A background Bash command or Agent subagent (run_in_background) settling
    // after its turn already ended — surface it the same way an unattended
    // automation run does, since the session that started it may be idle or
    // out of view by the time the task finishes.
    sessionManager.setBackgroundTaskCallback((update) => {
      const icon = update.status === "completed" ? "✓" : update.status === "stopped" ? "⏹" : "✗";
      notificationRouter.notify({
        title: `${icon} Background task ${update.status}`,
        body: update.summary || update.description || "A background task finished.",
        sessionId: update.sessionId,
        onlyWhenUnfocused: true,
      });
    });
  });
}
