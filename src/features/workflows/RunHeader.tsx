// src/features/workflows/RunHeader.tsx
//
// Top bar of the run-detail page: status pill, elapsed gauge, cancel,
// retry-from-step menu. Renders for both default and custom renderers
// so a custom renderer can never hide cancel (C-UI §4).

import type { RunSnapshot, WorkflowRunTickEvent } from "@common/workflows-contract";
import { isTerminalStatus } from "@common/workflows-reducer";
import { AlertCircle, CheckCircle2, CircleDashed, Loader2, XCircle } from "@/components/icons";
import { useState } from "react";

import { Badge } from "@/components/marshal-ui/badge";
import { Button } from "@/components/marshal-ui/marshal-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/marshal-class-names";

import { formatDuration, RUN_STATUS_LABEL } from "./format";

interface RunHeaderProps {
  runSnapshot: RunSnapshot;
  tick: WorkflowRunTickEvent | null;
  onCancel: (reason?: string) => Promise<void>;
  onRetryFromStep: (stepId: string) => Promise<void>;
}

export function RunHeader({ runSnapshot, tick, onCancel, onRetryFromStep }: RunHeaderProps) {
  const [cancelling, setCancelling] = useState(false);

  const terminal = isTerminalStatus(runSnapshot.status);
  // Prefer the live tick if available (1Hz). Fallback: finished elapsed if
  // the run has terminated, otherwise no number (Date.now() inside render
  // would violate react-compiler purity).
  const elapsedMs: number | null =
    tick?.elapsedMs ??
    (runSnapshot.startedAt > 0 && runSnapshot.endedAt != null
      ? runSnapshot.endedAt - runSnapshot.startedAt
      : null);

  const retryableSteps = runSnapshot.steps.filter(
    (s) => s.status === "succeeded" || s.status === "failed",
  );

  return (
    <div className="flex shrink-0 items-center justify-between border-b border-border bg-card px-6 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <StatusIcon status={runSnapshot.status} />
        <Badge variant="outline" className="uppercase">
          {RUN_STATUS_LABEL[runSnapshot.status]}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {elapsedMs != null ? `${formatDuration(elapsedMs)} elapsed` : "elapsed —"}
        </span>
        {tick && (
          <span className="text-sm text-muted-foreground">
            · {tick.activeSubagents} active / {tick.queued} queued
          </span>
        )}
        <span className="truncate text-xs text-muted-foreground">Run {runSnapshot.runId}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={retryableSteps.length === 0}>
              Retry from step ▾
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-[400px] overflow-auto">
            <DropdownMenuLabel>Replay starting at…</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {retryableSteps.length === 0 && (
              <DropdownMenuItem disabled>No completed steps yet</DropdownMenuItem>
            )}
            {retryableSteps.map((step) => (
              <DropdownMenuItem key={step.id} onSelect={() => void onRetryFromStep(step.id)}>
                {step.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="destructive"
          size="sm"
          disabled={terminal || cancelling}
          onClick={async () => {
            setCancelling(true);
            try {
              await onCancel();
            } finally {
              setCancelling(false);
            }
          }}
        >
          {cancelling ? "Cancelling…" : "Cancel"}
        </Button>
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: RunSnapshot["status"] }) {
  const cls = "size-5";
  switch (status) {
    case "succeeded":
      return <CheckCircle2 className={cn(cls, "text-(--success-loud)")} aria-hidden="true" />;
    case "failed":
      return <XCircle className={cn(cls, "text-(--warning-primary)")} aria-hidden="true" />;
    case "cancelled":
      return <AlertCircle className={cn(cls, "text-muted-foreground")} aria-hidden="true" />;
    case "running":
    case "pending":
      return (
        <Loader2 className={cn(cls, "animate-spin text-(--brand-border)")} aria-hidden="true" />
      );
    case "crashed":
      return <XCircle className={cn(cls, "text-(--warning-primary)")} aria-hidden="true" />;
    default:
      return <CircleDashed className={cn(cls, "text-muted-foreground")} aria-hidden="true" />;
  }
}
