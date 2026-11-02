import {
  ALL_SESSION_FILTERS,
  DEFAULT_SESSION_FILTERS,
  SESSION_FILTER_OPTIONS,
  matchesSessionFilter as matchesSidebarFilter,
  type SessionFilter as SidebarSessionFilter,
} from "@common/session-filters";
import { observeElementRect, useVirtualizer } from "@tanstack/react-virtual";
import type { ReactNode, UIEvent } from "react";
import { Fragment, useState, useEffect, useRef, useCallback, useMemo } from "react";
import { toast } from "sonner";

import {
  NewChatIcon,
  WorkflowsIcon,
  ActivityIcon,
  IntegrationsIcon,
  ExtensionsIcon,
  CoCreateIcon,
} from "@/assets/icons/nav-icons";
import {
  Bot,
  RefreshCw,
  LoaderCircle,
  ChevronRight,
  X,
  Search,
  SlidersHorizontal,
  ExternalLink,
  Plus,
  type MarshalIcon,
} from "@/components/icons";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/marshal-ui/hover-card";
import { Input } from "@/components/marshal-ui/input";
import { Button, buttonVariants } from "@/components/marshal-ui/marshal-button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/marshal-ui/marshal-collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/marshal-ui/marshal-tooltip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  RuntimeUiNavigationEntries,
  useRuntimeUiNavigation,
} from "@/features/runtime-ui/RuntimeUiNavigation";
import { cn } from "@/lib/marshal-class-names";
import { useTimeout } from "@/runtime-ui/hooks/use-timeout";
import {
  TelemetryPath_Nav,
  TelemetryPath_NavSessionItem,
  InteractiveElementMonitor_NewChat,
  InteractiveElementMonitor_NavItem,
  InteractiveElementMonitor_SessionItem,
  InteractiveElementMonitor_DeleteSession,
  useInteractiveElementMonitor_DragToPopout,
} from "@/services/telemetry/schema";
import { SESSION_PAGE_SIZE, useSessions, type DisplaySession } from "@/shared/hooks/useSessions";
import { formatChatTooltip, formatDate, formatDateFull } from "@/shared/marshal-foundation/date";

import { DeleteSessionDialog } from "./session-actions/DeleteSessionDialog";
import { SessionOverflowMenu } from "./SessionOverflowMenu";
import { SessionPinButton } from "./SessionPinButton";
import { SidebarAccountSettings } from "./SidebarAccountSettings";
import type { NavView, AnyNavView, NavigateFn } from "./useNavigation";
import { useSessionDragOut } from "./windowing/session-drag/use-session-drag-out";

export type { NavView } from "./useNavigation";

interface LeftNavProps {
  activeView: AnyNavView;
  /** When set, visually highlights this view instead of activeView (used when a panel overlays a page). */
  highlightedView?: AnyNavView;
  onViewChange: NavigateFn;
  onNewChat: (workspaceName?: string) => void;
  // Sessions
  activeSessionId: string | null;
  renameSessionRequest?: {
    sessionId: string;
    requestId: number;
  } | null;
  onRenameSessionRequestHandled?: (requestId: number) => void;
  onSessionSelect: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  navigationKey?: string;
  getNavigationEpoch?: () => number;
  /**
   * pop a chat into its own window. Optional — when omitted
   * (e.g. tests, popout windows themselves) the menu item is hidden.
   * `bounds` (drag screen coords) lets the drag-to-popout path position the
   * new window near where the user dropped; omitted by the overflow menu.
   */
  onOpenSessionInNewWindow?: (sessionId: string, bounds?: { x: number; y: number }) => void;
  // Skills
  onInsertSkill?: (skillName: string) => void;
  // Me Control
  connected?: boolean | null;
  onSignOut?: () => void;
  onSettingsAltClick?: () => void;
}

interface NavItem {
  view: NavView;
  label: string;
  Icon?: MarshalIcon;
  customIcon?: ReactNode;
  narrowOnly?: boolean;
}

const PLUGINS_VIEW: NavView = "plugins";

const ALL_NAV_ITEMS: NavItem[] = [
  {
    view: "chat",
    label: "Chat",
    customIcon: <NewChatIcon className="size-5 shrink-0" />,
    narrowOnly: true,
  },
  {
    view: "automations",
    label: "Orchestration",
    customIcon: <WorkflowsIcon className="size-5 shrink-0" />,
  },
  {
    view: "create",
    label: "Workspaces",
    customIcon: <CoCreateIcon className="size-5 shrink-0" />,
  },
  {
    view: "activities",
    label: "Activity",
    customIcon: <ActivityIcon className="size-5 shrink-0" />,
  },
  {
    view: PLUGINS_VIEW,
    label: "Plugins",
    customIcon: <ExtensionsIcon className="size-5 shrink-0" />,
  },
  {
    view: "integrations",
    label: "Integrations",
    customIcon: <IntegrationsIcon className="size-5 shrink-0" />,
  },
];

const COLLAPSED_THREAD_GROUPS_STORAGE_KEY = "marshal.left-nav.collapsed-thread-groups.v1";
const GENERAL_THREAD_GROUP_KEY = "group:general";
const PINNED_THREAD_GROUP_KEY = "group:pinned";
const THREAD_GROUP_PAGE_SIZE = 15;

function workspaceThreadGroupKey(registeredWorkspaceKey: string): string {
  return `group:workspace:${registeredWorkspaceKey}`;
}

function nestedAgentsExpansionKey(parentSessionId: string): string {
  return `agents:expanded:${parentSessionId}`;
}

function loadThreadDisclosureState(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_THREAD_GROUPS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
      return new Set();
    }
    return new Set(parsed);
  } catch {
    return new Set();
  }
}

function persistThreadDisclosureState(disclosureState: ReadonlySet<string>): void {
  try {
    if (disclosureState.size === 0) {
      window.localStorage.removeItem(COLLAPSED_THREAD_GROUPS_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(
      COLLAPSED_THREAD_GROUPS_STORAGE_KEY,
      JSON.stringify([...disclosureState].sort()),
    );
  } catch {
    // Collapsing still works for the current session when storage is unavailable.
  }
}

type ThreadListRow =
  | {
      kind: "heading";
      key: string;
      groupKey: string;
      label: string;
      workspaceName?: string;
      isExpanded: boolean;
    }
  | {
      kind: "session";
      key: string;
      session: DisplaySession;
      isNestedChild: boolean;
      nestedChildCount: number;
      areNestedChildrenExpanded: boolean;
    }
  | {
      kind: "load-more";
      key: string;
      groupKey: string;
      label: string;
      nextCount: number;
    };

function hasWorkspaceBinding(session: DisplaySession): boolean {
  return !!(session.workspaceName || session.originWorkspaceName);
}

const WORKFLOW_RUN_NAME_PREFIX = "Workflow: ";
const WORKFLOW_RUN_ID_SUFFIX = /\s+\([0-9a-f]{8}\)$/i;

function sessionDisplayName(session: DisplaySession): string {
  if (session.source !== "workflow-run") return session.name;

  const prefixedName = session.name.startsWith(WORKFLOW_RUN_NAME_PREFIX)
    ? session.name.slice(WORKFLOW_RUN_NAME_PREFIX.length)
    : session.name;
  const workflowName = prefixedName.replace(WORKFLOW_RUN_ID_SUFFIX, "").trim() || prefixedName;
  const timestamp = formatChatTooltip(new Date(session.createdAt));
  return timestamp ? `${workflowName} - ${timestamp}` : workflowName;
}

function isSessionRootVisible(
  session: DisplaySession,
  activeSessionId: string | null,
  isSearchActive: boolean,
): boolean {
  return (
    !hasWorkspaceBinding(session) ||
    !!session.registeredWorkspaceKey ||
    (session.isPinned ?? false) ||
    session.id === activeSessionId ||
    isSearchActive
  );
}

function registeredWorkspaceLabel(session: DisplaySession): string {
  return (
    session.registeredWorkspaceLabel ??
    session.workspaceName ??
    session.originWorkspaceName ??
    session.registeredWorkspaceKey ??
    "Workspace"
  );
}

function findNearestRootVisibleAncestor(
  session: DisplaySession,
  allSessionsById: ReadonlyMap<string, DisplaySession>,
  rootVisibleIds: ReadonlySet<string>,
): string | undefined {
  const visited = new Set([session.id]);
  let parentSessionId = session.parentSessionId;

  while (parentSessionId) {
    if (visited.has(parentSessionId)) return undefined;
    visited.add(parentSessionId);

    if (rootVisibleIds.has(parentSessionId)) return parentSessionId;
    const parent = allSessionsById.get(parentSessionId);
    if (!parent) return undefined;
    parentSessionId = parent.parentSessionId;
  }

  return undefined;
}

interface SessionHierarchy {
  rootSessions: DisplaySession[];
  nestedChildrenByRoot: ReadonlyMap<string, readonly DisplaySession[]>;
}

interface FilteredThreadHierarchy {
  rootSessions: DisplaySession[];
  nestedChildrenByRoot: ReadonlyMap<string, readonly DisplaySession[]>;
  visibleSessionCount: number;
}

function appendThreadSessionRows(
  rows: ThreadListRow[],
  session: DisplaySession,
  nestedChildrenByRoot: ReadonlyMap<string, readonly DisplaySession[]>,
  disclosureState: ReadonlySet<string>,
): void {
  const nestedChildren = nestedChildrenByRoot.get(session.id) ?? [];
  const areNestedChildrenExpanded =
    nestedChildren.length > 0 && disclosureState.has(nestedAgentsExpansionKey(session.id));
  rows.push({
    kind: "session",
    key: `session:${session.id}`,
    session,
    isNestedChild: false,
    nestedChildCount: nestedChildren.length,
    areNestedChildrenExpanded,
  });
  if (!areNestedChildrenExpanded) return;

  for (const child of nestedChildren) {
    rows.push({
      kind: "session",
      key: `session:${child.id}`,
      session: child,
      isNestedChild: true,
      nestedChildCount: 0,
      areNestedChildrenExpanded: false,
    });
  }
}

function appendThreadGroup(
  rows: ThreadListRow[],
  groupKey: string,
  label: string,
  sessions: DisplaySession[],
  disclosureState: ReadonlySet<string>,
  nestedChildrenByRoot: ReadonlyMap<string, readonly DisplaySession[]>,
  groupLimits: Readonly<Record<string, number>>,
  activeSessionId: string | null,
  limitSessions: boolean,
  workspaceName?: string,
): void {
  const isExpanded = !disclosureState.has(groupKey);
  rows.push({
    kind: "heading",
    key: `heading:${groupKey}`,
    groupKey,
    label,
    workspaceName,
    isExpanded,
  });
  if (!isExpanded) return;
  const visibleLimit = limitSessions
    ? (groupLimits[groupKey] ?? THREAD_GROUP_PAGE_SIZE)
    : sessions.length;
  let visibleSessions = sessions.slice(0, visibleLimit);
  const activeSession =
    activeSessionId && !visibleSessions.some((session) => session.id === activeSessionId)
      ? sessions.find((session) => session.id === activeSessionId)
      : undefined;
  if (activeSession && visibleSessions.length > 0) {
    const visibleIds = new Set(
      [...visibleSessions.slice(0, -1), activeSession].map((session) => session.id),
    );
    visibleSessions = sessions.filter((session) => visibleIds.has(session.id));
  }
  for (const session of visibleSessions) {
    appendThreadSessionRows(rows, session, nestedChildrenByRoot, disclosureState);
  }
  const remainingCount = sessions.length - visibleSessions.length;
  if (remainingCount > 0) {
    rows.push({
      kind: "load-more",
      key: `load-more:${groupKey}`,
      groupKey,
      label,
      nextCount: Math.min(THREAD_GROUP_PAGE_SIZE, remainingCount),
    });
  }
}

function buildThreadRows(
  hierarchy: FilteredThreadHierarchy,
  disclosureState: ReadonlySet<string>,
  groupLimits: Readonly<Record<string, number>>,
  activeSessionId: string | null,
  limitSessions: boolean,
): ThreadListRow[] {
  const generalSessions: DisplaySession[] = [];
  const workspaceSessions = new Map<string, { label: string; sessions: DisplaySession[] }>();

  for (const session of hierarchy.rootSessions) {
    const workspaceKey = session.registeredWorkspaceKey;
    if (!hasWorkspaceBinding(session) || !workspaceKey) {
      generalSessions.push(session);
      continue;
    }
    const group = workspaceSessions.get(workspaceKey);
    if (group) group.sessions.push(session);
    else {
      workspaceSessions.set(workspaceKey, {
        label: registeredWorkspaceLabel(session),
        sessions: [session],
      });
    }
  }

  const rows: ThreadListRow[] = [];
  if (generalSessions.length > 0) {
    appendThreadGroup(
      rows,
      GENERAL_THREAD_GROUP_KEY,
      "General",
      generalSessions,
      disclosureState,
      hierarchy.nestedChildrenByRoot,
      groupLimits,
      activeSessionId,
      limitSessions,
      undefined,
    );
  }

  const sortedWorkspaceGroups = [...workspaceSessions.entries()].sort(
    ([leftKey, left], [rightKey, right]) =>
      left.label.localeCompare(right.label) || leftKey.localeCompare(rightKey),
  );
  for (const [workspaceKey, group] of sortedWorkspaceGroups) {
    appendThreadGroup(
      rows,
      workspaceThreadGroupKey(workspaceKey),
      group.label,
      group.sessions,
      disclosureState,
      hierarchy.nestedChildrenByRoot,
      groupLimits,
      activeSessionId,
      limitSessions,
      group.label,
    );
  }

  return rows;
}

interface ThreadGroupHeadingProps {
  row: Extract<ThreadListRow, { kind: "heading" }>;
  onOpenChange: (groupKey: string, open: boolean) => void;
  onNewChat: (workspaceName: string) => void;
}

function ThreadGroupHeading({ row, onOpenChange, onNewChat }: ThreadGroupHeadingProps) {
  return (
    <div role="heading" aria-level={3} className="flex items-center">
      <Button
        type="button"
        variant="ghost"
        className="h-7 min-w-0 flex-1 justify-start gap-1 rounded-lg px-2 text-[10px] font-medium text-muted-foreground hover:bg-(--bg-hover) hover:text-foreground"
        aria-expanded={row.isExpanded}
        aria-label={`${row.isExpanded ? "Collapse" : "Expand"} ${row.label}`}
        onClick={() => onOpenChange(row.groupKey, !row.isExpanded)}
      >
        <ChevronRight
          className={cn("size-3 transition-transform", row.isExpanded && "rotate-90")}
        />
        <span className="truncate">{row.label}</span>
      </Button>
      {row.workspaceName ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
          aria-label={`New chat in ${row.label}`}
          title={`New chat in ${row.label}`}
          onClick={() => onNewChat(row.workspaceName!)}
        >
          <Plus className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

function ThreadGroupLoadMore({
  row,
  onLoadMore,
}: {
  row: Extract<ThreadListRow, { kind: "load-more" }>;
  onLoadMore: (groupKey: string) => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-8 w-full justify-start rounded-lg px-6 text-xs font-normal text-muted-foreground hover:bg-(--bg-hover) hover:text-foreground"
      aria-label={`Load ${row.nextCount} more sessions in ${row.label}`}
      onClick={() => onLoadMore(row.groupKey)}
    >
      Load {row.nextCount} more
    </Button>
  );
}

interface NavButtonProps {
  label: string;
  Icon?: MarshalIcon;
  customIcon?: ReactNode;
  isActive: boolean;
  /** Marks this button as the current page for assistive technology (aria-current). Defaults to isActive. */
  isCurrent?: boolean;
  isNarrow: boolean;
  badge?: number;
  onClick?: (e: React.MouseEvent) => void;
}

function NavButton({
  label,
  Icon,
  customIcon,
  isActive,
  isCurrent,
  isNarrow,
  badge,
  onClick,
}: NavButtonProps) {
  const btn = (
    <Button
      variant="ghost"
      size={isNarrow ? "icon-lg" : undefined}
      className={
        isNarrow
          ? `relative rounded-xl text-foreground transition-colors duration-150 hover:bg-(--bg-hover) ${isActive ? "bg-active-subtle" : ""}`
          : `h-auto w-full justify-start gap-2 rounded-xl px-3 py-1.5 font-normal text-foreground transition-colors duration-150 [&_svg]:text-foreground ${
              isActive ? "bg-active-subtle font-semibold" : "hover:bg-(--bg-hover)"
            }`
      }
      onClick={onClick}
      aria-label={isNarrow ? label : undefined}
      aria-current={(isCurrent ?? isActive) ? "page" : undefined}
    >
      {customIcon ?? (Icon && <Icon className="size-5 shrink-0" />)}
      {!isNarrow && label}
      {badge != null && badge > 0 && (
        <span
          className={
            isNarrow
              ? "absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-muted px-1 text-center text-[9px]/4 text-muted-foreground"
              : "ml-auto min-w-5 rounded-full bg-muted px-1.5 text-center text-[10px]/5 text-muted-foreground"
          }
          data-testid="automations-running-count"
        >
          {badge}
        </span>
      )}
    </Button>
  );
  if (!isNarrow) return btn;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{btn}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matchIndex = text.search(new RegExp(escaped, "i"));
  if (matchIndex === -1) return text;

  // If the match starts beyond a threshold, trim the beginning so the keyword is visible
  const CONTEXT_CHARS = 10;
  let displayText = text;
  let prefix = "";
  if (matchIndex > CONTEXT_CHARS + 3) {
    // Find a word boundary near the start of context
    const trimStart = Math.max(0, matchIndex - CONTEXT_CHARS);
    const spaceIndex = displayText.indexOf(" ", trimStart);
    const cutAt = spaceIndex !== -1 && spaceIndex < matchIndex ? spaceIndex + 1 : trimStart;
    displayText = displayText.slice(cutAt);
    prefix = "\u2026";
  }

  const parts = displayText.split(new RegExp(`(${escaped})`, "gi"));
  return (
    <>
      {prefix}
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          // eslint-disable-next-line react/no-array-index-key -- parsed content, no stable IDs
          <span key={i} className="font-semibold">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

interface SessionListItemProps {
  session: DisplaySession;
  activeSessionId: string | null;
  isEditing: boolean;
  isNestedChild?: boolean;
  nestedChildCount?: number;
  areNestedChildrenExpanded?: boolean;
  searchQuery?: string;
  showTooltip?: boolean;
  showTimestamp?: boolean;
  isDeletePending?: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onStartRename: (id: string) => void;
  onFinishRename: () => void;
  onRename?: (id: string, name: string) => void;
  onOpenInNewWindow?: (id: string, bounds?: { x: number; y: number }) => void;
  onNestedChildrenOpenChange?: (parentSessionId: string, open: boolean) => void;
}

interface NestedAgentsDisclosureProps {
  parentSessionId: string;
  parentSessionName: string;
  count: number;
  isExpanded: boolean;
  onOpenChange: (parentSessionId: string, open: boolean) => void;
}

function NestedAgentsDisclosure({
  parentSessionId,
  parentSessionName,
  count,
  isExpanded,
  onOpenChange,
}: NestedAgentsDisclosureProps) {
  const agentLabel = count === 1 ? "agent" : "agents";
  return (
    <Collapsible open={isExpanded} onOpenChange={(open) => onOpenChange(parentSessionId, open)}>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="-ml-1 h-5 min-w-8 shrink-0 gap-0.5 rounded-md px-1 text-[10px] text-muted-foreground hover:text-foreground"
          aria-label={`${isExpanded ? "Collapse" : "Expand"} ${count} nested ${agentLabel} for ${parentSessionName}`}
          data-testid="nested-agent-disclosure"
          onClick={(event) => event.stopPropagation()}
        >
          <ChevronRight className={cn("size-3 transition-transform", isExpanded && "rotate-90")} />
          <span data-testid="nested-agent-count">{count}</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent
        forceMount
        className="hidden"
        data-testid={`nested-agent-content-${parentSessionId}`}
      />
    </Collapsible>
  );
}

function SessionListItem(props: SessionListItemProps) {
  // The TelemetryPath wrapper must surround the hook calls — `useInteractiveElementMonitor_DragToPopout`
  // captures the surrounding telemetry context at hook-call time. Without the
  // split, the hook would capture `/App/Nav` and the DragToPopout measure
  // would emit under the wrong path. Splitting into Body keeps every hook
  // inside `<TelemetryPath_NavSessionItem>`.
  return (
    <TelemetryPath_NavSessionItem>
      <SessionListItemBody {...props} />
    </TelemetryPath_NavSessionItem>
  );
}

function SessionListItemBody({
  session,
  activeSessionId,
  isEditing,
  isNestedChild = false,
  nestedChildCount = 0,
  areNestedChildrenExpanded = false,
  searchQuery,
  showTooltip = true,
  showTimestamp = false,
  isDeletePending,
  onSelect,
  onDelete,
  onStartRename,
  onFinishRename,
  onRename,
  onOpenInNewWindow,
  onNestedChildrenOpenChange,
}: SessionListItemProps) {
  const displayName = sessionDisplayName(session);
  const chatWindowHandler = session.source === "workflow-run" ? undefined : onOpenInNewWindow;
  const renameCommittedRef = useRef(false);
  const restoreFocusPendingRef = useRef(false);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // Brief suppression after menu close so the tooltip doesn't flash while
  // the pointer is still near the trigger. Cleaned up on unmount via useTimeout.
  const [tooltipPaused, setTooltipPaused] = useState(false);
  useTimeout(() => setTooltipPaused(false), tooltipPaused ? 200 : null);
  // undefined = let Radix manage hover + focus natively (keyboard accessible)
  // false = force closed for suppress cases
  const tooltipOpen =
    isEditing || menuOpen || tooltipPaused || isDeletePending || !showTooltip ? false : undefined;

  const handleMenuOpenChange = (open: boolean) => {
    setMenuOpen(open);
    if (!open) setTooltipPaused(true);
  };

  const instrumentedOnOpenInNewWindow = useInteractiveElementMonitor_DragToPopout({
    hasContent: !!chatWindowHandler,
    callback: chatWindowHandler ?? (() => {}),
  });

  const { isDragging, isOutside, dragProps, dragPill } = useSessionDragOut({
    onOpenInNewWindow: chatWindowHandler ? instrumentedOnOpenInNewWindow : undefined,
    sessionId: session.id,
    sessionName: displayName,
  });

  const handleRenameInputRef = useCallback((input: HTMLInputElement | null) => {
    if (input) {
      renameCommittedRef.current = false;
      restoreFocusPendingRef.current = false;
      const active = document.activeElement;
      restoreFocusRef.current =
        active instanceof HTMLElement && active !== document.body ? active : null;
      input.focus();
      input.select();
      return;
    }

    if (!restoreFocusPendingRef.current) return;
    restoreFocusPendingRef.current = false;
    const previousFocus = restoreFocusRef.current;
    const focusTarget = previousFocus?.isConnected === true ? previousFocus : rowRef.current;
    focusTarget?.focus();
  }, []);

  return (
    <>
      <InteractiveElementMonitor_SessionItem callback={() => onSelect(session.id)}>
        {(cb) => (
          <Tooltip open={tooltipOpen} delayDuration={50}>
            <TooltipTrigger asChild>
              <div
                ref={rowRef}
                role="button"
                tabIndex={0}
                className={cn(
                  buttonVariants({ variant: "ghost", size: "default" }),
                  `group min-h-8 w-full cursor-pointer items-center gap-1 rounded-xl py-1.5 pr-2.5 text-left font-normal ${
                    session.id === activeSessionId ? "bg-active-subtle" : "bg-transparent"
                  }`,
                  isNestedChild ? "pl-7" : "pl-3",
                  isDragging && (isOutside ? "opacity-80" : "opacity-60"),
                )}
                data-testid="session-item"
                data-session-id={session.id}
                data-active={session.id === activeSessionId || undefined}
                data-nested={isNestedChild || undefined}
                onClick={cb}
                {...dragProps}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
                    e.preventDefault();
                    cb();
                  }
                }}
              >
                {nestedChildCount > 0 && onNestedChildrenOpenChange && (
                  <NestedAgentsDisclosure
                    parentSessionId={session.id}
                    parentSessionName={displayName}
                    count={nestedChildCount}
                    isExpanded={areNestedChildrenExpanded}
                    onOpenChange={onNestedChildrenOpenChange}
                  />
                )}
                {!isEditing && (
                  <SessionPinButton
                    sessionId={session.id}
                    sessionName={displayName}
                    isPinned={session.isPinned}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1">
                    {session.hasUnread && (
                      <span className="size-[7px] shrink-0 rounded-full bg-(--color-info)" />
                    )}
                    {(session.isBusy || session.hasRunningSubagent) && (
                      <span
                        className="inline-flex shrink-0 items-center text-primary"
                        title={
                          !session.isBusy && session.hasRunningSubagent
                            ? "Subagents are running"
                            : "Session is running"
                        }
                        aria-label={
                          !session.isBusy && session.hasRunningSubagent
                            ? "Subagents are running"
                            : "Session is running"
                        }
                        data-testid="session-running-spinner"
                      >
                        <LoaderCircle size={11} className="animate-spin" />
                      </span>
                    )}
                    {session.source === "automation" && (
                      <span
                        className="inline-flex shrink-0 items-center text-muted-foreground"
                        title="Automation run"
                      >
                        <RefreshCw size={10} />
                      </span>
                    )}
                    {session.source === "subagent" && (
                      <span
                        className="inline-flex shrink-0 items-center text-muted-foreground"
                        title="Subagent"
                      >
                        <Bot size={10} />
                      </span>
                    )}
                    {isEditing ? (
                      <input
                        ref={handleRenameInputRef}
                        className="w-full truncate rounded-sm bg-transparent px-1 text-sm ring-1 ring-border outline-none"
                        data-testid="session-rename-input"
                        aria-label={`Rename ${displayName}`}
                        defaultValue={session.name}
                        onKeyDown={(e) => {
                          if (e.nativeEvent.isComposing) return;
                          if (e.key === "Enter") {
                            e.preventDefault();
                            const trimmed = e.currentTarget.value.trim();
                            if (trimmed && trimmed !== session.name) {
                              onRename?.(session.id, trimmed);
                            }
                            renameCommittedRef.current = true;
                            restoreFocusPendingRef.current = true;
                            onFinishRename();
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            renameCommittedRef.current = true;
                            restoreFocusPendingRef.current = true;
                            onFinishRename();
                          }
                        }}
                        onBlur={(e) => {
                          if (renameCommittedRef.current) {
                            renameCommittedRef.current = false;
                            return;
                          }
                          const trimmed = e.currentTarget.value.trim();
                          if (trimmed && trimmed !== session.name) {
                            onRename?.(session.id, trimmed);
                          }
                          onFinishRename();
                        }}
                        onFocus={(e) => e.target.select()}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : isDragging && isOutside ? (
                      <span className="flex items-center gap-1.5 truncate text-sm text-foreground">
                        <ExternalLink size={12} className="shrink-0" />
                        Open in New Window
                      </span>
                    ) : (
                      <span className="truncate text-sm">
                        {highlightMatch(displayName, searchQuery ?? "")}
                      </span>
                    )}
                  </div>
                  {!!searchQuery && !showTimestamp && (
                    <div
                      className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground"
                      data-testid="session-date"
                    >
                      {formatDate(session.updatedAt)}
                    </div>
                  )}
                </div>
                {showTimestamp && !isEditing && (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {formatDate(session.updatedAt)}
                  </span>
                )}
                {!isEditing && session.source !== "workflow-run" && (
                  <InteractiveElementMonitor_DeleteSession callback={() => onDelete(session.id)}>
                    {(deleteCb) => (
                      <SessionOverflowMenu
                        onRename={() => {
                          onStartRename(session.id);
                        }}
                        onDelete={deleteCb}
                        onOpenInNewWindow={
                          chatWindowHandler
                            ? () => instrumentedOnOpenInNewWindow(session.id)
                            : undefined
                        }
                        onOpenChange={handleMenuOpenChange}
                      />
                    )}
                  </InteractiveElementMonitor_DeleteSession>
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent
              side="right"
              align="start"
              sideOffset={4}
              hideArrow
              className="max-w-xs flex-col items-start rounded-lg px-3 py-2"
            >
              <p className="text-sm">{displayName}</p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                {formatDateFull(session.updatedAt)}
              </p>
            </TooltipContent>
          </Tooltip>
        )}
      </InteractiveElementMonitor_SessionItem>
      {dragPill}
    </>
  );
}

interface PinnedThreadListProps {
  sessions: DisplaySession[];
  nestedChildrenByRoot: ReadonlyMap<string, readonly DisplaySession[]>;
  disclosureState: ReadonlySet<string>;
  activeSessionId: string | null;
  renamingSessionId: string | null;
  pendingDeleteId: string | null;
  searchQuery?: string;
  showTooltip?: boolean;
  className?: string;
  isExpanded: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onStartRename: (id: string) => void;
  onFinishRename: () => void;
  onRename: (id: string, name: string) => void;
  onOpenInNewWindow?: (id: string, bounds?: { x: number; y: number }) => void;
  onNestedChildrenOpenChange: (parentSessionId: string, open: boolean) => void;
}

function PinnedThreadList({
  sessions,
  nestedChildrenByRoot,
  disclosureState,
  activeSessionId,
  renamingSessionId,
  pendingDeleteId,
  searchQuery,
  showTooltip = true,
  className,
  isExpanded,
  onOpenChange,
  onSelect,
  onDelete,
  onStartRename,
  onFinishRename,
  onRename,
  onOpenInNewWindow,
  onNestedChildrenOpenChange,
}: PinnedThreadListProps) {
  if (sessions.length === 0) return null;

  return (
    <section className={className} data-testid="pinned-threads-section">
      <h2>
        <Button
          type="button"
          variant="ghost"
          className="h-7 w-full justify-start gap-1 rounded-lg px-1 text-xs font-medium text-muted-foreground hover:bg-(--bg-hover) hover:text-foreground"
          aria-expanded={isExpanded}
          aria-label={`${isExpanded ? "Collapse" : "Expand"} Pinned threads`}
          onClick={() => onOpenChange(!isExpanded)}
        >
          <ChevronRight className={cn("size-3 transition-transform", isExpanded && "rotate-90")} />
          <span className="truncate">Pinned threads</span>
        </Button>
      </h2>
      {isExpanded && (
        <div className="mt-1">
          {sessions.map((session) => {
            const nestedChildren = nestedChildrenByRoot.get(session.id) ?? [];
            const areNestedChildrenExpanded =
              nestedChildren.length > 0 &&
              disclosureState.has(nestedAgentsExpansionKey(session.id));
            return (
              <Fragment key={session.id}>
                <SessionListItem
                  session={session}
                  activeSessionId={activeSessionId}
                  isEditing={renamingSessionId === session.id}
                  nestedChildCount={nestedChildren.length}
                  areNestedChildrenExpanded={areNestedChildrenExpanded}
                  searchQuery={searchQuery}
                  showTooltip={showTooltip}
                  showTimestamp
                  isDeletePending={pendingDeleteId === session.id}
                  onSelect={onSelect}
                  onDelete={onDelete}
                  onStartRename={onStartRename}
                  onFinishRename={onFinishRename}
                  onRename={onRename}
                  onOpenInNewWindow={onOpenInNewWindow}
                  onNestedChildrenOpenChange={onNestedChildrenOpenChange}
                />
                {areNestedChildrenExpanded &&
                  nestedChildren.map((child) => (
                    <SessionListItem
                      key={child.id}
                      session={child}
                      activeSessionId={activeSessionId}
                      isEditing={renamingSessionId === child.id}
                      isNestedChild
                      searchQuery={searchQuery}
                      showTooltip={showTooltip}
                      showTimestamp
                      isDeletePending={pendingDeleteId === child.id}
                      onSelect={onSelect}
                      onDelete={onDelete}
                      onStartRename={onStartRename}
                      onFinishRename={onFinishRename}
                      onRename={onRename}
                      onOpenInNewWindow={onOpenInNewWindow}
                    />
                  ))}
              </Fragment>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function LeftNav({
  activeView,
  highlightedView,
  onViewChange,
  onNewChat,
  activeSessionId,
  renameSessionRequest,
  onRenameSessionRequestHandled,
  onSessionSelect,
  onDeleteSession,
  navigationKey,
  getNavigationEpoch,
  onOpenSessionInNewWindow,
  onSettingsAltClick,
}: LeftNavProps) {
  // useState lazy initializer guarantees the MediaQueryList is created once at
  // mount and identity is stable for the component lifetime — useMemo doesn't
  // promise that (React may evict memos under memory pressure).
  const [mq] = useState(() => window.matchMedia("(max-width: 599px)"));
  const [isNarrow, setIsNarrow] = useState(() => mq.matches);
  useEffect(() => {
    const handler = (e: MediaQueryListEvent) => setIsNarrow(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [mq]);

  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [renameState, setRenameState] = useState<{
    activeSessionId: string | null;
    manualSessionId: string | null;
    dismissedRequestId: number | null;
  }>({
    activeSessionId,
    manualSessionId: null,
    dismissedRequestId: null,
  });
  if (renameState.activeSessionId !== activeSessionId) {
    setRenameState({
      activeSessionId,
      manualSessionId: null,
      dismissedRequestId: renameSessionRequest?.requestId ?? null,
    });
  }
  const requestedRenameSessionId =
    renameSessionRequest &&
    renameSessionRequest.requestId !== renameState.dismissedRequestId &&
    renameSessionRequest.sessionId === activeSessionId
      ? renameSessionRequest.sessionId
      : null;
  const renamingSessionId = renameState.manualSessionId ?? requestedRenameSessionId;
  const handleStartRename = useCallback((sessionId: string) => {
    setRenameState((previous) => ({ ...previous, manualSessionId: sessionId }));
  }, []);
  const handleFinishRename = useCallback(() => {
    if (renameSessionRequest) {
      onRenameSessionRequestHandled?.(renameSessionRequest.requestId);
    }
    setRenameState((previous) => ({
      ...previous,
      manualSessionId: null,
      dismissedRequestId: renameSessionRequest?.requestId ?? previous.dismissedRequestId,
    }));
  }, [onRenameSessionRequestHandled, renameSessionRequest]);

  const {
    sessions,
    displaySessions,
    searchQuery,
    setSearchQuery,
    filter: sourceFilter,
    setFilter: setSourceFilter,
    isSearchStale,
    isLoading: sessionsLoading,
    isError: sessionsError,
    errorMessage: sessionsErrorMessage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    loadMore,
    optimisticRemove,
    refetch: refetchSessions,
  } = useSessions({ includeWorkflowRuns: true });
  if (sourceFilter !== "all") setSourceFilter("all");

  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const pendingSession = pendingDeleteId ? sessions.find((s) => s.id === pendingDeleteId) : null;
  const [selectedSessionFilters, setSelectedSessionFilters] = useState<Set<SidebarSessionFilter>>(
    () => new Set(DEFAULT_SESSION_FILTERS),
  );
  const [threadDisclosureState, setThreadDisclosureState] = useState(loadThreadDisclosureState);
  const [threadGroupLimits, setThreadGroupLimits] = useState<Record<string, number>>({});
  const workflowRunOpenRequestRef = useRef(0);
  useEffect(() => {
    workflowRunOpenRequestRef.current += 1;
  }, [activeView, navigationKey]);
  useEffect(
    () => () => {
      workflowRunOpenRequestRef.current += 1;
    },
    [],
  );

  const narrowSessionViewportRef = useRef<HTMLDivElement>(null);
  const wideNavViewportRef = useRef<HTMLDivElement>(null);
  const narrowSessionListRef = useRef<HTMLDivElement>(null);
  const wideSessionListRef = useRef<HTMLDivElement>(null);

  const allSessionFiltersSelected = selectedSessionFilters.size === SESSION_FILTER_OPTIONS.length;
  const defaultSessionFiltersSelected =
    selectedSessionFilters.size === DEFAULT_SESSION_FILTERS.size &&
    [...DEFAULT_SESSION_FILTERS].every((filter) => selectedSessionFilters.has(filter));
  const handleAllSessionFiltersChange = useCallback((checked: boolean) => {
    setSelectedSessionFilters(checked ? new Set(ALL_SESSION_FILTERS) : new Set());
  }, []);
  const handleSessionFilterChange = useCallback((value: SidebarSessionFilter, checked: boolean) => {
    setSelectedSessionFilters((previous) => {
      const next = new Set(previous);
      if (checked) next.add(value);
      else next.delete(value);
      return next;
    });
  }, []);
  const handleThreadGroupOpenChange = useCallback((groupKey: string, open: boolean) => {
    setThreadDisclosureState((previous) => {
      const wasCollapsed = previous.has(groupKey);
      if ((open && !wasCollapsed) || (!open && wasCollapsed)) return previous;
      const next = new Set(previous);
      if (open) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }, []);
  const handleNestedChildrenOpenChange = useCallback((parentSessionId: string, open: boolean) => {
    setThreadDisclosureState((previous) => {
      const expansionKey = nestedAgentsExpansionKey(parentSessionId);
      const wasExpanded = previous.has(expansionKey);
      if (open === wasExpanded) return previous;
      const next = new Set(previous);
      if (open) next.add(expansionKey);
      else next.delete(expansionKey);
      return next;
    });
  }, []);
  const handleThreadGroupLoadMore = useCallback((groupKey: string) => {
    setThreadGroupLimits((previous) => ({
      ...previous,
      [groupKey]: (previous[groupKey] ?? THREAD_GROUP_PAGE_SIZE) + THREAD_GROUP_PAGE_SIZE,
    }));
  }, []);
  useEffect(() => {
    persistThreadDisclosureState(threadDisclosureState);
  }, [threadDisclosureState]);

  const handleDelete = (sessionId: string) => {
    setPendingDeleteId(sessionId);
  };

  const handleDeleteConfirm = () => {
    if (pendingDeleteId) {
      optimisticRemove(pendingDeleteId);
      onDeleteSession(pendingDeleteId);
      setPendingDeleteId(null);
    }
  };

  const runtimeNavigation = useRuntimeUiNavigation();
  const handleNavClick = (view: NavView, e?: React.MouseEvent) => {
    runtimeNavigation?.dismiss();
    workflowRunOpenRequestRef.current += 1;
    if (view === "settings" && e?.altKey) {
      onSettingsAltClick?.();
    }
    onViewChange(view);
  };

  const handleNewChatClick = () => {
    runtimeNavigation?.dismiss();
    workflowRunOpenRequestRef.current += 1;
    onNewChat();
  };

  const handleWorkflowRunClick = useCallback(
    async (hostSessionId: string) => {
      const requestId = ++workflowRunOpenRequestRef.current;
      const navigationEpoch = getNavigationEpoch?.();
      const api = window.workflowsAPI;
      if (!api) {
        if (requestId === workflowRunOpenRequestRef.current) {
          toast.error("Workflows API unavailable");
        }
        return;
      }
      try {
        const result = await api.getRunForHostSession(hostSessionId);
        if (
          requestId !== workflowRunOpenRequestRef.current ||
          (navigationEpoch !== undefined && getNavigationEpoch?.() !== navigationEpoch)
        ) {
          return;
        }
        if (!result.success || !result.runId) {
          toast.error(result.error ?? "Workflow run not found");
          return;
        }
        onViewChange("workflows", { runId: result.runId });
      } catch (error) {
        if (requestId === workflowRunOpenRequestRef.current) {
          toast.error(error instanceof Error ? error.message : "Failed to open workflow run");
        }
      }
    },
    [getNavigationEpoch, onViewChange],
  );

  const handleSessionClick = (sessionId: string) => {
    runtimeNavigation?.dismiss();
    const session = displaySessions.find((candidate) => candidate.id === sessionId);
    if (session?.source === "workflow-run") {
      void handleWorkflowRunClick(sessionId);
      if (isNarrow) setSessionsOpen(false);
      return;
    }
    workflowRunOpenRequestRef.current += 1;
    onSessionSelect(sessionId);
    onViewChange("chat", { sessionId });
    if (isNarrow) {
      setSessionsOpen(false);
    }
  };

  const handleRename = useCallback(
    async (sessionId: string, name: string) => {
      await window.sessionsAPI?.rename(sessionId, name);
      void refetchSessions();
    },
    [refetchSessions],
  );
  const handleSessionScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
      if (scrollHeight - scrollTop - clientHeight <= 160) void loadMore();
    },
    [loadMore],
  );

  const visibleNarrowItems = ALL_NAV_ITEMS;

  const runtimeApplicationActive = Boolean(runtimeNavigation?.selectedInstanceId);
  const visualView = runtimeApplicationActive ? undefined : (highlightedView ?? activeView);
  const visualActiveSessionId = visualView === "chat" ? activeSessionId : null;

  const runningAutomationCount = useMemo(
    () =>
      sessions.filter(
        (session) =>
          !!session.automationId &&
          (session.isBusy === true || session.hasRunningSubagent === true),
      ).length,
    [sessions],
  );
  const isSearchActive = searchQuery.trim().length > 0;
  const sessionHierarchy = useMemo<SessionHierarchy>(() => {
    const allSessionsById = new Map(displaySessions.map((session) => [session.id, session]));
    const rootSessions = displaySessions.filter((session) =>
      isSessionRootVisible(session, activeSessionId, isSearchActive),
    );
    const rootVisibleIds = new Set(rootSessions.map((session) => session.id));
    const nestedChildrenByRoot = new Map<string, DisplaySession[]>();

    for (const session of displaySessions) {
      if (rootVisibleIds.has(session.id)) continue;
      const rootSessionId = findNearestRootVisibleAncestor(
        session,
        allSessionsById,
        rootVisibleIds,
      );
      if (!rootSessionId) continue;
      const children = nestedChildrenByRoot.get(rootSessionId);
      if (children) children.push(session);
      else nestedChildrenByRoot.set(rootSessionId, [session]);
    }
    for (const children of nestedChildrenByRoot.values()) {
      children.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }

    return { rootSessions, nestedChildrenByRoot };
  }, [activeSessionId, displaySessions, isSearchActive]);
  const pinnedSessions = useMemo(
    // Pinned threads stay reachable regardless of the active Threads filter.
    () => sessionHierarchy.rootSessions.filter((session) => session.isPinned ?? false),
    [sessionHierarchy.rootSessions],
  );
  const filteredThreadHierarchy = useMemo<FilteredThreadHierarchy>(() => {
    const rootSessions: DisplaySession[] = [];
    const nestedChildrenByRoot = new Map<string, DisplaySession[]>();
    let visibleSessionCount = 0;

    for (const session of sessionHierarchy.rootSessions) {
      if (session.isPinned ?? false) continue;
      const matchingChildren = (sessionHierarchy.nestedChildrenByRoot.get(session.id) ?? []).filter(
        (child) => matchesSidebarFilter(child, selectedSessionFilters),
      );
      if (!matchesSidebarFilter(session, selectedSessionFilters) && matchingChildren.length === 0) {
        continue;
      }

      rootSessions.push(session);
      visibleSessionCount += 1 + matchingChildren.length;
      if (matchingChildren.length > 0) {
        nestedChildrenByRoot.set(session.id, matchingChildren);
      }
    }

    return { rootSessions, nestedChildrenByRoot, visibleSessionCount };
  }, [selectedSessionFilters, sessionHierarchy]);
  const threadRows = useMemo(
    () =>
      buildThreadRows(
        filteredThreadHierarchy,
        threadDisclosureState,
        threadGroupLimits,
        activeSessionId,
        !isSearchActive,
      ),
    [
      activeSessionId,
      filteredThreadHierarchy,
      isSearchActive,
      threadDisclosureState,
      threadGroupLimits,
    ],
  );

  const narrowSessionVirtualizer = useVirtualizer({
    count: threadRows.length,
    getScrollElement: () => narrowSessionViewportRef.current,
    getItemKey: (index) => threadRows[index]?.key ?? index,
    estimateSize: (index) => {
      const kind = threadRows[index]?.kind;
      return kind === "heading" ? 28 : kind === "load-more" ? 32 : 40;
    },
    measureElement: (element) => element.getBoundingClientRect().height || 40,
    overscan: 6,
    initialRect: { width: 256, height: 600 },
    observeElementRect: (instance, callback) =>
      observeElementRect<HTMLDivElement>(instance, (rect) =>
        callback(rect.height > 0 ? rect : { width: rect.width || 256, height: 600 }),
      ),
    scrollMargin: narrowSessionListRef.current?.offsetTop ?? 0,
  });
  const wideSessionVirtualizer = useVirtualizer({
    count: threadRows.length,
    getScrollElement: () => wideNavViewportRef.current,
    getItemKey: (index) => threadRows[index]?.key ?? index,
    estimateSize: (index) => {
      const kind = threadRows[index]?.kind;
      return kind === "heading" ? 28 : kind === "load-more" ? 32 : 40;
    },
    measureElement: (element) => element.getBoundingClientRect().height || 40,
    overscan: 6,
    initialRect: { width: 256, height: 600 },
    observeElementRect: (instance, callback) =>
      observeElementRect<HTMLDivElement>(instance, (rect) =>
        callback(rect.height > 0 ? rect : { width: rect.width || 256, height: 600 }),
      ),
    scrollMargin: wideSessionListRef.current?.offsetTop ?? 0,
  });
  const activeSessionIndex = visualActiveSessionId
    ? threadRows.findIndex(
        (row) => row.kind === "session" && row.session.id === visualActiveSessionId,
      )
    : -1;
  const sessionPagingStatus = sessionsLoading ? (
    <div
      className="flex items-center justify-center gap-2 p-3 text-xs text-muted-foreground"
      data-testid="sessions-loading"
    >
      <LoaderCircle className="size-3.5 animate-spin" />
      Loading sessions…
    </div>
  ) : sessionsError && sessions.length === 0 ? (
    <div className="p-3 text-center text-xs text-destructive" data-testid="sessions-error">
      <p>{sessionsErrorMessage ?? "Sessions could not be loaded"}</p>
      <Button variant="ghost" size="sm" onClick={() => void refetchSessions()}>
        Retry
      </Button>
    </div>
  ) : isFetchNextPageError ? (
    <div
      className="px-3 py-2 text-center text-xs text-destructive"
      data-testid="sessions-more-error"
    >
      <p>More sessions could not be loaded.</p>
      <Button variant="ghost" size="sm" onClick={() => void loadMore()}>
        Retry
      </Button>
    </div>
  ) : isFetchingNextPage ? (
    <div
      className="flex items-center justify-center gap-2 px-3 py-2 text-xs text-muted-foreground"
      data-testid="sessions-loading-more"
    >
      <LoaderCircle className="size-3.5 animate-spin" />
      Loading more…
    </div>
  ) : !searchQuery.trim() && sessions.length > 0 && !hasNextPage ? (
    <div className="px-3 py-2 text-center text-xs text-muted-foreground" data-testid="sessions-end">
      End of sessions
    </div>
  ) : null;

  useEffect(() => {
    if (
      searchQuery.trim() ||
      sessionsLoading ||
      isFetchingNextPage ||
      !hasNextPage ||
      filteredThreadHierarchy.visibleSessionCount >= SESSION_PAGE_SIZE
    ) {
      return;
    }
    void loadMore();
  }, [
    hasNextPage,
    isFetchingNextPage,
    loadMore,
    searchQuery,
    sessionsLoading,
    filteredThreadHierarchy.visibleSessionCount,
  ]);

  useEffect(() => {
    const virtualizer = isNarrow ? narrowSessionVirtualizer : wideSessionVirtualizer;
    if (activeSessionIndex >= 0) {
      virtualizer.scrollToIndex(activeSessionIndex, { align: "auto" });
    } else {
      virtualizer.scrollToIndex(0, { align: "start" });
    }
  }, [
    activeSessionIndex,
    isNarrow,
    narrowSessionVirtualizer,
    sessionsOpen,
    wideSessionVirtualizer,
  ]);

  if (isNarrow) {
    return (
      <TelemetryPath_Nav>
        <nav
          aria-label="Main navigation"
          data-drag-boundary="nav"
          className="flex h-full w-14 min-w-14 flex-col overflow-visible border-r border-border bg-accent"
        >
          <div className="flex h-full w-14 flex-col items-center px-1.5 py-2 shadow-[1px_0_3px_rgba(0,0,0,0.08)]">
            <div className="flex flex-col gap-1.5">
              {visibleNarrowItems.map(({ view, label, Icon, customIcon }, i) => {
                const isActive = visualView === view;
                const isCurrent = !runtimeApplicationActive && activeView === view;

                if (view === "chat") {
                  // Icon highlights only on the fresh-new-chat state; hovering
                  // surfaces the sessions flyout for switching between chats.
                  return (
                    <HoverCard
                      key={view}
                      open={sessionsOpen || renamingSessionId !== null}
                      onOpenChange={setSessionsOpen}
                      openDelay={0}
                      closeDelay={300}
                    >
                      <HoverCardTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-lg"
                          data-testid="new-chat-btn"
                          className="rounded-xl text-brand-action hover:bg-(--bg-hover)"
                          onClick={() => {
                            handleNewChatClick();
                            setSessionsOpen(false);
                          }}
                          aria-label="New chat"
                        >
                          {customIcon ?? (Icon && <Icon className="size-5 shrink-0" />)}
                        </Button>
                      </HoverCardTrigger>
                      <HoverCardContent
                        side="right"
                        align="start"
                        sideOffset={8}
                        className="w-64 rounded-xl border-border bg-accent p-0 shadow-md"
                      >
                        <div className="p-2">
                          <Button
                            variant="ghost"
                            className="w-full justify-start gap-2 rounded-xl px-3 text-sm font-normal text-brand-action hover:bg-(--bg-hover)"
                            onClick={() => {
                              handleNewChatClick();
                              setSessionsOpen(false);
                            }}
                          >
                            <NewChatIcon className="size-4 shrink-0" /> New chat
                          </Button>
                        </div>
                        <PinnedThreadList
                          sessions={pinnedSessions}
                          nestedChildrenByRoot={sessionHierarchy.nestedChildrenByRoot}
                          disclosureState={threadDisclosureState}
                          activeSessionId={visualActiveSessionId}
                          renamingSessionId={renamingSessionId}
                          pendingDeleteId={pendingDeleteId}
                          searchQuery={searchQuery}
                          showTooltip={false}
                          className="px-2 pb-2"
                          isExpanded={!threadDisclosureState.has(PINNED_THREAD_GROUP_KEY)}
                          onOpenChange={(open) =>
                            handleThreadGroupOpenChange(PINNED_THREAD_GROUP_KEY, open)
                          }
                          onSelect={handleSessionClick}
                          onDelete={handleDelete}
                          onStartRename={handleStartRename}
                          onFinishRename={handleFinishRename}
                          onRename={handleRename}
                          onOpenInNewWindow={onOpenSessionInNewWindow}
                          onNestedChildrenOpenChange={handleNestedChildrenOpenChange}
                        />
                        <div className="px-4 pb-1">
                          <h3 className="text-[10px] font-normal text-muted-foreground">Threads</h3>
                        </div>
                        <ScrollArea
                          viewportRef={narrowSessionViewportRef}
                          viewportProps={{
                            onScroll: handleSessionScroll,
                            "aria-label": "Compact session list",
                          }}
                          className="max-h-[600px] [&_[data-slot=scroll-area-viewport]>div]:block! [&_[data-slot=scroll-area-viewport]>div]:min-w-0!"
                        >
                          <div
                            ref={narrowSessionListRef}
                            className="relative mx-2 mb-2"
                            style={{
                              height:
                                threadRows.length === 0
                                  ? "auto"
                                  : narrowSessionVirtualizer.getTotalSize(),
                            }}
                            data-testid="narrow-session-virtual-list"
                          >
                            {narrowSessionVirtualizer.getVirtualItems().map((virtualRow) => {
                              const row = threadRows[virtualRow.index];
                              if (!row) return null;
                              return (
                                <div
                                  key={virtualRow.key}
                                  ref={narrowSessionVirtualizer.measureElement}
                                  data-index={virtualRow.index}
                                  className="absolute top-0 left-0 w-full"
                                  style={{
                                    transform: `translateY(${virtualRow.start - narrowSessionVirtualizer.options.scrollMargin}px)`,
                                  }}
                                >
                                  {row.kind === "heading" ? (
                                    <ThreadGroupHeading
                                      row={row}
                                      onOpenChange={handleThreadGroupOpenChange}
                                      onNewChat={onNewChat}
                                    />
                                  ) : row.kind === "load-more" ? (
                                    <ThreadGroupLoadMore
                                      row={row}
                                      onLoadMore={handleThreadGroupLoadMore}
                                    />
                                  ) : (
                                    <SessionListItem
                                      session={row.session}
                                      activeSessionId={visualActiveSessionId}
                                      isEditing={renamingSessionId === row.session.id}
                                      isNestedChild={row.isNestedChild}
                                      nestedChildCount={row.nestedChildCount}
                                      areNestedChildrenExpanded={row.areNestedChildrenExpanded}
                                      showTooltip={false}
                                      isDeletePending={pendingDeleteId === row.session.id}
                                      onSelect={handleSessionClick}
                                      onDelete={handleDelete}
                                      onStartRename={handleStartRename}
                                      onFinishRename={handleFinishRename}
                                      onRename={handleRename}
                                      onOpenInNewWindow={onOpenSessionInNewWindow}
                                      onNestedChildrenOpenChange={handleNestedChildrenOpenChange}
                                    />
                                  )}
                                </div>
                              );
                            })}
                            {threadRows.length === 0 && !sessionsLoading && !sessionsError && (
                              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                                {pinnedSessions.length > 0
                                  ? "No other threads."
                                  : "No threads yet."}
                              </div>
                            )}
                          </div>
                          {sessionPagingStatus}
                        </ScrollArea>
                      </HoverCardContent>
                    </HoverCard>
                  );
                }

                return (
                  <InteractiveElementMonitor_NavItem
                    key={view}
                    callback={(e?: React.MouseEvent) => handleNavClick(view, e)}
                    index={i}
                    getMisc={() => ({ navView: view })}
                  >
                    {(cb) => (
                      <NavButton
                        label={label}
                        Icon={Icon}
                        customIcon={customIcon}
                        isActive={isActive}
                        isCurrent={isCurrent}
                        isNarrow
                        badge={view === "automations" ? runningAutomationCount : undefined}
                        onClick={cb}
                      />
                    )}
                  </InteractiveElementMonitor_NavItem>
                );
              })}
              <RuntimeUiNavigationEntries compact />
            </div>

            {/* Spacer */}
            <div className="flex-1" />

            <InteractiveElementMonitor_NavItem
              callback={(e?: React.MouseEvent) => handleNavClick("settings", e)}
              index={visibleNarrowItems.length}
              getMisc={() => ({ navView: "settings" })}
            >
              {(cb) => (
                <SidebarAccountSettings
                  compact
                  isActive={visualView === "settings"}
                  isCurrent={!runtimeApplicationActive && activeView === "settings"}
                  onClick={cb}
                />
              )}
            </InteractiveElementMonitor_NavItem>
          </div>

          <DeleteSessionDialog
            open={!!pendingDeleteId}
            onOpenChange={(open) => {
              if (!open) setPendingDeleteId(null);
            }}
            sessionName={pendingSession?.name ?? ""}
            onConfirm={handleDeleteConfirm}
          />
        </nav>
      </TelemetryPath_Nav>
    );
  }

  const wideNavItems = ALL_NAV_ITEMS.filter((item) => !item.narrowOnly);

  return (
    <TelemetryPath_Nav>
      <nav
        aria-label="Main navigation"
        data-drag-boundary="nav"
        className="flex h-full w-64 min-w-64 flex-col overflow-hidden border-r border-border bg-accent select-none"
      >
        <ScrollArea
          viewportRef={wideNavViewportRef}
          viewportProps={{
            onScroll: handleSessionScroll,
            "aria-label": "Session list",
          }}
          // Bottom fade-out via CSS mask on the viewport hints at more scrollable
          // content. Sibling ScrollBar lives outside the viewport, so the thumb
          // is unaffected.
          className={`min-h-0 flex-1 **:data-[slot=scroll-area-viewport]:mask-[linear-gradient(to_bottom,black_calc(100%-2rem),transparent)] [&_[data-slot=scroll-area-viewport]>div]:block! [&_[data-slot=scroll-area-viewport]>div]:min-w-0!${isSearchStale ? " transition-opacity" : ""}`}
        >
          <div className="flex flex-col px-2 pt-2">
            <InteractiveElementMonitor_NewChat callback={handleNewChatClick}>
              {(cb) => (
                <Button
                  variant="ghost"
                  className="h-auto w-full justify-start gap-2 rounded-xl px-3 py-1.5 text-sm font-normal text-brand-action hover:bg-(--bg-hover)"
                  data-testid="new-chat-btn"
                  onClick={cb}
                >
                  <NewChatIcon className="size-4 shrink-0" />
                  New chat
                </Button>
              )}
            </InteractiveElementMonitor_NewChat>
            {wideNavItems.map(({ view, label, Icon, customIcon }, i) => (
              <InteractiveElementMonitor_NavItem
                key={view}
                callback={(e?: React.MouseEvent) => handleNavClick(view, e)}
                index={i}
                getMisc={() => ({ navView: view })}
              >
                {(cb) => (
                  <NavButton
                    label={label}
                    Icon={Icon}
                    customIcon={customIcon}
                    isActive={visualView === view}
                    isCurrent={!runtimeApplicationActive && activeView === view}
                    isNarrow={false}
                    badge={view === "automations" ? runningAutomationCount : undefined}
                    onClick={cb}
                  />
                )}
              </InteractiveElementMonitor_NavItem>
            ))}
            <RuntimeUiNavigationEntries />
          </div>

          <PinnedThreadList
            sessions={pinnedSessions}
            nestedChildrenByRoot={sessionHierarchy.nestedChildrenByRoot}
            disclosureState={threadDisclosureState}
            activeSessionId={visualActiveSessionId}
            renamingSessionId={renamingSessionId}
            pendingDeleteId={pendingDeleteId}
            searchQuery={searchQuery}
            className="mt-3 px-2"
            isExpanded={!threadDisclosureState.has(PINNED_THREAD_GROUP_KEY)}
            onOpenChange={(open) => handleThreadGroupOpenChange(PINNED_THREAD_GROUP_KEY, open)}
            onSelect={handleSessionClick}
            onDelete={handleDelete}
            onStartRename={handleStartRename}
            onFinishRename={handleFinishRename}
            onRename={handleRename}
            onOpenInNewWindow={onOpenSessionInNewWindow}
            onNestedChildrenOpenChange={handleNestedChildrenOpenChange}
          />

          <div className="mt-3 flex items-center justify-between px-3 pb-1">
            <h2 className="text-xs font-medium text-muted-foreground">Threads</h2>
            <DropdownMenu>
              <Tooltip>
                <DropdownMenuTrigger asChild>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className={cn(
                        "relative text-muted-foreground hover:text-foreground",
                        !defaultSessionFiltersSelected && "text-foreground",
                      )}
                      aria-label={
                        defaultSessionFiltersSelected ? "Filter threads" : "Filter threads (active)"
                      }
                    >
                      <SlidersHorizontal className="size-3.5" />
                      {!defaultSessionFiltersSelected && (
                        <span
                          className="absolute top-0 right-0 size-1.5 rounded-full bg-primary"
                          data-testid="session-filter-active"
                        />
                      )}
                    </Button>
                  </TooltipTrigger>
                </DropdownMenuTrigger>
                <TooltipContent side="top">Filter threads</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuCheckboxItem
                  checked={allSessionFiltersSelected}
                  onCheckedChange={handleAllSessionFiltersChange}
                  onSelect={(event) => event.preventDefault()}
                >
                  All
                </DropdownMenuCheckboxItem>
                {SESSION_FILTER_OPTIONS.map((option) => (
                  <DropdownMenuCheckboxItem
                    key={option.value}
                    checked={selectedSessionFilters.has(option.value)}
                    onCheckedChange={(checked) => handleSessionFilterChange(option.value, checked)}
                    onSelect={(event) => event.preventDefault()}
                  >
                    {option.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="relative px-2 pb-0">
            <Input
              className="h-8 rounded-lg border border-transparent bg-muted/60 pr-8 pl-2.5 text-xs shadow-none ring-0 transition-colors placeholder:transition-opacity not-focus:placeholder:text-foreground hover:bg-muted focus-visible:border-brand-action/40 focus-visible:bg-card focus-visible:ring-0 focus-visible:placeholder:text-muted-foreground dark:bg-muted/50"
              placeholder="Search threads"
              aria-label="Search threads"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
                onClick={() => setSearchQuery("")}
              >
                <X />
              </Button>
            ) : (
              <span className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-muted-foreground">
                <Search size={14} />
              </span>
            )}
          </div>

          <div className={isSearchStale ? "opacity-60 transition-opacity" : ""}>
            <div
              ref={wideSessionListRef}
              className="relative mx-2 mt-2"
              style={{
                height: threadRows.length === 0 ? "auto" : wideSessionVirtualizer.getTotalSize(),
              }}
              data-testid="wide-session-virtual-list"
            >
              {wideSessionVirtualizer.getVirtualItems().map((virtualRow) => {
                const row = threadRows[virtualRow.index];
                if (!row) return null;
                return (
                  <div
                    key={virtualRow.key}
                    ref={wideSessionVirtualizer.measureElement}
                    data-index={virtualRow.index}
                    className="absolute top-0 left-0 w-full"
                    style={{
                      transform: `translateY(${virtualRow.start - wideSessionVirtualizer.options.scrollMargin}px)`,
                    }}
                  >
                    {row.kind === "heading" ? (
                      <ThreadGroupHeading
                        row={row}
                        onOpenChange={handleThreadGroupOpenChange}
                        onNewChat={onNewChat}
                      />
                    ) : row.kind === "load-more" ? (
                      <ThreadGroupLoadMore row={row} onLoadMore={handleThreadGroupLoadMore} />
                    ) : (
                      <SessionListItem
                        session={row.session}
                        activeSessionId={visualActiveSessionId}
                        isEditing={renamingSessionId === row.session.id}
                        isNestedChild={row.isNestedChild}
                        nestedChildCount={row.nestedChildCount}
                        areNestedChildrenExpanded={row.areNestedChildrenExpanded}
                        searchQuery={searchQuery}
                        isDeletePending={pendingDeleteId === row.session.id}
                        onSelect={handleSessionClick}
                        onDelete={handleDelete}
                        onStartRename={handleStartRename}
                        onFinishRename={handleFinishRename}
                        onRename={handleRename}
                        onOpenInNewWindow={onOpenSessionInNewWindow}
                        onNestedChildrenOpenChange={handleNestedChildrenOpenChange}
                      />
                    )}
                  </div>
                );
              })}

              {threadRows.length === 0 && !isSearchStale && !sessionsLoading && !sessionsError && (
                <div
                  className="px-3 py-4 text-center text-xs text-muted-foreground"
                  data-testid="no-sessions"
                >
                  {searchQuery.trim() ? (
                    <>No threads match &quot;{searchQuery}&quot;.</>
                  ) : selectedSessionFilters.size === 0 ? (
                    <>Select at least one thread type.</>
                  ) : pinnedSessions.length > 0 ? (
                    <>No other threads.</>
                  ) : (
                    <>No threads yet.</>
                  )}
                </div>
              )}
            </div>
            {sessionPagingStatus}
          </div>
        </ScrollArea>

        <div className="p-2">
          <InteractiveElementMonitor_NavItem
            callback={(e?: React.MouseEvent) => handleNavClick("settings", e)}
            index={wideNavItems.length}
            getMisc={() => ({ navView: "settings" })}
          >
            {(cb) => (
              <SidebarAccountSettings
                isActive={visualView === "settings"}
                isCurrent={!runtimeApplicationActive && activeView === "settings"}
                onClick={cb}
              />
            )}
          </InteractiveElementMonitor_NavItem>
        </div>

        <DeleteSessionDialog
          open={!!pendingDeleteId}
          onOpenChange={(open) => {
            if (!open) setPendingDeleteId(null);
          }}
          sessionName={pendingSession?.name ?? ""}
          onConfirm={handleDeleteConfirm}
        />
      </nav>
    </TelemetryPath_Nav>
  );
}
