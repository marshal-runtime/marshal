import type { ExperimentFlags } from "@common/marshal-ipc-contract";
import { createLogger } from "@common/marshal-logger";
import { DEFAULT_RUNTIME_ID } from "@common/runtime-config";
import { MARSHAL_RUNTIME_DEFAULT_WORKSPACE } from "@common/runtime-ui";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { QueryClientProvider } from "@tanstack/react-query";
import { useState, useRef, useEffect, useCallback } from "react";
import { toast } from "sonner";

import { GatewayAppShell } from "@/features/auth/gateway/GatewayAppShell";
import { GatewayAuthGate } from "@/features/auth/gateway/GatewayDeviceAuthGate";
import { useGatewayAuth } from "@/features/auth/gateway/useGatewayDeviceAuth";
import { RuntimeAuthGate } from "@/features/auth/runtime/RuntimeAuthGate";
import { useRuntimeAuth } from "@/features/auth/runtime/useRuntimeAuth";
import { sessionGateStage } from "@/features/auth/sessionGate";
import { useAuthFlow } from "@/features/auth/useAuthFlow";
import { RuntimeUiHost, RuntimeUiTrailingCards, marshalMonacoEditor } from "@/features/runtime-ui";
import { SessionDock } from "@/features/runtime-ui/dock/SessionDock";
import { RuntimeUiApplicationWorkspace } from "@/features/runtime-ui/RuntimeUiNavigation";
import {
  TelemetryPath_App,
  TelemetryPath_Session,
  SimplePropertyMonitor_HasSession,
} from "@/services/telemetry/schema";

import { applyTheme } from "./app-theme";
import { TooltipProvider } from "./components/marshal-ui/marshal-tooltip";
import { Toaster } from "./components/ui/sonner";
import { ActivitiesPanel } from "./features/activities/ActivitiesPanel";
import { AppNoticeRail } from "./features/app-notices";
import { AuthScreen } from "./features/auth/AuthScreen";
import { AutomationsPanel } from "./features/automations/AutomationsPanel";
import { ChatPanel, ChatPanelRef } from "./features/chat";
import { CreatePanel } from "./features/create/CreatePanel";
import { SessionActivityPanel } from "./features/create/SessionActivityPanel";
import { HeartbeatPanel } from "./features/heartbeat/HeartbeatPanel";
import { HotkeysRoot } from "./features/hotkeys";
import { IntegrationsPanel } from "./features/integrations/IntegrationsPanel";
import { McpOAuthDialog } from "./features/plugins/McpOAuthDialog";
import { PluginsPanel } from "./features/plugins/PluginsPanel";
import { SettingsPanel } from "./features/settings/SettingsPanel";
import { useRuntimeStartupSelection, useSettings } from "./features/settings/useSettings";
import { WorkflowsPanel } from "./features/workflows/WorkflowsPanel";
import { wireMcpOAuth } from "./hooks/mcp-oauth-store";
import { useWindowInactiveAttribute } from "./marshal/windowing/useWindowInactiveAttribute";
import { resolveRuntimeRoot } from "./runtime-root";
import { queryClient } from "./services/query/query-client";
import { SessionScope, TelemetryInstanceProvider } from "./services/telemetry";
import { RenderScenarioProvider } from "./services/telemetry/RenderScenarioProvider";
import { LayoutProvider } from "./shared/contexts/marshal-layout-provider";
import { useLayout } from "./shared/contexts/useMarshalLayout";
import { useSessions, wireSessionsApi } from "./shared/hooks/useSessions";
import { getAppHotkeyState } from "./shell/appHotkeyState";
import { DRAG_STYLE } from "./shell/drag-styles";
import { Header } from "./shell/Header";
import { useSidebarToggleHotkey } from "./shell/interaction/use-sidebar-toggle-hotkey";
import { LeftNav } from "./shell/LeftNav";
import { useChatNavigationHotkeys } from "./shell/useChatNavigationHotkeys";
import { useNavigation, isNavView } from "./shell/useNavigation";
import type { NavigationApplyEvent } from "./shell/useNavigation";
import { useSessionManager } from "./shell/useSessionManager";
import { useWorkspaceSessions } from "./shell/useWorkspaceSessionCatalog";
import { useChatWindows } from "./shell/windowing/use-chat-windows";

const log = createLogger("App");

type AppProps = {
  runtimeId: string;
  onSignOut: () => void;
};

function App({ runtimeId, onSignOut }: AppProps) {
  const [pendingSkill, setPendingSkill] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState<boolean | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [experiments, setExperiments] = useState<ExperimentFlags>({});
  const [showHiddenExperiments, setShowHiddenExperiments] = useState(false);
  const canShowHiddenExperiments = __MARSHAL_DEV_FEATURES__;
  const chatPanelRef = useRef<ChatPanelRef>(null);

  // Ref-based callback for navigation history restore — avoids circular dependency
  // between useNavigation (needs onApply) and useSessionManager (provides handleSessionSelect).
  const sessionSelectRef = useRef<(sessionId: string) => void>(() => {});
  const workspaceSwitchRef = useRef<(workspaceName: string) => void>(() => {});
  const navigationEpochRef = useRef(0);

  const handleNavApply = useCallback((event: NavigationApplyEvent) => {
    navigationEpochRef.current += 1;
    if (!event.isHistoryNavigation) return;
    if (isNavView(event, "chat") && event.state?.sessionId) {
      sessionSelectRef.current(event.state.sessionId);
    }
    if (isNavView(event, "create") && event.state?.workspaceName != null) {
      workspaceSwitchRef.current(event.state.workspaceName);
    }
  }, []);

  const {
    currentView,
    editAutomationName,
    pluginsTab,
    scrollToSection,
    workflowsState,

    navigate,
    dismissPanel,
    goBack,
    goForward,
    canGoBack,
    canGoForward,
  } = useNavigation({ onApply: handleNavApply });
  const { sidebarCollapsed, toggleSidebar } = useLayout();

  const handleNavigateFile = useCallback(
    (_filePath: string | undefined, workspaceName: string) => navigate("create", { workspaceName }),
    [navigate],
  );

  // chat popout windows. The hook resolves to a no-op fallback
  // when the IPC bridge isn't present (mock mode, web preview).
  const { isAvailable: chatWindowsAvailable, openInNewWindow } = useChatWindows();
  const handleOpenSessionInNewWindow = useCallback(
    (sessionId: string, bounds?: { x: number; y: number }) => {
      void openInNewWindow(sessionId, bounds);
    },
    [openInNewWindow],
  );

  // Reset hidden experiments visibility when navigating away from settings
  const [prevView, setPrevView] = useState(currentView);
  if (currentView !== prevView) {
    setPrevView(currentView);
    if (prevView === "settings") {
      setShowHiddenExperiments(false);
    }
  }

  const { sessions } = useSessions();

  const { restoreFromSessions } = useWorkspaceSessions();

  const {
    activeSessionId,
    handleNewChat,
    handleSessionSelect,
    handleDeleteSession,
    handleSoulChange,
    handleWorkspaceRoleChange,
  } = useSessionManager({
    chatPanelRef,
    navigate,
    onSessionsLoaded: restoreFromSessions,
  });
  const activeRuntimeSession = sessions.find((session) => session.id === activeSessionId);
  const runtimeExtensionsScope = activeSessionId
    ? {
        sessionId: activeSessionId,
        workspaceName: activeRuntimeSession?.workspaceName ?? MARSHAL_RUNTIME_DEFAULT_WORKSPACE,
      }
    : undefined;
  const getNavigationEpoch = useCallback(() => navigationEpochRef.current, []);
  const handleTrackedNewChat = useCallback(
    (workspaceName?: string) => {
      navigationEpochRef.current += 1;
      return handleNewChat(workspaceName);
    },
    [handleNewChat],
  );
  const handleTrackedSessionSelect = useCallback(
    (sessionId: string) => {
      navigationEpochRef.current += 1;
      return handleSessionSelect(sessionId);
    },
    [handleSessionSelect],
  );

  const [sessionRenameRequest, setSessionRenameRequest] = useState<{
    sessionId: string;
    requestId: number;
  } | null>(null);
  const sessionRenameRequestIdRef = useRef(0);
  if (
    sessionRenameRequest &&
    (sessionRenameRequest.sessionId !== activeSessionId || currentView !== "chat")
  ) {
    setSessionRenameRequest(null);
  }
  const handleSessionRename = useCallback(
    (sessionId: string) => {
      if (sidebarCollapsed) toggleSidebar();
      sessionRenameRequestIdRef.current += 1;
      setSessionRenameRequest({
        sessionId,
        requestId: sessionRenameRequestIdRef.current,
      });
    },
    [sidebarCollapsed, toggleSidebar],
  );
  const handleSessionRenameRequestHandled = useCallback((requestId: number) => {
    setSessionRenameRequest((previous) => (previous?.requestId === requestId ? null : previous));
  }, []);

  const { chatNavigationEnabled, sidebarToggleEnabled } = getAppHotkeyState({ currentView });
  useChatNavigationHotkeys({
    sessions,
    activeSessionId,
    handleNewChat: handleTrackedNewChat,
    handleSessionSelect: handleTrackedSessionSelect,
    handleSessionRename,
    renameEnabled: currentView === "chat",
    enabled: chatNavigationEnabled,
  });
  useSidebarToggleHotkey({
    toggleSidebar,
    enabled: sidebarToggleEnabled,
  });

  useEffect(() => {
    sessionSelectRef.current = handleTrackedSessionSelect;
    workspaceSwitchRef.current = (workspaceName: string) => {
      queryClient.setQueryData(
        ["workspace", "uiState"],
        (old: { activeWorkspace?: string; [k: string]: unknown } | undefined) => {
          if (!old) return old;
          return { ...old, activeWorkspace: workspaceName };
        },
      );
      void window.workspaceAPI?.setActiveWorkspace(workspaceName);
    };
  });

  // Load persisted settings on mount. Theme is applied synchronously from
  // localStorage in main.tsx for flash-free boot; this async load corrects
  // it from the source of truth (marshal-settings.json) in case localStorage was
  // stale or cleared by migration.
  useEffect(() => {
    const loadSettings = async () => {
      if (!window.settingsAPI) return;
      const result = await window.settingsAPI.get();
      if (result.success && result.settings) {
        applyTheme(result.settings.theme || "system");
        if (result.settings.experiments) {
          setExperiments(result.settings.experiments);
        }
      }
    };
    void loadSettings();
  }, []);

  // Prevent Electron from navigating to dropped files (default browser behavior).
  // Only preventDefault — no stopPropagation — so React handlers in FileTree still fire.
  useEffect(() => {
    const preventNav = (e: DragEvent) => e.preventDefault();
    document.addEventListener("dragover", preventNav);
    document.addEventListener("drop", preventNav);
    return () => {
      document.removeEventListener("dragover", preventNav);
      document.removeEventListener("drop", preventNav);
    };
  }, []);

  // Show toast when a local file link fails to open (workspace sandbox, blocked extension, etc.)
  useEffect(() => {
    if (!window.shellAPI?.onFileOpenError) return undefined;
    const unsubscribe = window.shellAPI.onFileOpenError((error: string) => {
      toast.error("Could not open file", { description: error });
    });
    return unsubscribe;
  }, []);

  // Listen for auth errors from main process
  useEffect(() => {
    const authApi = window.runtimeAuthAPI ?? window.copilotAPI;
    if (!authApi?.onAuthError) return undefined;
    const unsubscribe = authApi.onAuthError((error: string) => {
      log.warn("Auth error received:", error);
      setAuthError(error);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const cleanupMcpOAuth = wireMcpOAuth(queryClient);
    const cleanupSessions = wireSessionsApi(queryClient);
    return () => {
      cleanupMcpOAuth();
      cleanupSessions();
    };
  }, []);

  const handleInsertSkill = async (skillName: string) => {
    await handleTrackedNewChat();
    setPendingSkill(skillName);
  };

  const handleOpenCommandCenterSession = useCallback(
    (sessionId: string) => {
      void handleTrackedSessionSelect(sessionId);
      navigate("chat", { sessionId });
    },
    [handleTrackedSessionSelect, navigate],
  );

  // Workflow command-center dispatch creates and seeds the worker session
  // without changing the operator's current view.
  const handleLaunchWorkflowSession = useCallback(
    async ({ title, prompt }: { title: string; prompt: string }) => {
      const result = await window.sessionsAPI?.create(undefined, undefined, {
        name: title,
        setActive: false,
      });
      if (!result?.success || !result.session) {
        toast.error(result?.error ?? "Failed to create session");
        return null;
      }
      const sessionId = result.session.id;
      const sent = await window.copilotAPI?.send(prompt, sessionId);
      if (sent && !sent.success) {
        toast.error(sent.error ?? "Failed to start the session");
        return null;
      }
      return { sessionId, title: result.session.name ?? title };
    },
    [],
  );

  const handleToggleSettings = useCallback(() => {
    navigate(currentView === "settings" ? "chat" : "settings");
  }, [currentView, navigate]);

  const handleGoBack = useCallback(() => {
    goBack();
  }, [goBack]);

  const handleGoForward = useCallback(() => {
    goForward();
  }, [goForward]);

  // Listen for Cmd+, (macOS menu) to toggle settings
  useEffect(() => {
    if (!window.settingsAPI?.onToggle) return undefined;
    return window.settingsAPI.onToggle(handleToggleSettings);
  }, [handleToggleSettings]);

  useHotkeys(
    [
      {
        hotkey: window.platform === "darwin" ? "Meta+[" : "Alt+ArrowLeft",
        callback: handleGoBack,
      },
      {
        hotkey: window.platform === "darwin" ? "Meta+]" : "Alt+ArrowRight",
        callback: handleGoForward,
      },
    ],
    {
      enabled: !!experiments.titleBarNavigation,
      ignoreInputs: false,
      preventDefault: true,
      target: window,
    },
  );

  // Mouse back/forward thumb buttons (XButton1 = button 3, XButton2 = button 4)
  useEffect(() => {
    if (!experiments.titleBarNavigation) return undefined;
    const handler = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault();
        goBack();
      } else if (e.button === 4) {
        e.preventDefault();
        goForward();
      }
    };
    window.addEventListener("mouseup", handler);
    return () => window.removeEventListener("mouseup", handler);
  }, [experiments.titleBarNavigation, goBack, goForward]);

  const handleSignOut = () => {
    setAuthError(null);
    onSignOut();
  };

  const isCreateView = currentView === "create";
  const { ready: windowFocusReady } = useWindowInactiveAttribute();

  return (
    <RenderScenarioProvider view={currentView}>
      {/* TODO(shared-services): provide the editor through shared service injection during Marshal initialization. */}
      <RuntimeUiHost
        activeSessionId={activeSessionId}
        sessions={sessions}
        editor={marshalMonacoEditor}
        fullscreenOverlay={false}
      >
        <div
          className="flex h-full flex-col bg-background"
          data-app-root
          data-window-ready={windowFocusReady ? "" : undefined}
        >
          <TelemetryPath_App>
            <McpOAuthDialog />
            <TelemetryPath_Session>
              <SimplePropertyMonitor_HasSession value={!!activeSessionId} />
            </TelemetryPath_Session>
            <Header
              showNavigation={!!experiments.titleBarNavigation}
              onGoBack={goBack}
              onGoForward={goForward}
              canGoBack={canGoBack}
              canGoForward={canGoForward}
            />
            <AppNoticeRail authError={authError} runtimeId={runtimeId} onSignOut={handleSignOut} />
            {isCreateView ? (
              <CreatePanel isOpen={true} onBack={goBack} onNavigateFile={handleNavigateFile} />
            ) : (
              <div className="flex flex-1 overflow-hidden">
                <div
                  className={`shrink-0 overflow-hidden transition-[width] duration-200 ease-in-out${sidebarCollapsed ? " w-0" : ""}`}
                >
                  <LeftNav
                    activeView={currentView}
                    // Panels used to live behind a "..." overflow with no nav row of their
                    // own, so highlighting the page *underneath* was the only sensible
                    // choice. They are first-class rows now, so `returnToPage` must no
                    // longer drive the highlight or the previous page stays lit while a
                    // panel is open. `returnToPage` still drives `dismissPanel`.
                    highlightedView={
                      currentView === "commandCenter"
                        ? "activities"
                        : currentView === "workflows"
                          ? "automations"
                          : undefined
                    }
                    onViewChange={navigate}
                    onNewChat={handleTrackedNewChat}
                    activeSessionId={activeSessionId}
                    renameSessionRequest={sessionRenameRequest}
                    onRenameSessionRequestHandled={handleSessionRenameRequestHandled}
                    onSessionSelect={handleTrackedSessionSelect}
                    onDeleteSession={handleDeleteSession}
                    navigationKey={`${currentView}:${activeSessionId ?? ""}:${workflowsState?.runId ?? ""}:${workflowsState?.workflowId ?? ""}:${workflowsState?.repoPath ?? ""}`}
                    getNavigationEpoch={getNavigationEpoch}
                    onOpenSessionInNewWindow={
                      chatWindowsAvailable ? handleOpenSessionInNewWindow : undefined
                    }
                    connected={isConnected}
                    onSignOut={handleSignOut}
                    onSettingsAltClick={
                      canShowHiddenExperiments ? () => setShowHiddenExperiments(true) : undefined
                    }
                  />
                </div>
                <main
                  data-vibrancy-opaque
                  className="relative min-w-0 flex-1 overflow-hidden transition-all duration-300"
                >
                  <RuntimeUiApplicationWorkspace>
                    {currentView === "chat" && (
                      <SessionDock
                        chat={
                          <ChatPanel
                            ref={chatPanelRef}
                            sessionId={activeSessionId}
                            pendingSkill={pendingSkill}
                            runtimeUiInline={<RuntimeUiTrailingCards />}
                            onSkillInserted={() => setPendingSkill(null)}
                            onSoulChange={handleSoulChange}
                            onWorkspaceRoleChange={handleWorkspaceRoleChange}
                            onConnectionChange={setIsConnected}
                            onAuthError={(error) => setAuthError(error)}
                          />
                        }
                        renderProgress={(reportContent) => (
                          <SessionActivityPanel
                            sessionId={activeSessionId}
                            layout="dock"
                            onContentChange={reportContent}
                          />
                        )}
                      />
                    )}
                    {currentView === "heartbeat" && (
                      <HeartbeatPanel
                        isOpen={true}
                        onClose={dismissPanel}
                        onOpenSettings={() =>
                          navigate("settings", { scrollToSection: "power-management-section" })
                        }
                      />
                    )}
                    {(currentView === "automations" ||
                      (currentView === "workflows" && !workflowsState)) && (
                      <AutomationsPanel
                        isOpen={true}
                        initialEditAutomationName={editAutomationName}
                        onOpenHeartbeat={() => navigate("heartbeat")}
                        onOpenWorkflow={(workflowId, repoPath) =>
                          navigate("workflows", { workflowId, repoPath })
                        }
                      />
                    )}
                    {currentView === "workflows" && workflowsState && (
                      <WorkflowsPanel
                        onClose={dismissPanel}
                        initialWorkflowId={workflowsState?.workflowId}
                        initialRepoPath={workflowsState?.repoPath}
                        initialRunId={workflowsState?.runId}
                        onNavigateWorkflows={(state) => {
                          if (!state.workflowId && !state.runId && !state.repoPath) {
                            navigate("automations");
                            return;
                          }
                          navigate("workflows", state);
                        }}
                        onOpenSessionInChat={(sessionId) => navigate("chat", { sessionId })}
                        onLaunchSession={handleLaunchWorkflowSession}
                      />
                    )}
                    {(currentView === "activities" || currentView === "commandCenter") && (
                      <ActivitiesPanel
                        isOpen={true}
                        onClose={dismissPanel}
                        initialTab={currentView === "commandCenter" ? "command-center" : "upcoming"}
                        onSessionSelect={async (sessionId) => {
                          await handleTrackedSessionSelect(sessionId);
                          navigate("chat");
                        }}
                        onOpenCommandCenterSession={handleOpenCommandCenterSession}
                        onOpenAutomations={(name) =>
                          navigate("automations", { editAutomationName: name ?? undefined })
                        }
                        onOpenHeartbeat={() => navigate("heartbeat")}
                      />
                    )}
                    {currentView === "integrations" && (
                      <IntegrationsPanel
                        isOpen={true}
                        onClose={dismissPanel}
                        onOpenSettings={() =>
                          navigate("settings", { scrollToSection: "power-management-section" })
                        }
                      />
                    )}
                    {currentView === "plugins" && (
                      <PluginsPanel
                        isOpen={true}
                        onClose={dismissPanel}
                        initialTab={pluginsTab ?? undefined}
                        onInsertSkill={handleInsertSkill}
                        showUiPluginsTab={!!experiments.uiExtensionsSystem}
                        runtimeScope={runtimeExtensionsScope}
                      />
                    )}
                    {currentView === "settings" && (
                      <SettingsPanel
                        isOpen={true}
                        onClose={dismissPanel}
                        onExperimentsChange={setExperiments}
                        showHiddenExperiments={showHiddenExperiments}
                        scrollToSection={scrollToSection}
                        onSignOut={handleSignOut}
                      />
                    )}
                  </RuntimeUiApplicationWorkspace>
                </main>
              </div>
            )}
          </TelemetryPath_App>
        </div>
      </RuntimeUiHost>
    </RenderScenarioProvider>
  );
}

type AppRoutesProps = {
  runtimeId: string;
  onSignOut: () => void;
};

function AppRoutes({ runtimeId, onSignOut }: AppRoutesProps) {
  return (
    <LayoutProvider>
      <App runtimeId={runtimeId} onSignOut={onSignOut} />
      <Toaster position="bottom-right" closeButton />
    </LayoutProvider>
  );
}

function AuthGate({ runtimeId }: { runtimeId: string }) {
  const { isPending: settingsLoading } = useSettings();
  const { stage, actions } = useAuthFlow();

  if (settingsLoading) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center bg-background"
        style={DRAG_STYLE}
      >
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  // Session is gated only on the selected AI runtime.
  // SessionScope mounts when the flow reaches `ready` (→ SessionStart) and
  // unmounts when it leaves `ready`, which fires SessionEnd via the
  // RenderScenarioProvider inside AppRoutes (app close is covered by its pagehide
  // listener). Transient auth failures don't drop `stage` (React Query retains
  // last-good status), so the session isn't split on flaky networks. Pre-ready,
  // no session exists and AuthScreen errors route out-of-session.
  const gateStage = sessionGateStage(stage);
  if (gateStage) {
    return <AuthScreen stage={gateStage} actions={actions} />;
  }

  return (
    <SessionScope>
      <AppRoutes runtimeId={runtimeId} onSignOut={() => void actions.signOutAll()} />
    </SessionScope>
  );
}

function GatewayRoot({ runtimeId }: { runtimeId: string }) {
  const { signOut } = useGatewayAuth();
  // Gateway keeps the "session from mount" behavior: SessionScope here starts
  // the session when the gateway subtree mounts.
  return (
    <SessionScope>
      <GatewayAppShell>
        <AppRoutes runtimeId={runtimeId} onSignOut={() => void signOut()} />
      </GatewayAppShell>
    </SessionScope>
  );
}

function CopilotRuntimeRoot({ runtimeId }: { runtimeId: string }) {
  return <AuthGate runtimeId={runtimeId} />;
}

function GatewayRuntimeRoot({ runtimeId }: { runtimeId: string }) {
  return (
    <GatewayAuthGate>
      <GatewayRoot runtimeId={runtimeId} />
    </GatewayAuthGate>
  );
}

function LocalRuntimeRoot({ runtimeId }: { runtimeId: string }) {
  const auth = useRuntimeAuth(runtimeId);
  return (
    <RuntimeAuthGate auth={auth}>
      <SessionScope>
        <AppRoutes runtimeId={runtimeId} onSignOut={auth.signOut} />
      </SessionScope>
    </RuntimeAuthGate>
  );
}

function RuntimeRoot({ runtimeId }: { runtimeId: string }) {
  const root = resolveRuntimeRoot(runtimeId);
  switch (root) {
    case "copilot":
      return <CopilotRuntimeRoot runtimeId={runtimeId} />;
    case "gateway":
      return <GatewayRuntimeRoot runtimeId={runtimeId} />;
    case "local":
      return <LocalRuntimeRoot runtimeId={runtimeId} />;
  }
  root satisfies never;
  return null;
}

function AppRoot() {
  // Settings remain live, but runtime composition is fixed to the effective
  // startup selection until the process restarts.
  const { settings, isPending } = useSettings();
  const { runtimeSelection, isPending: isRuntimeSelectionPending } = useRuntimeStartupSelection();

  if (isPending || isRuntimeSelectionPending) return null;

  const runtimeId = runtimeSelection?.runtimeId ?? DEFAULT_RUNTIME_ID;
  const telemetryEnabled = settings?.telemetryEnabled ?? true;

  // TelemetryInstanceProvider builds the telemetry instance once and keeps it mounted
  // for the whole app run, so pre-login errors route out-of-session via
  // TelemetryErrorRouter. Each runtime root owns SessionScope and mounts it only
  // after that runtime's auth gate is ready.
  // Do NOT move session start back up here: a provider that spans auth+app and
  // unmounts on auth changes splits one user session into two (SessionEnd +
  // SessionStart) at the backend — the bug the earlier single-provider hoist
  // worked around.
  return (
    <TelemetryInstanceProvider telemetryEnabled={telemetryEnabled}>
      <RuntimeRoot key={runtimeId} runtimeId={runtimeId} />
    </TelemetryInstanceProvider>
  );
}

function AppWithProviders() {
  return (
    <QueryClientProvider client={queryClient}>
      <HotkeysRoot>
        <TooltipProvider>
          <AppRoot />
        </TooltipProvider>
      </HotkeysRoot>
    </QueryClientProvider>
  );
}

export default AppWithProviders;
