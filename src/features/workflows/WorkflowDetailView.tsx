// src/features/workflows/WorkflowDetailView.tsx
//
// Per-workflow detail page: header, run history, "New run" → SchemaForm.

import type { RunHistoryEntry, WorkflowSummary } from "@common/workflows-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, ChevronDown, Play } from "@/components/icons";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/marshal-ui/badge";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/marshal-ui/marshal-collapsible";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/marshal-ui/input";
import { Label } from "@/components/marshal-ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/marshal-ui/textarea";
import { SLOT, SlotRenderer } from "@/extensions";
import { cn } from "@/lib/marshal-class-names";

import { formatRelative, RUN_STATUS_GLYPH, RUN_STATUS_LABEL } from "./format";
import { SchemaForm } from "./SchemaForm";
import { useWorkflowCommandCenter } from "./useWorkflowCommandCenter";

interface WorkflowDetailViewProps {
  workflowId: string;
  repoPath?: string | null;
  onOpenRun: (runId: string) => void;
  onLaunchSession?: (options: {
    title: string;
    prompt: string;
  }) => Promise<{ sessionId: string; title: string } | null>;
  onBackToList: () => void;
}

export function WorkflowDetailView({
  workflowId,
  repoPath,
  onOpenRun,
  onLaunchSession,
  onBackToList,
}: WorkflowDetailViewProps) {
  const queryClient = useQueryClient();
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [scheduleText, setScheduleText] = useState("");
  const [scheduleInputText, setScheduleInputText] = useState("{}");
  const [commandCenterOpen, setCommandCenterOpen] = useState(true);

  // Load the workflow's optional custom command-center renderer. When present
  // it registers into the WORKFLOW_DETAIL_COMMAND_CENTER slot and we surface
  // the expandable section below; when absent the section stays hidden.
  const hasCommandCenter = useWorkflowCommandCenter(workflowId, repoPath);

  const { data: workflows = [] } = useQuery<WorkflowSummary[]>({
    queryKey: ["workflows", "list", repoPath],
    queryFn: async () => {
      const api = window.workflowsAPI;
      if (!api) return [];
      const result = await api.list(repoPath);
      return result.success && result.workflows ? result.workflows : [];
    },
  });
  const workflow = workflows.find(
    (w) => w.id === workflowId && (repoPath ? w.repoPath === repoPath : !w.repoPath),
  );

  const { data: runs = [] } = useQuery<RunHistoryEntry[]>({
    queryKey: ["workflows", "runs", workflowId, repoPath],
    queryFn: async () => {
      const api = window.workflowsAPI;
      if (!api) return [];
      const result = await api.listRuns(workflowId, repoPath);
      return result.success && result.runs ? result.runs : [];
    },
  });

  const runMutation = useMutation({
    mutationFn: async (input: unknown) => {
      const api = window.workflowsAPI;
      if (!api) throw new Error("Workflows API unavailable");
      const result = await api.run(workflowId, input, repoPath);
      if (!result.success || !result.runId) {
        throw new Error(result.error ?? "Run failed to start");
      }
      return result.runId;
    },
    onSuccess: async (runId) => {
      setRunDialogOpen(false);
      toast.success("Run started");
      await queryClient.invalidateQueries({
        queryKey: ["workflows", "runs", workflowId, repoPath],
      });
      onOpenRun(runId);
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Run failed");
    },
  });

  const scheduleMutation = useMutation({
    mutationFn: async () => {
      const api = window.workflowsAPI;
      if (!api) throw new Error("Workflows API unavailable");
      let input: unknown = undefined;
      if (scheduleInputText.trim()) {
        try {
          input = JSON.parse(scheduleInputText);
        } catch {
          throw new Error("Scheduled input must be valid JSON");
        }
      }
      const result = await api.updateSchedule(workflowId, scheduleText.trim(), input, repoPath);
      if (!result.success) throw new Error(result.error ?? "Schedule update failed");
      return result.schedule;
    },
    onSuccess: async () => {
      setScheduleDialogOpen(false);
      toast.success("Schedule saved");
      await queryClient.invalidateQueries({ queryKey: ["workflows", "list", repoPath] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Schedule update failed");
    },
  });

  const disableScheduleMutation = useMutation({
    mutationFn: async () => {
      const api = window.workflowsAPI;
      if (!api) throw new Error("Workflows API unavailable");
      const result = await api.disableSchedule(workflowId, repoPath);
      if (!result.success) throw new Error(result.error ?? "Disable schedule failed");
    },
    onSuccess: async () => {
      toast.success("Schedule disabled");
      await queryClient.invalidateQueries({ queryKey: ["workflows", "list", repoPath] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Disable schedule failed");
    },
  });

  if (!workflow) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <p className="text-sm text-muted-foreground">
          {repoPath ? (
            <>
              Workflow <code>{workflowId}</code> was not found in this repository's{" "}
              <code>.github/marshal-workflows</code> folder.
            </>
          ) : (
            <>
              Workflow <code>{workflowId}</code> was not found in the current workflow list.
            </>
          )}
        </p>
        <div>
          <Button variant="outline" size="sm" onClick={onBackToList}>
            Back to workflows
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-xl font-semibold">{workflow.displayName}</h2>
            <p className="truncate text-xs text-muted-foreground">{workflow.id}</p>
            {workflow.projectName && (
              <p className="truncate text-xs text-muted-foreground">{workflow.projectName}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="outline" className="uppercase">
              {workflow.source}
            </Badge>
            <Badge variant="outline">v{workflow.version}</Badge>
          </div>
        </div>
        {workflow.description && (
          <p className="text-sm text-muted-foreground">{workflow.description}</p>
        )}
        <div className="flex justify-end">
          <Button onClick={() => setRunDialogOpen(true)}>
            <Play className="mr-2 size-4" />
            New run
          </Button>
        </div>
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-sm font-semibold tracking-wide text-muted-foreground uppercase">
              <CalendarClock className="size-4" /> Schedule
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {workflow.schedule?.enabled
                ? `Enabled: ${workflow.schedule.naturalLanguage}`
                : workflow.defaultSchedule
                  ? `Disabled. Default: ${workflow.defaultSchedule}`
                  : "Disabled. No schedule configured."}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {workflow.schedule?.enabled && workflow.schedule.nextRunAt
                ? `Next run ${formatRelative(workflow.schedule.nextRunAt)}`
                : "Use plain language such as “every weekday at 9am” or “every hour at :15”."}
            </p>
            {workflow.schedule?.lastRunId && (
              <p className="mt-1 truncate text-xs text-muted-foreground">
                Last scheduled run {workflow.schedule.lastRunId}
              </p>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            {workflow.schedule?.enabled && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => disableScheduleMutation.mutate()}
                disabled={disableScheduleMutation.isPending}
              >
                Disable
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setScheduleText(
                  workflow.schedule?.naturalLanguage ??
                    workflow.defaultSchedule ??
                    "every day at 9am",
                );
                setScheduleInputText(JSON.stringify(workflow.schedule?.input ?? {}, null, 2));
                setScheduleDialogOpen(true);
              }}
            >
              Edit schedule
            </Button>
          </div>
        </div>
      </Card>

      <Card className="flex flex-col gap-2 p-4">
        <h3 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
          Recent runs
        </h3>
        <ScrollArea className="max-h-[420px]">
          {runs.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {runs.map((run) => (
                <li key={run.runId}>
                  <button
                    type="button"
                    onClick={() => onOpenRun(run.runId)}
                    className="flex w-full items-center justify-between gap-3 p-2 text-left text-sm hover:bg-muted"
                  >
                    <span className="font-mono">
                      {RUN_STATUS_GLYPH[run.status]} {RUN_STATUS_LABEL[run.status]}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {run.runId}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatRelative(run.finishedAt ?? run.startedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </Card>

      {hasCommandCenter && (
        <Collapsible open={commandCenterOpen} onOpenChange={setCommandCenterOpen}>
          <Card className="flex flex-col gap-3 p-4">
            <CollapsibleTrigger className="flex items-center justify-between gap-3 text-left">
              <h3 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
                Command center
              </h3>
              <ChevronDown
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform",
                  commandCenterOpen && "rotate-180",
                )}
              />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SlotRenderer
                slotId={SLOT.WORKFLOW_DETAIL_COMMAND_CENTER}
                slotCtx={{ workflowId, repoPath, runs, onOpenRun, onLaunchSession }}
                fallback={null}
              />
            </CollapsibleContent>
          </Card>
        </Collapsible>
      )}

      <Dialog open={runDialogOpen} onOpenChange={setRunDialogOpen}>
        <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Start {workflow.displayName}</DialogTitle>
          </DialogHeader>
          {workflow.inputSchema ? (
            <SchemaForm
              schema={workflow.inputSchema}
              onSubmit={(input) => runMutation.mutate(input)}
              onCancel={() => setRunDialogOpen(false)}
              submitting={runMutation.isPending}
              submitLabel="Start run"
            />
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">This workflow takes no input.</p>
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => setRunDialogOpen(false)}
                  disabled={runMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => runMutation.mutate(undefined)}
                  disabled={runMutation.isPending}
                >
                  Start run
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={scheduleDialogOpen} onOpenChange={setScheduleDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Schedule {workflow.displayName}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="workflow-schedule">Schedule</Label>
              <Input
                id="workflow-schedule"
                value={scheduleText}
                onChange={(event) => setScheduleText(event.target.value)}
                placeholder="every weekday at 9am"
              />
              <p className="text-xs text-muted-foreground">
                Use plain language. Examples: daily at 8:30am, every weekday at 9am,
                every hour at :15, or every day at 9am, 2pm, and 6pm.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="workflow-schedule-input">Input JSON</Label>
              <Textarea
                id="workflow-schedule-input"
                className="min-h-36 font-mono text-xs"
                value={scheduleInputText}
                onChange={(event) => setScheduleInputText(event.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => setScheduleDialogOpen(false)}
                disabled={scheduleMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                onClick={() => scheduleMutation.mutate()}
                disabled={scheduleMutation.isPending || !scheduleText.trim()}
              >
                Save schedule
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
