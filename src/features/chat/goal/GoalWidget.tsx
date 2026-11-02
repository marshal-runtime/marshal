import type { GoalRuntimeSnapshot, GoalStatus } from "@common/goal-contract";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  X,
} from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Collapsible, CollapsibleContent } from "@/components/marshal-ui/marshal-collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/marshal-ui/marshal-tooltip";
import { cn } from "@/lib/marshal-class-names";
import { ResizablePanelControls, ResizablePanelHandle } from "@/shared/components/ResizablePanel";
import { useInterval } from "@/shared/hooks/timing/useInterval";
import { useResizablePanel, useViewportSize } from "@/shared/hooks/useResizablePanel";

import { ConfirmStopGoalDialog } from "./ConfirmStopGoalDialog";
import {
  formatCompactElapsed,
  formatElapsed,
  formatTokenCount,
  humanizeDuration,
  truncateObjective,
} from "./format";
import { getGoalSnapshotView } from "./snapshotView";
import {
  type GoalMutationVariables,
  type GoalMutationInput,
  requireGoalFence,
  useGoalMutation,
  useGoalState,
} from "./useGoalState";

const GOAL_STATUS_LABEL = {
  pursuing: "Pursuing goal",
  paused: "Paused",
  blocked: "Blocked",
  completed: "Completed",
  stopped: "Stopped",
} satisfies Record<GoalStatus, string>;

function StatusIcon({ status }: { status: GoalStatus }) {
  switch (status) {
    case "pursuing":
      return <RefreshCw size={14} className="shrink-0 animate-spin text-muted-foreground" />;
    case "paused":
      return <Pause size={14} className="shrink-0 text-muted-foreground" />;
    case "blocked":
      return <AlertTriangle size={14} className="shrink-0 text-warning-primary" />;
    case "completed":
      return <CheckCircle2 size={14} className="shrink-0 text-success" />;
    case "stopped":
      return <AlertTriangle size={14} className="shrink-0 text-muted-foreground" />;
  }
  return null;
}

const GOAL_PANEL_STORAGE_KEY = "marshal.panel.goal.max-height";
const DEFAULT_GOAL_PANEL_HEIGHT = 320;
const MIN_GOAL_PANEL_HEIGHT = 160;
const GOAL_PANEL_VIEWPORT_INSET = 96;
const GOAL_PANEL_HEADER_HEIGHT = 40;

function sameStringList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function TextList({ label, values, testId }: { label: string; values: string[]; testId: string }) {
  if (values.length === 0) return null;
  return (
    <div data-testid={testId}>
      <span className="font-medium text-foreground">{label}:</span>
      <ul className="ml-4 list-disc space-y-0.5">
        {values.map((value, index) => (
          // eslint-disable-next-line react/no-array-index-key -- bounded text lists have no item IDs
          <li key={index}>{value}</li>
        ))}
      </ul>
    </div>
  );
}

export function GoalWidget({ sessionId }: { sessionId: string }) {
  const snapshot = useGoalState(sessionId);
  const mutation = useGoalMutation(sessionId);
  const viewportSize = useViewportSize();
  const normalMaxHeight = Math.max(0, Math.floor(viewportSize.height * 0.5));
  const goalPanel = useResizablePanel({
    storageKey: GOAL_PANEL_STORAGE_KEY,
    axis: "vertical",
    defaultSize: DEFAULT_GOAL_PANEL_HEIGHT,
    minSize: Math.min(MIN_GOAL_PANEL_HEIGHT, normalMaxHeight),
    maxSize: normalMaxHeight,
    expandedSize: Math.max(MIN_GOAL_PANEL_HEIGHT, viewportSize.height - GOAL_PANEL_VIEWPORT_INSET),
    initialMode: "collapsed",
    growDirection: "negative",
  });
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [editCriteria, setEditCriteria] = useState<string[]>([]);
  const [steerText, setSteerText] = useState("");
  const [stopOpen, setStopOpen] = useState(false);
  const [, setTick] = useState(0);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const view = snapshot?.goal ? getGoalSnapshotView(snapshot) : null;

  useInterval(() => setTick((tick) => tick + 1), view?.lifecycle === "pursuing" ? 1000 : null);

  useEffect(() => {
    if (editing) {
      editRef.current?.focus();
      editRef.current?.select();
    }
  }, [editing]);

  if (snapshot?.recovery && !snapshot.goal) {
    return (
      <div
        className="relative mb-1 flex items-start gap-2 rounded-[12px] border border-border bg-card px-3 py-2 text-xs text-foreground shadow-sm"
        data-testid="goal-recovery-notice"
      >
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning-primary" />
        <div className="min-w-0">
          <span className="font-medium text-warning-primary">Saved goal couldn't be read.</span>{" "}
          <span className="text-muted-foreground">
            A copy is preserved in this conversation's session file and nothing was resumed
            automatically. Type <code className="text-foreground">/goal &lt;objective&gt;</code> in
            the message box to set a new goal.
          </span>
        </div>
      </div>
    );
  }

  if (!snapshot || !view) return null;

  const runAction = async (
    variables: GoalMutationInput,
    current: GoalRuntimeSnapshot = snapshot,
  ): Promise<GoalRuntimeSnapshot | null> => {
    try {
      return await mutation.mutateAsync({
        ...variables,
        expectedFence: requireGoalFence(current),
      } as GoalMutationVariables);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Goal action failed");
      return null;
    }
  };

  const startEdit = () => {
    setEditText(view.objective);
    setEditCriteria([...view.criteria]);
    goalPanel.expand();
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditText("");
    setEditCriteria([]);
  };

  const saveEdit = async () => {
    const objective = editText.trim();
    if (!objective) {
      toast.error("Objective can't be empty");
      return;
    }
    const criteria = editCriteria.map((item) => item.trim()).filter(Boolean);
    if (objective === view.objective && sameStringList(criteria, view.criteria)) {
      cancelEdit();
      return;
    }
    const updated = await runAction({
      method: "updateDefinition",
      patch: { objective, criteria },
    });
    if (updated) cancelEdit();
  };

  const status = view.lifecycle;
  const elapsedMs = formatElapsed(view);
  const terminal = status === "completed" || status === "stopped";
  const canResume = status === "paused" || status === "blocked";
  const pendingMethod = mutation.isPending ? mutation.variables?.method : null;

  return (
    <Collapsible
      open={!goalPanel.isCollapsed}
      className="relative mb-1 flex flex-col overflow-hidden rounded-[12px] border border-border bg-card text-xs text-foreground shadow-sm"
      style={goalPanel.isCollapsed ? undefined : { maxHeight: goalPanel.size }}
      data-testid="goal-widget"
      data-status={status}
      data-panel-mode={goalPanel.mode}
    >
      <ResizablePanelHandle
        controller={goalPanel}
        label="Resize goal panel"
        testId="goal-panel-resize"
      />
      <div className="flex items-center gap-2 px-3 py-2">
        <StatusIcon status={status} />
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span
            className={cn(
              "shrink-0 font-medium",
              status === "blocked" && "text-warning-primary",
              status === "completed" && "text-success",
            )}
            data-testid="goal-status-label"
          >
            {editing ? "Editing goal" : GOAL_STATUS_LABEL[status]}
          </span>
          <span className="min-w-0 truncate text-muted-foreground" data-testid="goal-objective">
            {truncateObjective(view.objective)}
          </span>
          {!editing && (
            <span className="shrink-0 text-muted-foreground" data-testid="goal-elapsed">
              · {formatCompactElapsed(elapsedMs)}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {!editing && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={startEdit}
                    disabled={terminal}
                    aria-label="Edit goal"
                    data-testid="goal-edit"
                  >
                    <Pencil size={13} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" hideArrow>
                  Edit goal
                </TooltipContent>
              </Tooltip>
              {!terminal &&
                (canResume ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => void runAction({ method: "resume" })}
                    disabled={pendingMethod === "resume"}
                    aria-label="Resume goal"
                    data-testid="goal-resume"
                  >
                    <Play size={13} />
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => void runAction({ method: "pause" })}
                    disabled={pendingMethod === "pause"}
                    aria-label="Pause goal"
                    data-testid="goal-pause"
                  >
                    <Pause size={13} />
                  </Button>
                ))}
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setStopOpen(true)}
                disabled={terminal}
                aria-label="Stop goal"
                data-testid="goal-stop"
              >
                <Trash2 size={13} />
              </Button>
            </>
          )}
          <ResizablePanelControls
            controller={goalPanel}
            showLabel="Show goal details"
            expandLabel="Expand goal panel across chat"
            restoreLabel="Restore goal panel size"
            collapseLabel="Fold goal details"
            showIcon={<ChevronRight size={13} />}
            collapseIcon={<ChevronDown size={13} />}
            canCollapse={!editing}
            testIds={{
              show: "goal-expand",
              expand: "goal-maximize",
              restore: "goal-restore",
              collapse: "goal-collapse",
            }}
          />
        </div>
      </div>

      <CollapsibleContent className="min-h-0 overflow-hidden">
        <div
          className="flex flex-col gap-2 overflow-y-auto overscroll-contain border-t border-border/50 px-3 py-2 text-muted-foreground"
          style={{ maxHeight: Math.max(0, goalPanel.size - GOAL_PANEL_HEADER_HEIGHT) }}
          data-testid="goal-scroll"
        >
          {editing ? (
            <div className="flex flex-col gap-2" data-testid="goal-editor">
              <label className="font-medium text-foreground" htmlFor="goal-edit-objective">
                Objective
              </label>
              <textarea
                ref={editRef}
                id="goal-edit-objective"
                value={editText}
                onChange={(event) => setEditText(event.target.value)}
                rows={3}
                className="w-full resize-y rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus-visible:border-ring"
                data-testid="goal-edit-input"
              />
              <span className="font-medium text-foreground">Criteria</span>
              {editCriteria.map((criterion, index) => (
                // eslint-disable-next-line react/no-array-index-key -- positional editor rows
                <div key={index} className="flex items-center gap-1">
                  <input
                    value={criterion}
                    onChange={(event) =>
                      setEditCriteria((items) =>
                        items.map((item, itemIndex) =>
                          itemIndex === index ? event.target.value : item,
                        ),
                      )
                    }
                    className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus-visible:border-ring"
                    aria-label={`Criterion ${index + 1}`}
                  />
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() =>
                      setEditCriteria((items) =>
                        items.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                    aria-label="Remove criterion"
                  >
                    <X size={13} />
                  </Button>
                </div>
              ))}
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() => setEditCriteria((items) => [...items, ""])}
                data-testid="goal-edit-add-criterion"
              >
                <Plus size={13} /> Add criterion
              </Button>
              <div className="flex justify-end gap-1">
                <Button variant="outline" size="sm" onClick={cancelEdit}>
                  <X size={13} /> Cancel
                </Button>
                <Button size="sm" onClick={() => void saveEdit()} disabled={mutation.isPending}>
                  <Check size={13} /> Save
                </Button>
              </div>
            </div>
          ) : (
            <>
              <p className="wrap-break-word whitespace-pre-wrap text-foreground">
                {view.objective}
              </p>
              <TextList label="Criteria" values={view.criteria} testId="goal-criteria" />
              <TextList label="Progress" values={view.progress} testId="goal-progress" />
              <TextList label="Open questions" values={view.questions} testId="goal-questions" />
              <TextList label="Assumptions" values={view.assumptions} testId="goal-assumptions" />
              <TextList label="Decisions" values={view.decisions} testId="goal-decisions" />
              {view.stateJson && (
                <div data-testid="goal-state">
                  <span className="font-medium text-foreground">State:</span>
                  <pre className="mt-1 overflow-x-auto rounded-sm bg-muted/50 p-2 text-[0.7rem] whitespace-pre-wrap">
                    {view.stateJson}
                  </pre>
                </div>
              )}
              {status === "blocked" && (
                <p className="text-warning-primary" data-testid="goal-blocked-reason">
                  {view.blockedReason ?? "Blocked"}
                </p>
              )}
              {!terminal && (
                <div className="flex items-end gap-1" data-testid="goal-steer">
                  <textarea
                    value={steerText}
                    onChange={(event) => setSteerText(event.target.value)}
                    rows={2}
                    placeholder="Steer this goal"
                    className="min-w-0 flex-1 resize-y rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus-visible:border-ring"
                    aria-label="Steer goal"
                  />
                  <Button
                    size="icon-sm"
                    disabled={!steerText.trim() || pendingMethod === "steer"}
                    onClick={() => {
                      const instruction = steerText.trim();
                      if (!instruction) return;
                      void runAction({ method: "steer", instruction }).then((updated) => {
                        if (updated) setSteerText("");
                      });
                    }}
                    aria-label="Apply goal steering"
                  >
                    <Send size={13} />
                  </Button>
                </div>
              )}
              <p className="text-[0.7rem]" data-testid="goal-stats">
                {formatTokenCount(view.tokensUsed)} tokens · {view.continuationCount} turns · about{" "}
                {humanizeDuration(view.activeMs)}
              </p>
            </>
          )}
        </div>
      </CollapsibleContent>

      <ConfirmStopGoalDialog
        open={stopOpen}
        onOpenChange={setStopOpen}
        objective={view.objective}
        onConfirm={() => {
          setStopOpen(false);
          void runAction({ method: "stop" });
        }}
      />
    </Collapsible>
  );
}
