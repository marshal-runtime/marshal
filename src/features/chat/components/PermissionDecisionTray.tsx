import type { PermissionAction } from "@common/marshal-constants";

import { ShieldAlert } from "@/components/icons";
import type { PermissionCardData } from "@/types/electron";

import { PermissionCard } from "./PermissionCard";

interface PermissionDecisionTrayProps {
  requests: PermissionCardData[];
  onRespond: (requestId: string, action: PermissionAction, overridePattern?: string) => void;
}

export function PermissionDecisionTray({ requests, onRespond }: PermissionDecisionTrayProps) {
  if (requests.length === 0) return null;

  return (
    <section
      className="mx-auto w-full max-w-3xl px-4 pt-2 sm:px-6"
      aria-labelledby="permission-decision-tray-title"
      data-testid="permission-decision-tray"
    >
      <div className="rounded-2xl border border-primary/25 bg-card/95 p-2 shadow-md shadow-black/5 backdrop-blur-sm dark:shadow-black/20">
        <div className="flex items-center gap-2 px-2 py-1.5">
          <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ShieldAlert className="size-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="permission-decision-tray-title" className="text-sm font-semibold">
              Action needed
            </h2>
            <p className="text-xs text-muted-foreground" role="status" aria-live="assertive">
              {requests.length === 1
                ? "One action is waiting for your decision"
                : `${requests.length} actions are waiting for your decisions`}
            </p>
          </div>
          {requests.length > 1 && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {requests.length} queued
            </span>
          )}
        </div>
        <div
          className="max-h-[min(42vh,26rem)] divide-y divide-border/70 overflow-y-auto"
          data-testid="permission-decision-list"
        >
          {requests.map((request) => (
            <PermissionCard
              key={request.id}
              request={request}
              onRespond={onRespond}
              defaultDetailsExpanded={false}
              surface="tray"
            />
          ))}
        </div>
      </div>
    </section>
  );
}
