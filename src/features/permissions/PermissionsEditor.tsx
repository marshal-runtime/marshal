import { MCP_SERVER_CONFIG_KEYS, PERMISSION_SERVERS } from "@common/marshal-permission-servers";
import type { ComponentType, ReactNode } from "react";

import {
  AlertTriangle,
  Bot,
  Building2,
  Eye,
  Folder,
  Lock,
  Plug,
  RefreshCw,
  Rocket,
  Terminal,
} from "@/components/icons";
import { Alert, AlertDescription } from "@/components/marshal-ui/alert";
import { Label } from "@/components/marshal-ui/label";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Switch } from "@/components/marshal-ui/marshal-switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/marshal-ui/marshal-tooltip";
import { useRelayAvailable } from "@/features/integrations/useRelayAvailability";
import { cn } from "@/lib/marshal-class-names";
import {
  InteractiveElementMonitor_AllowModelPermissionsChange,
  InteractiveElementMonitor_AutoApprove,
  InteractiveElementMonitor_EditPermissions,
  InteractiveElementMonitor_RefreshMcpTools,
} from "@/services/telemetry/schema";
import { useTenantPolicy } from "@/shared/hooks/useTenantPolicy";
import type { PermissionsConfig, PermissionsControllableMap } from "@/types/electron";

import { FolderAccessSection } from "./FolderAccessSection";
import { SensitivePathsSection } from "./SensitivePathsSection";
import { ShellPatternsSection } from "./ShellPatternsSection";
import { getToolDescription } from "./tool-descriptions";
import { ToolGroupSection } from "./ToolGroupSection";
import { useToolRegistry } from "./usePermissionsToolRegistry";

/** Non-MCP servers (SDK capabilities) shown in the Servers section */
const SDK_SERVERS = PERMISSION_SERVERS.filter((s) => !MCP_SERVER_CONFIG_KEYS.has(s.configKey));

export interface PermissionsEditorProps {
  permissions: PermissionsConfig;
  onUpdatePermissions: (permissions: PermissionsConfig) => void;
  /** Per-field controllable flags. When unset, treat as all-true (legacy callers). */
  controllable?: PermissionsControllableMap;
  /** Show the file-chooser toggle (global panel only) */
  interceptFileChooser?: boolean;
  onToggleInterceptFileChooser?: () => void;
  /** Show "Edit raw JSON" button */
  showEditJson?: boolean;
  onEditJson?: () => void;
  /**
   * When true, the marshal config contains tool-name globs or strict allowlists
   * that cannot be represented as per-tool boolean toggles. A banner is shown
   * directing the user to the raw JSON editor for full fidelity.
   */
  hasUnrepresentablePatterns?: boolean;
}

export function PermissionsEditor({
  permissions,
  onUpdatePermissions,
  controllable,
  interceptFileChooser,
  onToggleInterceptFileChooser,
  showEditJson = false,
  onEditJson,
  hasUnrepresentablePatterns,
}: PermissionsEditorProps) {
  const { categories, loading } = useToolRegistry();
  const tenantPolicy = useTenantPolicy();
  const showRelayNotificationTools = useRelayAvailable();
  const isForcePrompt = tenantPolicy.forcePrompt;

  const ctrl: PermissionsControllableMap = controllable ?? {
    tools: { enabled: true },
    autopilotMode: { enabled: true },
    autoApproveReadOnly: { enabled: true },
    shellAllow: { enabled: true },
    shellDeny: { enabled: true },
    serverEnabled: { enabled: true },
    serverAutoApprove: { enabled: true },
    perHeartbeatScope: { enabled: true },
  };

  // Gateway mode has a restricted shell-pattern surface (only bare binary
  // names round-trip to marshal's `tools.exec.safeBins`). In copilot mode,
  // `controllable` is undefined or all-true, so this filter produces an
  // empty list and no warning chips render.
  const isRestrictedShellSurface = controllable !== undefined && !ctrl.shellDeny.enabled;
  const SHELL_PATTERN_BINARY_ONLY = /^[a-zA-Z0-9._/-]+$/;
  const unrepresentablePatterns = isRestrictedShellSurface
    ? permissions.allow.filter((p) => !SHELL_PATTERN_BINARY_ONLY.test(p.trim()))
    : [];
  const discovering = categories.some(
    (c) => c.key === "mcp" && c.groups.some((g) => g.status === "loading"),
  );

  const getServer = (key: string) =>
    permissions.servers[key] ?? { enabled: true, autoApprove: false };

  const toggleServerEnabled = (configKey: string) => {
    const current = getServer(configKey);
    onUpdatePermissions({
      ...permissions,
      servers: {
        ...permissions.servers,
        [configKey]: { ...current, enabled: !current.enabled },
      },
    });
  };

  const toggleServerAutoApprove = (configKey: string) => {
    const current = getServer(configKey);
    onUpdatePermissions({
      ...permissions,
      servers: {
        ...permissions.servers,
        [configKey]: { ...current, autoApprove: !current.autoApprove },
      },
    });
  };

  const toolReadEnabled = permissions.tools["tool:read"] ?? false;
  const toggleToolRead = () =>
    onUpdatePermissions({
      ...permissions,
      tools: { ...permissions.tools, "tool:read": !toolReadEnabled },
    });

  const toggleAutoApproveSafeCommands = () => {
    onUpdatePermissions({
      ...permissions,
      autoApproveReadOnly: !permissions.autoApproveReadOnly,
    });
  };

  const toggleAutopilotMode = () => {
    onUpdatePermissions({
      ...permissions,
      autopilotMode: !(permissions.autopilotMode ?? false),
    });
  };

  const toggleAllowModelPermissionsChange = () => {
    onUpdatePermissions({
      ...permissions,
      allowModelPermissionsChange: !(permissions.allowModelPermissionsChange ?? false),
    });
  };

  const lockedSwitch = (checked: boolean, reason: string | undefined, label?: string) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Switch checked={checked} disabled aria-label={label} />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{reason}</TooltipContent>
    </Tooltip>
  );

  return (
    <div className="flex flex-col gap-6">
      {tenantPolicy.managed && (
        <div
          className="flex items-center gap-2 self-start rounded-full border border-border/70 bg-muted/40 px-3 py-1 text-xs text-muted-foreground"
          data-testid="tenant-managed-banner"
        >
          <Building2 size={12} />
          <span>Managed by your organization</span>
        </div>
      )}

      <PermissionCard
        title="Approval mode"
        description="Decide how often Marshal stops to ask before agents act."
      >
        <div className="grid gap-2 py-4 @2xl:grid-cols-3">
          <ModeTile
            icon={Rocket}
            title="Autopilot mode"
            description={
              <>
                Auto-approve all user-allowable permission requests for agents and subagents. Your
                organization&apos;s policy blocks and required prompts still apply.
              </>
            }
            active={permissions.autopilotMode ?? false}
            locked={isForcePrompt}
            lockTestId="tenant-lock-autopilot-mode"
          >
            {ctrl.autopilotMode.enabled ? (
              <InteractiveElementMonitor_AutoApprove callback={toggleAutopilotMode}>
                {(cb) => (
                  <Switch
                    checked={permissions.autopilotMode ?? false}
                    onCheckedChange={cb}
                    disabled={isForcePrompt}
                    aria-label="Autopilot mode"
                  />
                )}
              </InteractiveElementMonitor_AutoApprove>
            ) : (
              lockedSwitch(permissions.autopilotMode ?? false, ctrl.autopilotMode.disabledReason)
            )}
          </ModeTile>

          <ModeTile
            icon={Eye}
            title="Auto-approve read-only operations"
            description={getToolDescription("autoApproveReadOnly")}
            active={permissions.autoApproveReadOnly}
            locked={isForcePrompt}
            lockTestId="tenant-lock-auto-approve"
          >
            {ctrl.autoApproveReadOnly.enabled ? (
              <InteractiveElementMonitor_AutoApprove callback={toggleAutoApproveSafeCommands}>
                {(cb) => (
                  <Switch
                    checked={permissions.autoApproveReadOnly}
                    onCheckedChange={cb}
                    disabled={isForcePrompt}
                  />
                )}
              </InteractiveElementMonitor_AutoApprove>
            ) : (
              lockedSwitch(permissions.autoApproveReadOnly, ctrl.autoApproveReadOnly.disabledReason)
            )}
          </ModeTile>

          <ModeTile
            icon={Bot}
            title="Allow AI to request permission changes"
            description="When enabled, the AI can propose permission changes in chat — each requires your explicit approval."
            active={permissions.allowModelPermissionsChange ?? false}
          >
            <InteractiveElementMonitor_AllowModelPermissionsChange
              callback={toggleAllowModelPermissionsChange}
            >
              {(cb) => (
                <Switch
                  checked={permissions.allowModelPermissionsChange ?? false}
                  onCheckedChange={cb}
                  aria-label="Allow AI to request permission changes"
                />
              )}
            </InteractiveElementMonitor_AllowModelPermissionsChange>
          </ModeTile>
        </div>
      </PermissionCard>

      <PermissionCard
        title="Capabilities"
        description="Built-in abilities agents can use. Turn one off to block it entirely."
      >
        {SDK_SERVERS.map((server) => {
          const config = getServer(server.configKey);
          const lockedByTenant =
            tenantPolicy?.isServerDisabledByTenant(server.displayName) ?? false;
          const serverDescription = getToolDescription(server.configKey);
          // Shell gets its own description ("Runs shell commands without
          // stopping to ask for approval each time.") because the generic
          // "every tool from this server" copy reads awkwardly for a single
          // capability; every other SDK server and every MCP server
          // (handled in ToolGroupSection) uses the generic serverAutoApprove
          // text. Restored after PR review.
          const serverAutoApproveDescription =
            server.configKey === "shell"
              ? getToolDescription("shellAutoApprove")
              : getToolDescription("serverAutoApprove");
          const CapabilityIcon = CAPABILITY_ICONS[server.configKey] ?? Plug;
          return (
            <div key={server.configKey} className="border-b border-border/60 py-3.5">
              <div className={cn(!config.enabled && "opacity-50")}>
                <Label className="flex w-full cursor-pointer items-start justify-between gap-3 overflow-clip">
                  <div className="flex min-w-0 items-start gap-3">
                    <IconChip icon={CapabilityIcon} active={config.enabled} />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-sm font-medium">
                        {server.configKey === "shell"
                          ? "Shell (terminal commands)"
                          : server.displayName}
                      </span>
                      {serverDescription && (
                        <span className="text-xs/5 font-normal text-muted-foreground">
                          {serverDescription}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 pt-0.5">
                    {lockedByTenant && (
                      <Lock
                        size={14}
                        className="text-muted-foreground"
                        data-testid={`tenant-lock-${server.displayName}`}
                      />
                    )}
                    {ctrl.serverEnabled.enabled ? (
                      <Switch
                        checked={config.enabled}
                        onCheckedChange={() => toggleServerEnabled(server.configKey)}
                        disabled={lockedByTenant}
                        data-testid={`${server.configKey}-server-enabled`}
                      />
                    ) : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>
                            <Switch
                              checked={config.enabled}
                              disabled
                              data-testid={`${server.configKey}-server-enabled`}
                            />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          {ctrl.serverEnabled.disabledReason}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </Label>
              </div>
              {config.enabled && (
                <div className="mt-3 ml-11 flex flex-col gap-1 rounded-xl border border-border/60 bg-muted/25 px-3 py-2">
                  <Label className="flex cursor-pointer items-start justify-between gap-3 py-1">
                    <div className="flex min-w-0 flex-col">
                      <span className="text-[13px] font-normal text-foreground">
                        Auto-approve without asking
                      </span>
                      {serverAutoApproveDescription && (
                        <span className="text-xs font-normal text-muted-foreground">
                          {serverAutoApproveDescription}
                        </span>
                      )}
                    </div>
                    {ctrl.serverAutoApprove.enabled ? (
                      <Switch
                        checked={config.autoApprove}
                        onCheckedChange={() => toggleServerAutoApprove(server.configKey)}
                        disabled={isForcePrompt || lockedByTenant}
                        data-testid={`${server.configKey}-server-auto-approve`}
                      />
                    ) : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>
                            <Switch
                              checked={config.autoApprove}
                              disabled
                              data-testid={`${server.configKey}-server-auto-approve`}
                            />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          {ctrl.serverAutoApprove.disabledReason}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </Label>
                  {server.configKey === "filesystem" && (
                    <>
                      {/* Intentionally NOT wrapped in InteractiveElementMonitor: grouped with the
                          per-server toggles above (serverEnabled/serverAutoApprove), which are also
                          unwrapped — not with the top-level AutoApprove switch. */}
                      <Label className="flex cursor-pointer items-start justify-between gap-3 border-t border-border/50 py-1 pt-2">
                        <div className="flex min-w-0 flex-col">
                          <span className="text-[13px] font-normal text-foreground">
                            Auto-approve file reads
                          </span>
                          <span className="text-xs font-normal text-muted-foreground">
                            Auto-approve in-workspace file reads (view / grep / glob). Sensitive
                            paths still prompt; out-of-workspace reads require a Folder access
                            grant.
                          </span>
                        </div>
                        {ctrl.serverAutoApprove.enabled ? (
                          <Switch
                            checked={toolReadEnabled}
                            onCheckedChange={toggleToolRead}
                            disabled={isForcePrompt || lockedByTenant}
                            aria-label="Auto-approve file reads"
                            data-testid="tool-read-enabled"
                          />
                        ) : (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>
                                <Switch
                                  checked={toolReadEnabled}
                                  disabled
                                  aria-label="Auto-approve file reads"
                                  data-testid="tool-read-enabled"
                                />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              {ctrl.serverAutoApprove.disabledReason}
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </Label>
                      <div className="border-t border-border/50 pt-1">
                        <FolderAccessSection
                          permissions={permissions}
                          onUpdate={onUpdatePermissions}
                          disabled={isForcePrompt || lockedByTenant}
                        />
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </PermissionCard>

      {hasUnrepresentablePatterns && (
        <Alert
          className="border-status-warning-border bg-status-warning-bg text-status-warning-fg"
          data-testid="unrepresentable-patterns-banner"
        >
          <AlertTriangle className="size-4" />
          <AlertDescription>
            <strong>Tool patterns detected.</strong> The marshal config has tool-name patterns
            (globs or strict allowlist) that can&apos;t be represented as per-tool toggles. Use the{" "}
            <strong>Edit raw JSON</strong> button below to modify them.
          </AlertDescription>
        </Alert>
      )}

      {loading && (
        <div className="rounded-2xl border border-dashed border-border/70 px-5 py-4 text-sm text-muted-foreground">
          Loading tools...
        </div>
      )}

      {categories.map((category) => {
        const visibleGroups = category.groups.filter((group) => {
          if (group.key === "tool:notifications") return showRelayNotificationTools;
          return true;
        });
        if (visibleGroups.length === 0) return null;

        return (
          <PermissionCard
            key={category.key}
            title={category.name}
            action={
              category.key === "mcp" ? (
                <InteractiveElementMonitor_RefreshMcpTools
                  callback={() => window.mcpsAPI?.rediscover()}
                >
                  {(cb) => (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={cb}
                          disabled={discovering}
                          aria-label="Refresh MCP tools"
                        >
                          <RefreshCw size={14} className={discovering ? "animate-spin" : ""} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {discovering ? "Discovering tools…" : "Re-discover MCP tools"}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </InteractiveElementMonitor_RefreshMcpTools>
              ) : undefined
            }
          >
            <div className="divide-y divide-border/60">
              {visibleGroups.map((group) => {
                const serverKey = group.key.startsWith("mcp:") ? group.key.slice(4) : undefined;
                const isMcpServer = serverKey && MCP_SERVER_CONFIG_KEYS.has(serverKey);
                const serverState = serverKey ? permissions.servers[serverKey] : undefined;
                const serverDisabled = serverState?.enabled === false;
                const serverAutoApprove = serverState?.autoApprove === true;

                const mcpLockedByTenant = isMcpServer
                  ? tenantPolicy.isServerDisabledByTenant(group.name)
                  : false;

                return (
                  <div key={group.key} className="py-1.5">
                    <ToolGroupSection
                      group={group}
                      permissions={permissions}
                      onUpdate={onUpdatePermissions}
                      disabled={serverDisabled || mcpLockedByTenant}
                      serverAutoApprove={serverAutoApprove}
                      forcePrompt={isForcePrompt}
                      controllable={ctrl}
                      serverConfig={
                        isMcpServer
                          ? {
                              configKey: serverKey,
                              enabled: serverState?.enabled ?? true,
                              autoApprove: serverState?.autoApprove ?? false,
                              onToggleEnabled: () => toggleServerEnabled(serverKey),
                              onToggleAutoApprove: () => toggleServerAutoApprove(serverKey),
                              lockedByTenant: mcpLockedByTenant,
                            }
                          : undefined
                      }
                      extraControls={
                        serverKey === "playwright" && onToggleInterceptFileChooser ? (
                          <Label className="flex cursor-pointer items-start justify-between gap-3 py-1">
                            <div className="flex min-w-0 flex-col">
                              <span className="text-sm font-normal text-muted-foreground">
                                Allow agent file uploads
                              </span>
                              <span className="text-xs text-muted-foreground/70">
                                {getToolDescription("interceptFileChooser")}
                              </span>
                            </div>
                            <Switch
                              checked={interceptFileChooser}
                              onCheckedChange={onToggleInterceptFileChooser}
                            />
                          </Label>
                        ) : undefined
                      }
                    />
                  </div>
                );
              })}
            </div>
          </PermissionCard>
        );
      })}

      <PermissionCard
        title="Shell Commands"
        description="Command patterns that run without asking. Anything else still prompts."
      >
        <div className="py-4">
          <ShellPatternsSection
            permissions={permissions}
            onUpdate={onUpdatePermissions}
            disabled={isForcePrompt}
            unrepresentablePatterns={unrepresentablePatterns}
          />
        </div>
      </PermissionCard>

      <PermissionCard
        title="Sensitive path overrides"
        description="These locations are blocked by default. Entries below have been explicitly permitted."
      >
        <div className="py-4">
          <SensitivePathsSection
            permissions={permissions}
            onUpdate={onUpdatePermissions}
            disabled={isForcePrompt}
          />
        </div>
      </PermissionCard>

      {showEditJson && onEditJson && (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-dashed border-border/70 px-5 py-3.5">
          <span className="text-xs text-muted-foreground">
            Need something the toggles can&apos;t express? Edit the raw configuration.
          </span>
          <InteractiveElementMonitor_EditPermissions callback={onEditJson}>
            {(cb) => (
              <Button variant="outline" size="sm" onClick={cb}>
                Edit raw JSON
              </Button>
            )}
          </InteractiveElementMonitor_EditPermissions>
        </div>
      )}
    </div>
  );
}

const CAPABILITY_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  shell: Terminal,
  filesystem: Folder,
};

function PermissionCard({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs">
      <header className="flex items-start justify-between gap-3 border-b border-border/60 px-5 pt-4 pb-3.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="text-sm font-semibold tracking-[-0.01em] text-foreground">{title}</h3>
          {description ? (
            <p className="max-w-xl text-xs/5 text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action}
      </header>
      <div className="-mb-px px-5">{children}</div>
    </section>
  );
}

function IconChip({
  icon: Icon,
  active,
}: {
  icon: ComponentType<{ className?: string }>;
  active: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg border",
        active
          ? "border-brand-stroke/40 bg-brand-subtle text-brand-action"
          : "border-border/70 bg-muted/40 text-muted-foreground",
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}

function ModeTile({
  icon,
  title,
  description,
  active,
  locked = false,
  lockTestId,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: ReactNode;
  active: boolean;
  locked?: boolean;
  lockTestId?: string;
  children: ReactNode;
}) {
  return (
    <Label
      className={cn(
        "flex cursor-pointer flex-col items-stretch gap-3 rounded-xl border p-3.5 transition-colors",
        active
          ? "border-brand-stroke/50 bg-brand-subtle/50"
          : "border-border/70 hover:border-border hover:bg-muted/30",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <IconChip icon={icon} active={active} />
        <div className="flex items-center gap-1.5">
          {locked && <Lock size={14} className="text-muted-foreground" data-testid={lockTestId} />}
          {children}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[13px] font-medium text-foreground">{title}</span>
        <span className="text-xs/5 font-normal text-muted-foreground">{description}</span>
      </div>
    </Label>
  );
}
