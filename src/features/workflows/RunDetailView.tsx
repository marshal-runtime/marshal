// src/features/workflows/RunDetailView.tsx
//
// Run-detail screen — composed of the run header, permission inbox,
// renderer slot (custom or default), and event-log drawer.

import type { RunActions } from "@common/workflows-contract";
import { useCallback, useEffect, useMemo } from "react";
import { toast } from "sonner";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/marshal-ui/marshal-tabs";
import { SLOT, SlotRenderer } from "@/extensions";

import { DefaultRunRenderer } from "./DefaultRunRenderer";
import { EventLogDrawer } from "./EventLogDrawer";
import { PermissionInbox } from "./PermissionInbox";
import { RunHeader } from "./RunHeader";
import { useRunSnapshot, useRunTick } from "./useWorkflowEvents";
import { useUserWorkflowRenderer } from "./useWorkflowRenderer";
import { WorkflowCommandCenter } from "./WorkflowCommandCenter";

interface RunDetailViewProps {
  runId: string;
  /** Open a chat session in the Chat tab. */
  onOpenSessionInChat: (sessionId: string) => void;
  /** Navigate to a newly created run after retry. */
  onNavigateToRun: (runId: string) => void;
  /**
   * Report the run's parent workflow once the snapshot resolves, so the
   * panel's Back button returns to that workflow's detail page (schedule +
   * runs + command center) instead of the top-level workflows list.
   */
  onWorkflowResolved?: (
    runId: string,
    info: { workflowId: string; repoPath?: string | null },
  ) => void;
}

export function RunDetailView({
  runId,
  onOpenSessionInChat,
  onNavigateToRun,
  onWorkflowResolved,
}: RunDetailViewProps) {
  const { snapshot, recentEvents, loading, error, refresh } = useRunSnapshot(runId);
  const tick = useRunTick(runId);
  useUserWorkflowRenderer(snapshot.workflowId, snapshot.repoPath);

  // Surface the run's workflow id/repo upward once known (snapshot-derived, so
  // it works for every entry point: deep link, retry, command-center openRun).
  useEffect(() => {
    if (snapshot.workflowId) {
      onWorkflowResolved?.(runId, {
        workflowId: snapshot.workflowId,
        repoPath: snapshot.repoPath,
      });
    }
  }, [runId, snapshot.workflowId, snapshot.repoPath, onWorkflowResolved]);

  const handleCancel = useCallback(
    async (reason?: string) => {
      const api = window.workflowsAPI;
      if (!api) {
        toast.error("Workflows API unavailable");
        return;
      }
      const result = await api.cancel(runId, reason);
      if (!result.success) {
        toast.error(result.error ?? "Cancel failed");
      } else {
        void refresh();
      }
    },
    [runId, refresh],
  );

  const handleRetryFromStep = useCallback(
    async (stepId: string) => {
      const api = window.workflowsAPI;
      if (!api) {
        toast.error("Workflows API unavailable");
        return;
      }
      const result = await api.retryFromStep(runId, stepId);
      if (!result.success || !result.newRunId) {
        toast.error(result.error ?? "Retry failed");
        return;
      }
      toast.success("New run started");
      onNavigateToRun(result.newRunId);
    },
    [runId, onNavigateToRun],
  );

  const actions = useMemo<RunActions>(
    () => ({
      cancel: handleCancel,
      retryFromStep: async (stepId) => {
        const api = window.workflowsAPI;
        if (!api) throw new Error("Workflows API unavailable");
        const result = await api.retryFromStep(runId, stepId);
        if (!result.success || !result.newRunId) {
          throw new Error(result.error ?? "Retry failed");
        }
        return {
          newRunId: result.newRunId,
          runFamilyId: result.runFamilyId ?? snapshot.runFamilyId,
        };
      },
      openSubagentChat: onOpenSessionInChat,
    }),
    [handleCancel, runId, snapshot.runFamilyId, onOpenSessionInChat],
  );

  const slotCtx = useMemo(
    () => ({
      workflowId: snapshot.workflowId,
      runId,
      runSnapshot: snapshot,
      events: recentEvents,
      actions,
      artifacts: snapshot.artifacts,
    }),
    [snapshot, runId, recentEvents, actions],
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background">
      <RunHeader
        runSnapshot={snapshot}
        tick={tick}
        onCancel={handleCancel}
        onRetryFromStep={handleRetryFromStep}
      />
      <PermissionInbox runId={runId} />
      {loading && (
        <div className="border-b border-border px-6 py-2 text-sm text-muted-foreground">
          Loading run snapshot…
        </div>
      )}
      {error && (
        <div className="border-b border-border bg-(--warning-subtle) px-6 py-2 text-sm">
          {error}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <Tabs defaultValue="command-center" className="min-h-0 flex-1 gap-0">
          <div className="border-b border-border px-4 py-2">
            <TabsList variant="line" className="w-full justify-start">
              <TabsTrigger value="command-center">Command center</TabsTrigger>
              <TabsTrigger value="run">Run execution</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="command-center" className="min-h-0">
            <WorkflowCommandCenter runSnapshot={snapshot} />
          </TabsContent>
          <TabsContent value="run" className="min-h-0">
            <SlotRenderer
              slotId={SLOT.WORKFLOW_RUN_DETAIL}
              slotCtx={slotCtx}
              fallback={<DefaultRunRenderer runSnapshot={snapshot} actions={actions} />}
            />
          </TabsContent>
        </Tabs>
      </div>
      <EventLogDrawer events={recentEvents} />
    </div>
  );
}
