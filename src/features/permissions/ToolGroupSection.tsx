import { ChevronRight, Lock } from "@/components/icons";
import type { ReactNode } from "react";
import { useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/marshal-ui/marshal-collapsible";
import { Label } from "@/components/marshal-ui/label";
import { Switch } from "@/components/marshal-ui/marshal-switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/marshal-ui/marshal-tooltip";
import { cn } from "@/lib/marshal-class-names";
import type { PermissionsConfig, PermissionsControllableMap, ToolGroup } from "@/types/electron";

import { getToolCopy, getToolDescription, getToolLabel } from "./tool-descriptions";

interface ServerConfig {
  configKey: string;
  enabled: boolean;
  autoApprove: boolean;
  onToggleEnabled: () => void;
  onToggleAutoApprove: () => void;
  /** Server is disabled by tenant policy */
  lockedByTenant?: boolean;
}

interface ToolGroupSectionProps {
  group: ToolGroup;
  permissions: PermissionsConfig;
  onUpdate: (permissions: PermissionsConfig) => void;
  disabled?: boolean;
  serverAutoApprove?: boolean;
  /** Tenant policy forces all operations to prompt — disable approval toggles */
  forcePrompt?: boolean;
  /** Server-level controls for MCP groups (enabled, auto-approve toggles) */
  serverConfig?: ServerConfig;
  /** Extra controls rendered in the server sub-section (e.g., file upload toggle) */
  extraControls?: ReactNode;
  /** Per-field controllable flags from the backend. When unset, all switches are interactive. */
  controllable?: PermissionsControllableMap;
}

export function ToolGroupSection({
  group,
  permissions,
  onUpdate,
  disabled,
  serverAutoApprove,
  forcePrompt,
  serverConfig,
  extraControls,
  controllable,
}: ToolGroupSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const tools = permissions.tools;

  const isGroupOn = tools[group.key] ?? false;
  const isMcpGroup = group.key.startsWith("mcp:");
  const isToolCoveredByServerAutoApprove = (toolKey: string): boolean => {
    if (serverAutoApprove !== true) return false;
    // MCP groups: tools must match the "mcp:server:tool" pattern
    if (isMcpGroup) return toolKey.startsWith(`${group.key}:`);
    // SDK tool groups: all tools in the group are covered by server auto-approve
    return true;
  };
  const isToolChecked = (toolKey: string): boolean => {
    if (isToolCoveredByServerAutoApprove(toolKey)) return true;
    if (toolKey in tools) return tools[toolKey];
    if (isMcpGroup && !toolKey.startsWith(`${group.key}:`)) return false;
    return isGroupOn;
  };
  const allOn = group.tools.length > 0 && group.tools.every((t) => isToolChecked(t.key));
  const enabledCount = group.tools.filter((t) => isToolChecked(t.key)).length;

  const toggleGroup = (checked: boolean) => {
    const updated = { ...tools };
    const prevTools = { ...(permissions.previousTools ?? {}) };

    if (checked) {
      // Snapshot only explicit per-tool overrides (keys present in tools)
      // so we can distinguish "unset/inherited" from "explicitly disabled"
      const snapshot: Record<string, boolean> = {};
      snapshot[group.key] = isGroupOn;
      for (const t of group.tools) {
        if (t.key in tools) {
          snapshot[t.key] = tools[t.key];
        }
      }
      prevTools[group.key] = snapshot;

      updated[group.key] = true;
      for (const t of group.tools) delete updated[t.key];
    } else {
      delete updated[group.key];
      // Restore previous per-tool states if we have a snapshot
      const snapshot = prevTools[group.key];
      if (snapshot) {
        // Restore the group key state
        if (snapshot[group.key]) {
          updated[group.key] = true;
        }
        // Only restore tools that had explicit overrides — leave new/unknown tools unset
        for (const t of group.tools) {
          if (t.key in snapshot) {
            updated[t.key] = snapshot[t.key];
          }
        }
        delete prevTools[group.key];
      } else {
        for (const t of group.tools) delete updated[t.key];
      }
    }
    onUpdate({ ...permissions, tools: updated, previousTools: prevTools });
  };

  const toggleTool = (toolKey: string, checked: boolean) => {
    onUpdate({ ...permissions, tools: { ...tools, [toolKey]: checked } });
  };

  const isInteractive = !disabled && !serverAutoApprove && !forcePrompt;
  const isToolInteractive = (toolKey: string) =>
    !disabled && !forcePrompt && !isToolCoveredByServerAutoApprove(toolKey);
  const serverDisabled = serverConfig && !serverConfig.enabled;
  const serverLockedByTenant = serverConfig?.lockedByTenant ?? false;
  const canToggleServerEnabled = controllable?.serverEnabled.enabled !== false;
  const canToggleServerAutoApprove = controllable?.serverAutoApprove.enabled !== false;
  const groupLabel = getToolLabel(group.key) ?? group.name;
  const groupDescription = getToolDescription(group.key);
  const autoApproveDescription = getToolDescription("serverAutoApprove");

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div className={serverDisabled ? "opacity-50" : ""}>
        {/* Header row */}
        <div className="flex items-center gap-2 py-2">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              aria-label={groupLabel}
              className="flex flex-1 cursor-pointer items-start gap-2"
            >
              <ChevronRight
                size={14}
                className={cn(
                  "mt-1 shrink-0 transition-transform duration-200",
                  expanded && "rotate-90",
                )}
              />
              <span className="flex min-w-0 flex-1 flex-col text-left">
                <span className="text-sm font-medium">
                  {groupLabel}
                  {group.tools.length > 0 && (
                    <span
                      className="ml-2 text-xs font-normal text-muted-foreground"
                      data-testid="tool-group-count"
                    >
                      {enabledCount}/{group.tools.length}
                    </span>
                  )}
                </span>
                {groupDescription && (
                  <span className="pr-4 text-xs font-normal text-muted-foreground">
                    {groupDescription}
                  </span>
                )}
              </span>
            </button>
          </CollapsibleTrigger>
          <span aria-live="polite">
            {group.status === "static" && (
              <span className="text-xs text-muted-foreground">(cached)</span>
            )}
            {group.status === "disconnected" && (
              <span className="text-xs text-muted-foreground">(no tools)</span>
            )}
            {group.status === "error" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-xs text-destructive" tabIndex={0} role="status">
                    (error)
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  Tool discovery failed. Use the refresh button to retry.
                </TooltipContent>
              </Tooltip>
            )}
          </span>
          {serverAutoApprove && (
            <span className="text-xs text-muted-foreground">auto-approves MCP tools</span>
          )}
          {forcePrompt && (
            <Lock
              size={14}
              className="text-muted-foreground"
              data-testid="tenant-lock-forcePrompt"
            />
          )}
          {serverLockedByTenant && (
            <Lock
              size={14}
              className="text-muted-foreground"
              data-testid={`tenant-lock-${group.name}`}
            />
          )}
          {serverConfig ? (
            canToggleServerEnabled ? (
              <Switch
                checked={serverConfig.enabled}
                onCheckedChange={serverConfig.onToggleEnabled}
                disabled={serverLockedByTenant}
              />
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Switch checked={serverConfig.enabled} disabled />
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  {controllable?.serverEnabled.disabledReason}
                </TooltipContent>
              </Tooltip>
            )
          ) : (
            <Switch
              checked={serverAutoApprove || isGroupOn || allOn}
              onCheckedChange={toggleGroup}
              disabled={!isInteractive}
            />
          )}
        </div>

        {/* Server sub-controls (MCP groups only) */}
        {serverConfig && serverConfig.enabled && (
          <div className="mt-2 mb-1 ml-1 border-l-2 border-border pl-3">
            <Label className="flex cursor-pointer items-start justify-between gap-3 py-1">
              <div className="flex min-w-0 flex-col">
                <span className="text-sm font-normal text-muted-foreground">
                  Auto-approve without asking
                </span>
                {autoApproveDescription && (
                  <span className="text-xs text-muted-foreground/70">{autoApproveDescription}</span>
                )}
              </div>
              {canToggleServerAutoApprove ? (
                <Switch
                  checked={serverConfig.autoApprove}
                  onCheckedChange={serverConfig.onToggleAutoApprove}
                  disabled={forcePrompt || serverLockedByTenant}
                />
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Switch checked={serverConfig.autoApprove} disabled />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    {controllable?.serverAutoApprove.disabledReason}
                  </TooltipContent>
                </Tooltip>
              )}
            </Label>
            {extraControls}
          </div>
        )}

        {/* Expandable tool list — Radix Collapsible handles animation, aria, and tab order */}
        {group.tools.length > 0 && (
          <CollapsibleContent>
            <div className="ml-6 space-y-1 pb-2">
              {group.tools.map((tool) => {
                const copy = getToolCopy(tool.key);
                const label = copy?.label ?? tool.name;
                const desc = copy?.description ?? tool.description;
                return (
                  <Label key={tool.key} className="flex cursor-pointer items-start gap-2 py-1">
                    <Checkbox
                      checked={isToolChecked(tool.key)}
                      onCheckedChange={(checked) => toggleTool(tool.key, checked === true)}
                      disabled={!isToolInteractive(tool.key) || !!serverDisabled}
                      className="mt-0.5"
                    />
                    <div className="flex min-w-0 flex-col">
                      <span className="text-xs font-medium">{label}</span>
                      {desc && <span className="text-xs text-muted-foreground">{desc}</span>}
                    </div>
                  </Label>
                );
              })}
            </div>
          </CollapsibleContent>
        )}
      </div>
    </Collapsible>
  );
}
