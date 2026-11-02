import type { RuntimeUiInstance } from "@common/runtime-ui";
import { workspaceDisplayName } from "@common/workspace-display";
import { SWARM_RUN_VIEW_RENDER_ID } from "@marshal/swarm/presentation";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleSlash,
  FileDiff,
  FolderGit2,
  History,
  Link as LinkIcon,
  ListTodo,
  LoaderCircle,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plus,
  PlayCircle,
  Reply,
  RotateCcw,
  Send,
  Trash2,
  X,
} from "@/components/icons";
import { Badge } from "@/components/marshal-ui/badge";
import { Button } from "@/components/marshal-ui/marshal-button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/marshal-ui/marshal-collapsible";
import { Textarea } from "@/components/marshal-ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChatPanel } from "@/features/chat/components/ChatPanel";
import { useOptionalRuntimeUiModel } from "@/features/runtime-ui/runtimeUiContext";
import { RuntimeUiRenderer } from "@/features/runtime-ui/RuntimeUiRenderer";
import { useRuntimeEvidence } from "@/features/runtime-ui/useRuntimeEvidence";
import { cn } from "@/lib/marshal-class-names";
import { ResizablePanelControls, ResizablePanelHandle } from "@/shared/components/ResizablePanel";
import { useElementSize, useResizablePanel } from "@/shared/hooks/useResizablePanel";
import type {
  CommandCenterAPI,
  CommandCenterSessionActivityDetails,
  CommandCenterSessionActivityFileChange,
  CommandCenterSessionActivitySource,
  CommandCenterSnapshot,
  CommandCenterTodoSummary,
  RunHistoryEntry,
  SessionMetadata,
  WorkflowSummary,
} from "@/types/electron";

import { SessionActivityProgressHeader } from "./SessionActivityProgressHeader";

interface WorkspaceActivityGroup {
  name: string;
  files: CommandCenterSessionActivityFileChange[];
  subagents: SessionMetadata[];
  sources: CommandCenterSessionActivitySource[];
  additions: number;
  deletions: number;
}

interface WorkflowRunEntry {
  run: RunHistoryEntry;
  /** Human-friendly workflow name; falls back to `workflowId`. */
  workflowLabel: string;
}

type DrawerSelection =
  | { kind: "workspace"; workspace: WorkspaceActivityGroup; activeFileId?: string }
  | { kind: "source"; source: CommandCenterSessionActivitySource }
  | { kind: "subagent"; session: SessionMetadata }
  | { kind: "workflow-run"; entry: WorkflowRunEntry };

type ReviewCommentStatus = "pending" | "resolved" | "wontfix";
type ReviewCommentSide = "added" | "removed" | "context";

interface ReviewCommentAnchor {
  side: ReviewCommentSide;
  oldLine?: number;
  newLine?: number;
  hunkHeader?: string;
  lineText: string;
}

interface ReviewReply {
  id: string;
  text: string;
  createdAt: number;
  author?: "user" | "agent";
}

interface ReviewComment {
  id: string;
  threadId: string;
  fileId: string;
  filePath: string;
  fileName: string;
  lineId: string;
  anchor: ReviewCommentAnchor;
  status: ReviewCommentStatus;
  text: string;
  replies: ReviewReply[];
  createdAt: number;
  updatedAt: number;
}

type ReviewHunkContextReason = "no-context-available" | "no-diff-line";

interface ReviewHunkContextLine {
  kind: ParsedDiffLine["kind"];
  side: ReviewCommentSide | "hunk" | "metadata";
  oldLine?: number;
  newLine?: number;
  prefix: string;
  content: string;
  hunkHeader?: string;
  contentTruncated?: boolean;
  hunkHeaderTruncated?: boolean;
}

interface ReviewHunkContextResult {
  lines: ReviewHunkContextLine[];
  truncated: boolean;
  reason?: ReviewHunkContextReason;
}

interface ParsedDiffLine {
  id: string;
  kind: "metadata" | "hunk" | "added" | "removed" | "context";
  oldLine?: number;
  newLine?: number;
  hunkHeader?: string;
  text: string;
  commentable: boolean;
}

type SendStatus =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; recipientName: string; appliedActions?: number }
  | { kind: "error"; message: string };

type ReviewAgentActionKind = "reply" | "add_location_comment" | "mark_resolved" | "mark_wontfix";

interface ReviewAgentAction {
  threadId: string;
  commentId: string;
  action: ReviewAgentActionKind;
  message?: string;
  status?: ReviewCommentStatus;
}

const MIN_PROGRESS_PANEL_WIDTH = 280;
const MAX_PROGRESS_PANEL_WIDTH = 720;
const DEFAULT_PROGRESS_PANEL_WIDTH = 360;
const MIN_DRAWER_WIDTH = 320;
const MAX_DRAWER_WIDTH = 1120;
const DEFAULT_DRAWER_WIDTH = 860;
const PANEL_HORIZONTAL_INSET = 32;
const PANEL_COLLAPSE_THRESHOLD = 96;
// Snapshot and list-changed events fire per agent event; refetching on each
// one kept the main process busy listing every session several times a second.
const ACTIVITY_REFRESH_THROTTLE_MS = 1_000;
const PROGRESS_PANEL_STORAGE_KEY = "marshal.panel.session-activity.progress-width";
const DETAIL_PANEL_STORAGE_KEY = "marshal.panel.session-activity.detail-width";
const REVIEW_HUNK_CONTEXT_MAX_LINES = 9;
const REVIEW_HUNK_CONTEXT_MAX_SERIALIZED_CHARS = 6_000;
const REVIEW_HUNK_HEADER_TRUNCATION_SUFFIX = "\n...[hunk header truncated]";
const REVIEW_CONTEXT_CONTENT_TRUNCATION_SUFFIX = "\n...[line content truncated]";

/** "dock" fills a dock tab: no floating chrome, no own resizing, docs live in sibling tabs. */
type SessionActivityPanelLayout = "overlay" | "rail" | "dock";
type AgentPresentationStatus = "running" | "idle" | "completed";

function getCommandCenterAPI(): CommandCenterAPI | undefined {
  return window.commandCenterAPI;
}

export function SessionActivityPanel({
  sessionId,
  layout = "overlay",
  onLayoutWidthChange,
  availableWidth,
  onContentChange,
}: {
  sessionId: string | null;
  layout?: SessionActivityPanelLayout;
  onLayoutWidthChange?: (width: number) => void;
  availableWidth?: number;
  /** Reports whether there is anything to show (the dock opens its Progress tab on it). */
  onContentChange?: (hasContent: boolean) => void;
}) {
  const runtimeUi = useOptionalRuntimeUiModel();
  const dockLayout = layout === "dock";
  // In the dock, side-panel views are tabs of their own rather than entries here.
  const runtimePanels =
    !dockLayout && runtimeUi?.scope?.sessionId === sessionId ? runtimeUi.bySurface.panel : [];
  const newestPanel = runtimePanels[0];
  const panelFocus = newestPanel ? `${newestPanel.instanceId}:${newestPanel.focusedAt}` : null;
  const [observedPanelFocus, setObservedPanelFocus] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const rootSize = useElementSize(rootRef);
  const api = getCommandCenterAPI();
  const [snapshot, setSnapshot] = useState<CommandCenterSnapshot | null>(null);
  const [activityResult, setActivityResult] = useState<{
    sessionId: string;
    activity: CommandCenterSessionActivityDetails | null;
    sessions: SessionMetadata[];
    error?: string;
  } | null>(null);
  const activityRequest = useRef({ version: 0 });
  const scopedActivity = activityResult?.sessionId === sessionId ? activityResult : null;
  const activity = scopedActivity?.activity ?? null;
  const sessions = useMemo(() => scopedActivity?.sessions ?? [], [scopedActivity]);
  const activityError = scopedActivity?.error;
  const [workflowRuns, setWorkflowRuns] = useState<RunHistoryEntry[]>([]);
  const [workflowSummaries, setWorkflowSummaries] = useState<WorkflowSummary[]>([]);
  const [evidenceSelection, setEvidenceSelection] = useState<{
    sessionId: string;
    instance: RuntimeUiInstance;
  } | null>(null);
  const selectedEvidence =
    evidenceSelection?.sessionId === sessionId ? evidenceSelection.instance : undefined;
  const [drawer, setDrawer] = useState<DrawerSelection | null>(null);
  const [reviewComments, setReviewComments] = useState<ReviewComment[]>([]);
  const fallbackAvailableWidth =
    typeof window === "undefined" ? DEFAULT_DRAWER_WIDTH : window.innerWidth;
  const panelAvailableWidth = Math.max(
    0,
    availableWidth ?? (rootSize.width || fallbackAvailableWidth),
  );
  const availableContentWidth = Math.max(0, panelAvailableWidth - PANEL_HORIZONTAL_INSET);
  const progressPanel = useResizablePanel({
    storageKey: PROGRESS_PANEL_STORAGE_KEY,
    axis: "horizontal",
    defaultSize: DEFAULT_PROGRESS_PANEL_WIDTH,
    minSize: MIN_PROGRESS_PANEL_WIDTH,
    maxSize: Math.min(MAX_PROGRESS_PANEL_WIDTH, availableContentWidth),
    expandedSize: availableContentWidth,
    growDirection: "negative",
    collapseThreshold: PANEL_COLLAPSE_THRESHOLD,
  });
  const detailPanel = useResizablePanel({
    storageKey: DETAIL_PANEL_STORAGE_KEY,
    axis: "horizontal",
    defaultSize: DEFAULT_DRAWER_WIDTH,
    minSize: MIN_DRAWER_WIDTH,
    maxSize: Math.min(MAX_DRAWER_WIDTH, availableContentWidth),
    expandedSize: availableContentWidth,
    growDirection: "negative",
    collapseThreshold: PANEL_COLLAPSE_THRESHOLD,
  });

  if (observedPanelFocus !== panelFocus) {
    setObservedPanelFocus(panelFocus);
    if (newestPanel && sessionId) {
      setEvidenceSelection({ sessionId, instance: newestPanel });
      setDrawer(null);
      progressPanel.restore();
    }
  }

  const refreshActivity = useCallback(() => {
    const request = ++activityRequest.current.version;
    if (!sessionId || !api?.getSessionActivity) {
      setActivityResult(null);
      return;
    }
    void api
      .getSessionActivity(sessionId)
      .then((result) => {
        if (request !== activityRequest.current.version) return;
        if (result.success && result.activity) {
          setActivityResult({
            sessionId,
            activity: result.activity,
            sessions: result.sessions ?? [],
          });
        } else {
          setActivityResult({
            sessionId,
            activity: null,
            sessions: [],
            error: result.error ?? "Could not load session activity",
          });
        }
      })
      .catch((error: unknown) => {
        if (request !== activityRequest.current.version) return;
        setActivityResult({
          sessionId,
          activity: null,
          sessions: [],
          error: error instanceof Error ? error.message : "Could not load session activity",
        });
      });
  }, [api, sessionId]);

  const activityRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleActivityRefresh = useCallback(() => {
    if (activityRefreshTimer.current) return;
    activityRefreshTimer.current = setTimeout(() => {
      activityRefreshTimer.current = null;
      refreshActivity();
    }, ACTIVITY_REFRESH_THROTTLE_MS);
  }, [refreshActivity]);
  useEffect(
    () => () => {
      if (activityRefreshTimer.current) clearTimeout(activityRefreshTimer.current);
      activityRefreshTimer.current = null;
    },
    [refreshActivity],
  );

  // Workflow runs (per-session "Workflows" section). We refetch the
  // full list whenever the Command Center snapshot fires (cheap call on
  // the main side, reads an in-memory index) so newly-started runs
  // show up without bespoke per-run subscriptions.
  const refreshWorkflowRuns = useCallback(() => {
    const workflowsApi = window.workflowsAPI;
    if (!workflowsApi?.listRuns) return;
    void workflowsApi.listRuns().then((result) => {
      if (result.success && result.runs) setWorkflowRuns(result.runs);
    });
    if (workflowsApi.list) {
      void workflowsApi.list().then((result) => {
        if (result.success && result.workflows) setWorkflowSummaries(result.workflows);
      });
    }
  }, []);

  useEffect(() => {
    if (!api) return undefined;
    let active = true;
    void api.getSnapshot().then((result) => {
      if (active && result.success && result.snapshot) setSnapshot(result.snapshot);
    });
    const unsubscribe = api.onSnapshot((next) => {
      setSnapshot(next);
      scheduleActivityRefresh();
      refreshWorkflowRuns();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, scheduleActivityRefresh, refreshWorkflowRuns]);

  useEffect(() => {
    let active = true;
    const requestState = activityRequest.current;
    queueMicrotask(() => {
      if (active) refreshActivity();
    });
    return () => {
      active = false;
      requestState.version++;
    };
  }, [refreshActivity]);

  useEffect(
    () => window.sessionsAPI?.onListChanged?.(scheduleActivityRefresh) ?? (() => {}),
    [scheduleActivityRefresh],
  );

  useEffect(() => {
    refreshWorkflowRuns();
  }, [refreshWorkflowRuns]);

  const rawScope = useMemo(
    () => new Set(activity?.sessionIds ?? (sessionId ? [sessionId] : [])),
    [activity, sessionId],
  );
  const currentSafeSessionId = activity?.safeSessionIds[0];
  const todos = useMemo(
    () =>
      (snapshot?.todos ?? []).filter(
        (todo) =>
          !todo.sessionId ||
          todo.sessionId === currentSafeSessionId ||
          todo.sessionId === sessionId,
      ),
    [currentSafeSessionId, sessionId, snapshot],
  );
  const todoGoals = useMemo(() => groupTodosByGoal(todos), [todos]);
  // Index 0 == latest goal. Reset to latest whenever the set of goal
  // ids changes (e.g. a new goal arrives — show it by default).
  const [goalIndex, setGoalIndex] = useState(0);
  const goalKey = useMemo(() => todoGoals.map((g) => g.goalId).join("|"), [todoGoals]);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) setGoalIndex(0);
    });
    return () => {
      active = false;
    };
  }, [goalKey]);
  const safeGoalIndex = Math.min(goalIndex, Math.max(0, todoGoals.length - 1));
  const activeGoal = todoGoals[safeGoalIndex];
  const activeTodos = activeGoal?.todos ?? [];
  const subagents = useMemo(
    () =>
      sessions.filter(
        (session) => session.parentSessionId && rawScope.has(session.parentSessionId),
      ),
    [rawScope, sessions],
  );
  const fileChanges = useMemo(() => activity?.fileChanges ?? [], [activity]);
  const sources = useMemo(() => activity?.sources ?? [], [activity]);
  const todoProgress = progressForTodos(activeTodos);
  const sessionById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const reviewTargetSessionId = activity?.rootSessionId ?? null;
  const reviewTargetSessionName = reviewTargetSessionId
    ? (sessionById.get(reviewTargetSessionId)?.name ?? "owning session")
    : "owning session";
  const rootWorkspaceName = sessionId ? sessionById.get(sessionId)?.workspaceName : undefined;
  const runtimeEvidence = useRuntimeEvidence(
    sessionId,
    sessions.length ? (rootWorkspaceName ?? "marshal") : undefined,
  );
  useEffect(() => {
    return window.runtimeUiAPI?.onEvent((event) => {
      if (event.scope.sessionId !== sessionId) return;
      if (event.type === "instance-closed") {
        setEvidenceSelection((selected) =>
          selected?.instance.instanceId === event.instanceId ? null : selected,
        );
        return;
      }
      if (event.type !== "instance-updated" && event.type !== "instance-opened") return;
      if (event.scope.sessionId !== sessionId || !sessionId) return;
      if (
        event.type === "instance-opened" &&
        event.instance.content.kind === "application" &&
        event.instance.content.renderId === SWARM_RUN_VIEW_RENDER_ID
      ) {
        setEvidenceSelection({ sessionId, instance: event.instance });
        return;
      }
      setEvidenceSelection((selected) =>
        selected?.sessionId === sessionId &&
        selected.instance.instanceId === event.instance.instanceId
          ? { ...selected, instance: event.instance }
          : selected,
      );
    });
  }, [sessionId]);
  const evidenceApplications = [
    ...new Set(
      runtimeEvidence.entries.map((entry) => `${entry.extensionId}:${entry.applicationId}`),
    ),
  ];
  const workspaceGroups = useMemo(
    () => groupByWorkspace(fileChanges, subagents, sources, sessionById, rootWorkspaceName),
    [fileChanges, rootWorkspaceName, sessionById, sources, subagents],
  );
  const groupsWithChanges = workspaceGroups.filter((group) => group.files.length > 0);
  const runningAgentGroups = agentGroupsForStatus(workspaceGroups, "running");
  const idleAgentGroups = agentGroupsForStatus(workspaceGroups, "idle");
  const completedAgentGroups = agentGroupsForStatus(workspaceGroups, "completed");
  const runningAgentCount = runningAgentGroups.reduce(
    (count, group) => count + group.subagents.length,
    0,
  );
  const groupsWithSources = workspaceGroups.filter((group) => group.sources.length > 0);

  // Workflow runs initiated by any session in this session's tree.
  // Runs without `initiatorSessionId` (schedule/automation-triggered)
  // never show in the per-session panel — they appear in the Workflows
  // tab only.
  const workflowSummaryById = useMemo(
    () => new Map(workflowSummaries.map((w) => [w.id, w])),
    [workflowSummaries],
  );
  const scopedWorkflowRuns = useMemo<WorkflowRunEntry[]>(() => {
    return workflowRuns
      .filter((run) => !!run.initiatorSessionId && rawScope.has(run.initiatorSessionId))
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((run) => ({
        run,
        workflowLabel: workflowSummaryById.get(run.workflowId)?.displayName ?? run.workflowId,
      }));
  }, [rawScope, workflowRuns, workflowSummaryById]);

  const openWorkspaceDrawer = useCallback((workspace: WorkspaceActivityGroup) => {
    setDrawer({ kind: "workspace", workspace, activeFileId: workspace.files[0]?.id });
  }, []);

  const openSubagentDrawer = useCallback((session: SessionMetadata) => {
    setDrawer({ kind: "subagent", session });
  }, []);

  const openSourceDrawer = useCallback((source: CommandCenterSessionActivitySource) => {
    // Pull requests are always opened in an external browser tab — they have
    // first-class web UIs and never use the right-side drawer.
    if (source.kind === "pr" && source.url) {
      window.open(source.url, "_blank", "noopener,noreferrer");
      return;
    }
    setDrawer({ kind: "source", source });
  }, []);

  const openWorkflowRunDrawer = useCallback((entry: WorkflowRunEntry) => {
    setDrawer({ kind: "workflow-run", entry });
  }, []);

  // Lazy panel: hide the whole rail until at least one section has content.
  // Each section is also rendered lazily — empty ones are omitted entirely
  // (no "No X tracked yet" placeholder text).
  const hasTodos = activeTodos.length > 0;
  const hasChanges = groupsWithChanges.length > 0;
  const hasRunningAgents = runningAgentGroups.length > 0;
  const hasIdleAgents = idleAgentGroups.length > 0;
  const hasCompletedAgents = completedAgentGroups.length > 0;
  const hasAgents = hasRunningAgents || hasIdleAgents || hasCompletedAgents;
  const hasSources = groupsWithSources.length > 0;
  const hasWorkflows = scopedWorkflowRuns.length > 0;
  const hasAnyContent =
    hasTodos ||
    hasChanges ||
    hasAgents ||
    hasSources ||
    hasWorkflows ||
    !!activityError ||
    runtimePanels.length > 0 ||
    runtimeEvidence.entries.length > 0 ||
    !!runtimeEvidence.error ||
    !!selectedEvidence;
  const activePanel = drawer ? detailPanel : progressPanel;

  useEffect(() => {
    onContentChange?.(!!sessionId && hasAnyContent);
  }, [hasAnyContent, onContentChange, sessionId]);

  useEffect(() => {
    if (!onLayoutWidthChange) return;
    if (!sessionId || (!drawer && !hasAnyContent)) {
      onLayoutWidthChange(0);
      return;
    }
    onLayoutWidthChange(activePanel.isCollapsed ? 40 : activePanel.size + PANEL_HORIZONTAL_INSET);
  }, [
    activePanel.isCollapsed,
    activePanel.size,
    drawer,
    hasAnyContent,
    onLayoutWidthChange,
    sessionId,
  ]);

  if (!sessionId) return null;
  const railLayout = layout === "rail";

  return (
    <div
      ref={rootRef}
      className={cn(
        "z-30 h-full min-h-0",
        dockLayout
          ? "pointer-events-auto relative size-full"
          : railLayout
            ? "pointer-events-none relative size-full"
            : "pointer-events-none absolute inset-0",
      )}
      data-testid="session-activity-panel"
      data-panel-mode={activePanel.mode}
    >
      {!dockLayout && (drawer || hasAnyContent) && activePanel.isCollapsed && (
        <div className="pointer-events-auto absolute top-4 right-1 z-40 rounded-lg border border-border/70 bg-card/95 p-1 shadow-lg backdrop-blur-md">
          <ResizablePanelControls
            controller={activePanel}
            showLabel="Show session activity"
            expandLabel="Expand session activity"
            restoreLabel="Restore session activity size"
            collapseLabel="Fold session activity"
            showIcon={<PanelRightOpen className="size-3.5" />}
            collapseIcon={<PanelRightClose className="size-3.5" />}
            testIds={{ show: "session-activity-panel-show" }}
          />
        </div>
      )}

      {!drawer && (dockLayout || (hasAnyContent && !progressPanel.isCollapsed)) && (
        <aside
          className={cn(
            "pointer-events-auto flex min-h-0 flex-col overflow-hidden",
            dockLayout
              ? "size-full bg-card"
              : "absolute inset-y-4 right-4 rounded-2xl border border-border/70 bg-card/95 shadow-2xl backdrop-blur-md",
          )}
          style={dockLayout ? undefined : { width: progressPanel.size }}
          data-testid="session-activity-progress"
        >
          {!dockLayout && (
            <ResizablePanelHandle
              controller={progressPanel}
              label="Resize session activity panel"
              testId="session-activity-panel-resize"
            />
          )}
          <div className="border-b border-border/70 px-4 py-3">
            <SessionActivityProgressHeader
              evidence={selectedEvidence}
              showProgressTitle={!dockLayout}
              sessionCount={activity?.sessionIds.length ?? 1}
              todoProgress={hasTodos ? todoProgress : undefined}
              onBack={() => setEvidenceSelection(null)}
              onClose={
                selectedEvidence?.surface === "panel" && runtimeUi
                  ? () => {
                      void runtimeUi.close(selectedEvidence);
                      setEvidenceSelection(null);
                    }
                  : undefined
              }
              panelControls={
                dockLayout ? undefined : (
                  <ResizablePanelControls
                    controller={progressPanel}
                    showLabel="Show session activity"
                    expandLabel="Expand session activity across chat"
                    restoreLabel="Restore session activity split size"
                    collapseLabel="Fold session activity"
                    showIcon={<PanelRightOpen className="size-3.5" />}
                    collapseIcon={<PanelRightClose className="size-3.5" />}
                    testIds={{
                      expand: "session-activity-panel-expand",
                      restore: "session-activity-panel-restore",
                      collapse: "session-activity-panel-collapse",
                    }}
                  />
                )
              }
            />
            {!selectedEvidence && todoGoals.length > 1 && activeGoal && (
              <GoalHistoryControls
                goals={todoGoals}
                activeIndex={safeGoalIndex}
                onChange={setGoalIndex}
              />
            )}
          </div>
          <ScrollArea
            className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!"
            data-testid="session-activity-scroll"
          >
            {selectedEvidence ? (
              <div className="min-w-0 space-y-3 p-4" data-testid="session-activity-evidence-detail">
                {selectedEvidence.content.kind === "file" ? (
                  // FilePreview fills its parent; inside the scroll area it needs an explicit height or Monaco collapses.
                  <div
                    className="h-[calc(100vh-14rem)] min-h-96"
                    data-testid="session-activity-document"
                  >
                    <RuntimeUiRenderer instance={selectedEvidence} />
                  </div>
                ) : (
                  <RuntimeUiRenderer instance={selectedEvidence} />
                )}
              </div>
            ) : (
              <div className="space-y-4 p-4 text-sm">
                {dockLayout && !hasAnyContent && (
                  <p className="text-xs text-muted-foreground" data-testid="session-activity-empty">
                    The plan, file changes, agents, and sources for this session appear here.
                  </p>
                )}
                {activityError && (
                  <div role="alert" className="text-xs text-destructive">
                    <p>{activityError}</p>
                    <Button variant="ghost" size="sm" onClick={refreshActivity}>
                      Retry session activity
                    </Button>
                  </div>
                )}
                {runtimeEvidence.error && (
                  <p role="alert" className="text-xs text-destructive">
                    {runtimeEvidence.error}
                  </p>
                )}
                {runtimePanels.length > 0 && (
                  <ProgressSection
                    title="Open documents and applications"
                    icon={<FolderGit2 className="size-4" />}
                    testId="session-activity-runtime-panels"
                  >
                    {runtimePanels.map((instance) => (
                      <Button
                        key={instance.instanceId}
                        variant="ghost"
                        className="w-full justify-start truncate"
                        onClick={() => setEvidenceSelection({ sessionId, instance })}
                      >
                        {instance.content.kind === "file"
                          ? instance.content.path.split(/[\\/]/).pop()
                          : instance.owner.applicationId}
                      </Button>
                    ))}
                  </ProgressSection>
                )}
                {evidenceApplications.map((applicationKey) => {
                  const entries = runtimeEvidence.entries.filter(
                    (entry) => `${entry.extensionId}:${entry.applicationId}` === applicationKey,
                  );
                  return (
                    <ProgressSection
                      key={applicationKey}
                      title={entries[0]?.applicationTitle ?? "Evidence"}
                      icon={<FolderGit2 className="size-4" />}
                      testId="session-activity-section-runtime-evidence"
                    >
                      {entries.map((entry) => (
                        <button
                          type="button"
                          key={entry.id}
                          className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-border/70 bg-background/70 px-3 py-2 text-left text-xs hover:bg-muted"
                          onClick={() => {
                            if (entry.extensionId !== "@marshal/swarm") {
                              void runtimeEvidence.open(entry);
                              return;
                            }
                            void runtimeEvidence.open(entry, "embedded").then((instance) => {
                              if (instance) setEvidenceSelection({ sessionId, instance });
                            });
                          }}
                          data-testid="session-activity-evidence-run"
                        >
                          <span className="shrink-0 font-medium">{entry.applicationTitle}</span>
                          <span className="min-w-0 flex-1 truncate">
                            {evidenceSummary(entry.title)}
                          </span>
                          <span className="shrink-0 text-muted-foreground">{entry.status}</span>
                          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                        </button>
                      ))}
                    </ProgressSection>
                  );
                })}

                {hasTodos && (
                  <ProgressSection
                    title={
                      activeGoal?.goalLabel ? `Todo list — ${activeGoal.goalLabel}` : "Todo list"
                    }
                    icon={<ListTodo className="size-4" />}
                    testId="session-activity-section-todos"
                  >
                    {activeTodos.map((todo) => (
                      <TodoRow key={todo.id} todo={todo} />
                    ))}
                  </ProgressSection>
                )}

                {hasChanges && (
                  <ProgressSection
                    title="Changes"
                    icon={<FileDiff className="size-4" />}
                    testId="session-activity-section-changes"
                  >
                    {groupsWithChanges.map((group) => (
                      <WorkspaceSummaryRow
                        key={group.name}
                        group={group}
                        onClick={() => openWorkspaceDrawer(group)}
                      />
                    ))}
                  </ProgressSection>
                )}

                {hasRunningAgents && (
                  <ProgressSection
                    title="Agents"
                    icon={<MessageSquare className="size-4" />}
                    testId="session-activity-section-agents"
                    collapsedLabel={`${runningAgentCount} running`}
                  >
                    {runningAgentGroups.map((group) => (
                      <WorkspaceAgentGroup
                        key={group.name}
                        group={group}
                        status="running"
                        onAgentClick={openSubagentDrawer}
                      />
                    ))}
                  </ProgressSection>
                )}

                {hasIdleAgents && (
                  <ProgressSection
                    title="Idle"
                    icon={<Circle className="size-4" />}
                    testId="session-activity-section-idle-agents"
                  >
                    {idleAgentGroups.map((group) => (
                      <WorkspaceAgentGroup
                        key={group.name}
                        group={group}
                        status="idle"
                        onAgentClick={openSubagentDrawer}
                      />
                    ))}
                  </ProgressSection>
                )}

                {hasCompletedAgents && (
                  <ProgressSection
                    title="Completed"
                    icon={<CircleCheck className="size-4" />}
                    testId="session-activity-section-completed-agents"
                    defaultOpen={false}
                  >
                    {completedAgentGroups.map((group) => (
                      <WorkspaceAgentGroup
                        key={group.name}
                        group={group}
                        status="completed"
                        onAgentClick={openSubagentDrawer}
                      />
                    ))}
                  </ProgressSection>
                )}

                {hasSources && (
                  <ProgressSection
                    title="Sources"
                    icon={<LinkIcon className="size-4" />}
                    testId="session-activity-section-sources"
                  >
                    {groupsWithSources.map((group) => (
                      <WorkspaceSourceGroup
                        key={group.name}
                        group={group}
                        onSourceClick={openSourceDrawer}
                      />
                    ))}
                  </ProgressSection>
                )}

                {hasWorkflows && (
                  <ProgressSection
                    title="Workflows"
                    icon={<PlayCircle className="size-4" />}
                    testId="session-activity-section-workflows"
                  >
                    {scopedWorkflowRuns.map((entry) => (
                      <WorkflowRunRow
                        key={entry.run.runId}
                        entry={entry}
                        onClick={() => openWorkflowRunDrawer(entry)}
                      />
                    ))}
                  </ProgressSection>
                )}
              </div>
            )}
          </ScrollArea>
        </aside>
      )}

      {drawer && (dockLayout || !detailPanel.isCollapsed) && (
        <aside
          className={cn(
            "pointer-events-auto z-40 flex min-h-0 overflow-hidden bg-card",
            dockLayout
              ? "absolute inset-0"
              : "absolute inset-y-4 right-4 rounded-2xl border border-border/70 shadow-2xl",
          )}
          style={dockLayout ? undefined : { width: detailPanel.size }}
          data-testid="session-activity-detail"
        >
          {!dockLayout && (
            <ResizablePanelHandle
              controller={detailPanel}
              label="Resize session activity details"
              testId="session-activity-detail-resize"
            />
          )}
          <ActivityDetail
            selection={drawer}
            layoutWidth={dockLayout ? rootSize.width || detailPanel.size : detailPanel.size}
            comments={reviewComments}
            setComments={setReviewComments}
            reviewTargetSessionId={reviewTargetSessionId}
            reviewTargetSessionName={reviewTargetSessionName}
            onClose={() => setDrawer(null)}
            panelActions={
              dockLayout ? undefined : (
                <ResizablePanelControls
                  controller={detailPanel}
                  showLabel="Show session activity details"
                  expandLabel="Expand session activity details across chat"
                  restoreLabel="Restore session activity details split size"
                  collapseLabel="Fold session activity details"
                  showIcon={<PanelRightOpen className="size-3.5" />}
                  collapseIcon={<PanelRightClose className="size-3.5" />}
                  testIds={{
                    expand: "session-activity-panel-expand",
                    restore: "session-activity-panel-restore",
                    collapse: "session-activity-panel-collapse",
                  }}
                />
              )
            }
            onWorkspaceFileSelect={(fileId) => {
              setDrawer((current) =>
                current?.kind === "workspace" ? { ...current, activeFileId: fileId } : current,
              );
            }}
          />
        </aside>
      )}
    </div>
  );
}

function ProgressSection({
  icon,
  title,
  children,
  testId,
  defaultOpen = true,
  collapsedLabel,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  testId?: string;
  defaultOpen?: boolean;
  collapsedLabel?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section className="space-y-2" data-testid={testId}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-full justify-start gap-2 px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground"
          >
            {icon}
            <span className="min-w-0 flex-1 truncate text-left">{title}</span>
            {!open && collapsedLabel && (
              <span
                className="shrink-0 text-[10px] font-normal text-muted-foreground normal-case"
                aria-live="polite"
                data-testid={`${testId}-collapsed-label`}
              >
                {collapsedLabel}
              </span>
            )}
            <ChevronDown
              className={cn(
                "size-4 shrink-0 transition-transform",
                open ? "rotate-0" : "-rotate-90",
              )}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-1.5">{children}</div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

function TodoRow({ todo }: { todo: CommandCenterTodoSummary }) {
  const done = todo.status === "done";
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/70 px-3 py-2">
      {done ? (
        <CircleCheck className="size-4 shrink-0 text-status-success-fg" />
      ) : (
        <Circle className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{todo.title}</span>
      <Badge variant="outline" className="shrink-0 text-[10px] capitalize">
        {todo.status}
      </Badge>
    </div>
  );
}

function GoalHistoryControls({
  goals,
  activeIndex,
  onChange,
}: {
  goals: TodoGoalGroup[];
  activeIndex: number;
  onChange: (index: number) => void;
}) {
  // Goals are ordered most-recent first (index 0 = latest). "Previous"
  // moves to an older goal (index + 1); "Next" moves toward latest
  // (index - 1). Show position as "Goal N of M" reading natural order
  // (oldest = 1) so users have a stable reference.
  const total = goals.length;
  const oldestFirstPosition = total - activeIndex;
  const isLatest = activeIndex === 0;
  const hasOlder = activeIndex < total - 1;
  return (
    <div
      className="mt-2 flex items-center justify-between gap-2 rounded-md border border-border/60 bg-background/50 px-2 py-1.5 text-xs"
      data-testid="session-activity-goal-history"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-2"
        disabled={!hasOlder}
        onClick={() => onChange(activeIndex + 1)}
        aria-label="Previous goal"
        data-testid="session-activity-goal-prev"
      >
        <ChevronLeft className="size-3.5" />
        Prev
      </Button>
      <div className="flex min-w-0 flex-1 items-center justify-center gap-1 text-muted-foreground">
        <History className="size-3.5 shrink-0" />
        <span className="truncate">
          Goal {oldestFirstPosition} of {total}
          {isLatest ? " · latest" : ""}
        </span>
      </div>
      {isLatest ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2"
          disabled
          aria-label="Next goal"
          data-testid="session-activity-goal-next"
        >
          Next
          <ChevronRight className="size-3.5" />
        </Button>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2"
          onClick={() => onChange(0)}
          aria-label="Return to latest goal"
          data-testid="session-activity-goal-latest"
        >
          Latest
          <ChevronRight className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

function WorkspaceSummaryRow({
  group,
  onClick,
}: {
  group: WorkspaceActivityGroup;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-lg border border-border/70 bg-background/70 px-3 py-2 text-left hover:bg-muted"
      onClick={onClick}
      data-testid="session-activity-workspace-change"
    >
      <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{group.name}</div>
        <div className="text-xs text-muted-foreground">
          {group.files.length} file{group.files.length === 1 ? "" : "s"}
        </div>
      </div>
      <div className="shrink-0 text-right text-xs tabular-nums">
        <div className="text-status-success-fg">+{group.additions}</div>
        <div className="text-destructive">-{group.deletions}</div>
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

function WorkspaceAgentGroup({
  group,
  status,
  onAgentClick,
}: {
  group: WorkspaceActivityGroup;
  status: AgentPresentationStatus;
  onAgentClick: (session: SessionMetadata) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="px-1 text-xs font-medium text-muted-foreground">{group.name}</div>
      {group.subagents.map((session) => (
        <button
          key={session.id}
          type="button"
          className="flex w-full items-center gap-2 rounded-lg border border-border/70 bg-background/70 px-3 py-2 text-left hover:bg-muted"
          onClick={() => onAgentClick(session)}
          data-testid="session-activity-agent"
          data-agent-status={status}
        >
          {status === "running" ? (
            <LoaderCircle
              className="size-4 shrink-0 animate-spin text-primary"
              aria-label="Agent is running"
            />
          ) : status === "completed" ? (
            <CircleCheck
              className="size-4 shrink-0 text-status-success-fg"
              aria-label="Agent completed"
            />
          ) : (
            <Circle className="size-4 shrink-0 text-muted-foreground" aria-label="Agent is idle" />
          )}
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{session.name}</span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}

function WorkspaceSourceGroup({
  group,
  onSourceClick,
}: {
  group: WorkspaceActivityGroup;
  onSourceClick: (source: CommandCenterSessionActivitySource) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="px-1 text-xs font-medium text-muted-foreground">{group.name}</div>
      {group.sources.map((source) => (
        <button
          key={source.id}
          type="button"
          className="flex w-full items-center gap-2 rounded-lg border border-border/70 bg-background/70 px-3 py-2 text-left hover:bg-muted"
          onClick={() => onSourceClick(source)}
        >
          <LinkIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{source.label}</span>
          <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
            {source.kind}
          </Badge>
        </button>
      ))}
    </div>
  );
}

function WorkflowRunRow({ entry, onClick }: { entry: WorkflowRunEntry; onClick: () => void }) {
  const { run, workflowLabel } = entry;
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-lg border border-border/70 bg-background/70 px-3 py-2 text-left hover:bg-muted"
      onClick={onClick}
      data-testid="session-activity-workflow-run"
    >
      <PlayCircle className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{workflowLabel}</div>
        <div className="truncate text-xs text-muted-foreground">{run.runId}</div>
      </div>
      <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
        {run.status}
      </Badge>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

function ActivityDetail({
  selection,
  layoutWidth,
  comments,
  setComments,
  reviewTargetSessionId,
  reviewTargetSessionName,
  onClose,
  panelActions,
  onWorkspaceFileSelect,
}: {
  selection: DrawerSelection;
  layoutWidth: number;
  comments: ReviewComment[];
  setComments: Dispatch<SetStateAction<ReviewComment[]>>;
  reviewTargetSessionId: string | null;
  reviewTargetSessionName: string;
  onClose: () => void;
  panelActions: ReactNode;
  onWorkspaceFileSelect: (fileId: string) => void;
}) {
  const activeWorkspaceFile =
    selection.kind === "workspace"
      ? (selection.workspace.files.find((file) => file.id === selection.activeFileId) ??
        selection.workspace.files[0])
      : undefined;
  const [draftLineId, setDraftLineId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [replyingCommentId, setReplyingCommentId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [sendStatus, setSendStatus] = useState<SendStatus>({ kind: "idle" });

  const activeWorkspaceDiff = activeWorkspaceFile
    ? (activeWorkspaceFile.diff ??
      buildUnavailableDiff(
        normalizePanelFilePath(activeWorkspaceFile.path),
        activeWorkspaceFile.diffUnavailableReason,
      ))
    : undefined;
  const activeDiffNotices = activeWorkspaceFile ? diffNoticesForFile(activeWorkspaceFile) : [];
  const workspaceFiles = useMemo(
    () => (selection.kind === "workspace" ? selection.workspace.files : []),
    [selection],
  );
  const workspaceFileIds = useMemo(
    () => new Set(workspaceFiles.map((file) => file.id)),
    [workspaceFiles],
  );
  const workspaceComments = useMemo(
    () => comments.filter((comment) => workspaceFileIds.has(comment.fileId)),
    [comments, workspaceFileIds],
  );
  const activeFileComments = useMemo(
    () => comments.filter((comment) => comment.fileId === activeWorkspaceFile?.id),
    [activeWorkspaceFile?.id, comments],
  );
  const useStackedWorkspaceLayout = selection.kind === "workspace" && layoutWidth < 520;

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setDraftLineId(null);
      setDraftText("");
      setEditingCommentId(null);
      setEditingText("");
      setReplyingCommentId(null);
      setReplyText("");
      setSendStatus({ kind: "idle" });
    });
    return () => {
      active = false;
    };
  }, [activeWorkspaceFile?.id]);

  const addComment = useCallback(
    (line: ParsedDiffLine) => {
      if (!activeWorkspaceFile) return;
      const text = draftText.trim();
      if (!text) return;
      const filePath = normalizePanelFilePath(activeWorkspaceFile.path);
      const now = Date.now();
      const anchor = anchorForDiffLine(line);
      const threadId = reviewThreadId(activeWorkspaceFile.id, anchor);
      setComments((current) => [
        ...current,
        {
          id: `${threadId}:comment:${now}`,
          threadId,
          fileId: activeWorkspaceFile.id,
          filePath,
          fileName: fileNameForPath(filePath),
          lineId: line.id,
          anchor,
          status: "pending",
          text,
          replies: [],
          createdAt: now,
          updatedAt: now,
        },
      ]);
      setDraftLineId(null);
      setDraftText("");
      setSendStatus({ kind: "idle" });
    },
    [activeWorkspaceFile, draftText, setComments],
  );

  const saveEditedComment = useCallback(() => {
    const id = editingCommentId;
    const text = editingText.trim();
    if (!id || !text) return;
    setComments((current) =>
      current.map((comment) =>
        comment.id === id ? { ...comment, text, updatedAt: Date.now() } : comment,
      ),
    );
    setEditingCommentId(null);
    setEditingText("");
    setSendStatus({ kind: "idle" });
  }, [editingCommentId, editingText, setComments]);

  const deleteComment = useCallback(
    (commentId: string) => {
      setComments((current) => current.filter((comment) => comment.id !== commentId));
      setEditingCommentId((current) => (current === commentId ? null : current));
      setReplyingCommentId((current) => (current === commentId ? null : current));
      setSendStatus({ kind: "idle" });
    },
    [setComments],
  );

  const setCommentStatus = useCallback(
    (commentId: string, status: ReviewCommentStatus) => {
      setComments((current) =>
        current.map((comment) =>
          comment.id === commentId ? { ...comment, status, updatedAt: Date.now() } : comment,
        ),
      );
      setSendStatus({ kind: "idle" });
    },
    [setComments],
  );

  const addReply = useCallback(() => {
    const commentId = replyingCommentId;
    const text = replyText.trim();
    if (!commentId || !text) return;
    const now = Date.now();
    setComments((current) =>
      current.map((comment) =>
        comment.id === commentId
          ? {
              ...comment,
              replies: [
                ...comment.replies,
                { id: `${comment.id}:reply:${now}`, text, createdAt: now },
              ],
              updatedAt: now,
            }
          : comment,
      ),
    );
    setReplyingCommentId(null);
    setReplyText("");
    setSendStatus({ kind: "idle" });
  }, [replyText, replyingCommentId, setComments]);

  const applyAgentReviewActions = useCallback(
    (response: string | undefined, recipientName: string) => {
      const parsed = parseReviewAgentActions(response);
      if (!parsed.success) {
        setSendStatus({
          kind: "error",
          message: `Sent to ${recipientName}, but no valid review actions were returned.`,
        });
        return;
      }
      let appliedActions = 0;
      setComments((current) => {
        const commentsById = new Map(current.map((comment) => [comment.id, comment]));
        const next = current.map((comment) => ({ ...comment, replies: [...comment.replies] }));
        const mutableById = new Map(next.map((comment) => [comment.id, comment]));
        for (const action of parsed.actions) {
          const original = commentsById.get(action.commentId);
          const target = mutableById.get(action.commentId);
          if (!original || !target || original.threadId !== action.threadId) continue;
          const now = Date.now();
          if (action.action === "reply" || action.action === "add_location_comment") {
            const text = action.message?.trim();
            if (!text) continue;
            target.replies.push({
              id: `${target.id}:agent-reply:${now}:${target.replies.length}`,
              text,
              createdAt: now,
              author: "agent",
            });
            target.updatedAt = now;
            appliedActions += 1;
            continue;
          }
          if (action.action === "mark_resolved") {
            target.status = "resolved";
            target.updatedAt = now;
            appliedActions += 1;
            continue;
          }
          if (action.action === "mark_wontfix") {
            target.status = "wontfix";
            target.updatedAt = now;
            appliedActions += 1;
          }
        }
        return next;
      });
      setSendStatus({ kind: "sent", recipientName, appliedActions });
    },
    [setComments],
  );

  const sendComments = useCallback(() => {
    if (!reviewTargetSessionId || workspaceComments.length === 0) return;
    setSendStatus({ kind: "sending" });
    void window.sessionsAPI
      ?.sendReviewComments?.(
        reviewTargetSessionId,
        buildReviewCommentMessage(workspaceComments, workspaceFiles),
        { deliveryMode: "queue", waitForResponse: true, timeoutMs: 120_000 },
      )
      .then((result) => {
        if (result?.success) {
          applyAgentReviewActions(result.response, reviewTargetSessionName);
          return;
        }
        setSendStatus({ kind: "error", message: result?.error ?? "Failed to send comments." });
      })
      .catch((error: unknown) => {
        setSendStatus({
          kind: "error",
          message: error instanceof Error ? error.message : "Failed to send comments.",
        });
      });
  }, [
    applyAgentReviewActions,
    reviewTargetSessionId,
    reviewTargetSessionName,
    workspaceComments,
    workspaceFiles,
  ]);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h3 className="truncate text-sm font-semibold">{detailTitle(selection)}</h3>
        <div className="flex shrink-0 items-center gap-0.5">
          {panelActions}
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close session activity details"
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {selection.kind === "workspace" ? (
          <div
            className={cn(
              "grid size-full min-h-0",
              useStackedWorkspaceLayout
                ? "grid-rows-[minmax(0,12rem)_minmax(0,1fr)]"
                : "grid-cols-[minmax(150px,220px)_minmax(0,1fr)]",
            )}
            data-testid="session-activity-workspace-layout"
            data-layout={useStackedWorkspaceLayout ? "stacked" : "split"}
          >
            <ScrollArea
              className={cn(
                "border-border bg-muted/20 [&_[data-slot=scroll-area-viewport]>div]:block!",
                useStackedWorkspaceLayout ? "border-b" : "border-r",
              )}
            >
              <div className="space-y-2 p-3">
                <div className="px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  File changes
                </div>
                {selection.workspace.files.map((file) => (
                  <button
                    key={file.id}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted",
                      activeWorkspaceFile?.id === file.id && "bg-muted",
                    )}
                    onClick={() => onWorkspaceFileSelect(file.id)}
                  >
                    <FileDiff className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div
                        className="truncate text-foreground"
                        title={normalizePanelFilePath(file.path)}
                      >
                        {fileNameForPath(file.path)}
                      </div>
                      <div className="text-xs text-muted-foreground">{file.toolName}</div>
                    </div>
                    <div className="shrink-0 text-right text-xs tabular-nums">
                      <div className="text-status-success-fg">+{file.additions}</div>
                      <div className="text-destructive">-{file.deletions}</div>
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
            <div className="min-h-0 min-w-0 p-3">
              {activeWorkspaceFile ? (
                <div className="flex size-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border bg-muted/20 p-3">
                    <div className="min-w-0 flex-1">
                      <div
                        className="truncate text-sm font-semibold text-foreground"
                        title={normalizePanelFilePath(activeWorkspaceFile.path)}
                      >
                        {fileNameForPath(activeWorkspaceFile.path)}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {activeWorkspaceFile.toolName}
                      </div>
                    </div>
                    <div
                      className="flex max-w-full min-w-0 flex-wrap items-center justify-end gap-2"
                      data-testid="session-activity-review-actions"
                    >
                      {activeDiffNotices.map((notice) => (
                        <Badge
                          key={notice}
                          variant="outline"
                          className="max-w-full text-[10px] whitespace-normal"
                          data-testid="session-activity-diff-notice"
                        >
                          {notice}
                        </Badge>
                      ))}
                      {workspaceComments.length > 0 && (
                        <Badge variant="outline" className="text-[10px]">
                          {workspaceComments.length} comment
                          {workspaceComments.length === 1 ? "" : "s"}
                        </Badge>
                      )}
                      {workspaceComments.length > 0 && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 min-w-fit"
                          onClick={sendComments}
                          disabled={!reviewTargetSessionId || sendStatus.kind === "sending"}
                          data-testid="session-activity-send-review"
                        >
                          <Send className="size-3.5" />
                          Send review
                        </Button>
                      )}
                    </div>
                  </div>
                  {sendStatus.kind !== "idle" && (
                    <div
                      className={cn(
                        "border-b px-3 py-2 text-xs",
                        sendStatus.kind === "error"
                          ? "border-destructive/30 bg-destructive/10 text-destructive"
                          : "border-status-success-fg/30 bg-status-success-fg/10 text-status-success-fg",
                      )}
                    >
                      {sendStatus.kind === "sending"
                        ? "Sending comments and waiting for review actions..."
                        : sendStatus.kind === "sent"
                          ? `Sent to ${sendStatus.recipientName}.${
                              sendStatus.appliedActions
                                ? ` Applied ${sendStatus.appliedActions} action${
                                    sendStatus.appliedActions === 1 ? "" : "s"
                                  }.`
                                : ""
                            }`
                          : sendStatus.message}
                    </div>
                  )}
                  <div className="min-h-0 flex-1 overflow-hidden">
                    <InlineDiffViewer
                      diff={
                        activeWorkspaceDiff ??
                        buildUnavailableDiff(normalizePanelFilePath(activeWorkspaceFile.path))
                      }
                      notices={activeDiffNotices}
                      comments={activeFileComments}
                      draftLineId={draftLineId}
                      draftText={draftText}
                      onStartComment={(line) => {
                        setDraftLineId(line.id);
                        setDraftText("");
                        setEditingCommentId(null);
                        setReplyingCommentId(null);
                      }}
                      onDraftTextChange={setDraftText}
                      onAddComment={addComment}
                      onCancelComment={() => {
                        setDraftLineId(null);
                        setDraftText("");
                      }}
                      editingCommentId={editingCommentId}
                      editingText={editingText}
                      onStartEdit={(comment) => {
                        setEditingCommentId(comment.id);
                        setEditingText(comment.text);
                        setReplyingCommentId(null);
                      }}
                      onEditingTextChange={setEditingText}
                      onSaveEdit={saveEditedComment}
                      onCancelEdit={() => {
                        setEditingCommentId(null);
                        setEditingText("");
                      }}
                      onDeleteComment={deleteComment}
                      onSetCommentStatus={setCommentStatus}
                      replyingCommentId={replyingCommentId}
                      replyText={replyText}
                      onStartReply={(comment) => {
                        setReplyingCommentId(comment.id);
                        setReplyText("");
                        setEditingCommentId(null);
                      }}
                      onReplyTextChange={setReplyText}
                      onAddReply={addReply}
                      onCancelReply={() => {
                        setReplyingCommentId(null);
                        setReplyText("");
                      }}
                    />
                  </div>
                </div>
              ) : (
                <div className="flex size-full items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">
                  Select a file to inspect its diff.
                </div>
              )}
            </div>
          </div>
        ) : selection.kind === "subagent" ? (
          <ChatPanel
            sessionId={selection.session.id}
            hideAvatars
            hideAttachments
            hideTokenCounter
          />
        ) : selection.kind === "workflow-run" ? (
          <WorkflowRunDetail entry={selection.entry} />
        ) : (
          <ScrollArea className="size-full [&_[data-slot=scroll-area-viewport]>div]:block!">
            <div className="space-y-3 p-4 text-sm">
              {selection.kind === "source" && <SourceDetail source={selection.source} />}
              {selection.kind === "source" && selection.source.url && (
                <Button
                  variant="outline"
                  onClick={() => window.open(selection.source.url, "_blank", "noopener,noreferrer")}
                >
                  Open source
                </Button>
              )}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}

function SourceDetail({ source }: { source: CommandCenterSessionActivitySource }) {
  return (
    <div className="space-y-4">
      <DetailFields detail={sourceDetailFields(source)} />
      {source.query && (
        <div className="space-y-1.5">
          <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Query
          </div>
          <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-muted p-3 text-xs whitespace-pre-wrap text-foreground">
            {source.query}
          </pre>
        </div>
      )}
    </div>
  );
}

function WorkflowRunDetail({ entry }: { entry: WorkflowRunEntry }) {
  const { run, workflowLabel } = entry;
  const [snapshot, setSnapshot] = useState<RunSnapshotShape | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    const api = window.workflowsAPI;
    if (!api?.getRun) return undefined;
    let active = true;
    void api.getRun(run.runId).then((result) => {
      if (!active) return;
      if (result.success && result.snapshot) {
        setSnapshot(result.snapshot as RunSnapshotShape);
        setSnapshotError(null);
      } else {
        setSnapshotError(result.error ?? "Snapshot unavailable.");
      }
    });
    return () => {
      active = false;
    };
  }, [run.runId]);

  const terminal =
    run.status === "succeeded" ||
    run.status === "failed" ||
    run.status === "cancelled" ||
    run.status === "crashed";

  const handleCancel = useCallback(async () => {
    const api = window.workflowsAPI;
    if (!api?.cancel) return;
    setCancelling(true);
    try {
      await api.cancel(run.runId);
    } finally {
      setCancelling(false);
    }
  }, [run.runId]);

  return (
    <ScrollArea
      className="size-full [&_[data-slot=scroll-area-viewport]>div]:block!"
      data-testid="session-activity-workflow-run-detail"
    >
      <div className="space-y-4 p-4 text-sm">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">{workflowLabel}</div>
            <div className="truncate text-xs text-muted-foreground">{run.workflowId}</div>
          </div>
          <Badge variant="outline" className="shrink-0 uppercase">
            {run.status}
          </Badge>
        </div>

        <DetailFields
          detail={{
            "Run ID": run.runId,
            "Run family": run.runFamilyId,
            ...(run.parentRunId ? { "Parent run": run.parentRunId } : {}),
            ...(run.workspaceName ? { Workspace: workspaceDisplayName(run.workspaceName) } : {}),
            ...(run.initiatorSessionId ? { "Initiator session": run.initiatorSessionId } : {}),
            Started: new Date(run.startedAt).toLocaleString(),
            ...(run.finishedAt ? { Finished: new Date(run.finishedAt).toLocaleString() } : {}),
          }}
        />

        {snapshot && (
          <div className="space-y-2">
            <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Steps ({snapshot.steps.length})
            </div>
            <ul className="space-y-1">
              {snapshot.steps.map((step) => (
                <li
                  key={step.stepId ?? step.key ?? `${step.status}-${step.title ?? ""}`}
                  className="flex items-center gap-2 rounded-md border border-border/70 bg-background/70 px-2 py-1.5 text-xs"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {step.title ?? step.key ?? step.stepId ?? "step"}
                  </span>
                  <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
                    {step.status}
                  </Badge>
                </li>
              ))}
            </ul>
            {snapshot.errorSummary && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                {snapshot.errorSummary.message}
              </div>
            )}
          </div>
        )}

        {snapshotError && !snapshot && (
          <div className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            {snapshotError}
          </div>
        )}

        {!terminal && (
          <Button variant="outline" onClick={handleCancel} disabled={cancelling}>
            {cancelling ? "Cancelling…" : "Cancel run"}
          </Button>
        )}
      </div>
    </ScrollArea>
  );
}

// Local structural type for the bits of RunSnapshot we read. Keeps
// SessionActivityPanel independent of the full workflows-contract surface
// (which pulls Zod schemas + reducers we don't need here).
interface RunSnapshotShape {
  steps: ReadonlyArray<{
    stepId?: string;
    key?: string;
    title?: string;
    status: string;
  }>;
  errorSummary?: { message: string };
}

function InlineDiffViewer({
  diff,
  notices,
  comments,
  draftLineId,
  draftText,
  onStartComment,
  onDraftTextChange,
  onAddComment,
  onCancelComment,
  editingCommentId,
  editingText,
  onStartEdit,
  onEditingTextChange,
  onSaveEdit,
  onCancelEdit,
  onDeleteComment,
  onSetCommentStatus,
  replyingCommentId,
  replyText,
  onStartReply,
  onReplyTextChange,
  onAddReply,
  onCancelReply,
}: {
  diff: string;
  notices: string[];
  comments: ReviewComment[];
  draftLineId: string | null;
  draftText: string;
  onStartComment: (line: ParsedDiffLine) => void;
  onDraftTextChange: (text: string) => void;
  onAddComment: (line: ParsedDiffLine) => void;
  onCancelComment: () => void;
  editingCommentId: string | null;
  editingText: string;
  onStartEdit: (comment: ReviewComment) => void;
  onEditingTextChange: (text: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onDeleteComment: (commentId: string) => void;
  onSetCommentStatus: (commentId: string, status: ReviewCommentStatus) => void;
  replyingCommentId: string | null;
  replyText: string;
  onStartReply: (comment: ReviewComment) => void;
  onReplyTextChange: (text: string) => void;
  onAddReply: () => void;
  onCancelReply: () => void;
}) {
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const lineIds = useMemo(() => new Set(lines.map((line) => line.id)), [lines]);
  const commentsByLine = useMemo(() => {
    const grouped = new Map<string, ReviewComment[]>();
    for (const comment of comments) {
      const existing = grouped.get(comment.lineId) ?? [];
      existing.push(comment);
      grouped.set(comment.lineId, existing);
    }
    return grouped;
  }, [comments]);
  const outdatedComments = useMemo(
    () => comments.filter((comment) => !lineIds.has(comment.lineId)),
    [comments, lineIds],
  );

  return (
    <ScrollArea
      className="size-full bg-background text-foreground [&_[data-slot=scroll-area-viewport]>div]:block!"
      data-testid="session-activity-file-diff"
    >
      <div
        className="w-full py-2 font-mono text-[13px] leading-[1.45]"
        data-testid="session-activity-diff-content"
      >
        {notices.length > 0 && (
          <div className="space-y-1 px-3 pb-2 font-sans text-xs text-muted-foreground">
            {notices.map((notice) => (
              <div
                key={notice}
                className="rounded-md border border-border bg-muted/50 px-2 py-1 wrap-break-word"
                data-testid="session-activity-diff-inline-notice"
              >
                {notice}
              </div>
            ))}
          </div>
        )}
        {lines.map((line) => {
          const lineComments = commentsByLine.get(line.id) ?? [];
          return (
            <div key={line.id}>
              <div
                className={cn(
                  "grid grid-cols-[2.5rem_2.5rem_1.75rem_minmax(0,1fr)] items-start border-l-2 pr-2",
                  diffLineClassName(line.kind),
                )}
                data-line-id={line.id}
              >
                <div className="px-1.5 text-right text-muted-foreground tabular-nums select-none">
                  {line.oldLine ?? ""}
                </div>
                <div className="px-1.5 text-right text-muted-foreground tabular-nums select-none">
                  {line.newLine ?? ""}
                </div>
                <div className="flex min-h-5 items-start justify-center pt-0.5">
                  {line.commentable && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-5 rounded-sm border border-transparent bg-background/70 text-muted-foreground opacity-80 hover:border-border hover:bg-background hover:text-foreground"
                      title="Add comment"
                      aria-label={`Add comment on ${line.kind} line ${line.newLine ?? line.oldLine ?? ""}`}
                      onClick={() => onStartComment(line)}
                    >
                      <Plus className="size-3" />
                    </Button>
                  )}
                </div>
                <pre className="min-w-0 px-2 font-mono wrap-break-word whitespace-pre-wrap text-foreground">
                  {linePrefix(line.kind)}
                  {line.text || " "}
                </pre>
              </div>
              {draftLineId === line.id && (
                <div
                  className="border-l-2 border-primary/60 bg-primary/5 p-3"
                  data-testid="session-activity-comment-composer"
                >
                  <div className="w-full max-w-none rounded-lg border border-primary/30 bg-background p-3 shadow-sm">
                    <Textarea
                      value={draftText}
                      onChange={(event) => onDraftTextChange(event.target.value)}
                      placeholder="Comment"
                      className="min-h-20 resize-y font-sans text-sm/6 wrap-break-word"
                      autoFocus
                    />
                    <div className="mt-2 flex flex-wrap justify-end gap-2">
                      <Button type="button" variant="ghost" size="sm" onClick={onCancelComment}>
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => onAddComment(line)}
                        disabled={!draftText.trim()}
                      >
                        Add comment
                      </Button>
                    </div>
                  </div>
                </div>
              )}
              {lineComments.map((comment) => (
                <div
                  key={comment.id}
                  className="border-l-2 border-amber-400/80 bg-amber-500/5 px-3 py-2"
                >
                  <ReviewCommentCard
                    comment={comment}
                    isEditing={editingCommentId === comment.id}
                    editingText={editingText}
                    onStartEdit={onStartEdit}
                    onEditingTextChange={onEditingTextChange}
                    onSaveEdit={onSaveEdit}
                    onCancelEdit={onCancelEdit}
                    onDeleteComment={onDeleteComment}
                    onSetCommentStatus={onSetCommentStatus}
                    isReplying={replyingCommentId === comment.id}
                    replyText={replyText}
                    onStartReply={onStartReply}
                    onReplyTextChange={onReplyTextChange}
                    onAddReply={onAddReply}
                    onCancelReply={onCancelReply}
                  />
                </div>
              ))}
            </div>
          );
        })}
        {outdatedComments.length > 0 && (
          <div
            className="mt-3 space-y-2 border-t border-border bg-muted/20 p-3 font-sans"
            data-testid="session-activity-outdated-comments"
          >
            <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Outdated comments
            </div>
            {outdatedComments.map((comment) => (
              <ReviewCommentCard
                key={comment.id}
                comment={comment}
                outdated
                isEditing={editingCommentId === comment.id}
                editingText={editingText}
                onStartEdit={onStartEdit}
                onEditingTextChange={onEditingTextChange}
                onSaveEdit={onSaveEdit}
                onCancelEdit={onCancelEdit}
                onDeleteComment={onDeleteComment}
                onSetCommentStatus={onSetCommentStatus}
                isReplying={replyingCommentId === comment.id}
                replyText={replyText}
                onStartReply={onStartReply}
                onReplyTextChange={onReplyTextChange}
                onAddReply={onAddReply}
                onCancelReply={onCancelReply}
              />
            ))}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

function ReviewCommentCard({
  comment,
  outdated = false,
  isEditing,
  editingText,
  onStartEdit,
  onEditingTextChange,
  onSaveEdit,
  onCancelEdit,
  onDeleteComment,
  onSetCommentStatus,
  isReplying,
  replyText,
  onStartReply,
  onReplyTextChange,
  onAddReply,
  onCancelReply,
}: {
  comment: ReviewComment;
  outdated?: boolean;
  isEditing: boolean;
  editingText: string;
  onStartEdit: (comment: ReviewComment) => void;
  onEditingTextChange: (text: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onDeleteComment: (commentId: string) => void;
  onSetCommentStatus: (commentId: string, status: ReviewCommentStatus) => void;
  isReplying: boolean;
  replyText: string;
  onStartReply: (comment: ReviewComment) => void;
  onReplyTextChange: (text: string) => void;
  onAddReply: () => void;
  onCancelReply: () => void;
}) {
  const actionButtonClassName =
    "h-auto min-h-8 min-w-0 max-w-full flex-none items-start justify-start whitespace-normal text-left leading-tight wrap-anywhere [word-break:break-word]";

  return (
    <div
      className="w-full max-w-none min-w-0 overflow-hidden rounded-lg border border-border bg-background px-3 py-2.5 font-sans text-sm/6 wrap-anywhere [word-break:break-word] text-foreground shadow-sm"
      data-testid="session-activity-review-comment"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge
          variant="outline"
          className={cn(
            "max-w-full text-[10px] wrap-anywhere [word-break:break-word] whitespace-normal",
            reviewStatusBadgeClass(comment.status),
          )}
        >
          {reviewStatusLabel(comment.status)}
        </Badge>
        {outdated && (
          <Badge
            variant="outline"
            className="max-w-full text-[10px] wrap-anywhere [word-break:break-word] whitespace-normal"
          >
            Outdated
          </Badge>
        )}
        <span className="max-w-full min-w-0 text-xs wrap-anywhere [word-break:break-word] text-muted-foreground">
          {reviewAnchorLabel(comment.anchor)}
        </span>
      </div>

      {isEditing ? (
        <Textarea
          value={editingText}
          onChange={(event) => onEditingTextChange(event.target.value)}
          placeholder="Edit comment"
          className="mt-2 min-h-20 resize-y text-sm/6 wrap-break-word"
          autoFocus
        />
      ) : (
        <p className="mt-2 wrap-anywhere [word-break:break-word] whitespace-pre-wrap">
          {comment.text}
        </p>
      )}

      {comment.replies.length > 0 && (
        <div className="mt-3 min-w-0 space-y-2 border-l-2 border-border pl-3">
          {comment.replies.map((reply) => (
            <div
              key={reply.id}
              className="min-w-0 overflow-hidden rounded-md bg-muted/60 px-3 py-2 text-sm wrap-anywhere [word-break:break-word] text-foreground"
              data-testid="session-activity-review-reply"
            >
              <div className="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                Reply
              </div>
              <div className="wrap-anywhere [word-break:break-word] whitespace-pre-wrap">
                {reply.text}
              </div>
            </div>
          ))}
        </div>
      )}

      {isReplying && (
        <div className="mt-3 min-w-0 overflow-hidden rounded-lg border border-border bg-muted/30 p-2">
          <Textarea
            value={replyText}
            onChange={(event) => onReplyTextChange(event.target.value)}
            placeholder="Reply"
            className="min-h-16 resize-y text-sm/6 wrap-break-word"
            autoFocus
          />
          <div className="mt-2 flex min-w-0 flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={actionButtonClassName}
              onClick={onCancelReply}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className={actionButtonClassName}
              onClick={onAddReply}
              disabled={!replyText.trim()}
            >
              Add reply
            </Button>
          </div>
        </div>
      )}

      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
        {isEditing ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={actionButtonClassName}
              onClick={onCancelEdit}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className={actionButtonClassName}
              onClick={onSaveEdit}
              disabled={!editingText.trim()}
            >
              Save comment
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={actionButtonClassName}
              onClick={() => onStartEdit(comment)}
            >
              <Pencil className="size-3.5 shrink-0" />
              Edit comment
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={actionButtonClassName}
              onClick={() => onStartReply(comment)}
            >
              <Reply className="size-3.5 shrink-0" />
              Reply
            </Button>
            {comment.status === "pending" ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={actionButtonClassName}
                  onClick={() => onSetCommentStatus(comment.id, "resolved")}
                >
                  <CircleCheck className="size-3.5 shrink-0" />
                  Mark resolved
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={actionButtonClassName}
                  onClick={() => onSetCommentStatus(comment.id, "wontfix")}
                >
                  <CircleSlash className="size-3.5 shrink-0" />
                  Mark won't fix
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={actionButtonClassName}
                onClick={() => onSetCommentStatus(comment.id, "pending")}
              >
                <RotateCcw className="size-3.5 shrink-0" />
                Reopen comment
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(actionButtonClassName, "text-destructive hover:text-destructive")}
              onClick={() => onDeleteComment(comment.id)}
            >
              <Trash2 className="size-3.5 shrink-0" />
              Delete comment
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function parseUnifiedDiff(diff: string): ParsedDiffLine[] {
  const rows = splitContentLines(diff);
  let oldLine = 1;
  let newLine = 1;
  let hunkHeader: string | undefined;
  return rows.map((raw, index) => {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      hunkHeader = raw;
      return {
        id: `hunk:${oldLine}:${newLine}:${hashString(raw)}`,
        kind: "hunk",
        hunkHeader: raw,
        text: raw,
        commentable: false,
      } satisfies ParsedDiffLine;
    }

    if (raw.startsWith("+++ ")) {
      return {
        id: `header:added:${hashString(raw)}`,
        kind: "added",
        text: diffHeaderFileName(raw.slice(4)),
        commentable: false,
      } satisfies ParsedDiffLine;
    }
    if (raw.startsWith("--- ")) {
      return {
        id: `header:removed:${hashString(raw)}`,
        kind: "removed",
        text: diffHeaderFileName(raw.slice(4)),
        commentable: false,
      } satisfies ParsedDiffLine;
    }
    if (raw.startsWith("+")) {
      const text = raw.slice(1);
      const line = {
        id: diffLineId("added", undefined, newLine, text),
        kind: "added",
        newLine,
        hunkHeader,
        text,
        commentable: true,
      } satisfies ParsedDiffLine;
      newLine += 1;
      return line;
    }
    if (raw.startsWith("-")) {
      const text = raw.slice(1);
      const line = {
        id: diffLineId("removed", oldLine, undefined, text),
        kind: "removed",
        oldLine,
        hunkHeader,
        text,
        commentable: true,
      } satisfies ParsedDiffLine;
      oldLine += 1;
      return line;
    }
    if (raw.startsWith(" ")) {
      const text = raw.slice(1);
      const line = {
        id: diffLineId("context", oldLine, newLine, text),
        kind: "context",
        oldLine,
        newLine,
        hunkHeader,
        text,
        commentable: true,
      } satisfies ParsedDiffLine;
      oldLine += 1;
      newLine += 1;
      return line;
    }
    return {
      id: `metadata:${index}:${hashString(raw)}`,
      kind: "metadata",
      text: raw,
      commentable: false,
    } satisfies ParsedDiffLine;
  });
}

function diffLineClassName(kind: ParsedDiffLine["kind"]): string {
  if (kind === "added") return "border-emerald-500/70 bg-emerald-500/10";
  if (kind === "removed") return "border-destructive/70 bg-destructive/10";
  if (kind === "hunk") return "border-primary/60 bg-primary/10 text-primary";
  if (kind === "metadata") return "border-border bg-muted/60 text-muted-foreground";
  return "border-transparent bg-background";
}

function linePrefix(kind: ParsedDiffLine["kind"]): string {
  if (kind === "added") return "+ ";
  if (kind === "removed") return "- ";
  return "  ";
}

function diffHeaderFileName(value: string): string {
  if (value === "/dev/null") return value;
  return fileNameForPath(value.replace(/^[ab]\//, ""));
}

function diffLineId(
  side: ReviewCommentSide,
  oldLine: number | undefined,
  newLine: number | undefined,
  lineText: string,
): string {
  return `${side}:${oldLine ?? ""}:${newLine ?? ""}:${hashString(lineText)}`;
}

function anchorForDiffLine(line: ParsedDiffLine): ReviewCommentAnchor {
  return {
    side: line.kind === "removed" ? "removed" : line.kind === "added" ? "added" : "context",
    ...(line.oldLine !== undefined ? { oldLine: line.oldLine } : {}),
    ...(line.newLine !== undefined ? { newLine: line.newLine } : {}),
    ...(line.hunkHeader ? { hunkHeader: line.hunkHeader } : {}),
    lineText: line.text,
  };
}

function reviewThreadId(fileId: string, anchor: ReviewCommentAnchor): string {
  return [
    fileId,
    anchor.side,
    anchor.oldLine ?? "",
    anchor.newLine ?? "",
    hashString(anchor.lineText),
  ].join(":");
}

function reviewAnchorLabel(anchor: ReviewCommentAnchor): string {
  const line = anchor.newLine ?? anchor.oldLine;
  const side = anchor.side;
  return line ? `${side} line ${line}` : `${side} line`;
}

function reviewStatusLabel(status: ReviewCommentStatus): string {
  if (status === "wontfix") return "Won't fix";
  return status;
}

function reviewStatusBadgeClass(status: ReviewCommentStatus): string {
  if (status === "resolved") return "border-status-success-fg/40 text-status-success-fg";
  if (status === "wontfix") return "border-muted-foreground/40 text-muted-foreground";
  return "border-amber-500/40 text-amber-700 dark:text-amber-300";
}

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash, 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function buildReviewCommentMessage(
  comments: ReviewComment[],
  fileChanges: CommandCenterSessionActivityFileChange[],
): string {
  const fileById = new Map(fileChanges.map((file) => [file.id, file]));
  const payload = {
    schemaVersion: 1,
    kind: "workspace_file_review_comments",
    requestedActions: ["reply", "add_location_comment", "mark_resolved", "mark_wontfix"],
    threads: comments.map((comment) => {
      const context = buildReviewHunkContext(comment, fileById.get(comment.fileId));
      return {
        threadId: comment.threadId,
        commentId: comment.id,
        file: {
          path: comment.filePath,
          name: comment.fileName,
        },
        anchor: {
          side: comment.anchor.side,
          ...(comment.anchor.oldLine !== undefined ? { oldLine: comment.anchor.oldLine } : {}),
          ...(comment.anchor.newLine !== undefined ? { newLine: comment.anchor.newLine } : {}),
          ...(comment.anchor.hunkHeader ? { hunkHeader: comment.anchor.hunkHeader } : {}),
          lineText: truncateForPayload(comment.anchor.lineText, 2_000),
        },
        hunkContext: context.lines,
        ...(context.truncated ? { hunkContextTruncated: true } : {}),
        ...(context.reason ? { hunkContextReason: context.reason } : {}),
        status: comment.status,
        comment: truncateForPayload(comment.text, 4_000),
        replies: comment.replies.map((reply) => ({
          replyId: reply.id,
          text: truncateForPayload(reply.text, 2_000),
        })),
      };
    }),
  };
  const responseSchema = {
    schemaVersion: 1,
    actions: [
      {
        threadId: "<threadId from payload>",
        commentId: "<commentId from payload>",
        action: "reply | add_location_comment | mark_resolved | mark_wontfix",
        message: "<required for reply/add_location_comment>",
        status: "pending | resolved | wontfix",
      },
    ],
  };

  return [
    "Please review and address these file-change comments from the Progress panel.",
    "Use the provided file paths and anchors exactly; do not guess alternate locations.",
    "Requested actions: reply, add_location_comment, mark_resolved, mark_wontfix.",
    "",
    "Return a short summary, then a fenced JSON response labeled marshal-actions matching this schema:",
    "~~~json",
    "marshal-actions",
    JSON.stringify(responseSchema, null, 2),
    "~~~",
    "",
    "Comment payload:",
    "~~~json",
    JSON.stringify(payload, null, 2),
    "~~~",
  ].join("\n");
}

function parseReviewAgentActions(
  response: string | undefined,
): { success: true; actions: ReviewAgentAction[] } | { success: false } {
  if (!response) return { success: false };
  const actions: ReviewAgentAction[] = [];
  const blockPattern = /(?:~~~|```)json\s*(?:marshal-actions)?\s*([\s\S]*?)(?:~~~|```)/gi;
  for (const match of response.matchAll(blockPattern)) {
    const parsed = parseReviewAgentActionPayload(match[1]);
    if (parsed.length > 0) actions.push(...parsed);
  }
  return actions.length > 0 ? { success: true, actions } : { success: false };
}

function parseReviewAgentActionPayload(value: string): ReviewAgentAction[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") return [];
    const actions = (parsed as { actions?: unknown }).actions;
    if (!Array.isArray(actions)) return [];
    return actions.filter(isReviewAgentAction);
  } catch {
    return [];
  }
}

function isReviewAgentAction(value: unknown): value is ReviewAgentAction {
  if (!value || typeof value !== "object") return false;
  const action = value as Partial<ReviewAgentAction>;
  return (
    typeof action.threadId === "string" &&
    typeof action.commentId === "string" &&
    isReviewAgentActionKind(action.action) &&
    (action.message === undefined || typeof action.message === "string") &&
    (action.status === undefined || isReviewCommentStatus(action.status))
  );
}

function isReviewAgentActionKind(value: unknown): value is ReviewAgentActionKind {
  return (
    value === "reply" ||
    value === "add_location_comment" ||
    value === "mark_resolved" ||
    value === "mark_wontfix"
  );
}

function isReviewCommentStatus(value: unknown): value is ReviewCommentStatus {
  return value === "pending" || value === "resolved" || value === "wontfix";
}

function buildReviewHunkContext(
  comment: ReviewComment,
  file: CommandCenterSessionActivityFileChange | undefined,
): ReviewHunkContextResult {
  if (!file?.diff) return { lines: [], truncated: false, reason: "no-context-available" };
  const parsed = parseUnifiedDiff(file.diff);
  const anchorIndex = parsed.findIndex((line) => line.id === comment.lineId);
  if (anchorIndex < 0) return { lines: [], truncated: false, reason: "no-diff-line" };

  const anchorLine = parsed[anchorIndex];
  const candidates = anchorLine.hunkHeader
    ? parsed.filter((line) =>
        line.kind === "hunk"
          ? line.text === anchorLine.hunkHeader
          : line.hunkHeader === anchorLine.hunkHeader,
      )
    : parsed.filter((line) => line.kind !== "metadata");
  const candidateAnchorIndex = candidates.findIndex((line) => line.id === comment.lineId);
  if (candidateAnchorIndex < 0) return { lines: [], truncated: false, reason: "no-diff-line" };

  const { lines, anchorContextIndex, truncated } = selectBoundedContextLines(
    candidates,
    candidateAnchorIndex,
  );
  const serialized = fitContextSerializedBudget(
    lines.map(reviewHunkContextLineForDiffLine),
    anchorContextIndex,
  );
  return {
    lines: serialized.lines,
    truncated: truncated || serialized.truncated,
  };
}

function selectBoundedContextLines(
  candidates: ParsedDiffLine[],
  anchorIndex: number,
): { lines: ParsedDiffLine[]; anchorContextIndex: number; truncated: boolean } {
  if (candidates.length <= REVIEW_HUNK_CONTEXT_MAX_LINES) {
    return { lines: candidates, anchorContextIndex: anchorIndex, truncated: false };
  }
  const before = Math.floor((REVIEW_HUNK_CONTEXT_MAX_LINES - 1) / 2);
  const maxStart = Math.max(0, candidates.length - REVIEW_HUNK_CONTEXT_MAX_LINES);
  const start = Math.min(maxStart, Math.max(0, anchorIndex - before));
  const end = start + REVIEW_HUNK_CONTEXT_MAX_LINES;
  return {
    lines: candidates.slice(start, end),
    anchorContextIndex: anchorIndex - start,
    truncated: true,
  };
}

function fitContextSerializedBudget(
  lines: ReviewHunkContextLine[],
  anchorIndex: number,
): { lines: ReviewHunkContextLine[]; truncated: boolean } {
  const next = [...lines];
  let nextAnchorIndex = anchorIndex;
  let truncated = false;
  while (
    next.length > 1 &&
    JSON.stringify(next).length > REVIEW_HUNK_CONTEXT_MAX_SERIALIZED_CHARS
  ) {
    const removeIndex = farthestContextLineIndex(next, nextAnchorIndex);
    next.splice(removeIndex, 1);
    if (removeIndex < nextAnchorIndex) nextAnchorIndex -= 1;
    truncated = true;
  }
  if (JSON.stringify(next).length <= REVIEW_HUNK_CONTEXT_MAX_SERIALIZED_CHARS) {
    return { lines: next, truncated };
  }
  return {
    lines: [truncateContextLineToBudget(next[Math.max(0, nextAnchorIndex)])],
    truncated: true,
  };
}

function farthestContextLineIndex(lines: ReviewHunkContextLine[], anchorIndex: number): number {
  let selected = 0;
  let selectedDistance = -1;
  for (let index = 0; index < lines.length; index++) {
    if (index === anchorIndex) continue;
    const distance = Math.abs(index - anchorIndex);
    if (distance >= selectedDistance) {
      selected = index;
      selectedDistance = distance;
    }
  }
  return selected;
}

function truncateContextLineToBudget(line: ReviewHunkContextLine): ReviewHunkContextLine {
  let candidate = { ...line };
  if (JSON.stringify([candidate]).length <= REVIEW_HUNK_CONTEXT_MAX_SERIALIZED_CHARS) {
    return candidate;
  }
  candidate = truncateContextStringFieldToBudget(
    candidate,
    "hunkHeader",
    REVIEW_HUNK_HEADER_TRUNCATION_SUFFIX,
    "hunkHeaderTruncated",
  );
  if (JSON.stringify([candidate]).length <= REVIEW_HUNK_CONTEXT_MAX_SERIALIZED_CHARS) {
    return candidate;
  }
  return truncateContextStringFieldToBudget(
    candidate,
    "content",
    REVIEW_CONTEXT_CONTENT_TRUNCATION_SUFFIX,
    "contentTruncated",
  );
}

function truncateContextStringFieldToBudget(
  line: ReviewHunkContextLine,
  field: "content" | "hunkHeader",
  suffix: string,
  marker: "contentTruncated" | "hunkHeaderTruncated",
): ReviewHunkContextLine {
  const value = line[field];
  if (value === undefined) return line;
  let low = 0;
  let high = value.length;
  let best: ReviewHunkContextLine = { ...line, [field]: suffix, [marker]: true };
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate: ReviewHunkContextLine = {
      ...line,
      [field]: `${value.slice(0, mid)}${suffix}`,
      [marker]: true,
    };
    if (JSON.stringify([candidate]).length <= REVIEW_HUNK_CONTEXT_MAX_SERIALIZED_CHARS) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function reviewHunkContextLineForDiffLine(line: ParsedDiffLine): ReviewHunkContextLine {
  return {
    kind: line.kind,
    side: reviewContextSideForLine(line.kind),
    ...(line.oldLine !== undefined ? { oldLine: line.oldLine } : {}),
    ...(line.newLine !== undefined ? { newLine: line.newLine } : {}),
    prefix: reviewContextPrefixForLine(line.kind),
    content: line.text,
    ...(line.kind === "hunk"
      ? { hunkHeader: line.text }
      : line.hunkHeader
        ? { hunkHeader: line.hunkHeader }
        : {}),
  };
}

function reviewContextSideForLine(kind: ParsedDiffLine["kind"]): ReviewHunkContextLine["side"] {
  if (kind === "added") return "added";
  if (kind === "removed") return "removed";
  if (kind === "context") return "context";
  return kind;
}

function reviewContextPrefixForLine(kind: ParsedDiffLine["kind"]): string {
  if (kind === "added") return "+";
  if (kind === "removed") return "-";
  if (kind === "context") return " ";
  return "";
}

function sourceDetailFields(source: CommandCenterSessionActivitySource): object {
  const { query: _query, ...detail } = source;
  return detail;
}

function normalizePanelFilePath(value: string): string {
  const parsed = parsePanelPathCandidate(value);
  if (Array.isArray(parsed)) {
    const first = parsed.find((entry): entry is string => typeof entry === "string");
    return first ? normalizePanelFilePath(first) : value.trim();
  }
  const text = typeof parsed === "string" ? parsed : value;
  return text.trim().replace(/^['"]|['"]$/g, "");
}

function fileNameForPath(value: string): string {
  const normalized = normalizePanelFilePath(value);
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? normalized;
}

function parsePanelPathCandidate(value: string): unknown {
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function truncateForPayload(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...[truncated]`;
}

function diffNoticesForFile(file: CommandCenterSessionActivityFileChange): string[] {
  const notices: string[] = [];
  if (file.diff && file.diffContextLines !== undefined) {
    notices.push(`Only changed hunks shown (${file.diffContextLines} context lines).`);
  }
  if (file.diffTruncated) notices.push("Diff truncated.");
  if (file.diffUnavailableReason === "source-too-large") {
    notices.push("File too large for inline diff.");
  } else if (!file.diff) {
    notices.push("Full file unavailable.");
  }
  return notices;
}

function buildUnavailableDiff(
  filePath: string,
  reason: CommandCenterSessionActivityFileChange["diffUnavailableReason"] = "not-captured",
): string {
  const message =
    reason === "source-too-large"
      ? "File too large for inline diff. The change is tracked, but Marshal could not safely load enough source to compute a scoped diff."
      : "Full diff unavailable. Marshal did not capture enough change metadata for this file; no full-file fallback is shown.";
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    "@@ -0,0 +0,0 @@",
    `Diff unavailable: ${message}`,
  ].join("\n");
}

function splitContentLines(content: string): string[] {
  if (!content) return [];
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

function DetailFields({ detail }: { detail: object }) {
  return (
    <dl className="space-y-2">
      {Object.entries(detail)
        .filter(([, value]) => value != null && typeof value !== "object")
        .map(([key, value]) => (
          <div key={key}>
            <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {key}
            </dt>
            <dd className="mt-0.5 wrap-break-word">{String(value)}</dd>
          </div>
        ))}
    </dl>
  );
}

function detailTitle(selection: DrawerSelection): string {
  if (selection.kind === "workspace") return `${selection.workspace.name} changes`;
  if (selection.kind === "source") return selection.source.label;
  if (selection.kind === "subagent") return selection.session.name;
  if (selection.kind === "workflow-run") {
    return `${selection.entry.workflowLabel} — ${selection.entry.run.status}`;
  }
  return "Session activity";
}

function progressForTodos(todos: CommandCenterTodoSummary[]): { done: number; total: number } {
  return { done: todos.filter((todo) => todo.status === "done").length, total: todos.length };
}

interface TodoGoalGroup {
  goalId: string;
  goalLabel?: string;
  todos: CommandCenterTodoSummary[];
  /** Latest updatedAt across the group's todos. Used to order the goals
   *  most-recent-first so the panel defaults to the active goal. */
  updatedAt: number;
}

/**
 * Partition todos into one group per goal id, ordered most-recent first.
 *
 * Todos that lack a goalId (pre-goal historical events) are collected
 * into a single synthetic "legacy" group so they still render somewhere.
 * Within each group, todos are ordered by snapshot order (already sorted
 * descending by updatedAt in the reducer); we re-sort by updatedAt
 * ascending so the panel reads top-down in the order the agent built
 * the list.
 */
function groupTodosByGoal(todos: CommandCenterTodoSummary[]): TodoGoalGroup[] {
  const byGoal = new Map<string, TodoGoalGroup>();
  for (const todo of todos) {
    const key = todo.goalId ?? "__legacy__";
    const existing = byGoal.get(key);
    if (existing) {
      existing.todos.push(todo);
      existing.updatedAt = Math.max(existing.updatedAt, todo.updatedAt);
      if (todo.goalLabel && todo.updatedAt >= existing.updatedAt) {
        existing.goalLabel = todo.goalLabel;
      }
    } else {
      byGoal.set(key, {
        goalId: key,
        goalLabel: todo.goalLabel,
        todos: [todo],
        updatedAt: todo.updatedAt,
      });
    }
  }
  const groups = Array.from(byGoal.values());
  for (const group of groups) {
    group.todos.sort((a, b) => a.updatedAt - b.updatedAt);
  }
  groups.sort((a, b) => b.updatedAt - a.updatedAt);
  return groups;
}

function groupByWorkspace(
  files: CommandCenterSessionActivityFileChange[],
  subagents: SessionMetadata[],
  sources: CommandCenterSessionActivitySource[],
  sessionById: ReadonlyMap<string, SessionMetadata>,
  rootWorkspaceName: string | undefined,
): WorkspaceActivityGroup[] {
  const groups = new Map<string, WorkspaceActivityGroup>();
  const ensure = (name: string) => {
    const existing = groups.get(name);
    if (existing) return existing;
    const created: WorkspaceActivityGroup = {
      name,
      files: [],
      subagents: [],
      sources: [],
      additions: 0,
      deletions: 0,
    };
    groups.set(name, created);
    return created;
  };

  for (const file of files) {
    const group = ensure(workspaceNameForSession(file.sessionId, sessionById, rootWorkspaceName));
    group.files.push(file);
    group.additions += file.additions;
    group.deletions += file.deletions;
  }
  for (const session of subagents) {
    ensure(
      workspaceDisplayName(session.workspaceName ?? rootWorkspaceName ?? "Current workspace"),
    ).subagents.push(session);
  }
  for (const source of sources) {
    ensure(workspaceNameForSession(source.sessionId, sessionById, rootWorkspaceName)).sources.push(
      source,
    );
  }

  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function agentStatus(session: SessionMetadata): AgentPresentationStatus {
  if (session.isBusy) return "running";
  return session.isActive ? "idle" : "completed";
}

function agentGroupsForStatus(
  groups: WorkspaceActivityGroup[],
  status: AgentPresentationStatus,
): WorkspaceActivityGroup[] {
  return groups
    .map((group) => ({
      ...group,
      subagents: group.subagents.filter((session) => agentStatus(session) === status),
    }))
    .filter((group) => group.subagents.length > 0);
}

function workspaceNameForSession(
  sessionId: string,
  sessionById: ReadonlyMap<string, SessionMetadata>,
  fallback: string | undefined,
): string {
  return workspaceDisplayName(
    sessionById.get(sessionId)?.workspaceName ?? fallback ?? "Current workspace",
  );
}

function evidenceSummary(title: string): string {
  const singleLine = title.slice(0, 500).replace(/\s+/g, " ").trim();
  return singleLine.length > 120 ? `${singleLine.slice(0, 117)}…` : singleLine;
}
