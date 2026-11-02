import { useRef } from "react";

import {
  ChevronRight,
  Clock,
  Download,
  Eye,
  Package,
  Pause,
  Pencil,
  Play,
  Plus,
} from "@/components/icons";
import { Badge } from "@/components/marshal-ui/badge";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/marshal-ui/marshal-collapsible";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/marshal-ui/marshal-tooltip";
import { useRelayAvailable } from "@/features/integrations/useRelayAvailability";
import { getNextOccurrence } from "@/runtime-ui/automations/next-occurrence";
import { TelemetryPath } from "@/services/telemetry/opensource";
import {
  TelemetryPath_List,
  TelemetryPath_Automation,
  InteractiveElementMonitor_New,
  InteractiveElementMonitor_Import,
  InteractiveElementMonitor_Edit,
} from "@/services/telemetry/schema";
import { useIsOverflowing } from "@/shared/hooks/layout/useIsOverflowing";
import { useAutomationCapabilities } from "@/shared/hooks/useAutomationCapabilities";
import type { Skill, AutomationData, AutomationSchedule } from "@/types/electron";

import { AutomationOverflowMenu } from "./AutomationOverflowMenu";

/** Skill description clamped to 2 lines — shows tooltip only when text overflows. */
function ClampedDescription({ text }: { text: string }) {
  const [ref, overflowing] = useIsOverflowing();
  return (
    <Tooltip open={overflowing ? undefined : false}>
      <TooltipTrigger asChild>
        <span ref={ref} className="line-clamp-2 text-muted-foreground">
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

function formatOneShotSchedule(schedule: AutomationSchedule): string {
  const next = getNextOccurrence(schedule);
  if (!next) return "Runs once";
  const time = next.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const date = next.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return `Runs once · ${date} at ${time}`;
}

function formatFiredAt(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

export interface AutomationListViewProps {
  automations: AutomationData[];
  skills: Skill[];
  runningId: string | null;
  expandedSkills: Set<string>;
  importSummary: string | null;
  importError: string | null;
  disableAutomations?: boolean;
  onClearImportSummary: () => void;
  onClearImportError: () => void;
  onCreate: () => void;
  onEdit: (wf: AutomationData) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onRunNow: (id: string) => void;
  onExport: (id: string) => void;
  onDeleteClick: (wf: AutomationData) => void;
  onViewHistory: (wf: AutomationData) => void;
  onFileSelected: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onImportBundle: () => void;
  onGithubImport: () => void;
  onToggleSkills: (wfId: string) => void;
  getAutomationSkills: (wf: AutomationData) => Skill[];
}

export function AutomationListView({
  automations,
  skills,
  runningId,
  expandedSkills,
  importSummary,
  importError,
  disableAutomations,
  onClearImportSummary,
  onClearImportError,
  onCreate,
  onEdit,
  onToggle,
  onRunNow,
  onExport,
  onDeleteClick,
  onViewHistory,
  onFileSelected,
  onImportBundle,
  onGithubImport,
  onToggleSkills,
  getAutomationSkills,
}: AutomationListViewProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const caps = useAutomationCapabilities();
  const hasRelay = useRelayAvailable();

  const visibleAutomations = automations.filter((wf) => !(wf.oneShot && !wf.enabled));

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Create automated multi-step tasks that run on a schedule.
        {hasRelay && " Results are sent to you over your connected relay."}
      </p>

      {importSummary && (
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-status-success-border bg-status-success-bg p-3 text-left text-sm text-status-success-fg"
          onClick={onClearImportSummary}
        >
          ✓ {importSummary}
        </button>
      )}

      {importError && (
        <button
          type="button"
          className="w-full cursor-pointer rounded-lg border border-brand-border bg-(--color-danger-bg) p-3 text-left text-sm text-(--color-danger)"
          onClick={onClearImportError}
        >
          {importError}
        </button>
      )}

      <TelemetryPath_List>
        <div className="flex items-center justify-between gap-2">
          <InteractiveElementMonitor_New callback={onCreate}>
            {(cb) => (
              <Button
                className="bg-brand-action text-brand-action-fg hover:bg-brand-action-hover"
                onClick={cb}
                disabled={disableAutomations}
              >
                <Plus size={16} />
                New automation
              </Button>
            )}
          </InteractiveElementMonitor_New>
          <TooltipProvider>
            <div className="flex items-center gap-1">
              {caps.exportImport && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <InteractiveElementMonitor_Import
                      callback={() => fileInputRef.current?.click()}
                    >
                      {(cb) => (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={cb}
                          disabled={disableAutomations}
                        >
                          <Download size={14} />
                          Import
                        </Button>
                      )}
                    </InteractiveElementMonitor_Import>
                  </TooltipTrigger>
                  <TooltipContent>
                    Import a single automation or an array of automations from a .json file
                  </TooltipContent>
                </Tooltip>
              )}
              {caps.bundleImport && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={onImportBundle}
                      disabled={disableAutomations}
                    >
                      <Package size={14} />
                      Import Bundle
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Import from a local directory — installs all .json automations found in the
                    folder, plus any skills in the skills/ subfolder
                  </TooltipContent>
                </Tooltip>
              )}
              {caps.githubImport && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={onGithubImport}
                      disabled={disableAutomations}
                    >
                      GitHub
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Import automations and skills from a GitHub repository directory
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </TooltipProvider>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={(e) => {
            onFileSelected(e);
            if (fileInputRef.current) fileInputRef.current.value = "";
          }}
        />
        {visibleAutomations.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16">
            <p className="font-bold">No automations yet</p>
            <p className="text-sm text-muted-foreground">Create one to automate your daily tasks</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {visibleAutomations.map((wf, i) => (
              <TelemetryPath key={wf.id} id={i}>
                <TelemetryPath_Automation>
                  <div
                    data-testid="automation-card"
                    className="group rounded-xl border border-border p-3 transition-colors hover:border-foreground/20"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div
                        className={`flex min-w-0 items-center gap-2 ${wf.enabled ? "" : "opacity-60"}`}
                      >
                        <span
                          className={`size-2 shrink-0 rounded-full ${wf.enabled ? "bg-success" : "bg-muted-foreground"}`}
                        />
                        <span className="truncate text-sm font-medium">{wf.name}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={wf.enabled ? "Disable" : "Enable"}
                          disabled={disableAutomations && !wf.enabled}
                          onClick={() => onToggle(wf.id, !wf.enabled)}
                        >
                          {wf.enabled ? <Pause size={14} /> : <Play size={14} />}
                        </Button>
                        <InteractiveElementMonitor_Edit callback={() => onEdit(wf)}>
                          {(cb) => (
                            <Button variant="ghost" size="icon-sm" aria-label="Edit" onClick={cb}>
                              <Pencil size={14} />
                            </Button>
                          )}
                        </InteractiveElementMonitor_Edit>
                        <AutomationOverflowMenu
                          running={runningId === wf.id}
                          canExport={caps.exportImport}
                          onRunNow={() => onRunNow(wf.id)}
                          onHistory={() => onViewHistory(wf)}
                          onExport={() => onExport(wf.id)}
                          onDelete={() => onDeleteClick(wf)}
                        />
                      </div>
                    </div>

                    {wf.description && (
                      <p
                        className={`mt-1.5 truncate text-xs text-muted-foreground ${wf.enabled ? "" : "opacity-60"}`}
                      >
                        {wf.description}
                      </p>
                    )}

                    <div
                      className={`mt-2 flex items-center justify-between text-xs text-muted-foreground ${wf.enabled ? "" : "opacity-60"}`}
                    >
                      <span className="flex items-center gap-1">
                        {wf.triggerType === "condition" ? (
                          <>
                            <Eye size={12} />
                            {wf.condition || "Condition"} · every {wf.conditionCheckInterval ?? 15}m
                            {wf.firedAt ? (
                              <Badge variant="secondary" className="ml-1 text-xs">
                                Fired {formatFiredAt(wf.firedAt)}
                              </Badge>
                            ) : null}
                          </>
                        ) : wf.oneShot ? (
                          formatOneShotSchedule(wf.schedule)
                        ) : (
                          <>
                            <Clock size={12} />
                            {wf.schedule.naturalLanguage}
                          </>
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {wf.steps.length} step{wf.steps.length !== 1 ? "s" : ""}
                      </span>
                    </div>

                    {wf.skillNames && wf.skillNames.length > 0 && (
                      <div
                        className={`mt-2 border-t border-border pt-1.5 ${wf.enabled ? "" : "opacity-60"}`}
                      >
                        <Collapsible
                          open={expandedSkills.has(wf.id)}
                          onOpenChange={() => onToggleSkills(wf.id)}
                        >
                          <CollapsibleTrigger asChild>
                            <button
                              type="button"
                              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                            >
                              <ChevronRight
                                size={12}
                                className={`transition-transform duration-200 ${expandedSkills.has(wf.id) ? "rotate-90" : ""}`}
                              />
                              <span>
                                {wf.skillNames.length} skill
                                {wf.skillNames.length !== 1 ? "s" : ""}
                              </span>
                            </button>
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <div className="mt-1.5 flex flex-col gap-1 pl-4">
                              {getAutomationSkills(wf).map((skill) => (
                                <div key={skill.id} className="flex flex-col text-xs">
                                  <span className="font-medium text-(--color-link)">
                                    /{skill.name}
                                  </span>
                                  <ClampedDescription text={skill.description} />
                                </div>
                              ))}
                              {wf.skillNames
                                .filter((n) => !skills.some((s) => s.name === n))
                                .map((name) => (
                                  <div key={name} className="flex gap-2 text-xs opacity-50">
                                    <span className="font-medium text-(--color-link)">/{name}</span>
                                    <span className="text-muted-foreground">Skill not found</span>
                                  </div>
                                ))}
                            </div>
                          </CollapsibleContent>
                        </Collapsible>
                      </div>
                    )}
                  </div>
                </TelemetryPath_Automation>
              </TelemetryPath>
            ))}
          </div>
        )}
      </TelemetryPath_List>
    </div>
  );
}
