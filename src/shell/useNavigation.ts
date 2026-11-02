import { createMemoryHistory } from "@tanstack/history";
import { useState, useCallback, useRef, useEffect } from "react";

import { withViewTransition } from "@/shared/marshal-foundation/animation";

export type NavView =
  | "chat"
  | "heartbeat"
  | "automations"
  | "commandCenter"
  | "workflows"
  | "activities"
  | "integrations"
  | "plugins"
  | "create"
  | "settings";

// ---------------------------------------------------------------------------
// Per-view state types — each view declares what state it tracks in history.
// Views not listed here carry no state.
// ---------------------------------------------------------------------------

export interface NavStateMap {
  chat: { sessionId?: string };
  automations: { editAutomationName?: string };
  workflows: {
    /** Selected workflow in the library (right-pane detail). */
    workflowId?: string;
    /** Repo scope for repo-local workflows. */
    repoPath?: string | null;
    /** Selected run (deep link to run-detail view). */
    runId?: string;
  };
  plugins: { tab?: "skills" | "mcp-servers" };
  create: { workspaceName?: string };
  settings: { scrollToSection?: string };
}

/** Views that carry typed state. */
type StatefulView = keyof NavStateMap;

/** Views that carry no state. */
type StatelessView = Exclude<NavView, StatefulView>;

/** Extension views use an `ext:` prefix and carry opaque state. */
type ExtensionView = `ext:${string}`;

/** All navigable views — core + extensions. */
export type AnyNavView = NavView | ExtensionView;

// ---------------------------------------------------------------------------
// Navigate function — fully typed overloads per view
// ---------------------------------------------------------------------------

export interface NavigateFn {
  <V extends StatefulView>(view: V, state: NavStateMap[V]): void;
  (view: StatelessView): void;
  (view: ExtensionView, state?: Record<string, unknown>): void;
  // Convenience: stateful views can also be called without state
  (view: NavView): void;
}

// ---------------------------------------------------------------------------
// Apply event — fired on every entry application.
// Consumers narrow on `view` using the `isNavView` helper for typed state.
// ---------------------------------------------------------------------------

export interface NavigationApplyEvent {
  view: AnyNavView;
  state?: Record<string, unknown>;
  isHistoryNavigation: boolean;
}

/** Type guard — narrows a NavigationApplyEvent to a specific view with typed state. */
export function isNavView<V extends StatefulView>(
  event: NavigationApplyEvent,
  view: V,
): event is NavigationApplyEvent & { view: V; state?: NavStateMap[V] } {
  return event.view === view;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_VIEWS: Record<string, NavView> = {
  chat: "chat",
  heartbeat: "heartbeat",
  automations: "automations",
  commandCenter: "commandCenter",
  "command-center": "commandCenter",
  workflows: "workflows",
  activities: "activities",
  integrations: "integrations",
  plugins: "plugins",
  extensions: "plugins", // Legacy persisted/deep-link id.
  create: "create",
  settings: "settings",
};

/**
 * Views that behave as panels (opened from "More" menu).
 * When navigating to a panel, the previously-active page is remembered
 * so the dismiss button can return the user there.
 */
export const PANEL_VIEWS: ReadonlySet<NavView> = new Set<NavView>([
  "heartbeat",
  "activities",
  "plugins",
  "integrations",
  "settings",
]);

function isPanelView(view: AnyNavView): boolean {
  return (PANEL_VIEWS as ReadonlySet<string>).has(view);
}

/** Validates an unknown persisted value as a stored AnyNavView. */
function parseStoredView(value: unknown): AnyNavView | null {
  if (typeof value !== "string") return null;
  if (value.startsWith("ext:")) return `ext:${value.slice(4)}`;
  return VALID_VIEWS[value] ?? null;
}

function pathToView(pathname: string): AnyNavView {
  const stripped = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  if (stripped.startsWith("ext/")) {
    const extId = stripped.slice(4);
    if (!extId) return "chat"; // /ext/ with no ID is invalid
    return `ext:${extId}`;
  }
  return VALID_VIEWS[stripped] ?? "chat";
}

function viewToPath(view: AnyNavView): string {
  if (typeof view === "string" && view.startsWith("ext:")) {
    return `/ext/${view.slice(4)}`;
  }
  if (view === "commandCenter") {
    return "/command-center";
  }
  return `/${view}`;
}

interface LocationState {
  key?: string;
  custom?: Record<string, unknown>;
}

function toLocationState(raw: unknown): LocationState {
  return raw !== null && typeof raw === "object" ? (raw as LocationState) : {};
}

function stateEqual(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => k in b && a[k] === b[k]);
}

// Singleton history instance — survives across hook re-mounts (React strict mode)
let history = createMemoryHistory({ initialEntries: ["/chat"] });
let indexRef = 0;
let lengthRef = 1;

/**
 * Reset the navigation history to initial state.
 * Only safe to call before hook mount (e.g. in test `beforeEach`) —
 * calling mid-mount orphans existing subscribers.
 */
export function resetNavHistoryForTests(initialPath = "/chat"): void {
  history = createMemoryHistory({ initialEntries: [initialPath] });
  indexRef = 0;
  lengthRef = 1;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseNavigationOptions {
  onApply?: (event: NavigationApplyEvent) => void;
}

export function useNavigation({ onApply }: UseNavigationOptions = {}) {
  // Initialize React state from the singleton — handles Strict Mode remount,
  // hot reload, and future sign-out-and-remount flows.
  const [currentView, setCurrentView] = useState<AnyNavView>(() =>
    pathToView(history.location.pathname),
  );
  const [editAutomationName, setEditAutomationName] = useState<string | null>(() => {
    const c = toLocationState(history.location.state).custom;
    return pathToView(history.location.pathname) === "automations" &&
      typeof c?.editAutomationName === "string"
      ? c.editAutomationName
      : null;
  });
  const [pluginsTab, setPluginsTab] = useState<"skills" | "mcp-servers" | null>(() => {
    const c = toLocationState(history.location.state).custom;
    const tab = pathToView(history.location.pathname) === "plugins" ? c?.tab : undefined;
    return tab === "skills" || tab === "mcp-servers" ? tab : null;
  });
  const [scrollToSection, setScrollToSection] = useState<string | null>(() => {
    const c = toLocationState(history.location.state).custom;
    return pathToView(history.location.pathname) === "settings" &&
      typeof c?.scrollToSection === "string"
      ? c.scrollToSection
      : null;
  });
  const [workflowsState, setWorkflowsState] = useState<NavStateMap["workflows"] | null>(() => {
    const c = toLocationState(history.location.state).custom;
    if (pathToView(history.location.pathname) !== "workflows") return null;
    const wfId = typeof c?.workflowId === "string" ? c.workflowId : undefined;
    const repoPath = typeof c?.repoPath === "string" ? c.repoPath : undefined;
    const runId = typeof c?.runId === "string" ? c.runId : undefined;
    return wfId || runId || repoPath
      ? {
          ...(wfId !== undefined ? { workflowId: wfId } : {}),
          ...(repoPath !== undefined ? { repoPath } : {}),
          ...(runId !== undefined ? { runId } : {}),
        }
      : null;
  });
  const [historyIndex, setHistoryIndex] = useState(() => indexRef);
  const [historyLength, setHistoryLength] = useState(() => lengthRef);
  const [returnToPage, setReturnToPage] = useState<AnyNavView | null>(() => {
    const c = toLocationState(history.location.state).custom;
    return parseStoredView(c?.returnToPage);
  });

  const onApplyRef = useRef(onApply);
  useEffect(() => {
    onApplyRef.current = onApply;
  });

  const applyLocation = useCallback(
    (pathname: string, locState: LocationState, isHistoryNavigation: boolean) => {
      const view = pathToView(pathname);
      const custom = locState?.custom;
      setCurrentView(view);
      setEditAutomationName(
        view === "automations" && typeof custom?.editAutomationName === "string"
          ? custom.editAutomationName
          : null,
      );
      const tab = view === "plugins" ? custom?.tab : undefined;
      setPluginsTab(tab === "skills" || tab === "mcp-servers" ? tab : null);
      setScrollToSection(
        view === "settings" && typeof custom?.scrollToSection === "string"
          ? custom.scrollToSection
          : null,
      );
      if (view === "workflows") {
        const wfId = typeof custom?.workflowId === "string" ? custom.workflowId : undefined;
        const repoPath = typeof custom?.repoPath === "string" ? custom.repoPath : undefined;
        const runId = typeof custom?.runId === "string" ? custom.runId : undefined;
        setWorkflowsState(
          wfId || runId || repoPath
            ? {
                ...(wfId !== undefined ? { workflowId: wfId } : {}),
                ...(repoPath !== undefined ? { repoPath } : {}),
                ...(runId !== undefined ? { runId } : {}),
              }
            : null,
        );
      } else {
        setWorkflowsState(null);
      }
      setHistoryIndex(indexRef);
      setHistoryLength(lengthRef);
      setReturnToPage(parseStoredView(custom?.returnToPage));
      onApplyRef.current?.({ view, state: custom, isHistoryNavigation });
    },
    [],
  );

  // Contract: history.push/back/forward fire subscribers synchronously in the
  // same tick. The withViewTransition wrap math and the indexRef/lengthRef read
  // order in applyLocation depend on it.
  useEffect(() => {
    return history.subscribe((update) => {
      const isHistoryNav = update.action.type === "BACK" || update.action.type === "FORWARD";
      const locState = toLocationState(update.location.state);
      if (isHistoryNav) {
        withViewTransition(() => applyLocation(update.location.pathname, locState, true));
      } else {
        applyLocation(update.location.pathname, locState, false);
      }
    });
  }, [applyLocation]);

  // Contract: history.push/back/forward fire subscribers synchronously in the
  // same tick. The withViewTransition wrap math and the indexRef/lengthRef read
  // order in applyLocation depend on it.
  const navigateImpl = (view: AnyNavView, state?: Record<string, unknown>): void => {
    const currentCustom = toLocationState(history.location.state).custom;

    const currentUserState = currentCustom
      ? Object.fromEntries(Object.entries(currentCustom).filter(([k]) => k !== "returnToPage"))
      : undefined;
    const hasCurrentUserState = currentUserState && Object.keys(currentUserState).length > 0;

    if (
      pathToView(history.location.pathname) === view &&
      stateEqual(hasCurrentUserState ? currentUserState : undefined, state)
    ) {
      return;
    }

    const currentReturnTo = parseStoredView(currentCustom?.returnToPage);
    let nextReturnTo: AnyNavView | null = null;
    if (isPanelView(view)) {
      const currentViewVal = pathToView(history.location.pathname);
      if (!isPanelView(currentViewVal)) {
        nextReturnTo = currentViewVal;
      } else {
        nextReturnTo = currentReturnTo ?? null;
      }
    }
    withViewTransition(() => {
      indexRef = indexRef + 1;
      lengthRef = indexRef + 1;
      history.push(viewToPath(view), {
        custom: nextReturnTo ? { ...state, returnToPage: nextReturnTo } : state,
      });
    });
  };
  const navigate: NavigateFn = useCallback(navigateImpl, []);

  const goBack = useCallback(() => {
    if (indexRef <= 0) return;
    // Update counter before back — back fires the subscriber synchronously
    indexRef--;
    history.back();
  }, []);

  const goForward = useCallback(() => {
    if (indexRef >= lengthRef - 1) return;
    indexRef++;
    history.forward();
  }, []);

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < historyLength - 1;

  const dismissPanel = useCallback(() => {
    const target = returnToPage ?? "chat";
    navigateImpl(target);
  }, [returnToPage]);

  return {
    currentView,
    editAutomationName,
    pluginsTab,
    scrollToSection,
    workflowsState,
    navigate,
    goBack,
    goForward,
    canGoBack,
    canGoForward,
    returnToPage,
    dismissPanel,
  };
}
