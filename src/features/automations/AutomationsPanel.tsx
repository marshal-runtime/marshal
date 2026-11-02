import { DEFAULT_SETTINGS } from "@common/marshal-default-settings";
import { SKILL_IMPORT_DISMISSED } from "@common/marshal-ipc-contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Lock } from "@/components/icons";
import { Separator } from "@/components/marshal-ui/separator";
import { Button } from "@/components/marshal-ui/marshal-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SurfaceHeader } from "@/components/ui/surface-header";
import { useSettings } from "@/features/settings/useSettings";
import { PermissionInbox } from "@/features/workflows/PermissionInbox";
import { WorkflowsListView } from "@/features/workflows/WorkflowsListView";
import { TelemetryPath_Automations } from "@/services/telemetry/schema";
import { useIpcMutation } from "@/shared/hooks/useIpcMutation";
import { useSkills } from "@/shared/hooks/useSkillCatalog";
import { useTenantPolicy } from "@/shared/hooks/useTenantPolicy";
import type {
  Skill,
  AutomationData,
  AutomationSchedule,
  AutomationRunData,
} from "@/types/electron";

import { PermissionsPanel } from "../permissions/PermissionsPanel";
import { INITIAL_AUTOMATION_FORM_STATE, type AutomationFormState } from "./automation-form-state";
import { AutomationFormView } from "./AutomationFormView";
import { AutomationHistoryView } from "./AutomationHistoryView";
import { AutomationListView } from "./AutomationListView";
import { AutomationDeleteDialog } from "./dialogs/AutomationDeleteDialog";
import { GithubImportView } from "./GithubImportView";

interface AutomationsPanelProps {
  isOpen: boolean;
  initialEditAutomationName?: string | null;
  onOpenWorkflow?: (workflowId: string, repoPath?: string | null) => void;
  onOpenHeartbeat?: () => void;
}

type View = "list" | "create" | "edit" | "history" | "github-import" | "permissions";

export function AutomationsPanel({
  isOpen,
  initialEditAutomationName,
  onOpenWorkflow,
  onOpenHeartbeat,
}: AutomationsPanelProps) {
  const { disableAutomations } = useTenantPolicy();
  const queryClient = useQueryClient();

  const { data: automations = [] } = useQuery<AutomationData[]>({
    queryKey: ["automations"],
    queryFn: async () => {
      if (!window.automationsAPI) return [];
      const result = await window.automationsAPI.list();
      return result.success && result.automations ? result.automations : [];
    },
    enabled: isOpen,
  });
  const { settings: globalSettings } = useSettings(isOpen);
  const [view, setView] = useState<View>("list");
  const [editId, setEditId] = useState<string | null>(null);
  const [, setHistoryId] = useState<string | null>(null);
  const [runs, setRuns] = useState<AutomationRunData[]>([]);
  const [runningId, setRunningId] = useState<string | null>(null);

  const { data: skills = [] } = useSkills(isOpen);
  const [expandedSkills, setExpandedSkills] = useState(new Set<string>());

  // Delete confirmation state
  const [deleteConfirm, setDeleteConfirm] = useState<{
    id: string;
    name: string;
    skillNames: string[];
  } | null>(null);

  // Brief summary shown after a successful bundle/github import
  const [importSummary, setImportSummary] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const [form, setForm] = useState<AutomationFormState>(INITIAL_AUTOMATION_FORM_STATE);
  const updateForm = useCallback((patch: Partial<AutomationFormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);
  const resetForm = useCallback(() => setForm(INITIAL_AUTOMATION_FORM_STATE), []);

  const handleCreate = () => {
    // setEditId(null) is load-bearing: the <AutomationFormView key={editId ?? "create"}>
    // pattern remounts the form on transition. Without this, edit→list→create reuses
    // the prior edit's mount, leaking any local state added to the view in the future.
    setEditId(null);
    resetForm();
    setView("create");
  };

  const handleEdit = useCallback((automation: AutomationData) => {
    setEditId(automation.id);
    setForm({
      name: automation.name,
      description: automation.description || "",
      steps: automation.steps.length > 0 ? automation.steps : [{ id: "1", label: "", prompt: "" }],
      schedule: automation.oneShot
        ? automation.schedule.naturalLanguage.replace(/^every\s+/i, "")
        : automation.schedule.naturalLanguage,
      scheduleReadOnly: !!automation.schedule.readOnly,
      error: "",
      triggerType: automation.triggerType || "schedule",
      condition: automation.condition || "",
      checkInterval: automation.conditionCheckInterval ?? 15,
      isOneShot: !!automation.oneShot,
      model: automation.model,
      permissions: automation.permissions,
      browserHeadless: automation.browserHeadless ?? false,
      // Grandfather missing values to "always" — same default as INITIAL_AUTOMATION_FORM_STATE.
      teamsNotify: automation.teamsNotify ?? "always",
    });
    setView("edit");
  }, []);

  // Auto-open edit view when navigated to with a specific automation name (consumed once).
  // handleEdit cascades ~10 form setters for a single user action. Neither useCallback,
  // useEffectEvent, nor the render-phase "adjust state when a prop changes" pattern
  // satisfies react-compiler/set-state-in-effect here — oxlint traces setState through
  // the call graph regardless of the wrapper. Targeted disable on the call site.
  const consumedEditName = useRef<string | null>(null);
  useEffect(() => {
    if (
      initialEditAutomationName &&
      initialEditAutomationName !== consumedEditName.current &&
      automations.length > 0
    ) {
      const wf = automations.find((w) => w.name === initialEditAutomationName);
      if (wf) {
        consumedEditName.current = initialEditAutomationName;
        // eslint-disable-next-line react-compiler/set-state-in-effect -- handleEdit is a consumer-intent handler reused by the Edit button; cascading form setters are the correct behavior for a navigate-to-edit action.
        handleEdit(wf);
      }
    }
  }, [initialEditAutomationName, automations, handleEdit]);

  const handleViewHistory = async (automation: AutomationData) => {
    if (!window.automationsAPI) return;
    setHistoryId(automation.id);
    const result = await window.automationsAPI.getHistory(automation.id);
    if (result.success && result.runs) {
      setRuns(result.runs.reverse());
    }
    setView("history");
  };

  const handleSave = async () => {
    if (!window.automationsAPI) return;
    updateForm({ error: "" });

    if (!form.name.trim()) {
      updateForm({ error: "Name is required" });
      return;
    }
    const validSteps = form.steps.filter((s) => s.prompt.trim());
    if (validSteps.length === 0) {
      updateForm({ error: "At least one step is required" });
      return;
    }
    if (form.triggerType === "schedule" && !form.schedule.trim() && !form.scheduleReadOnly) {
      updateForm({ error: "Schedule is required" });
      return;
    }
    if (form.triggerType === "condition" && !form.condition.trim()) {
      updateForm({ error: "Condition is required" });
      return;
    }

    const steps = validSteps.map((s, i) => ({
      id: s.id || String(i + 1),
      label: s.label || `Step ${i + 1}`,
      prompt: s.prompt.trim(),
    }));

    // TODO: Emit kind:"single" once IPC contract uses the discriminated union.
    // Currently sends legacy flat shape — normalizeSchedule() in the main process handles conversion.
    const schedule: AutomationSchedule = {
      naturalLanguage: form.schedule.trim(),
      days: [],
      hour: 0,
      minute: 0,
    };

    if (view === "create") {
      const result = await window.automationsAPI.create({
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        steps,
        schedule:
          form.triggerType === "condition"
            ? { naturalLanguage: "", days: [], hour: 0, minute: 0 }
            : schedule,
        triggerType: form.triggerType,
        ...(form.triggerType === "condition" && { condition: form.condition.trim() }),
        ...(form.triggerType === "condition" && { conditionCheckInterval: form.checkInterval }),
        ...(form.model !== undefined && { model: form.model }),
        ...(form.permissions !== undefined && { permissions: form.permissions }),
        // Conditional spread on create: new automations have no prior value, so
        // omitting on `false` keeps the create payload tidy. Edit branch (below)
        // sends the value unconditionally so toggling OFF persists.
        ...(form.browserHeadless && { browserHeadless: true }),
        ...(form.teamsNotify !== "always" && { teamsNotify: form.teamsNotify }),
      });
      if (!result.success) {
        updateForm({ error: result.error || "Failed to create" });
        return;
      }
    } else if (view === "edit" && editId) {
      // When the schedule is read-only (e.g. an opaque cron expression that
      // doesn't round-trip to our natural-language form), omit the `schedule`
      // field from the update payload so we don't clobber the source of truth.
      const scheduleUpdate =
        form.triggerType === "condition"
          ? { schedule: { naturalLanguage: "", days: [], hour: 0, minute: 0 } }
          : form.scheduleReadOnly
            ? {}
            : { schedule };
      const result = await window.automationsAPI.update(editId, {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        steps,
        ...scheduleUpdate,
        triggerType: form.triggerType,
        ...(form.triggerType === "condition" && { condition: form.condition.trim() }),
        ...(form.triggerType === "condition" && { conditionCheckInterval: form.checkInterval }),
        model: form.model,
        permissions: form.permissions,
        // Always include on update so toggling OFF persists; omitting would leave the prior true value.
        browserHeadless: form.browserHeadless,
        teamsNotify: form.teamsNotify,
      });
      if (!result.success) {
        updateForm({ error: result.error || "Failed to update" });
        return;
      }
    }

    await queryClient.invalidateQueries({ queryKey: ["automations"] });
    setView("list");
  };

  const handleDeleteClick = (wf: AutomationData) => {
    // Only prompt for skill deletion if the automation has skills that still exist
    const existingSkillNames = (wf.skillNames ?? []).filter((n) =>
      skills.some((s) => s.name === n),
    );
    if (existingSkillNames.length > 0) {
      setDeleteConfirm({ id: wf.id, name: wf.name, skillNames: existingSkillNames });
    } else {
      handleDelete(wf.id, false);
    }
  };

  // Save mutations route through `useIpcMutation` — failures
  // toast `result.error` automatically; per-handler `onSuccess` handles
  // navigation / state cleanup that used to live inline. Pre-refactor the
  // success branches were silently mutating state on backend failures.
  //
  // The `!window.automationsAPI` guard lives in the handler (not the
  // mutationFn) because a `Promise.resolve({ success: true })` short-circuit
  // would still fire `onSuccess` — closing the delete dialog, invalidating
  // queries — even though no IPC call ran. In production the preload bridge
  // installs the API before the panel mounts; the guard is defense in depth
  // for harnesses that haven't called `installMockAPIs`.
  const deleteMutation = useIpcMutation({
    mutationFn: ({ id, deleteSkills }: { id: string; deleteSkills: boolean }) =>
      window.automationsAPI.delete(id, deleteSkills ? { deleteSkills: true } : undefined),
    fallbackErrorMessage: "Failed to delete automation",
    // Success-only side effects (closing the confirm dialog) stay in
    // onSuccess; query invalidation goes in onSettled so the cache
    // re-syncs to server truth even on backend failure — otherwise a
    // stale list would persist alongside the toast.
    onSuccess: () => {
      setDeleteConfirm(null);
    },
    onSettled: (_data, _err, { deleteSkills }) => {
      void queryClient.invalidateQueries({ queryKey: ["automations"] });
      if (deleteSkills) void queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
  const handleDelete = (id: string, deleteSkills: boolean) => {
    if (!window.automationsAPI) return;
    deleteMutation.mutate({ id, deleteSkills });
  };

  const toggleMutation = useIpcMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      window.automationsAPI.toggle(id, enabled),
    fallbackErrorMessage: "Failed to toggle automation",
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["automations"] }),
  });
  const handleToggle = (id: string, enabled: boolean) => {
    if (!window.automationsAPI) return;
    toggleMutation.mutate({ id, enabled });
  };

  const runNowMutation = useIpcMutation({
    mutationFn: (id: string) => window.automationsAPI.runNow(id),
    fallbackErrorMessage: "Failed to run automation",
    onMutate: (id: string) => {
      setRunningId(id);
    },
    onSettled: () => {
      setRunningId(null);
      void queryClient.invalidateQueries({ queryKey: ["automations"] });
    },
  });
  const handleRunNow = (id: string) => {
    if (!window.automationsAPI) return;
    runNowMutation.mutate(id);
  };

  // Export keeps its imperative shape — the success branch chains into
  // `fileExportAPI.saveJson` which is itself fire-and-forget IPC. Inline
  // success-check + toast covers the dead-letter case the helper would
  // catch. Worth folding into useIpcMutation later if more chained
  // file-export flows appear.
  const handleExport = async (id: string) => {
    if (!window.automationsAPI) return;
    try {
      const result = await window.automationsAPI.exportAutomation(id);
      if (!result.success) {
        toast.error(result.error ?? "Failed to export automation");
        return;
      }
      if (result.json) {
        const automation = automations.find((w) => w.id === id);
        const filename = `${(automation?.name || "automation").replace(/[^a-z0-9]/gi, "-")}.json`;
        await window.fileExportAPI?.saveJson(result.json, filename);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to export automation");
    }
  };

  const importFileMutation = useIpcMutation({
    mutationFn: (text: string) => window.automationsAPI.importAutomation(text),
    fallbackErrorMessage: "Failed to import automation",
    // onSettled (not onSuccess) so a partial-success backend result still
    // refreshes the cache — pre-fix, a partial import would surface a toast
    // but the panel would keep showing pre-import state until next mount.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["automations"] });
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !window.automationsAPI) return;
    const text = await file.text();
    importFileMutation.mutate(text);
  };

  // Import-bundle uses local state to surface its summary AND error inline
  // rather than via toast (the panel renders both as banners just below the
  // import buttons). Opt out of the helper's toast accordingly. The
  // `"Cancelled"` reason — fired when the user dismisses the file picker —
  // is intentionally treated as success-shape: no error banner, no toast.
  const importBundleMutation = useIpcMutation({
    mutationFn: () => window.automationsAPI.importBundle(),
    fallbackErrorMessage: "Failed to import bundle",
    toastOnError: false,
    onMutate: () => {
      setImportSummary(null);
      setImportError(null);
    },
    onSuccess: (result) => {
      // Success-only side effect (the summary banner) stays here; query
      // invalidation moves to onSettled so a partial-failure import still
      // refreshes the list.
      const wfCount = result.automations?.length ?? 0;
      const skillCount = result.skillsInstalled?.length ?? 0;
      const parts: string[] = [];
      if (wfCount > 0) parts.push(`${wfCount} automation${wfCount !== 1 ? "s" : ""}`);
      if (skillCount > 0) parts.push(`${skillCount} skill${skillCount !== 1 ? "s" : ""}`);
      if (parts.length > 0) setImportSummary(`Imported ${parts.join(" and ")}`);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["automations"] });
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err) => {
      // User-initiated dismissals (file-picker cancel, skipped existing
      // skill, etc.) flow through the mutationFn and reach here as
      // `err.message`. `SKILL_IMPORT_DISMISSED` (common/marshal-ipc-contract.ts)
      // is the canonical set — using the constant means a future addition
      // to that array is honored without touching this panel.
      const dismissals: readonly string[] = SKILL_IMPORT_DISMISSED;
      if (!dismissals.includes(err.message)) setImportError(err.message);
    },
  });
  const handleImportBundle = () => {
    if (!window.automationsAPI) return;
    importBundleMutation.mutate();
  };

  const toggleSkillsAccordion = (wfId: string) => {
    setExpandedSkills((prev) => {
      const next = new Set(prev);
      if (next.has(wfId)) next.delete(wfId);
      else next.add(wfId);
      return next;
    });
  };

  /** Get Skill objects matching an automation's skillNames */
  const getAutomationSkills = (wf: AutomationData): Skill[] => {
    if (!wf.skillNames?.length) return [];
    return skills.filter((s) => wf.skillNames!.includes(s.name));
  };

  if (!isOpen) return null;

  const backAction = () => setView("list");

  return (
    <TelemetryPath_Automations>
      <section
        aria-label="Orchestration"
        className="flex size-full flex-col overflow-hidden bg-card"
      >
        {view === "permissions" && form.permissions ? (
          <PermissionsPanel
            title={`${form.name || "Automation"} — Permissions`}
            onBack={() => setView(editId ? "edit" : "create")}
            permissions={form.permissions}
            onUpdatePermissions={(p) => updateForm({ permissions: p })}
          />
        ) : (
          <>
            {view === "list" ? (
              <SurfaceHeader title="Orchestration" />
            ) : (
              <SurfaceHeader title="Orchestration" onBack={backAction} />
            )}

            {/* Override Radix ScrollArea viewport's display:table wrapper which breaks flex layouts */}
            <ScrollArea className="flex-1 [&_[data-slot=scroll-area-viewport]>div]:block! [&_[data-slot=scroll-area-viewport]>div]:min-w-0!">
              <div className="p-4">
                {view === "list" && (
                  <>
                    <section className="mb-6 flex items-center justify-between gap-4 rounded-lg border border-border bg-background p-4">
                      <div>
                        <h2 className="text-lg font-semibold">Heartbeat</h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Configure recurring checks alongside automations and workflows.
                        </p>
                      </div>
                      <Button variant="outline" size="sm" onClick={onOpenHeartbeat}>
                        Configure
                      </Button>
                    </section>
                    {disableAutomations && (
                      <div
                        data-testid="automations-tenant-disabled"
                        className="mb-4 rounded-lg border border-border bg-muted/50 p-3 text-sm text-muted-foreground"
                      >
                        <Lock size={14} className="mr-1 inline-block" /> Automations are disabled by
                        your organization.
                      </div>
                    )}
                    <AutomationListView
                      automations={automations}
                      skills={skills}
                      runningId={runningId}
                      expandedSkills={expandedSkills}
                      importSummary={importSummary}
                      importError={importError}
                      disableAutomations={disableAutomations}
                      onClearImportSummary={() => setImportSummary(null)}
                      onClearImportError={() => setImportError(null)}
                      onCreate={handleCreate}
                      onEdit={handleEdit}
                      onToggle={handleToggle}
                      onRunNow={handleRunNow}
                      onExport={handleExport}
                      onDeleteClick={handleDeleteClick}
                      onViewHistory={handleViewHistory}
                      onFileSelected={handleFileSelected}
                      onImportBundle={handleImportBundle}
                      onGithubImport={() => setView("github-import")}
                      onToggleSkills={toggleSkillsAccordion}
                      getAutomationSkills={getAutomationSkills}
                    />
                    <Separator className="my-8" />
                    <section aria-labelledby="workflows-heading">
                      <div className="px-4">
                        <h2 id="workflows-heading" className="text-lg font-semibold">
                          Workflows
                        </h2>
                      </div>
                      <PermissionInbox />
                      <WorkflowsListView
                        onOpenWorkflow={(workflowId, repoPath) =>
                          onOpenWorkflow?.(workflowId, repoPath)
                        }
                      />
                    </section>
                  </>
                )}

                {(view === "create" || view === "edit") && (
                  <AutomationFormView
                    key={editId ?? "create"}
                    mode={view === "create" ? "create" : "edit"}
                    state={form}
                    onChange={updateForm}
                    onManagePermissions={() => setView("permissions")}
                    onCustomizePermissions={() => {
                      updateForm({
                        permissions: {
                          ...(globalSettings.permissions ?? DEFAULT_SETTINGS.permissions!),
                        },
                      });
                      setView("permissions");
                    }}
                    onSave={handleSave}
                    onCancel={() => setView("list")}
                  />
                )}

                {view === "history" && (
                  <AutomationHistoryView runs={runs} onBack={() => setView("list")} />
                )}

                {view === "github-import" && (
                  <GithubImportView
                    onBack={() => setView("list")}
                    onImported={async (summary) => {
                      await queryClient.invalidateQueries({ queryKey: ["automations"] });
                      await queryClient.invalidateQueries({ queryKey: ["skills"] });
                      setImportSummary(summary);
                      setView("list");
                    }}
                  />
                )}
              </div>
            </ScrollArea>

            {deleteConfirm && (
              <AutomationDeleteDialog
                deleteConfirm={deleteConfirm}
                onDelete={handleDelete}
                onCancel={() => setDeleteConfirm(null)}
              />
            )}
          </>
        )}
      </section>
    </TelemetryPath_Automations>
  );
}
