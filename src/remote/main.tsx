/* eslint-disable better-tailwindcss/no-unknown-classes -- These scoped classes are defined in remote.css. */
/* eslint-disable react/only-export-components -- Dedicated browser entry mounts the root here. */
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import React, { useEffect, useEffectEvent, useState, useRef, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { applyTheme } from "../app-theme";
import { PanelLeftOpen, FileEdit } from "../components/icons";
import { TooltipProvider } from "../components/marshal-ui/marshal-tooltip";
import { Toaster } from "../components/ui/sonner";
import { ChatPanel, type ChatPanelRef } from "../features/chat/components/ChatPanel";
import { hydrationStore } from "../features/chat/session-state/hydration-store";
import { HotkeysRoot } from "../features/hotkeys";
import { RuntimeUiTrailingCards } from "../features/runtime-ui/cards/ConversationCards";
import { MobileSessionViews } from "../features/runtime-ui/mobile/MobileSessionViews";
import { RuntimeUiHost } from "../features/runtime-ui/RuntimeUiHost";
import { queryClient } from "../services/query/query-client";
import { TelemetryProvider } from "../services/telemetry";
import { LayoutProvider } from "../shared/contexts/marshal-layout-provider";
import { wireQueryInvalidations } from "../shared/hooks/wireQueryInvalidations";
import { ErrorBoundary } from "../shell/ErrorBoundary";
import {
  RemoteAppPane,
  remoteRuntimeEditor,
  useRemoteApplications,
  type RemoteAppOwner,
} from "./Apps";
import { Conversations } from "./Conversations";
import { ProjectPicker } from "./ProjectPicker";
import { registerRemoteServiceWorker } from "./service-worker";
import { remoteTransport } from "./transport";

import "../index.css";
import "./remote.css";

wireQueryInvalidations(queryClient);
hydrationStore.initialize();
void window.settingsAPI
  .get()
  .then((result) => {
    if (result.settings) applyTheme(result.settings.theme ?? "system");
  })
  .catch(() => {
    /* Keep the browser theme during connection recovery. */
  });
const APP_OWNER_KEY = "marshal.remote.app";

function storedAppOwner(): RemoteAppOwner | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(APP_OWNER_KEY) ?? "null");
    if (
      typeof value === "object" &&
      value !== null &&
      "extensionId" in value &&
      "applicationId" in value &&
      typeof value.extensionId === "string" &&
      typeof value.applicationId === "string"
    ) {
      return { extensionId: value.extensionId, applicationId: value.applicationId };
    }
  } catch {
    /* Fresh view. */
  }
  return null;
}

// A tapped notification that had to launch the app arrives as ?session=<id>.
const launchSessionId = new URLSearchParams(location.search).get("session");
if (launchSessionId) {
  localStorage.setItem("marshal.remote.session", launchSessionId);
  history.replaceState(null, "", location.pathname);
}

const CONNECTION_EVENT = "marshal:connection";
// The app can mount before the socket opens, so state is read from the transport
// rather than captured once.
function subscribeConnection(onChange: () => void) {
  window.addEventListener(CONNECTION_EVENT, onChange);
  return () => window.removeEventListener(CONNECTION_EVENT, onChange);
}

function RemoteApp() {
  const [sessionId, setSessionId] = useState<string | null>(() =>
    localStorage.getItem("marshal.remote.session"),
  );
  // Extension app view (survives reload); null = chat view.
  const [appOwner, setAppOwner] = useState<RemoteAppOwner | null>(storedAppOwner);
  const applications = useRemoteApplications();
  const openApp = (owner: RemoteAppOwner | null) => {
    try {
      if (owner) localStorage.setItem(APP_OWNER_KEY, JSON.stringify(owner));
      else localStorage.removeItem(APP_OWNER_KEY);
    } catch {
      /* View state stays in memory. */
    }
    setAppOwner(owner);
    if (owner) setDrawer(false);
  };
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(null);
  const [drawer, setDrawer] = useState(!sessionId);
  const connection = useSyncExternalStore(subscribeConnection, () => remoteTransport.state);
  const [showConnectionBanner, setShowConnectionBanner] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [changingProject, setChangingProject] = useState(false);
  const chatPanelRef = useRef<ChatPanelRef>(null);
  const projectChangeInFlight = useRef(false);
  const selectedIdRef = useRef(sessionId);
  const workspaces = useQuery({
    queryKey: ["remote", "workspaces"],
    queryFn: async () => {
      const result = await window.workspaceAPI.listWorkspaces();
      if (!result.success) throw new Error(result.error ?? "Could not load projects");
      return result.workspaces ?? [];
    },
  });
  const host = useQuery({
    queryKey: ["remote", "host"],
    queryFn: async () => {
      const response = await fetch("/remote/status");
      if (!response.ok) throw new Error("Connection unavailable");
      const value: { computerName?: string } = await response.json();
      return value.computerName ?? "Your Mac";
    },
  });
  const sessions = useQuery({
    queryKey: ["remote", "sessions"],
    queryFn: async () => {
      const result = await window.sessionsAPI.list();
      if (!result.success) throw Error("Could not load sessions");
      return result.sessions ?? [];
    },
  });
  useEffect(() => {
    const resetBanner = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === "connected")
        setShowConnectionBanner(false);
    };
    window.addEventListener(CONNECTION_EVENT, resetBanner);
    // Open views resubscribe through useTransportReconnects; remounting the chat here
    // would reload the whole conversation and drop the keyboard mid-typing.
    remoteTransport.onReconnect = () => {
      void queryClient.invalidateQueries();
    };
    const update = () => {
      void queryClient.invalidateQueries({ queryKey: ["remote", "sessions"] });
    };
    const unsub = window.sessionsAPI.onListChanged(update);
    const unstatus = window.sessionsAPI.onStatusDelta(update);
    const unmeta = window.sessionsAPI.onMetadataChanged(update);
    // iOS does not reliably fire visibilitychange for Home Screen apps, so any of
    // these resume signals re-verifies the socket; only a dead one is replaced.
    const resume = () => {
      if (document.visibilityState === "visible") void remoteTransport.verify();
    };
    // Lets the Mac skip notifying about the thread that is on screen right now.
    const reportPresence = () => {
      remoteTransport
        .invoke("remote:presence", document.visibilityState === "visible")
        .catch(() => {
          /* A new connection starts out as visible. */
        });
      resume();
    };
    document.addEventListener("visibilitychange", reportPresence);
    window.addEventListener("pageshow", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    // Keep retrying rather than parking until an "online" event iOS may never send.
    const offline = () => remoteTransport.refresh();
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener(CONNECTION_EVENT, resetBanner);
      unsub();
      unmeta();
      unstatus();
      document.removeEventListener("visibilitychange", reportPresence);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", offline);
    };
  }, []);
  const select = (id: string) => {
    selectedIdRef.current = id;
    localStorage.setItem("marshal.remote.session", id);
    setSessionId(id);
    setDrawer(false);
    setError("");
  };
  const openFromNotification = useEffectEvent((id: string) => {
    openApp(null);
    select(id);
  });
  useEffect(() => registerRemoteServiceWorker(openFromNotification), []);
  async function create(workspaceName?: string) {
    setCreating(true);
    setError("");
    try {
      const result = await window.sessionsAPI.create(undefined, undefined, {
        source: "user",
        setActive: false,
        ...(workspaceName ? { workspaceName } : {}),
      });
      if (!result.success || !result.session) throw Error(result.error ?? "Could not create chat");
      select(result.session.id);
      await queryClient.invalidateQueries({ queryKey: ["remote", "sessions"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create chat");
    } finally {
      setCreating(false);
    }
  }
  async function changeProject(workspaceName?: string) {
    if (!sessionId || projectChangeInFlight.current) return;
    const oldId = sessionId;
    const current = sessions.data?.find((session) => session.id === oldId);
    if ((current?.workspaceName || undefined) === workspaceName) return;
    projectChangeInFlight.current = true;
    setChangingProject(true);
    try {
      // Workspace identity is captured and validated by the existing create handler.
      // A project change creates a new draft; no existing conversation is rebound.
      const result = await window.sessionsAPI.create(current?.model, current?.soul, {
        source: "user",
        setActive: false,
        ...(workspaceName ? { workspaceName } : {}),
      });
      if (!result.success || !result.session)
        throw new Error(result.error ?? "Could not choose project");
      if (selectedIdRef.current !== oldId)
        throw new Error("The selected conversation changed. Open the new project chat from Chats.");
      chatPanelRef.current?.migrateDraftToSession(
        oldId,
        result.session.id,
        chatPanelRef.current.getInput(),
      );
      select(result.session.id);
      await queryClient.invalidateQueries({ queryKey: ["remote", "sessions"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not choose project");
    } finally {
      projectChangeInFlight.current = false;
      setChangingProject(false);
    }
  }
  // A reconnect usually completes within a second; only a lasting drop is announced.
  const connected = connection === "connected";
  useEffect(() => {
    if (connected) return undefined;
    const timer = window.setTimeout(() => setShowConnectionBanner(true), 2_500);
    return () => window.clearTimeout(timer);
  }, [connected]);
  useEffect(() => {
    if (!error) return undefined;
    const timer = window.setTimeout(() => setError(""), 6_000);
    return () => window.clearTimeout(timer);
  }, [error]);
  const current = sessions.data?.find((session) => session.id === sessionId);
  useEffect(() => {
    if (drawer || !sessionId || !current?.hasUnread || connection !== "connected") return undefined;
    const markVisibleRead = () => {
      if (document.visibilityState !== "visible") return;
      void window.sessionsAPI
        .markRead(sessionId)
        .then((result) => {
          if (result.success) void queryClient.invalidateQueries({ queryKey: ["remote"] });
        })
        .catch(() => {
          /* Retry on the next session update or reconnect. */
        });
    };
    markVisibleRead();
    document.addEventListener("visibilitychange", markVisibleRead);
    return () => document.removeEventListener("visibilitychange", markVisibleRead);
  }, [drawer, sessionId, current?.hasUnread, connection]);

  return (
    <RuntimeUiHost
      activeSessionId={sessionId}
      sessions={sessions.data ?? []}
      editor={remoteRuntimeEditor}
    >
      <div className="remote-shell" data-app-root data-window-ready="">
        {appOwner && !drawer && (
          <RemoteAppPane
            extensionId={appOwner.extensionId}
            applicationId={appOwner.applicationId}
            onBack={() => openApp(null)}
          />
        )}
        <header className="remote-header" hidden={drawer || !!appOwner}>
          <button aria-label="Show sessions" onClick={() => setDrawer(true)}>
            <PanelLeftOpen size={22} />
          </button>
          <div>
            <strong>{current?.name ?? "Marshal"}</strong>
            <small>
              {connection === "connected"
                ? `${current?.workspaceName || "General"} · ${host.data ?? "Your Mac"}`
                : connection === "connecting"
                  ? "Connecting…"
                  : "Reconnecting…"}
            </small>
          </div>
          <button
            aria-label="New chat"
            onClick={() => void create()}
            disabled={creating || connection !== "connected"}
          >
            <FileEdit size={22} />
          </button>
          <div className="remote-header-actions" ref={setToolbarTarget} />
        </header>
        {showConnectionBanner && connection !== "connected" && (
          <div role="status" className="remote-banner">
            Your Mac keeps working. Waiting for connection…{" "}
            <button onClick={() => remoteTransport.refresh()}>Reconnect</button>
          </div>
        )}
        {(error || (connection === "connected" && sessions.error)) && (
          <div role="alert" className="remote-banner">
            {error || sessions.error?.message}
          </div>
        )}
        <main
          className="remote-chat"
          hidden={drawer || !!appOwner}
          inert={drawer || !!appOwner || changingProject}
        >
          {sessionId ? (
            <MobileSessionViews>
              <ChatPanel
                hideAvatars
                timelineToolbarTarget={toolbarTarget}
                ref={chatPanelRef}
                key={sessionId}
                sessionId={sessionId}
                composerHeader={({ workspaceName, hasUserMessages, isWaiting, ready }) => (
                  <ProjectPicker
                    workspaceName={workspaceName}
                    workspaces={workspaces.data ?? []}
                    locked={hasUserMessages || isWaiting}
                    disabled={
                      !ready || changingProject || workspaces.isPending || !!workspaces.error
                    }
                    onSelect={(name) => void changeProject(name)}
                  />
                )}
                runtimeUiInline={<RuntimeUiTrailingCards />}
              />
            </MobileSessionViews>
          ) : (
            <div className="remote-empty">
              <h1>What’s next?</h1>
              <p>Continue a conversation or start a new one on your Mac.</p>
              <button onClick={() => setDrawer(true)}>Browse conversations</button>
            </div>
          )}
        </main>
        {drawer && (
          <Conversations
            sessions={sessions.data ?? []}
            workspaces={workspaces.data ?? []}
            applications={applications}
            selectedId={sessionId}
            computerName={host.data ?? "Your Mac"}
            connected={connection === "connected"}
            creating={creating}
            onSelect={(id) => {
              openApp(null);
              select(id);
            }}
            onCreate={(workspaceName) => void create(workspaceName)}
            onOpenApp={openApp}
            onClose={() => setDrawer(false)}
          />
        )}
        <Toaster position="top-center" closeButton />
      </div>
    </RuntimeUiHost>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <TelemetryProvider telemetryEnabled={false}>
        <QueryClientProvider client={queryClient}>
          <HotkeysRoot>
            <LayoutProvider>
              <TooltipProvider>
                <RemoteApp />
              </TooltipProvider>
            </LayoutProvider>
          </HotkeysRoot>
        </QueryClientProvider>
      </TelemetryProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
