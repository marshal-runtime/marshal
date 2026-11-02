import { DEFAULT_SETTINGS } from "@common/marshal-default-settings";
import {
  DEFAULT_WORK_DAYS,
  DEFAULT_WORK_END_HOUR,
  DEFAULT_WORK_START_HOUR,
} from "@common/marshal-ipc-contract";
import { createLogger } from "@common/marshal-logger";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useEffectEvent } from "react";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Circle,
  Lock,
  RefreshCw,
  XCircle,
} from "@/components/icons";
import { Label } from "@/components/marshal-ui/label";
import { Button } from "@/components/marshal-ui/marshal-button";
import { SectionHeader } from "@/components/marshal-ui/section-header";
import { Separator } from "@/components/marshal-ui/separator";
import { Textarea } from "@/components/marshal-ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SurfaceHeader } from "@/components/ui/surface-header";
import { useSettings } from "@/features/settings/useSettings";
import {
  TelemetryPath_Heartbeat,
  InteractiveElementMonitor_Enable,
  InteractiveElementMonitor_Trigger,
  InteractiveElementMonitor_Save,
} from "@/services/telemetry/schema";
import { useAutomationCapabilitiesQuery } from "@/shared/hooks/useAutomationCapabilities";
import { useIpcMutation } from "@/shared/hooks/useIpcMutation";
import { useTenantPolicy } from "@/shared/hooks/useTenantPolicy";
import type {
  HeartbeatControllableMap,
  HeartbeatStatusEnvelope,
  HeartbeatSettingsEnvelope,
  HeartbeatSettings,
  HeartbeatLogEntry,
  PermissionsConfig,
} from "@/types/electron";

import { PermissionsPanel } from "../permissions/PermissionsPanel";
import { PermissionsSummary } from "../permissions/PermissionsSummary";
import { usePermissionsControllable } from "../permissions/usePermissionsConfig";

const ALL_CONTROLLABLE: HeartbeatControllableMap = {
  enabled: true,
  intervalMinutes: true,
  schedule: true,
  prompt: true,
  permissions: true,
  workDays: true,
  workStartHour: true,
  workEndHour: true,
};

const log = createLogger("HeartbeatPanel");

interface HeartbeatPanelProps {
  isOpen: boolean;
  onClose?: () => void;
  onOpenActivities?: () => void;
  onOpenSettings?: () => void;
}

const INTERVAL_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 15, label: "Every 15 min" },
  { value: 30, label: "Every 30 min" },
  { value: 60, label: "Every hour" },
  { value: 120, label: "Every 2 hours" },
];

const SCHEDULE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "work-hours", label: "Work hours" },
  { value: "always", label: "Always (while app is open)" },
];

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Format an hour (0-23) as "8am", "12pm", "6pm", etc. */
function formatHour(h: number): string {
  if (h === 0) return "12am";
  if (h < 12) return `${h}am`;
  if (h === 12) return "12pm";
  return `${h - 12}pm`;
}

function LogIcon({ type }: { type: string }) {
  switch (type) {
    case "urgent":
      return <AlertTriangle size={14} className="text-(--color-warning-text)" />;
    case "error":
      return <XCircle size={14} className="text-(--color-danger)" />;
    case "ok":
    case "complete":
      return <CheckCircle2 size={14} className="text-success" />;
    default:
      return <Circle size={14} className="text-muted-foreground" />;
  }
}

export function HeartbeatPanel({
  isOpen,
  onClose,
  onOpenActivities,
  onOpenSettings,
}: HeartbeatPanelProps) {
  const { settings: globalSettings } = useSettings(isOpen);
  const { disableHeartbeat } = useTenantPolicy();
  const { capabilities, isLoading: capabilitiesLoading } = useAutomationCapabilitiesQuery();
  const queryClient = useQueryClient();
  const [promptDraft, setPromptDraft] = useState("");
  const [promptDirty, setPromptDirty] = useState(false);
  const [polling, setPolling] = useState(false);
  const [showPermissions, setShowPermissions] = useState(false);

  const { data: statusEnvelope = null } = useQuery<HeartbeatStatusEnvelope | null>({
    queryKey: ["heartbeat", "status"],
    queryFn: async () => {
      if (!window.heartbeatAPI) return null;
      const result = await window.heartbeatAPI.status();
      return result.success && result.status ? result.status : null;
    },
    refetchInterval: polling ? 2000 : false,
    enabled: isOpen,
  });

  const { data: settingsEnvelope = null, isPending: settingsPending } =
    useQuery<HeartbeatSettingsEnvelope | null>({
      queryKey: ["heartbeat", "settings"],
      queryFn: async () => {
        if (!window.heartbeatAPI) return null;
        const result = await window.heartbeatAPI.getSettings();
        return result.success && result.settings ? result.settings : null;
      },
      enabled: isOpen,
    });

  // Phase 3a-1: HeartbeatSettingsEnvelope/HeartbeatStatusEnvelope are
  // discriminated unions on `supported`. Unwrap once here so the rest of the
  // component sees a flat optional shape, and surface a "not connected"
  // placeholder below when the active backend reports `supported: false`.
  const status = statusEnvelope?.supported ? statusEnvelope : null;
  const settings = settingsEnvelope?.supported ? settingsEnvelope : null;
  const controllable: HeartbeatControllableMap = settings?.controllable ?? ALL_CONTROLLABLE;
  // Both queries must settle before we render capability/controllable-gated
  // sections; otherwise the all-true loading defaults render briefly and
  // snap closed when the gateway envelope arrives. Used by gated JSX below.
  const ready = !capabilitiesLoading && !settingsPending;

  const { data: permControl } = usePermissionsControllable();
  const permissionsControllable = permControl?.controllable;

  const { data: logs = [] } = useQuery<HeartbeatLogEntry[]>({
    queryKey: ["heartbeat", "logs"],
    queryFn: async () => {
      if (!window.heartbeatAPI) return [];
      const result = await window.heartbeatAPI.getLogs(50);
      return result.success && result.logs ? result.logs : [];
    },
    refetchInterval: polling ? 2000 : false,
    enabled: isOpen,
  });

  useEffect(() => {
    if (status && !status.running) {
      // Force one more logs fetch before polling stops — the scheduled 2s
      // refetch gets cancelled when polling flips off and the final
      // "Heartbeat check complete" entry is lost otherwise.
      void queryClient.invalidateQueries({ queryKey: ["heartbeat", "logs"] });
      setPolling(false); // eslint-disable-line react-compiler/set-state-in-effect -- stop polling when heartbeat finishes
    }
  }, [status, queryClient]);

  // Skip while dirty: another field's mutation invalidates `settings`, and
  // re-syncing would clobber the user's in-progress draft. Dirty is cleared
  // only on successful save (see handleSavePrompt.onSuccess).
  const syncPromptFromSettings = useEffectEvent(() => {
    if (settings && !promptDirty) {
      setPromptDraft(settings.prompt || "");
    }
  });
  useEffect(() => {
    syncPromptFromSettings(); // eslint-disable-line react-compiler/set-state-in-effect
  }, [settings]);

  const isValidPrompt = promptDraft.trim().length > 0;

  // Save mutations — single source of truth for the IPC error toast +
  // settings-query invalidation. React Query handles `isPending` so the
  // renderer can show "Saving…" affordances.
  //
  // The `!window.heartbeatAPI` guard lives in each handler (not the
  // mutationFn) — short-circuiting via `Promise.resolve({ success: true })`
  // would still fire `onSettled`, invalidating cached state even though no
  // IPC ran. In production the preload bridge installs the API before this
  // panel mounts; the handler-level guard is defense in depth.
  const settingsMutation = useIpcMutation({
    mutationFn: (patch: Partial<HeartbeatSettings>) => window.heartbeatAPI.saveSettings(patch),
    fallbackErrorMessage: "Failed to save heartbeat settings",
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["heartbeat", "settings"] }),
  });

  const toggleMutation = useIpcMutation({
    mutationFn: (enabled: boolean) => window.heartbeatAPI.toggle(enabled),
    fallbackErrorMessage: "Failed to toggle heartbeat",
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["heartbeat", "status"] }),
  });

  const runNowMutation = useIpcMutation({
    mutationFn: () => window.heartbeatAPI.runNow(),
    fallbackErrorMessage: "Failed to run heartbeat",
    onError: (err) => {
      // Existing diagnostic logging — keep alongside the helper's toast.
      log.error("heartbeat runNow failed:", err);
    },
  });

  const handleToggle = () => {
    if (!window.heartbeatAPI || !status) return;
    // Prevent enabling with empty prompt.
    if (!status.enabled && !isValidPrompt) return;
    toggleMutation.mutate(!status.enabled);
  };

  const handleIntervalChange = (value: number) => {
    if (!window.heartbeatAPI) return;
    settingsMutation.mutate({
      intervalMinutes: value as HeartbeatSettings["intervalMinutes"], // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- Select value constrained to valid interval options
    });
  };

  const handleScheduleChange = (value: string) => {
    if (!window.heartbeatAPI) return;
    settingsMutation.mutate({
      schedule: value as HeartbeatSettings["schedule"], // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- Select value constrained to valid schedule options
    });
  };

  const handleWorkDayToggle = (day: number) => {
    if (!window.heartbeatAPI) return;
    const current = settings?.workDays ?? DEFAULT_WORK_DAYS;
    const next = current.includes(day)
      ? current.filter((d) => d !== day)
      : [...current, day].sort((a, b) => a - b);
    if (next.length === 0) return; // must keep at least one day
    settingsMutation.mutate({ workDays: next });
  };

  const handleWorkHourChange = (field: "workStartHour" | "workEndHour", value: number) => {
    if (!window.heartbeatAPI) return;
    // Send both hours together: marshal's `config.patch` does a merge-patch
    // and replaces `activeHours` wholesale. Sending only one side would let
    // the mapper synthesize the other from marshal's hardcoded default and silently
    // overwrite whatever value the server held.
    const currentStart = settings?.workStartHour ?? DEFAULT_WORK_START_HOUR;
    const currentEnd = settings?.workEndHour ?? DEFAULT_WORK_END_HOUR;
    settingsMutation.mutate({
      workStartHour: field === "workStartHour" ? value : currentStart,
      workEndHour: field === "workEndHour" ? value : currentEnd,
    });
  };

  const handleSavePrompt = () => {
    if (!window.heartbeatAPI) return;
    settingsMutation.mutate(
      { prompt: promptDraft },
      {
        onSuccess: () => setPromptDirty(false),
      },
    );
  };

  const handlePermissionsToggle = (enabled: boolean) => {
    if (!window.heartbeatAPI || !settings) return;
    if (enabled) {
      // Seed from global permissions with autoApproveReadOnly forced on
      const base = globalSettings.permissions ?? DEFAULT_SETTINGS.permissions!;
      settingsMutation.mutate({ permissions: { ...base, autoApproveReadOnly: true } });
    } else {
      settingsMutation.mutate({ permissions: undefined });
    }
  };

  const handlePermissionsUpdate = (perms: PermissionsConfig) => {
    if (!window.heartbeatAPI) return;
    settingsMutation.mutate({ permissions: perms });
  };

  const handleRunNow = () => {
    if (!window.heartbeatAPI) return;
    runNowMutation.mutate();
    setPolling(true);
  };

  const handleOpenActivities = () => {
    onOpenActivities?.();
  };

  if (!isOpen) return null;

  if (disableHeartbeat) {
    return (
      <TelemetryPath_Heartbeat>
        <section
          aria-label="Heartbeat settings"
          className="flex size-full flex-col overflow-hidden bg-card"
        >
          <SurfaceHeader title="Heartbeat" onClose={onClose} />
          <div className="flex flex-1 items-center justify-center p-8">
            <p className="text-center text-sm text-muted-foreground">
              <Lock size={14} className="mr-1 inline-block" /> Heartbeat is disabled by your
              organization.
            </p>
          </div>
        </section>
      </TelemetryPath_Heartbeat>
    );
  }

  // Phase 3a-1: when the active backend doesn't support heartbeat (e.g.
  // gateway with no marshal connection yet), either envelope can return
  // { supported: false }. Guard both — they can land out of order, and a
  // half-supported state would otherwise render the editable form against
  // a null status / null settings.
  if (
    (settingsEnvelope && !settingsEnvelope.supported) ||
    (statusEnvelope && !statusEnvelope.supported)
  ) {
    return (
      <TelemetryPath_Heartbeat>
        <section
          aria-label="Heartbeat settings"
          className="flex size-full flex-col overflow-hidden bg-card"
        >
          <SurfaceHeader title="Heartbeat" onClose={onClose} />
          <div className="flex flex-1 items-center justify-center p-8">
            <p className="text-center text-sm text-muted-foreground">
              Heartbeat is not connected to a backend.
            </p>
          </div>
        </section>
      </TelemetryPath_Heartbeat>
    );
  }

  const currentInterval = settings?.intervalMinutes ?? 30;
  const currentIntervalLabel =
    INTERVAL_OPTIONS.find((o) => o.value === currentInterval)?.label ?? "Every 30 min";
  const currentSchedule = settings?.schedule ?? "work-hours";
  const currentScheduleLabel =
    SCHEDULE_OPTIONS.find((o) => o.value === currentSchedule)?.label ?? "Work hours";
  const workDays = settings?.workDays ?? DEFAULT_WORK_DAYS;
  const workStartHour = settings?.workStartHour ?? DEFAULT_WORK_START_HOUR;
  const workEndHour = settings?.workEndHour ?? DEFAULT_WORK_END_HOUR;
  // The work-schedule section is visible whenever ANY of its three sub-controls
  // would render — copilot has all three, gateway has hours but not workDays.
  const showWorkScheduleSection =
    controllable.workDays || controllable.workStartHour || controllable.workEndHour;

  if (showPermissions && settings?.permissions) {
    return (
      <TelemetryPath_Heartbeat>
        <PermissionsPanel
          title="Heartbeat — Permissions"
          onBack={() => setShowPermissions(false)}
          onClose={onClose}
          permissions={settings.permissions}
          onUpdatePermissions={handlePermissionsUpdate}
          controllable={permissionsControllable}
          hasUnrepresentablePatterns={permControl?.hasUnrepresentablePatterns}
        />
      </TelemetryPath_Heartbeat>
    );
  }

  return (
    <TelemetryPath_Heartbeat>
      <section
        aria-label="Heartbeat settings"
        className="flex size-full flex-col overflow-hidden bg-card"
      >
        <SurfaceHeader title="Heartbeat" onClose={onClose} />

        {/* Scrollable content */}
        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-4 p-4">
            {/* Status card */}
            <div className="flex items-center justify-between rounded-xl border border-border px-5 py-4">
              <span className="text-sm font-medium">{status?.enabled ? "Active" : "Inactive"}</span>
              <InteractiveElementMonitor_Enable callback={handleToggle}>
                {(cb) =>
                  status?.enabled ? (
                    <Button variant="outline" onClick={cb} disabled={!controllable.enabled}>
                      Disable
                    </Button>
                  ) : (
                    <div className="flex items-center gap-2">
                      {!isValidPrompt && (
                        <span className="flex items-center gap-1.5 text-xs text-warning-primary">
                          <AlertTriangle size={12} />
                          Add a prompt below to enable
                        </span>
                      )}
                      <Button
                        className="bg-success-loud text-white hover:bg-success-loud-hover"
                        onClick={cb}
                        disabled={!isValidPrompt || !controllable.enabled}
                      >
                        Enable
                      </Button>
                    </div>
                  )
                }
              </InteractiveElementMonitor_Enable>
            </div>

            {onOpenSettings && (
              <p className="text-xs/snug text-muted-foreground">
                Sleep prevention settings are in{" "}
                <Button
                  variant="link"
                  className="h-auto p-0 text-xs text-foreground underline underline-offset-2 hover:text-muted-foreground"
                  onClick={onOpenSettings}
                >
                  Settings → Power Management
                </Button>
                .
              </p>
            )}

            {/* Frequency — underline-only trigger */}
            <div className="flex items-center justify-between gap-4">
              <Label className="text-sm font-semibold">Frequency</Label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    aria-label="Frequency"
                    disabled={!controllable.intervalMinutes}
                    className="flex h-9 items-center gap-2 border-b border-border bg-transparent px-1 text-sm font-normal text-foreground outline-none focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {currentIntervalLabel} <ChevronDown size={14} className="opacity-50" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {INTERVAL_OPTIONS.map((o) => (
                    <DropdownMenuItem key={o.value} onClick={() => handleIntervalChange(o.value)}>
                      {o.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Schedule — bordered trigger */}
            <div className="flex items-center justify-between gap-4">
              <Label className="text-sm font-semibold">Schedule</Label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    className="h-9 gap-2 rounded-xl font-normal"
                    aria-label="Schedule"
                    disabled={!controllable.schedule}
                  >
                    {currentScheduleLabel} <ChevronDown size={14} className="opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {SCHEDULE_OPTIONS.map((o) => (
                    <DropdownMenuItem key={o.value} onClick={() => handleScheduleChange(o.value)}>
                      {o.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Work schedule config — only shown when schedule is "work-hours" */}
            {currentSchedule === "work-hours" && showWorkScheduleSection && (
              <div
                data-testid="work-days-picker"
                className="flex flex-col gap-3 rounded-xl border border-border p-3"
              >
                {/* Day toggles — gateway has no per-day equivalent in marshal.
                 *  `ready &&` suppresses the brief loading-state flash where
                 *  ALL_CONTROLLABLE renders the toggles before the gateway
                 *  envelope arrives and snaps them closed. */}
                {ready && controllable.workDays && (
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-xs text-muted-foreground">Work days</Label>
                    <div className="flex gap-1">
                      {DAY_LABELS.map((label, i) => (
                        <button
                          key={label}
                          aria-label={label}
                          aria-pressed={workDays.includes(i)}
                          onClick={() => handleWorkDayToggle(i)}
                          className={`flex h-7 w-9 items-center justify-center rounded-md text-xs font-medium transition-colors ${
                            workDays.includes(i)
                              ? "bg-brand-action text-brand-action-fg"
                              : "bg-muted text-muted-foreground hover:bg-muted/80"
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Hour range */}
                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground">Hours</Label>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        aria-label="Work start hour"
                        disabled={!controllable.workStartHour}
                        className="flex h-7 items-center gap-1 rounded-md border border-border bg-transparent px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {formatHour(workStartHour)} <ChevronDown size={12} className="opacity-50" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="max-h-48 overflow-y-auto">
                      {Array.from({ length: 24 }, (_, h) => (
                        <DropdownMenuItem
                          key={h}
                          disabled={h >= workEndHour}
                          onClick={() => handleWorkHourChange("workStartHour", h)}
                        >
                          {formatHour(h)}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <span className="text-xs text-muted-foreground">to</span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        aria-label="Work end hour"
                        disabled={!controllable.workEndHour}
                        className="flex h-7 items-center gap-1 rounded-md border border-border bg-transparent px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {formatHour(workEndHour)} <ChevronDown size={12} className="opacity-50" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="max-h-48 overflow-y-auto">
                      {Array.from({ length: 24 }, (_, h) => (
                        <DropdownMenuItem
                          key={h}
                          disabled={h <= workStartHour}
                          onClick={() => handleWorkHourChange("workEndHour", h)}
                        >
                          {formatHour(h)}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            )}

            {/* Prompt */}
            <div className="flex flex-col gap-2">
              <Label className="text-sm font-semibold">What to check</Label>
              <Textarea
                value={promptDraft}
                disabled={!controllable.prompt}
                onChange={(e) => {
                  setPromptDraft(e.target.value);
                  setPromptDirty(true);
                }}
                placeholder="e.g. Check my inbox and chat messages for anything urgent from my manager or about Project X"
                rows={4}
                aria-describedby={
                  (status?.enabled || promptDirty) && !isValidPrompt
                    ? "heartbeat-prompt-warning"
                    : undefined
                }
              />
              {(status?.enabled || promptDirty) && !isValidPrompt && (
                <p
                  id="heartbeat-prompt-warning"
                  className="flex items-center gap-1.5 text-xs text-warning-primary"
                >
                  <AlertTriangle size={12} />
                  {status?.enabled
                    ? "Heartbeat is on but every run is skipped — add a prompt above."
                    : "A prompt is required to enable heartbeat."}
                </p>
              )}
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2">
              {promptDirty && (
                <InteractiveElementMonitor_Save callback={handleSavePrompt}>
                  {(cb) => (
                    <Button
                      className="animate-in bg-brand-action text-brand-action-fg duration-300 fade-in hover:bg-brand-action-hover"
                      onClick={cb}
                      disabled={!isValidPrompt || settingsMutation.isPending}
                    >
                      <RefreshCw size={14} />
                      {settingsMutation.isPending ? "Saving…" : "Save"}
                    </Button>
                  )}
                </InteractiveElementMonitor_Save>
              )}
              {ready && capabilities.heartbeatRunNow && (
                <InteractiveElementMonitor_Trigger callback={handleRunNow}>
                  {(cb) => (
                    <Button
                      variant="outline"
                      onClick={cb}
                      disabled={
                        status?.running || !settings?.prompt?.trim() || settingsMutation.isPending
                      }
                    >
                      <RefreshCw size={14} />
                      {status?.running ? "Running…" : "Run now"}
                    </Button>
                  )}
                </InteractiveElementMonitor_Trigger>
              )}
            </div>

            {/* Permissions — visible whenever the permissions envelope reports controllable */}
            {ready && permissionsControllable && (
              <div data-testid="heartbeat-permissions-section">
                <SectionHeader divider={false}>
                  {settings?.permissions
                    ? "Permissions — Custom"
                    : "Permissions — Global defaults + read-only"}
                </SectionHeader>
                <PermissionsSummary
                  permissions={settings?.permissions}
                  onManagePermissions={() => setShowPermissions(true)}
                  onCustomize={() => {
                    handlePermissionsToggle(true);
                    setShowPermissions(true);
                  }}
                  onReset={() => handlePermissionsToggle(false)}
                  defaultsLabel="Using global permissions with read-only auto-approved"
                  customizeDisabled={!permissionsControllable.perHeartbeatScope.enabled}
                  customizeTooltip={permissionsControllable.perHeartbeatScope.disabledReason}
                />
              </div>
            )}

            {/* Last run */}
            {status?.lastRun && (
              <p className="text-right text-xs text-muted-foreground">Last run: {status.lastRun}</p>
            )}

            <Separator />

            {/* Recent Activity — always visible */}
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Recent Activity</h3>
              {onOpenActivities && (
                <Button
                  variant="link"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={handleOpenActivities}
                >
                  View all
                </Button>
              )}
            </div>

            <div className="flex flex-col gap-0.5">
              {logs.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">No activity yet</p>
              ) : (
                logs.slice(0, 20).map((entry, i) => (
                  <div
                    // eslint-disable-next-line react/no-array-index-key -- composite key; index needed for same-second duplicates
                    key={`${entry.timestamp}-${entry.type}-${i}`}
                    className={`flex items-start gap-1.5 rounded-sm px-2 py-1 text-[11px] hover:bg-muted/50 ${
                      entry.type === "urgent"
                        ? "border-l-[3px] border-l-(--color-warning-text) bg-(--color-warning-bg) pl-[5px]"
                        : ""
                    }`}
                    data-testid="log-entry"
                    data-log-type={entry.type}
                  >
                    <time className="min-w-[48px] shrink-0 font-mono text-[10px] text-muted-foreground">
                      {entry.timestamp.split(" ")[1] || entry.timestamp}
                    </time>
                    <span className="shrink-0">
                      <LogIcon type={entry.type} />
                    </span>
                    <span
                      className={`min-w-0 flex-1 wrap-break-word whitespace-pre-wrap ${
                        entry.type === "urgent"
                          ? "font-semibold text-(--color-warning-text)"
                          : entry.type === "error"
                            ? "text-(--color-danger)"
                            : "text-muted-foreground"
                      }`}
                    >
                      {entry.message}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </ScrollArea>
      </section>
    </TelemetryPath_Heartbeat>
  );
}
