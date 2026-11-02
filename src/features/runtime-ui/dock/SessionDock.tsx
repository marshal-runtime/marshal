import "dockview-react/dist/styles/dockview.css";
import "./sessionDock.css";
import { createLogger } from "@common/marshal-logger";
import { runtimeUiScopeKey } from "@common/runtime-ui";
import type { RuntimeUiDockRegion } from "@common/runtime-ui-layout";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type SerializedDockview,
} from "dockview-react";
import {
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { RuntimeUiTransientCards } from "../cards/ConversationCards";
import { RuntimeUiContext } from "../runtimeUiContext";
import { RuntimeUiDockScopeContext } from "../runtimeUiDockScope";
import { SessionDockContext } from "./dockContext";
import { DockFloatDropZone, type DockDragSubject } from "./DockFloatDropZone";
import {
  addPanelInRegion,
  CHAT_PANEL_ID,
  keepChatUsable,
  DOCK_COMPONENT,
  ensureEdgeGroups,
  instanceIdOfPanel,
  movePanelToRegion,
  regionOfPanel,
  PROGRESS_PANEL_ID,
  syncEdgeVisibility,
} from "./dockLayout";
import { maximizePanel, restorePanel, type MaximizedView } from "./dockMaximize";
import {
  ChatDockPanel,
  DockGroupActions,
  DockTab,
  DockWatermark,
  ProgressDockPanel,
  ViewDockPanel,
} from "./dockPanels";
import { isSerializedDockview, saveDockLayout as saveLayout } from "./dockPersistence";
import { DockReconciler } from "./dockReconciler";

const log = createLogger("SessionDock");
const SAVE_DELAY_MS = 400;
const DOCK_THEME = { name: "marshal", className: "dockview-theme-marshal", gap: 0 };
const DOCK_COMPONENTS = {
  [DOCK_COMPONENT.chat]: ChatDockPanel,
  [DOCK_COMPONENT.progress]: ProgressDockPanel,
  [DOCK_COMPONENT.view]: ViewDockPanel,
};

function createHost(testId: string): HTMLElement {
  const host = document.createElement("div");
  host.className = "size-full min-h-0";
  host.dataset.testid = testId;
  return host;
}

/**
 * The per-session workspace: Chat, Progress, and every docked runtime view as
 * tabs that can be dragged between the chat tab strip, the side and bottom
 * docks, and floating windows. Opening a view always adds a tab. The layout is
 * saved per session and reported to the host so the agent can read it.
 */
export function SessionDock({
  chat,
  renderProgress,
}: {
  readonly chat: ReactNode;
  /** Renders the session's progress; it reports whether there is anything to show. */
  readonly renderProgress: (reportContent: (hasContent: boolean) => void) => ReactNode;
}) {
  const model = use(RuntimeUiContext);
  const scope = model?.scope ?? null;
  const scopeKey = scope ? runtimeUiScopeKey(scope) : null;
  const [chatHost] = useState(() => createHost("session-dock-chat-host"));
  const [progressHost] = useState(() => createHost("session-dock-progress-host"));
  const [api, setApi] = useState<DockviewApi | null>(null);
  const [loaded, setLoaded] = useState<{ readonly key: string | null } | null>(null);
  const [progressOpen, setProgressOpen] = useState(false);
  const [progressHasContent, setProgressHasContent] = useState(false);
  const [maximizedPanelId, setMaximizedPanelId] = useState<string | null>(null);
  const maximized = useRef<MaximizedView | null>(null);
  const reconciler = useRef(new DockReconciler());
  const loading = useRef(false);
  const progressDismissed = useRef(new Set<string>());
  const pendingSave = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragSubject = useRef<DockDragSubject | null>(null);
  const [showFloatZone, setShowFloatZone] = useState(false);
  const ready = api !== null && loaded !== null && loaded.key === scopeKey;

  const docked = useMemo(
    () =>
      model
        ? [
            ...model.bySurface.tab,
            ...model.bySurface.fullscreen,
            ...model.bySurface.panel,
            ...model.bySurface["bottom-panel"],
            ...model.bySurface.floating,
          ]
        : [],
    [model],
  );
  const instances = useMemo(
    () => new Map((model?.instances ?? []).map((instance) => [instance.instanceId, instance])),
    [model?.instances],
  );
  // Debounced saves run later; they read the newest views, not the ones at scheduling time.
  const instancesRef = useRef(instances);
  useEffect(() => {
    instancesRef.current = instances;
  }, [instances]);

  const flushSave = useCallback(() => {
    if (pendingSave.current === undefined) return;
    clearTimeout(pendingSave.current);
    pendingSave.current = undefined;
    if (api && scope && !loading.current) {
      saveLayout(api, scope, instancesRef.current, reconciler.current);
    }
  }, [api, scope]);

  const scheduleSave = useCallback(() => {
    if (loading.current || !api || !scope || maximized.current) return;
    clearTimeout(pendingSave.current);
    pendingSave.current = setTimeout(() => {
      pendingSave.current = undefined;
      saveLayout(api, scope, instancesRef.current, reconciler.current);
    }, SAVE_DELAY_MS);
  }, [api, scope]);

  const openProgress = useCallback((dockApi: DockviewApi, activate: boolean) => {
    if (!dockApi.getPanel(PROGRESS_PANEL_ID)) {
      addPanelInRegion(
        dockApi,
        { id: PROGRESS_PANEL_ID, component: DOCK_COMPONENT.progress, title: "Progress" },
        "side",
        !activate,
      );
    }
    setProgressOpen(true);
  }, []);

  // Load the session's saved arrangement whenever the session changes, and
  // flush the previous session's pending save first.
  useEffect(() => {
    if (!api) return undefined;
    let cancelled = false;
    loading.current = true;
    const dockReconciler = reconciler.current;
    const applyLayout = (saved: SerializedDockview | undefined, complete = true) => {
      if (cancelled) return;
      dockReconciler.reset();
      maximized.current = null;
      setMaximizedPanelId(null);
      let restored = false;
      if (saved) {
        try {
          api.fromJSON(saved);
          restored = api.getPanel(CHAT_PANEL_ID) !== undefined;
        } catch (error) {
          log.warn(`saved layout rejected: ${error instanceof Error ? error.name : "unknown"}`);
        }
      }
      if (!restored) {
        // Keep the chat host attached across scope updates and layout reads.
        // Clearing the whole dock temporarily removes an already visible chat.
        for (const panel of [...api.panels]) {
          if (panel.id !== CHAT_PANEL_ID) api.removePanel(panel);
        }
      }
      ensureEdgeGroups(api);
      if (!api.getPanel(CHAT_PANEL_ID)) {
        addPanelInRegion(
          api,
          { id: CHAT_PANEL_ID, component: DOCK_COMPONENT.chat, title: "Chat" },
          "chat",
          false,
        );
      }
      syncEdgeVisibility(api, false);
      if (rootRef.current) keepChatUsable(api, rootRef.current.getBoundingClientRect());
      setProgressOpen(api.getPanel(PROGRESS_PANEL_ID) !== undefined);
      if (complete) {
        loading.current = false;
        setLoaded({ key: scopeKey });
      } else {
        setLoaded(null);
      }
    };
    const bridge = window.runtimeUiAPI;
    if (!scope || !bridge?.getLayout) {
      applyLayout(undefined);
    } else {
      // Layout authorization waits for the runtime. Keep the chat attached while
      // that request is pending, without saving over the arrangement being read.
      applyLayout(undefined, false);
      void bridge
        .getLayout(scope)
        .then((result) => {
          const saved: unknown = result.success ? result.value.desktop?.dockview : undefined;
          applyLayout(isSerializedDockview(saved) ? saved : undefined);
        })
        .catch(() => applyLayout(undefined));
    }
    return () => {
      cancelled = true;
      if (pendingSave.current !== undefined && scope) {
        clearTimeout(pendingSave.current);
        pendingSave.current = undefined;
        saveLayout(api, scope, instancesRef.current, dockReconciler);
      }
    };
  }, [api, scope, scopeKey]);

  useEffect(() => {
    if (!ready || !api) return;
    // Dockview does not report every programmatic move (emptying an edge dock is silent).
    if (reconciler.current.apply(api, docked)) scheduleSave();
  }, [api, docked, ready, scheduleSave]);

  useEffect(() => {
    if (!ready || !api || !scopeKey || !progressHasContent) return;
    if (!progressDismissed.current.has(scopeKey)) openProgress(api, false);
  }, [api, openProgress, progressHasContent, ready, scopeKey]);

  const closeView = useCallback(
    (instanceId: string) => {
      const instance = instances.get(instanceId);
      if (instance && model) void model.close(instance);
    },
    [instances, model],
  );

  const moveView = useCallback(
    (panelId: string, region: RuntimeUiDockRegion) => {
      const panel = api?.getPanel(panelId);
      if (!api || !panel) return;
      // Moving a maximized tab from its menu places it for good.
      if (maximized.current?.panelId === panelId) {
        maximized.current = null;
        setMaximizedPanelId(null);
      }
      movePanelToRegion(api, panel, region);
      panel.api.setActive();
      scheduleSave();
      flushSave();
    },
    [api, flushSave, scheduleSave],
  );

  const hideProgress = useCallback(() => {
    const panel = api?.getPanel(PROGRESS_PANEL_ID);
    if (scopeKey) progressDismissed.current.add(scopeKey);
    if (api && panel) api.removePanel(panel);
    setProgressOpen(false);
  }, [api, scopeKey]);

  const showProgress = useCallback(() => {
    if (scopeKey) progressDismissed.current.delete(scopeKey);
    if (api) openProgress(api, true);
  }, [api, openProgress, scopeKey]);

  const exitMaximize = useCallback(() => {
    const view = maximized.current;
    if (!view || !api) return;
    maximized.current = null;
    setMaximizedPanelId(null);
    restorePanel(api, view);
    scheduleSave();
  }, [api, scheduleSave]);

  const enterMaximize = useCallback(
    (panelId: string) => {
      const panel = api?.getPanel(panelId);
      if (!api || !panel || !rootRef.current) return;
      exitMaximize();
      // The temporary floating window is not a user move: save first, then pause saving.
      flushSave();
      maximized.current = { panelId, home: regionOfPanel(panel) };
      maximizePanel(api, panelId, rootRef.current, maximized.current.home);
      setMaximizedPanelId(panelId);
    },
    [api, exitMaximize, flushSave],
  );

  const toggleMaximize = useCallback(
    (panelId: string) => {
      if (maximized.current?.panelId === panelId) exitMaximize();
      else enterMaximize(panelId);
    },
    [enterMaximize, exitMaximize],
  );

  useEffect(() => {
    const dockReconciler = reconciler.current;
    dockReconciler.onFullscreen = enterMaximize;
    // The agent moved a maximized view elsewhere: its new place wins over the old home.
    dockReconciler.onSurfaceChange = (panelId) => {
      if (maximized.current?.panelId !== panelId) return;
      maximized.current = null;
      setMaximizedPanelId(null);
    };
  }, [enterMaximize]);

  // While a tab is maximized: Escape restores it, and it follows the dock area's size.
  useEffect(() => {
    const root = rootRef.current;
    if (!maximizedPanelId || !api || !root) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") exitMaximize();
    };
    let fitted = root.getBoundingClientRect();
    const observer = new ResizeObserver(() => {
      const view = maximized.current;
      const next = root.getBoundingClientRect();
      if (!view || (next.width === fitted.width && next.height === fitted.height)) return;
      fitted = next;
      maximizePanel(api, view.panelId, root, view.home);
    });
    observer.observe(root);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      observer.disconnect();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [api, exitMaximize, maximizedPanelId]);

  const dockContext = useMemo(
    () => ({
      chatHost,
      progressHost,
      instances,
      progressOpen,
      maximizedPanelId,
      closeView,
      moveView,
      toggleMaximize,
      showProgress,
      hideProgress,
    }),
    [
      chatHost,
      closeView,
      hideProgress,
      instances,
      maximizedPanelId,
      moveView,
      progressHost,
      progressOpen,
      showProgress,
      toggleMaximize,
    ],
  );

  const handleReady = useCallback((event: DockviewReadyEvent) => {
    const dockApi = event.api;
    let dragging = false;
    const endDrag = () => {
      dragging = false;
      window.removeEventListener("dragend", endDrag, true);
      window.removeEventListener("drop", endDrag, true);
      window.removeEventListener("pointerup", endDrag, true);
      rootRef.current?.removeAttribute("data-dock-dragging");
      // Let dockview (or the float zone) finish the drop before hiding docks that stayed empty.
      setTimeout(() => {
        dragSubject.current = null;
        setShowFloatZone(false);
        syncEdgeVisibility(dockApi, false);
      }, 0);
    };
    const beginDrag = (subject: DockDragSubject | null) => {
      dragging = true;
      dragSubject.current = subject;
      if (subject) setShowFloatZone(true);
      rootRef.current?.setAttribute("data-dock-dragging", "");
      syncEdgeVisibility(dockApi, true);
      window.addEventListener("dragend", endDrag, true);
      window.addEventListener("drop", endDrag, true);
      window.addEventListener("pointerup", endDrag, true);
    };
    dockApi.onWillDragPanel((drag) => {
      if (drag.panel.id === CHAT_PANEL_ID) drag.nativeEvent.preventDefault();
      else beginDrag({ kind: "panel", panelId: drag.panel.id });
    });
    dockApi.onWillDragGroup((drag) => {
      if (drag.group.panels.some((panel) => panel.id === CHAT_PANEL_ID)) {
        drag.nativeEvent.preventDefault();
      } else {
        // Dragging a floating window's own handle moves it; there is nothing to float.
        beginDrag(
          drag.group.api.location.type === "floating" ? null : { kind: "group", group: drag.group },
        );
      }
    });
    dockApi.onDidLayoutChange(() => {
      if (!dragging) syncEdgeVisibility(dockApi, false);
    });
    setApi(dockApi);
  }, []);

  // A view tab that disappeared without the reconciler removing it was closed by the user.
  useEffect(() => {
    if (!api) return undefined;
    const removed = api.onDidRemovePanel((panel) => {
      if (reconciler.current.removing.delete(panel.id) || loading.current) return;
      queueMicrotask(() => {
        if (api.getPanel(panel.id)) return;
        if (maximized.current?.panelId === panel.id) {
          maximized.current = null;
          setMaximizedPanelId(null);
        }
        const instanceId = instanceIdOfPanel(panel.id);
        if (instanceId) closeView(instanceId);
        if (panel.id === PROGRESS_PANEL_ID) setProgressOpen(false);
      });
    });
    const changed = api.onDidLayoutChange(scheduleSave);
    return () => {
      removed.dispose();
      changed.dispose();
    };
  }, [api, closeView, scheduleSave]);

  useEffect(() => () => clearTimeout(pendingSave.current), []);

  // Dockview reports no layout change when an edge dock is resized, so a
  // divider drag is settled and saved once the pointer is released.
  const saveAfterDividerDrag = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!api || !(event.target instanceof Element) || !event.target.closest(".dv-sash")) return;
      const root = event.currentTarget;
      const settle = () => {
        keepChatUsable(api, root.getBoundingClientRect());
        scheduleSave();
      };
      window.addEventListener("pointerup", settle, { once: true, capture: true });
    },
    [api, scheduleSave],
  );

  return (
    <SessionDockContext value={dockContext}>
      <RuntimeUiDockScopeContext value={scopeKey}>
        {/* Dockview leaves hidden tabs at their old size after a resize. Clip, not hidden: a
            scrollable ancestor could be scrolled, pushing the tab strip off screen. */}
        <div
          ref={rootRef}
          className="relative size-full min-h-0 overflow-clip"
          data-testid="session-dock"
          onPointerDownCapture={saveAfterDividerDrag}
        >
          {/* Temporary cards float above every tab, clear of the composer. */}
          <RuntimeUiTransientCards className="absolute right-4 bottom-36 z-1100 max-h-[calc(100%-12rem)] w-[min(26rem,calc(100%-2rem))] overflow-y-auto" />
          {showFloatZone && api && (
            <DockFloatDropZone api={api} subject={dragSubject} rootRef={rootRef} />
          )}
          <DockviewReact
            components={DOCK_COMPONENTS}
            defaultTabComponent={DockTab}
            rightHeaderActionsComponent={DockGroupActions}
            watermarkComponent={DockWatermark}
            onReady={handleReady}
            theme={DOCK_THEME}
            defaultRenderer="always"
          />
        </div>
        {createPortal(chat, chatHost)}
        {createPortal(renderProgress(setProgressHasContent), progressHost)}
      </RuntimeUiDockScopeContext>
    </SessionDockContext>
  );
}
