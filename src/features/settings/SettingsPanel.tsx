import { DEFAULT_SETTINGS } from "@common/marshal-default-settings";
import type { ExperimentFlags, PermissionsConfig } from "@common/marshal-ipc-contract";
import {
  DEFAULT_RUNTIME_ID,
  canSwitchRuntimeLive,
  getRuntimeDisplayName,
  getRuntimeSelectionMetadata,
} from "@common/runtime-config";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import {
  useState,
  useEffect,
  useRef,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from "react";

import { ThemeMode, applyThemeWithTransition } from "@/app-theme";
import {
  Code,
  Lightbulb,
  Settings as SettingsIcon,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
} from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Switch } from "@/components/marshal-ui/marshal-switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/marshal-ui/marshal-tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SurfaceHeader } from "@/components/ui/surface-header";
import { GatewayNodeSettingsSection } from "@/features/gateway-node/GatewayNodeSettingsSection";
import { PermissionsPanel } from "@/features/permissions/PermissionsPanel";
import { usePermissions } from "@/features/permissions/usePermissionsConfig";
import { cn } from "@/lib/marshal-class-names";
import { TelemetryPath_Settings } from "@/services/telemetry/schema";
import { useIdentity } from "@/shared/hooks/useIdentity";
import { DevErrorTrigger } from "@/shell/ErrorBoundary";
import { SignOutConfirmDialog } from "@/shell/presentation/SignOutConfirmDialog";

import { describePermissions } from "../permissions/permissions-summary-format";
import { DefaultModelPicker } from "./DefaultModelPicker";
import { EditPermissionsDialog } from "./permissions/EditPermissionsDialog";
import { RemoteAccessSection } from "./RemoteAccessSection";
import { RuntimeAccountsSection } from "./runtime-accounts/RuntimeAccountsSection";
import {
  AboutFact,
  AboutSection,
  AppearanceSection,
  PowerManagementSection,
  SessionRetentionSection,
  WindowBehaviorSection,
} from "./Sections";
import { SettingsRow } from "./SettingsRow";
import { SettingsBlock, SettingsNote, SettingsSection } from "./SettingsSection";
import { TierModelPicker } from "./TierModelPicker";
import { useMarshalDefaultWorkspaceDir } from "./useMarshalDefaultWorkspaceDir";
import { useRuntimeStartupSelection, useSettings } from "./useSettings";

interface SettingsPanelProps {
  isOpen: boolean;
  onClose?: () => void;
  onExperimentsChange?: (experiments: ExperimentFlags) => void;
  showHiddenExperiments?: boolean;
  scrollToSection?: string | null;
  onSignOut?: () => void;
}

interface SettingsGroupMeta {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

type ExperimentKey = keyof ExperimentFlags;

export function SettingsPanel({
  isOpen,
  onClose,
  onExperimentsChange,
  showHiddenExperiments,
  scrollToSection,
  onSignOut,
}: SettingsPanelProps) {
  const { settings, persist } = useSettings(isOpen);
  const {
    runtimeSelection,
    isPending: isRuntimeSelectionPending,
    switchRuntime,
    isSwitching: isRuntimeSwitching,
    switchError,
  } = useRuntimeStartupSelection();
  const defaultWorkspaceDir = useMarshalDefaultWorkspaceDir();
  const identity = useIdentity();
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!scrollToSection) return undefined;
    // Delay to ensure the panel content has rendered inside the ScrollArea
    const timer = setTimeout(() => {
      document
        .getElementById(scrollToSection)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 100);
    return () => clearTimeout(timer);
  }, [scrollToSection]);

  const { data: mockMode = false } = useQuery({
    queryKey: ["dev", "mockMode"],
    queryFn: async () => {
      const r = await window.devAPI?.getMockMode?.();
      return r?.enabled ?? false;
    },
    enabled: import.meta.env.DEV,
  });
  const devFeatures = __MARSHAL_DEV_FEATURES__;
  const canEnableDiagnostics = devFeatures;
  const canShowExperiments = devFeatures;
  const queryClient = useQueryClient();
  const { mutate: toggleMockMode } = useMutation({
    mutationFn: (enabled: boolean) =>
      window.devAPI?.setMockMode(enabled) ?? Promise.resolve({ success: false }),
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ["dev", "mockMode"] });
    },
  });
  const [showPermissions, setShowPermissions] = useState(false);
  const [editJsonOpen, setEditJsonOpen] = useState(false);
  const [pendingRuntimeId, setPendingRuntimeId] = useState<string | null>(null);
  const [runtimeSignOutOpen, setRuntimeSignOutOpen] = useState(false);
  const selectedRuntimeId =
    settings.runtimeId ?? runtimeSelection?.requestedRuntimeId ?? DEFAULT_RUNTIME_ID;
  const runtimeOptions = getRuntimeSelectionMetadata(selectedRuntimeId);

  const { envelope, save: savePermissions } = usePermissions();
  const permissions = envelope?.permissions ?? DEFAULT_SETTINGS.permissions!;
  const controllable = envelope?.controllable;

  const updatePermissions = (next: PermissionsConfig) => {
    savePermissions(next);
  };

  const toggleInterceptFileChooser = () =>
    persist({
      ...settings,
      interceptFileChooser: !settings.interceptFileChooser,
    });

  const changeTheme = (theme: ThemeMode, originEl?: HTMLElement | null) => {
    persist({ ...settings, theme });
    applyThemeWithTransition(theme, originEl);
  };

  const toggleExperiment = (key: ExperimentKey, defaultValue: boolean) => {
    const newExperiments = {
      ...settings.experiments,
      [key]: !(settings.experiments?.[key] ?? defaultValue),
    };
    persist({ ...settings, experiments: newExperiments });
    onExperimentsChange?.(newExperiments);
  };

  const pickWorkspaceDirMutation = useMutation({
    mutationFn: async () => {
      if (!window.settingsAPI?.pickWorkspaceDir) throw new Error("pickWorkspaceDir not available");
      const currentPath = settings.workspaceDir ?? defaultWorkspaceDir;
      const result = await window.settingsAPI.pickWorkspaceDir(currentPath);
      if (!result.success || !result.folderPath)
        throw new Error(result.error || "Failed to pick directory");
      return result.folderPath;
    },
    onSuccess: (folderPath) => {
      persist({ ...settings, workspaceDir: folderPath });
    },
  });

  const pickWorkspaceDir = () => pickWorkspaceDirMutation.mutate();

  const pickWorktreeDirMutation = useMutation({
    mutationFn: async () => {
      if (!window.settingsAPI?.pickWorktreeDir) throw new Error("pickWorktreeDir not available");
      const result = await window.settingsAPI.pickWorktreeDir(settings.worktreeDir);
      if (!result.success || !result.folderPath)
        throw new Error(result.error || "Failed to pick directory");
      return result.folderPath;
    },
    onSuccess: (folderPath) => {
      persist({ ...settings, worktreeDir: folderPath });
    },
  });

  const pickWorktreeDir = () => pickWorktreeDirMutation.mutate();

  const showHiddenExperimentsSection =
    canShowExperiments &&
    (showHiddenExperiments ||
      settings.experiments?.titleBarNavigation ||
      settings.experiments?.uiExtensionsSystem);

  const groups: SettingsGroupMeta[] = [
    { id: "settings-group-general", label: "General", icon: SlidersHorizontal },
    { id: "settings-group-ai", label: "AI & models", icon: Sparkles },
    { id: "settings-group-access", label: "Access & devices", icon: ShieldCheck },
    { id: "settings-group-system", label: "System", icon: SettingsIcon },
    ...(canShowExperiments ? [{ id: "settings-group-labs", label: "Labs", icon: Lightbulb }] : []),
    ...(import.meta.env.DEV
      ? [{ id: "settings-group-developer", label: "Developer", icon: Code }]
      : []),
  ];
  const activeGroupId = useActiveGroup(
    viewportRef,
    groups.map((group) => group.id),
    isOpen && !showPermissions,
  );

  if (!isOpen) return null;

  if (showPermissions) {
    return (
      <>
        <PermissionsPanel
          onBack={() => setShowPermissions(false)}
          onClose={onClose}
          permissions={permissions}
          onUpdatePermissions={updatePermissions}
          controllable={controllable}
          interceptFileChooser={settings.interceptFileChooser ?? false}
          onToggleInterceptFileChooser={toggleInterceptFileChooser}
          showEditJson
          onEditJson={() => setEditJsonOpen(true)}
          hasUnrepresentablePatterns={envelope?.hasUnrepresentablePatterns}
        />
        <EditPermissionsDialog
          open={editJsonOpen}
          onOpenChange={setEditJsonOpen}
          permissions={permissions}
          onSave={updatePermissions}
        />
      </>
    );
  }

  const activeRuntimeName = isRuntimeSelectionPending
    ? "Loading…"
    : getRuntimeDisplayName(runtimeSelection?.runtimeId ?? DEFAULT_RUNTIME_ID);

  return (
    <TelemetryPath_Settings>
      <div className="flex size-full flex-col overflow-hidden" data-testid="settings-panel">
        <SurfaceHeader title="Settings" onClose={onClose} />
        <ScrollArea className="flex-1 bg-background" viewportRef={viewportRef}>
          <div className="@container">
            <div className="mx-auto flex w-full max-w-5xl gap-8 px-4 pt-5 pb-16 @3xl:px-8 @3xl:pt-8">
              <SettingsNav
                groups={groups}
                activeGroupId={activeGroupId}
                className="sticky top-8 hidden w-48 shrink-0 self-start @3xl:flex"
              />
              <div className="flex min-w-0 flex-1 flex-col gap-10">
                <SettingsNav
                  groups={groups}
                  activeGroupId={activeGroupId}
                  compact
                  className="sticky top-0 z-10 -mx-4 -mt-5 flex border-b border-border/60 bg-background/95 px-4 py-2 backdrop-blur-sm @3xl:hidden"
                />

                <AboutSection isOpen={isOpen}>
                  <AboutFact label="Runtime" value={activeRuntimeName} />
                  <AboutFact
                    label="Theme"
                    value={THEME_LABELS[settings.theme || "system"] ?? "System"}
                  />
                </AboutSection>

                <SettingsGroup meta={groups[0]}>
                  <SettingsSection title="Appearance">
                    <AppearanceSection
                      theme={settings.theme || "system"}
                      onThemeChange={changeTheme}
                    />
                  </SettingsSection>

                  <SettingsSection
                    title="Workspaces"
                    description="Where Marshal creates new workspaces and files."
                  >
                    <SettingsRow label="Default file location">
                      <PathField
                        value={settings.workspaceDir ?? defaultWorkspaceDir ?? "Not available"}
                      >
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={pickWorkspaceDir}
                          disabled={pickWorkspaceDirMutation.isPending}
                        >
                          Browse
                        </Button>
                      </PathField>
                    </SettingsRow>
                    <SettingsNote>Changes take effect after you restart Marshal.</SettingsNote>
                  </SettingsSection>

                  <SettingsSection title="Data retention">
                    <SessionRetentionSection settings={settings} onSaveSettings={persist} />
                  </SettingsSection>
                </SettingsGroup>

                <SettingsGroup meta={groups[1]}>
                  <SettingsSection
                    title="Runtime adapters"
                    description="The AI runtime that serves your chats."
                  >
                    <SettingsRow
                      label="Active AI runtime"
                      description="The adapter currently serving new and resumed chats."
                    >
                      <StatusPill>{activeRuntimeName}</StatusPill>
                    </SettingsRow>
                    {onSignOut && (
                      <SettingsRow
                        label="Runtime account"
                        description="Sign out to authenticate this runtime with a different account or credential."
                      >
                        <div className="flex flex-wrap items-center gap-3">
                          <span className="text-sm font-medium">
                            {identity.subtitle ?? identity.displayName}
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setRuntimeSignOutOpen(true)}
                          >
                            Sign out
                          </Button>
                        </div>
                      </SettingsRow>
                    )}
                    <SettingsRow
                      label="AI runtime"
                      description="Copilot, Codex, Claude, and Cursor switch immediately. Gateway changes still require a restart."
                    >
                      <Select
                        value={selectedRuntimeId}
                        onValueChange={(runtimeId) => {
                          if (runtimeId !== selectedRuntimeId) {
                            setPendingRuntimeId(runtimeId);
                          }
                        }}
                      >
                        <SelectTrigger className="w-48 rounded-xl" aria-label="AI runtime">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {runtimeOptions.map((runtime) => (
                            <SelectItem
                              key={runtime.id}
                              value={runtime.id}
                              disabled={!runtime.selectable && runtime.id !== selectedRuntimeId}
                            >
                              {runtime.displayName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </SettingsRow>
                    <RuntimeConfirmDialog
                      open={pendingRuntimeId !== null}
                      currentRuntimeId={runtimeSelection?.runtimeId ?? DEFAULT_RUNTIME_ID}
                      targetRuntimeId={pendingRuntimeId ?? selectedRuntimeId}
                      isPending={isRuntimeSwitching}
                      error={switchError}
                      onOpenChange={(open) => {
                        if (!open) setPendingRuntimeId(null);
                      }}
                      onConfirm={async () => {
                        if (!pendingRuntimeId) return;
                        try {
                          await switchRuntime(pendingRuntimeId);
                          setPendingRuntimeId(null);
                        } catch {
                          // The mutation error is rendered inside the dialog.
                        }
                      }}
                    />
                    <SignOutConfirmDialog
                      open={runtimeSignOutOpen}
                      onOpenChange={setRuntimeSignOutOpen}
                      onConfirm={() => onSignOut?.()}
                      title={identity.signOut.title}
                      description={identity.signOut.description}
                      confirmLabel={identity.signOut.confirmLabel}
                    />
                  </SettingsSection>

                  {window.runtimeAccountsAPI && (
                    <SettingsSection title="Runtime accounts" id="runtime-accounts-section">
                      <SettingsBlock>
                        <RuntimeAccountsSection isOpen={isOpen} />
                      </SettingsBlock>
                    </SettingsSection>
                  )}

                  <SettingsSection
                    title="Default model"
                    description="Used for new chats unless you pick another model in the composer."
                  >
                    <DefaultModelPicker enabled={isOpen} />
                  </SettingsSection>

                  <SettingsSection
                    title="Subagents & workflows"
                    description="Models and worktree location for delegated work."
                  >
                    <TierModelPicker tier="subagent" label="subagents" enabled={isOpen} />
                    <TierModelPicker tier="workflow" label="workflows" enabled={isOpen} />
                    <SettingsRow
                      label="New worktree location"
                      description="Root folder for future subagent git worktrees. Existing worktrees stay where they are."
                    >
                      <PathField
                        value={settings.worktreeDir ?? "Default (~/.marshal/marshal-worktrees)"}
                      >
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label="Browse worktree location"
                          onClick={pickWorktreeDir}
                          disabled={pickWorktreeDirMutation.isPending}
                        >
                          Browse
                        </Button>
                        {settings.worktreeDir && (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label="Reset worktree location"
                            onClick={() => persist({ ...settings, worktreeDir: undefined })}
                          >
                            Reset
                          </Button>
                        )}
                      </PathField>
                    </SettingsRow>
                  </SettingsSection>
                </SettingsGroup>

                <SettingsGroup meta={groups[2]}>
                  <PermissionsSummaryCard
                    permissions={permissions}
                    onManage={() => setShowPermissions(true)}
                  />
                  <RemoteAccessSection />
                  <GatewayNodeSettingsSection />
                </SettingsGroup>

                <SettingsGroup meta={groups[3]}>
                  <SettingsSection title="Window behavior">
                    <WindowBehaviorSection
                      isOpen={isOpen}
                      settings={settings}
                      onSaveSettings={persist}
                    />
                  </SettingsSection>

                  <SettingsSection title="Power management" id="power-management-section">
                    <PowerManagementSection
                      settings={settings}
                      onSaveSettings={persist}
                      showMouseWiggle={devFeatures}
                    />
                  </SettingsSection>

                  {canEnableDiagnostics && (
                    <SettingsSection title="Diagnostic logs">
                      <SettingsRow
                        label="Log file"
                        description="Marshal writes structured logs to a local file for troubleshooting. No data is sent automatically — you can share the file with support when needed."
                      >
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void window.diagnosticsAPI?.revealLogFolder()}
                        >
                          Show log file in {window.platform === "darwin" ? "Finder" : "Explorer"}
                        </Button>
                      </SettingsRow>
                    </SettingsSection>
                  )}
                </SettingsGroup>

                {canShowExperiments && (
                  <SettingsGroup meta={groups.find((group) => group.id === "settings-group-labs")!}>
                    <SettingsSection
                      title="Experiments"
                      description="Early features. They may change or go away."
                    >
                      <ExperimentToggle
                        label="Lean system prompt"
                        description="New Claude sessions use shorter tooling, host-tool and runtime sections, and fewer duplicate native tools. Turn off to restore them; existing sessions keep what they started with."
                        checked={settings.experiments?.leanPrompt ?? true}
                        onToggle={() => toggleExperiment("leanPrompt", true)}
                      />
                      <ExperimentToggle
                        label="Lean repository rules"
                        description="New Claude sessions get an index of large always-apply repository rule files (read on demand) instead of their full text, and duplicate rule copies are omitted. Turn off to inline them as before."
                        checked={settings.experiments?.leanRepoRules ?? true}
                        onToggle={() => toggleExperiment("leanRepoRules", true)}
                      />
                      <ExperimentToggle
                        label="Lean behavior core"
                        description="New Claude sessions use a rewritten, shorter core behavior prompt. Turn off to restore the full core text; existing sessions keep what they started with."
                        checked={settings.experiments?.leanCore ?? true}
                        onToggle={() => toggleExperiment("leanCore", true)}
                      />
                    </SettingsSection>

                    {showHiddenExperimentsSection && (
                      <SettingsSection title="Hidden Experiments">
                        <ExperimentToggle
                          label="Title Bar Navigation"
                          description="Show back/forward navigation buttons in the title bar."
                          checked={settings.experiments?.titleBarNavigation ?? false}
                          onToggle={() => toggleExperiment("titleBarNavigation", false)}
                        />
                        <ExperimentToggle
                          label="UI Plugins"
                          description="Enable the UI Plugins tab in the Plugins panel. Allows first-party plugins to contribute UI slots."
                          checked={settings.experiments?.uiExtensionsSystem ?? false}
                          onToggle={() => toggleExperiment("uiExtensionsSystem", false)}
                        />
                      </SettingsSection>
                    )}
                  </SettingsGroup>
                )}

                {import.meta.env.DEV && (
                  <SettingsGroup
                    meta={groups.find((group) => group.id === "settings-group-developer")!}
                  >
                    <SettingsSection title="Developer">
                      <SettingsRow htmlFor="mock-mode-switch" label="Mock conversation mode">
                        <Switch
                          id="mock-mode-switch"
                          checked={mockMode}
                          onCheckedChange={() => {
                            toggleMockMode(!mockMode);
                          }}
                        />
                      </SettingsRow>
                    </SettingsSection>

                    <SettingsSection
                      title="Mini Mode Test Notifications"
                      description="Click a button, then minimize to mini mode within 5 seconds to see the notification."
                    >
                      <SettingsBlock className="flex-row flex-wrap gap-2">
                        {MINI_MODE_TEST_NOTIFICATIONS.map(([kind, label]) => (
                          <Button
                            key={kind}
                            variant="outline"
                            size="sm"
                            onClick={() => window.devAPI?.testMiniModeNotification(kind, 5000)}
                          >
                            {label}
                          </Button>
                        ))}
                      </SettingsBlock>
                    </SettingsSection>

                    <SettingsSection title="Error Boundary Test">
                      <SettingsBlock>
                        <DevErrorTrigger />
                      </SettingsBlock>
                    </SettingsSection>
                  </SettingsGroup>
                )}
              </div>
            </div>
          </div>
        </ScrollArea>
      </div>
    </TelemetryPath_Settings>
  );
}

const THEME_LABELS: Record<string, string> = { system: "System", light: "Light", dark: "Dark" };

const MINI_MODE_TEST_NOTIFICATIONS = [
  ["heartbeat-urgent", "⚠️ Heartbeat Urgent"],
  ["heartbeat-error", "❌ Heartbeat Error"],
  ["heartbeat-ok", "✅ Heartbeat OK"],
  ["automation-complete", "✅ Automation Complete"],
  ["automation-failed", "❌ Automation Failed"],
  ["approval", "🔐 Approval"],
] as const;

/**
 * Tracks which settings group is under the top of the scroll viewport so the
 * category nav can highlight it.
 */
function useActiveGroup(
  viewportRef: RefObject<HTMLDivElement | null>,
  groupIds: string[],
  enabled: boolean,
): string | undefined {
  const [activeId, setActiveId] = useState<string | undefined>(groupIds[0]);
  const groupKey = groupIds.join("|");

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!enabled || !viewport) return undefined;
    const ids = groupKey.split("|");
    const update = () => {
      const top = viewport.getBoundingClientRect().top;
      let current = ids[0];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top - top <= 120) current = id;
      }
      if (viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 4) {
        current = ids[ids.length - 1];
      }
      setActiveId(current);
    };
    update();
    viewport.addEventListener("scroll", update, { passive: true });
    return () => viewport.removeEventListener("scroll", update);
  }, [viewportRef, groupKey, enabled]);

  return activeId;
}

function SettingsNav({
  groups,
  activeGroupId,
  compact = false,
  className,
}: {
  groups: SettingsGroupMeta[];
  activeGroupId: string | undefined;
  compact?: boolean;
  className?: string;
}) {
  return (
    <nav
      aria-label={compact ? "Settings categories" : "Settings sections"}
      className={cn(compact ? "gap-1 overflow-x-auto" : "flex-col gap-0.5", className)}
    >
      {groups.map(({ id, label, icon: Icon }) => {
        const active = id === activeGroupId;
        return (
          <Button
            key={id}
            variant="ghost"
            size="sm"
            aria-current={active ? "true" : undefined}
            onClick={() =>
              document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
            className={cn(
              "shrink-0 justify-start gap-2.5 rounded-lg font-normal text-muted-foreground",
              compact ? "h-8 px-3" : "h-9 w-full px-3",
              active && "bg-brand-subtle font-medium text-brand-action hover:bg-brand-subtle",
            )}
          >
            <Icon className="size-4 shrink-0" />
            {label}
          </Button>
        );
      })}
    </nav>
  );
}

function SettingsGroup({ meta, children }: { meta: SettingsGroupMeta; children: ReactNode }) {
  const Icon = meta.icon;
  return (
    <div id={meta.id} className="flex scroll-mt-14 flex-col gap-4 @3xl:scroll-mt-8">
      <h2 className="flex items-center gap-2 px-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        <Icon className="size-3.5" />
        {meta.label}
      </h2>
      {children}
    </div>
  );
}

function StatusPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/40 px-3 py-1 text-sm font-medium">
      {children}
    </span>
  );
}

function PathField({ value, children }: { value: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span
        className="block w-[320px] max-w-full overflow-x-auto rounded-lg border border-border/70 bg-muted/40 px-3 py-1.5 font-mono text-xs whitespace-nowrap text-foreground"
        title={value}
      >
        {value}
      </span>
      {children}
    </div>
  );
}

function PermissionsSummaryCard({
  permissions,
  onManage,
}: {
  permissions: PermissionsConfig;
  onManage: () => void;
}) {
  const facts = [
    { label: "Autopilot", on: permissions.autopilotMode ?? false },
    { label: "Read-only auto-approve", on: permissions.autoApproveReadOnly },
    { label: "AI can request changes", on: permissions.allowModelPermissionsChange ?? false },
  ];
  return (
    <SettingsSection
      title="Permissions"
      description="Control which tools agents can use and what runs without asking."
      action={
        <Button size="sm" data-testid="manage-permissions-btn" onClick={onManage}>
          Manage Permissions
        </Button>
      }
    >
      <SettingsRow
        label={describePermissions(permissions)}
        description={
          permissions.autopilotMode
            ? "Autopilot mode auto-approves user-allowable requests"
            : permissions.autoApproveReadOnly
              ? "Read-only operations auto-approved"
              : undefined
        }
      >
        <ShieldCheck className="hidden size-5 text-brand-action sm:block" />
      </SettingsRow>
      <SettingsBlock className="grid grid-cols-1 gap-2 @xl:grid-cols-3">
        {facts.map((fact) => (
          <div
            key={fact.label}
            className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2"
          >
            <span className="text-xs text-muted-foreground">{fact.label}</span>
            <span
              className={cn(
                "text-xs font-semibold",
                fact.on ? "text-status-success-fg" : "text-muted-foreground",
              )}
            >
              {fact.on ? "On" : "Off"}
            </span>
          </div>
        ))}
      </SettingsBlock>
    </SettingsSection>
  );
}

function ExperimentToggle({
  label,
  description,
  checked,
  onToggle,
  disabled,
  disabledTooltip,
}: {
  label: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
  disabledTooltip?: string;
}) {
  const id = `experiment-${label.toLowerCase().replace(/\s+/g, "-")}`;
  const switchEl = (
    <Switch id={id} checked={checked} onCheckedChange={onToggle} disabled={disabled} />
  );
  return (
    <SettingsRow htmlFor={id} label={label} description={description}>
      {disabled && disabledTooltip ? (
        <Tooltip>
          {/* Disabled <button> elements don't fire pointer events, so the
              tooltip can't open. Wrap in a focusable span as a hover/focus
              target. */}
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              className="inline-flex rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              {switchEl}
            </span>
          </TooltipTrigger>
          <TooltipContent>{disabledTooltip}</TooltipContent>
        </Tooltip>
      ) : (
        switchEl
      )}
    </SettingsRow>
  );
}

function RuntimeConfirmDialog({
  open,
  currentRuntimeId,
  targetRuntimeId,
  isPending,
  error,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  currentRuntimeId: string;
  targetRuntimeId: string;
  isPending: boolean;
  error: Error | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const switchesLive = canSwitchRuntimeLive(currentRuntimeId, targetRuntimeId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Switch to {getRuntimeDisplayName(targetRuntimeId)}?</DialogTitle>
          <DialogDescription>
            {switchesLive
              ? `Marshal will use ${getRuntimeDisplayName(targetRuntimeId)} for new chats. Existing chats transfer their context only when you continue them in this runtime.`
              : `Marshal will use ${getRuntimeDisplayName(targetRuntimeId)} after you restart. Sessions from ${getRuntimeDisplayName(currentRuntimeId)} remain stored but are hidden while the new runtime is active.`}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={isPending} onClick={onConfirm}>
            {isPending ? "Switching…" : switchesLive ? "Switch now" : "Use after restart"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
