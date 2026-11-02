// src/features/workflows/WorkflowsPanel.tsx
//
// Top-level Workflows tab — one panel, three internal view states (list,
// workflow-detail, run-detail) selected entirely by the deep-linked nav
// state (`workflows?workflowId=` or `workflows?runId=`). No duplicate
// state — the panel re-renders whenever navigation changes the props,
// which keeps it react-compiler-friendly. Children are passed `key={runId}`
// so their hooks re-initialize cleanly when navigating between runs.

import { useCallback, useMemo, useState } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { SurfaceHeader } from "@/components/ui/surface-header";

import { PermissionInbox } from "./PermissionInbox";
import { RunDetailView } from "./RunDetailView";
import { WorkflowDetailView } from "./WorkflowDetailView";
import { WorkflowsListView } from "./WorkflowsListView";

interface WorkflowsPanelProps {
  onClose: () => void;
  initialWorkflowId?: string;
  initialRepoPath?: string | null;
  initialRunId?: string;
  /** Navigate the URL bar; the panel re-derives its view from the new state. */
  onNavigateWorkflows: (state: {
    workflowId?: string;
    repoPath?: string | null;
    runId?: string;
  }) => void;
  onOpenSessionInChat: (sessionId: string) => void;
  /** Create + open a new chat session seeded with a prompt (command-center one-click). */
  onLaunchSession?: (options: {
    title: string;
    prompt: string;
  }) => Promise<{ sessionId: string; title: string } | null>;
}

type ViewState =
  | { kind: "list" }
  | { kind: "workflow"; workflowId: string; repoPath?: string | null }
  | { kind: "run"; runId: string };

export function WorkflowsPanel({
  onClose,
  initialWorkflowId,
  initialRepoPath,
  initialRunId,
  onNavigateWorkflows,
  onOpenSessionInChat,
  onLaunchSession,
}: WorkflowsPanelProps) {
  const view = useMemo<ViewState>(() => {
    if (initialRunId) return { kind: "run", runId: initialRunId };
    if (initialWorkflowId) {
      return { kind: "workflow", workflowId: initialWorkflowId, repoPath: initialRepoPath };
    }
    return { kind: "list" };
  }, [initialRunId, initialWorkflowId, initialRepoPath]);

  const goList = useCallback(() => onNavigateWorkflows({}), [onNavigateWorkflows]);
  const goWorkflow = useCallback(
    (workflowId: string, repoPath?: string | null) => onNavigateWorkflows({ workflowId, repoPath }),
    [onNavigateWorkflows],
  );
  const goRun = useCallback(
    (runId: string) => onNavigateWorkflows({ runId }),
    [onNavigateWorkflows],
  );

  // The run view is deep-linked by runId alone; RunDetailView reports its
  // parent workflow once the snapshot resolves so Back returns to the workflow
  // detail page (not the workflows list). Keyed by runId so a stale parent from
  // a previous run is ignored until the new run resolves.
  const [runParent, setRunParent] = useState<{
    runId: string;
    workflowId: string;
    repoPath?: string | null;
  } | null>(null);
  const handleRunWorkflowResolved = useCallback(
    (runId: string, info: { workflowId: string; repoPath?: string | null }) =>
      setRunParent({ runId, ...info }),
    [],
  );

  const title = view.kind === "list" ? "Workflows" : view.kind === "workflow" ? "Workflow" : "Run";
  const headerOnBack = view.kind === "list" ? undefined : goList;

  if (view.kind === "run") {
    // Back returns to this run's workflow detail once resolved; until then
    // (or if it can't resolve) fall back to the workflows list.
    const parent = runParent && runParent.runId === view.runId ? runParent : null;
    const runBack = parent ? () => goWorkflow(parent.workflowId, parent.repoPath) : goList;
    return (
      <section
        aria-label="Workflow run"
        className="flex size-full flex-col overflow-hidden bg-card"
      >
        <SurfaceHeader title={title} onClose={onClose} onBack={runBack} />
        <RunDetailView
          key={view.runId}
          runId={view.runId}
          onOpenSessionInChat={onOpenSessionInChat}
          onNavigateToRun={goRun}
          onWorkflowResolved={handleRunWorkflowResolved}
        />
      </section>
    );
  }

  return (
    <section aria-label="Workflows" className="flex size-full flex-col overflow-hidden bg-card">
      <SurfaceHeader title={title} onClose={onClose} onBack={headerOnBack} />
      <PermissionInbox />
      <ScrollArea className="flex-1 [&_[data-slot=scroll-area-viewport]>div]:block! [&_[data-slot=scroll-area-viewport]>div]:min-w-0!">
        {view.kind === "list" && <WorkflowsListView onOpenWorkflow={goWorkflow} />}
        {view.kind === "workflow" && (
          <WorkflowDetailView
            key={`${view.repoPath ?? "global"}:${view.workflowId}`}
            workflowId={view.workflowId}
            repoPath={view.repoPath}
            onOpenRun={goRun}
            onLaunchSession={onLaunchSession}
            onBackToList={goList}
          />
        )}
      </ScrollArea>
    </section>
  );
}
