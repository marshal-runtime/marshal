/**
 * PopoutApp — "Open in New Window" for chats.
 *
 * Lightweight renderer surface used when the URL contains `?popout=<sessionId>`.
 * Renders a single ChatPanel locked to the given session, with no left nav and
 * no other top-level panels. The chat registers per-window interest for its
 * detailed session view; metadata and settings events remain app-wide.
 *
 * Auth and consent gates are intentionally bypassed: the popout is launched
 * from an already-authenticated main window and shares the main process's
 * Copilot SDK and session store, so it has no separate auth state of its own.
 */
import { QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { Toaster } from "./components/ui/sonner";
import { TooltipProvider } from "./components/marshal-ui/marshal-tooltip";
import { ChatPanelWithActivity } from "./features/chat";
import { HotkeysRoot } from "./features/hotkeys";
import { useWindowInactiveAttribute } from "./marshal/windowing/useWindowInactiveAttribute";
import { queryClient } from "./services/query/query-client";
import { TelemetryProvider } from "./services/telemetry";
import { LayoutProvider } from "./shared/contexts/marshal-layout-provider";
import { Header } from "./shell/Header";
import { applyTheme } from "./app-theme";

interface PopoutAppProps {
  sessionId: string;
}

/**
 * Sibling of ChatPanel so rename re-renders don't propagate down into chat.
 * The query key is intentionally isolated from ["session", id] and ["sessions"]
 * — earlier attempts that reused those keys hit v5's last-observer-wins and
 * broke chat sync.
 */
function PopoutHeader({ sessionId }: { sessionId: string }) {
  const qc = useQueryClient();
  const { data: name } = useQuery({
    queryKey: ["session-name", sessionId],
    queryFn: async () => {
      const result = await window.sessionsAPI?.get(sessionId, { messageLimit: 0 });
      return result?.success && result.session ? result.session.name : null;
    },
    // `onMetadataChanged` below is the authoritative invalidation source.
    // Without `staleTime: Infinity`, the default 5s window + refetchOnWindowFocus
    // would fire a background sessions:get on every focus change for as long as
    // the popout is open — pure waste.
    staleTime: Infinity,
  });

  useEffect(() => {
    if (!window.sessionsAPI?.onMetadataChanged) return undefined;
    return window.sessionsAPI.onMetadataChanged((changedId: string) => {
      if (changedId === sessionId) {
        void qc.invalidateQueries({ queryKey: ["session-name", sessionId] });
      }
    });
  }, [sessionId, qc]);

  return (
    <Header
      showSidebarToggle={false}
      showChatToggle={false}
      showNavigation={false}
      subtitle={name ?? undefined}
    />
  );
}

export function PopoutApp({ sessionId }: PopoutAppProps) {
  // Initial theme is applied synchronously in `main.tsx` from `localStorage`,
  // so popouts inherit the main window's theme with no flash. We only need to
  // listen for *runtime* theme changes here: the main window's SettingsPanel
  // calls `applyThemeWithTransition` imperatively in its click handler, which
  // doesn't reach our separate renderer process. Re-applying via the
  // settings:changed broadcast keeps theme in sync without racing the main
  // window's own View Transition animation.
  //
  // We deliberately do NOT call `sessionsAPI.switch(sessionId)` — that would
  // move the global "active session" pointer and pull the main window onto
  // this popout's chat. ChatPanel subscribes this renderer to its session view
  // regardless of which session is globally "active".
  useEffect(() => {
    if (!window.settingsAPI?.onChanged) return undefined;
    return window.settingsAPI.onChanged(() => {
      void (async () => {
        try {
          const result = await window.settingsAPI?.get();
          if (result?.success && result.settings) {
            applyTheme(result.settings.theme || "system");
          }
        } catch {
          /* ignore — popout keeps its current theme */
        }
      })();
    });
  }, []);

  const { ready: windowFocusReady } = useWindowInactiveAttribute();

  return (
    // `telemetryEnabled={false}` is intentional: the main window already
    // accounts for the user's tenant policy and emits all session-scoped
    // telemetry. Popouts share the same SDK/session in the main process, so
    // double-counting them as a separate renderer surface would inflate
    // session/usage metrics.
    <TelemetryProvider telemetryEnabled={false}>
      <QueryClientProvider client={queryClient}>
        <HotkeysRoot>
          <LayoutProvider>
            <TooltipProvider>
              <div
                className="flex h-full flex-col bg-background"
                data-app-root
                data-window-ready={windowFocusReady ? "" : undefined}
              >
                {/* PopoutHeader (sibling of ChatPanel) so rename re-renders
                    stay scoped to the title bar. */}
                <PopoutHeader sessionId={sessionId} />
                <div className="min-h-0 flex-1" data-vibrancy-opaque>
                  <ChatPanelWithActivity sessionId={sessionId} />
                </div>
              </div>
              <Toaster position="bottom-right" closeButton />
            </TooltipProvider>
          </LayoutProvider>
        </HotkeysRoot>
      </QueryClientProvider>
    </TelemetryProvider>
  );
}
