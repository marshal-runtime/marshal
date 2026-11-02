import { useState } from "react";

import {
  Check,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  CircleSlash,
  Clock,
  Loader,
  X as XIcon,
  XCircle,
} from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/marshal-ui/marshal-collapsible";
import { cn } from "@/lib/marshal-class-names";
import { TelemetryPath_History, TelemetryPath_AutomationRun } from "@/services/telemetry/schema";
import { TelemetryPath } from "@/services/telemetry/opensource";
import type { AutomationRunData } from "@/types/electron";

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 size={16} className="text-success" />;
    case "failed":
      return <XCircle size={16} className="text-(--color-danger)" />;
    case "skipped":
      // The visible "Skipped" label is rendered separately by `statusLabel`,
      // so the icon is decorative — `aria-hidden` prevents screen readers
      // from double-announcing "Skipped, Skipped".
      return <CircleSlash size={16} className="text-muted-foreground" aria-hidden="true" />;
    default:
      return <Clock size={16} className="text-(--color-info)" />;
  }
}

function statusLabel(status: string): string | null {
  switch (status) {
    case "skipped":
      return "Skipped";
    default:
      return null;
  }
}

function StepIcon({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return <Check size={14} className="text-success" />;
    case "failed":
      return <XIcon size={14} className="text-(--color-danger)" />;
    case "running":
      return <Loader size={14} className="animate-spin text-(--color-info)" />;
    case "skipped":
      return <CircleSlash size={14} className="text-muted-foreground" />;
    default:
      return <span className="text-muted-foreground">·</span>;
  }
}

const cardBorder: Record<string, string> = {
  completed: "border-l-4 border-l-(--color-success)",
  failed: "border-l-4 border-l-(--color-danger)",
  running: "border-l-4 border-l-(--color-info)",
  skipped: "border-l-4 border-l-border",
};

function RunCard({ run }: { run: AutomationRunData }) {
  const [expanded, setExpanded] = useState(false);
  const time = new Date(run.startedAt).toLocaleString();

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div
        className={`overflow-hidden rounded-xl border border-border ${cardBorder[run.status] ?? ""}`}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full cursor-pointer items-center justify-between px-3 py-2.5 text-xs text-foreground transition-colors hover:bg-muted/50"
          >
            <span className="flex items-center gap-1.5">
              <StatusIcon status={run.status} />
              {time}
              {statusLabel(run.status) && (
                <span className="ml-1 text-muted-foreground">· {statusLabel(run.status)}</span>
              )}
            </span>
            <span className="text-muted-foreground">
              <ChevronRight
                size={16}
                className={cn("transition-transform duration-200", expanded && "rotate-90")}
              />
            </span>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="flex flex-col gap-1.5 border-t border-border px-3 py-2">
            {run.stepResults.map((sr, i) => (
              <div key={sr.stepId} className="flex items-start gap-2 text-xs">
                <span className="mt-0.5 flex w-4 shrink-0 justify-center">
                  <StepIcon status={sr.status} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 font-medium text-foreground">Step {i + 1}</div>
                  {sr.output && (
                    <pre className="max-h-[150px] overflow-auto rounded-lg bg-muted p-2 text-xs wrap-break-word whitespace-pre-wrap text-muted-foreground">
                      <code>
                        {sr.output.slice(0, 500)}
                        {sr.output.length > 500 ? "..." : ""}
                      </code>
                    </pre>
                  )}
                  {sr.error && (
                    <div role="alert" className="text-sm text-(--color-danger)">
                      {sr.error}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

export interface AutomationHistoryViewProps {
  runs: AutomationRunData[];
  onBack: () => void;
}

export function AutomationHistoryView({ runs, onBack }: AutomationHistoryViewProps) {
  return (
    <TelemetryPath_History>
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeft size={16} />
          Back
        </Button>
        <h3 className="text-lg font-semibold text-foreground">Run History</h3>
        {runs.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No runs yet</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {runs.map((run, i) => (
              <TelemetryPath key={run.id} id={i}>
                <TelemetryPath_AutomationRun>
                  <RunCard run={run} />
                </TelemetryPath_AutomationRun>
              </TelemetryPath>
            ))}
          </div>
        )}
      </div>
    </TelemetryPath_History>
  );
}
