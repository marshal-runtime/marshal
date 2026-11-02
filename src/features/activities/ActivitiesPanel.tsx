import { useState, useMemo } from "react";

import { Badge } from "@/components/marshal-ui/badge";
import { SurfaceHeader } from "@/components/ui/surface-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/marshal-ui/marshal-tabs";
import { CommandCenterContent } from "@/features/command-center/CommandCenterPanel";
import { MarkdownRenderer } from "@/plugins/streamdown-config";
import { getNextOccurrence } from "@/runtime-ui/automations/next-occurrence";
import { useTimeout } from "@/runtime-ui/hooks/use-timeout";
import { TelemetryPath } from "@/services/telemetry/opensource";
import {
  TelemetryPath_Activities,
  TelemetryPath_Activity,
  NonInteractiveElementMonitor_UpcomingItem,
  NonInteractiveElementMonitor_HistoryItem,
} from "@/services/telemetry/schema";

import { useActivitiesPanelData } from "./useActivitiesPanelData";

interface ActivitiesPanelProps {
  isOpen: boolean;
  onClose?: () => void;
  initialTab?: "upcoming" | "history" | "command-center";
  onSessionSelect?: (sessionId: string) => void | Promise<void>;
  onOpenCommandCenterSession?: (sessionId: string) => void;
  onOpenAutomations?: (automationName?: string) => void;
  onOpenHeartbeat?: () => void;
}

interface HistoryEntry {
  id: string;
  type: "heartbeat" | "automation";
  name: string;
  status: string;
  startedAt: Date;
  summary?: string;
  sessionId?: string;
}

interface UpcomingEntry {
  type: "heartbeat" | "automation";
  name: string;
  nextRun: Date | null;
  scheduleLabel: string;
  enabled: boolean;
  oneShot?: boolean;
  triggerType?: "schedule" | "condition";
  condition?: string;
  lastError?: string | null;
}

function parseTimestamp(ts: string): Date {
  // Format: "YYYY-MM-DD HH:MM:SS" from heartbeat, or ISO string from automations
  const d = new Date(ts.includes("T") ? ts : ts.replace(" ", "T"));
  return isNaN(d.getTime()) ? new Date(0) : d;
}

function formatRelative(date: Date): string {
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  const past = diff < 0;
  if (abs < 60_000) return past ? "just now" : "in a moment";
  if (abs < 3_600_000) {
    const m = Math.round(abs / 60_000);
    return past ? `${m}m ago` : `in ${m}m`;
  }
  if (abs < 86_400_000) {
    const h = Math.round(abs / 3_600_000);
    return past ? `${h}h ago` : `in ${h}h`;
  }
  const d = Math.round(abs / 86_400_000);
  return past ? `${d}d ago` : `in ${d}d`;
}

function formatAbsolute(date: Date): string {
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return `Today, ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" }) + `, ${time}`;
}

const STATUS_ICON: Record<string, string> = {
  ok: "\u2713",
  complete: "\u2713",
  completed: "\u2713",
  urgent: "\u26A0",
  error: "\u2715",
  failed: "\u2715",
  running: "\u23F3",
  // Gateway-mode automation runs that marshal skipped (empty systemEvent
  // text, policy-rejected, etc.). AutomationRunData.status was widened
  // with "skipped" in this PR; without an explicit mapping the badge
  // falls through to the generic `\u00B7` fallback and looks like a
  // rendering bug.
  skipped: "\u2298",
  skip: "\u2013",
};

const STATUS_CLASS: Record<string, string> = {
  ok: "success",
  complete: "success",
  completed: "success",
  urgent: "warning",
  error: "danger",
  failed: "danger",
  running: "info",
  skipped: "muted",
  skip: "muted",
};

function statusBadgeClasses(status: string): string {
  const category = STATUS_CLASS[status];
  switch (category) {
    case "success":
      return "border bg-status-success-bg border-status-success-border text-status-success-fg";
    case "warning":
      return "border border-warning-border-light bg-status-warning-bg text-status-warning-fg";
    case "danger":
      return "border bg-destructive/10 border-destructive/30 text-destructive";
    case "info":
    case "muted":
    default:
      return "border bg-muted border-border text-muted-foreground";
  }
}

export function ActivitiesPanel({
  isOpen,
  onClose,
  initialTab = "upcoming",
  onSessionSelect,
  onOpenCommandCenterSession,
  onOpenAutomations,
  onOpenHeartbeat,
}: ActivitiesPanelProps) {
  const [sessionNotFound, setSessionNotFound] = useState(false);
  const {
    now,
    heartbeatStatus,
    heartbeatSettings,
    heartbeatLogs,
    automations,
    allAutomationRuns,
    conditionStatuses,
  } = useActivitiesPanelData(isOpen);

  // Build history entries from heartbeat logs and automation run history
  const historyEntries = useMemo(() => {
    const entries: HistoryEntry[] = [];

    // Heartbeat: show terminal result entries (ok, urgent, error) — omit start/skip/complete
    heartbeatLogs
      .filter((l) => ["ok", "urgent", "error"].includes(l.type))
      .forEach((l, i) => {
        entries.push({
          id: `hb-${i}`,
          type: "heartbeat",
          name: "Heartbeat",
          status: l.type,
          startedAt: parseTimestamp(l.timestamp),
          summary: l.message,
        });
      });

    // Automation runs — use stored automationName so history survives automation deletion
    allAutomationRuns.forEach((run) => {
      const name =
        run.automationName ??
        automations.find((wf) => wf.id === run.automationId)?.name ??
        "Deleted automation";
      entries.push({
        id: `wf-${run.id}`,
        type: "automation",
        name,
        status: run.status,
        startedAt: new Date(run.startedAt),
        summary: run.finalOutput ? run.finalOutput.slice(0, 500) : undefined,
        sessionId: run.sessionId,
      });
    });

    entries.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    return entries;
  }, [heartbeatLogs, allAutomationRuns, automations]);

  // Build upcoming entries
  const upcomingEntries = useMemo(() => {
    const entries: UpcomingEntry[] = [];

    // Heartbeat: compute approx next run from lastRun + interval, or now + interval
    if (heartbeatSettings && heartbeatStatus?.enabled) {
      const intervalMs = heartbeatSettings.intervalMinutes * 60_000;
      let nextRun: Date | null = null;
      if (heartbeatStatus.lastRun) {
        const lastRunDate = parseTimestamp(heartbeatStatus.lastRun);
        const candidate = new Date(lastRunDate.getTime() + intervalMs);
        nextRun = candidate > new Date(now) ? candidate : new Date(now + intervalMs);
      } else {
        nextRun = new Date(now + intervalMs);
      }
      const scheduleLabel =
        heartbeatSettings.schedule === "work-hours"
          ? `Every ${heartbeatSettings.intervalMinutes}m \u00B7 work hours`
          : `Every ${heartbeatSettings.intervalMinutes}m`;
      entries.push({
        type: "heartbeat",
        name: "Heartbeat",
        nextRun,
        scheduleLabel,
        enabled: true,
      });
    } else if (heartbeatSettings && !heartbeatStatus?.enabled) {
      entries.push({
        type: "heartbeat",
        name: "Heartbeat",
        nextRun: null,
        scheduleLabel: "Disabled",
        enabled: false,
      });
    }

    // Automations — skip one-shot automations that have already run (disabled after completion)
    automations.forEach((wf) => {
      if (wf.oneShot && !wf.enabled) return;
      const isCondition = wf.triggerType === "condition";
      let nextRun: Date | null = null;
      let lastError: string | null = null;
      if (isCondition && wf.enabled) {
        const status = conditionStatuses.get(wf.id);
        if (status?.nextCheck) {
          nextRun = new Date(status.nextCheck);
        }
        lastError = status?.lastError ?? null;
      } else if (!isCondition && wf.enabled) {
        nextRun = getNextOccurrence(wf.schedule);
      }
      entries.push({
        type: "automation",
        name: wf.name,
        nextRun,
        scheduleLabel: isCondition
          ? `\uD83D\uDC41 ${wf.condition || "Condition"} \u00B7 every ${wf.conditionCheckInterval ?? 15}m`
          : wf.schedule.naturalLanguage || "Scheduled",
        enabled: wf.enabled,
        oneShot: wf.oneShot,
        triggerType: wf.triggerType,
        condition: wf.condition,
        lastError,
      });
    });

    // Sort enabled ones with next runs first, then disabled
    entries.sort((a, b) => {
      if (!a.enabled && b.enabled) return 1;
      if (a.enabled && !b.enabled) return -1;
      if (!a.nextRun && !b.nextRun) return 0;
      if (!a.nextRun) return 1;
      if (!b.nextRun) return -1;
      return a.nextRun.getTime() - b.nextRun.getTime();
    });

    return entries;
  }, [heartbeatSettings, heartbeatStatus, automations, now, conditionStatuses]);

  useTimeout(() => setSessionNotFound(false), sessionNotFound ? 3000 : null);

  const handleRunClick = async (sessionId: string) => {
    if (!window.sessionsAPI || !onSessionSelect) return;
    const result = await window.sessionsAPI.get(sessionId, { messageLimit: 0 });
    if (result.success && result.session) {
      await onSessionSelect(sessionId);
    } else {
      setSessionNotFound(true);
    }
  };

  if (!isOpen) return null;

  return (
    <TelemetryPath_Activities>
      <div className="flex size-full flex-col overflow-clip" data-testid="activities-panel">
        <SurfaceHeader title="Activity" onClose={onClose} />

        <Tabs key={initialTab} defaultValue={initialTab} className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 overflow-auto bg-card">
            <div className="px-6 pt-4 pb-2">
              <TabsList className="h-auto gap-1 bg-transparent p-0">
                <TabsTrigger
                  value="upcoming"
                  className="rounded-xl bg-transparent px-2.5 py-1.5 text-foreground hover:bg-accent data-active:bg-primary data-active:text-primary-foreground data-active:hover:bg-primary data-active:hover:text-primary-foreground"
                >
                  Upcoming
                </TabsTrigger>
                <TabsTrigger
                  value="history"
                  className="rounded-xl bg-transparent px-2.5 py-1.5 text-foreground hover:bg-accent data-active:bg-primary data-active:text-primary-foreground data-active:hover:bg-primary data-active:hover:text-primary-foreground"
                >
                  History
                </TabsTrigger>
                <TabsTrigger
                  value="command-center"
                  className="rounded-xl bg-transparent px-2.5 py-1.5 text-foreground hover:bg-accent data-active:bg-primary data-active:text-primary-foreground data-active:hover:bg-primary data-active:hover:text-primary-foreground"
                >
                  Command Center
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="upcoming">
              <div className="px-6 pb-6">
                {upcomingEntries.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No automations configured yet
                  </p>
                ) : (
                  <ul className="overflow-hidden rounded-2xl border border-border" role="list">
                    {upcomingEntries.map((entry, i) => {
                      const navigable =
                        (entry.type === "automation" && !!onOpenAutomations) ||
                        (entry.type === "heartbeat" && !!onOpenHeartbeat);
                      const handleClick =
                        entry.type === "automation" && onOpenAutomations
                          ? () => onOpenAutomations(entry.name)
                          : entry.type === "heartbeat" && onOpenHeartbeat
                            ? () => onOpenHeartbeat()
                            : undefined;

                      const content = (
                        <>
                          <span className="mt-0.5 shrink-0 text-lg leading-none">
                            {entry.type === "heartbeat"
                              ? "\uD83D\uDC9A"
                              : entry.triggerType === "condition"
                                ? "\uD83D\uDC41"
                                : "\uD83D\uDD04"}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-base font-semibold text-foreground">
                                {entry.name}
                              </span>
                              {entry.oneShot && (
                                <Badge variant="outline" className="text-[10px]">
                                  one-time
                                </Badge>
                              )}
                            </div>
                            {!entry.oneShot && (
                              <p className="mt-0.5 text-sm text-muted-foreground">
                                {entry.scheduleLabel}
                              </p>
                            )}
                            {entry.lastError && (
                              <p className="mt-0.5 truncate text-sm text-destructive">
                                Last check failed: {entry.lastError}
                              </p>
                            )}
                            {entry.nextRun && (
                              <p className="mt-0.5 text-sm text-muted-foreground">
                                {formatAbsolute(entry.nextRun)}
                              </p>
                            )}
                          </div>
                          {entry.nextRun && entry.enabled && (
                            <span className="mt-0.5 shrink-0 text-sm text-muted-foreground">
                              {entry.triggerType === "condition"
                                ? `check ${formatRelative(entry.nextRun)}`
                                : formatRelative(entry.nextRun)}
                            </span>
                          )}
                          {!entry.enabled && (
                            <span className="mt-0.5 shrink-0 text-sm text-muted-foreground">
                              off
                            </span>
                          )}
                        </>
                      );

                      return (
                        <TelemetryPath key={`${entry.type}-${entry.name}`} id={i}>
                          <TelemetryPath_Activity>
                            <NonInteractiveElementMonitor_UpcomingItem>
                              <li
                                data-testid="activity-item"
                                className={`flex gap-4 border-b border-border px-4 py-3 last:border-b-0 ${!entry.enabled ? "opacity-50" : ""} ${navigable ? "cursor-pointer hover:bg-accent focus-visible:bg-accent focus-visible:outline-none" : ""}`}
                                onClick={handleClick}
                                onKeyDown={
                                  navigable
                                    ? (e) => {
                                        if (e.key === "Enter" || e.key === " ") {
                                          e.preventDefault();
                                          handleClick?.();
                                        }
                                      }
                                    : undefined
                                }
                                tabIndex={navigable ? 0 : undefined}
                                role={navigable ? "button" : undefined}
                                title={
                                  navigable
                                    ? entry.type === "automation"
                                      ? "Open in Automations"
                                      : "Open Heartbeat"
                                    : undefined
                                }
                              >
                                {content}
                              </li>
                            </NonInteractiveElementMonitor_UpcomingItem>
                          </TelemetryPath_Activity>
                        </TelemetryPath>
                      );
                    })}
                  </ul>
                )}
              </div>
            </TabsContent>

            <TabsContent value="history">
              <div className="px-6 pb-6">
                {sessionNotFound && (
                  <p className="mb-3 rounded-lg bg-destructive/10 p-3 text-center text-sm text-destructive">
                    Session no longer exists
                  </p>
                )}
                {historyEntries.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">No activity yet</p>
                ) : (
                  <ul className="overflow-hidden rounded-2xl border border-border" role="list">
                    {historyEntries.slice(0, 50).map((entry) => {
                      const navigable =
                        entry.type === "automation" && !!entry.sessionId && !!onSessionSelect;
                      return (
                        <NonInteractiveElementMonitor_HistoryItem key={entry.id}>
                          <li
                            data-testid="activity-item"
                            className={`group flex gap-4 border-b border-border px-4 py-3 last:border-b-0 ${navigable ? "cursor-pointer hover:bg-accent focus-visible:bg-accent focus-visible:outline-none" : ""}`}
                            onClick={
                              navigable ? () => void handleRunClick(entry.sessionId!) : undefined
                            }
                            onKeyDown={
                              navigable
                                ? (e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      e.preventDefault();
                                      void handleRunClick(entry.sessionId!);
                                    }
                                  }
                                : undefined
                            }
                            tabIndex={navigable ? 0 : undefined}
                            role={navigable ? "button" : undefined}
                            title={navigable ? "Open session" : undefined}
                          >
                            <span className="mt-0.5 shrink-0 text-lg leading-none">
                              {entry.type === "heartbeat" ? "\uD83D\uDC9A" : "\uD83D\uDD04"}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-base font-semibold text-foreground">
                                  {entry.name}
                                </span>
                                <Badge
                                  className={`text-[10px] font-semibold ${statusBadgeClasses(entry.status)}`}
                                  data-status={STATUS_CLASS[entry.status] ?? ""}
                                >
                                  {STATUS_ICON[entry.status] ?? "\u00B7"} {entry.status}
                                </Badge>
                              </div>
                              {entry.summary && (
                                <div className="relative mt-0.5 max-h-24 overflow-hidden text-sm text-muted-foreground">
                                  <div className="pointer-events-none">
                                    <MarkdownRenderer>{entry.summary}</MarkdownRenderer>
                                  </div>
                                  <div className="absolute inset-x-0 bottom-0 h-6 bg-linear-to-t from-card to-transparent transition-opacity group-hover:opacity-0" />
                                </div>
                              )}
                              <p className="mt-0.5 text-sm text-muted-foreground">
                                {formatAbsolute(entry.startedAt)}
                              </p>
                            </div>
                            <span className="mt-0.5 shrink-0 text-sm text-muted-foreground">
                              {formatRelative(entry.startedAt)}
                            </span>
                          </li>
                        </NonInteractiveElementMonitor_HistoryItem>
                      );
                    })}
                  </ul>
                )}
              </div>
            </TabsContent>

            <TabsContent value="command-center">
              <CommandCenterContent onOpenSession={onOpenCommandCenterSession ?? onSessionSelect} />
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </TelemetryPath_Activities>
  );
}
