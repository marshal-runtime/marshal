import type { NodeActivityStatus } from "@common/marshal-ipc-contract";

import { Badge } from "@/components/marshal-ui/badge";

import { pairEntries } from "./model/pair-entries";
import { useGatewayNodeActivity } from "./useGatewayNodeActivity";

const STATUS_LABEL: Record<NodeActivityStatus, string> = {
  received: "in-flight",
  ok: "ok",
  error: "error",
};

const STATUS_CLASS: Record<NodeActivityStatus, string> = {
  received: "bg-muted text-muted-foreground",
  ok: "border bg-status-success-bg border-status-success-border text-status-success-fg",
  error: "bg-destructive/10 text-destructive",
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function GatewayNodeActivityList() {
  const { entries, loaded } = useGatewayNodeActivity();

  if (!loaded) {
    return <p className="text-sm text-muted-foreground">Loading activity...</p>;
  }

  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No activity yet. Inbound requests from the gateway will appear here as they arrive.
      </p>
    );
  }

  const pairs = pairEntries(entries);
  const ordered = pairs.slice().reverse();

  return (
    <ul className="flex flex-col gap-2">
      {ordered.map((p) => {
        const primary = p.outbound ?? p.inbound;
        if (!primary) return null;
        const status = primary.status;
        const errorMsg = p.outbound?.errorMessage ?? p.inbound?.errorMessage;
        const timeSource = p.inbound ?? primary;
        return (
          <li
            key={p.invocationId}
            className="flex flex-col gap-1 rounded-md border border-border/50 bg-card/40 px-3 py-2"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 truncate">
                <span className="font-mono text-sm">{p.command}</span>
                <Badge className={STATUS_CLASS[status]}>{STATUS_LABEL[status]}</Badge>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>{formatDuration(p.outbound?.durationMs)}</span>
                <span>{formatTime(timeSource.timestamp)}</span>
              </div>
            </div>
            {p.inbound?.paramsPreview ? (
              <pre className="overflow-x-auto rounded-sm bg-muted/50 px-2 py-1 text-xs whitespace-pre-wrap">
                {p.inbound.paramsPreview}
              </pre>
            ) : null}
            {p.outbound?.resultPreview ? (
              <pre className="overflow-x-auto rounded-sm bg-muted/50 px-2 py-1 text-xs whitespace-pre-wrap">
                {p.outbound.resultPreview}
              </pre>
            ) : null}
            {errorMsg ? <p className="text-xs text-destructive">{errorMsg}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}
