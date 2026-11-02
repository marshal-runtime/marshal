// src/features/workflows/WorkflowsListView.tsx
//
// Library page — cards for discovered workflows plus last-run summaries.

import type { WorkflowSummary } from "@common/workflows-contract";
import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/marshal-ui/badge";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Card } from "@/components/ui/card";

import { formatRelative, RUN_STATUS_GLYPH, RUN_STATUS_LABEL } from "./format";

interface WorkflowsListViewProps {
  onOpenWorkflow: (workflowId: string, repoPath?: string | null) => void;
}

export function WorkflowsListView({ onOpenWorkflow }: WorkflowsListViewProps) {
  const { data: workflows = [], isLoading } = useQuery<WorkflowSummary[]>({
    queryKey: ["workflows", "list"],
    queryFn: async () => {
      const api = window.workflowsAPI;
      if (!api) return [];
      const result = await api.list();
      return result.success && result.workflows ? result.workflows : [];
    },
  });

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Workflows are automatically collected from workspaces inside{" "}
          <code>.marshal/marshal-worktrees</code>. Repository definitions under{" "}
          <code>.github/marshal-workflows/</code> are discovered and run directly.
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading workflows…</p>
      ) : workflows.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 p-8 text-center">
          <div className="text-lg font-semibold">No workflows yet</div>
          <p className="max-w-md text-sm text-muted-foreground">
            Dynamic Workflows are programmatic multi-agent runs. Add a workspace containing{" "}
            <code>.github/marshal-workflows/&lt;id&gt;</code> to run repo-local workflows directly.
            Advanced local installs remain available to agents through the workflow self-tools.
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {workflows.map((wf) => (
            <WorkflowCard
              key={wf.key ?? wf.id}
              workflow={wf}
              onOpen={() => onOpenWorkflow(wf.id, wf.repoPath)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkflowCard({ workflow, onOpen }: { workflow: WorkflowSummary; onOpen: () => void }) {
  return (
    <Card className="flex flex-col gap-2 p-4 transition-colors hover:border-(--brand-border)">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <button
            type="button"
            onClick={onOpen}
            className="block min-w-0 truncate text-left text-base font-semibold hover:underline"
          >
            {workflow.displayName}
          </button>
          <div className="truncate text-xs text-muted-foreground">{workflow.id}</div>
          {workflow.projectName && (
            <div className="truncate text-xs text-muted-foreground">{workflow.projectName}</div>
          )}
        </div>
        <Badge variant="outline" className="shrink-0 uppercase">
          {workflow.source}
        </Badge>
      </div>
      {workflow.description && (
        <p className="line-clamp-2 text-sm text-muted-foreground">{workflow.description}</p>
      )}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>v{workflow.version}</span>
        {workflow.lastRun ? (
          <span>
            {RUN_STATUS_GLYPH[workflow.lastRun.status]} {RUN_STATUS_LABEL[workflow.lastRun.status]}{" "}
            · {formatRelative(workflow.lastRun.finishedAt)}
          </span>
        ) : (
          <span>Never run</span>
        )}
      </div>
      <div className="mt-1 flex justify-end gap-2">
        <Button variant="default" size="sm" onClick={onOpen}>
          Open
        </Button>
      </div>
    </Card>
  );
}
