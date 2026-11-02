import { Button } from "@/components/marshal-ui/marshal-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/marshal-ui/marshal-tooltip";
import { TelemetryPath_Permissions } from "@/services/telemetry/schema";
import type { PermissionsConfig } from "@/types/electron";

import { describePermissions } from "./permissions-summary-format";

interface PermissionsSummaryProps {
  /** The permissions to summarize, or undefined if using defaults */
  permissions: PermissionsConfig | undefined;
  /** Open the full-screen permissions editor */
  onManagePermissions: () => void;
  /** For entity mode: initialize custom permissions and open editor */
  onCustomize?: () => void;
  /** For entity mode: clear custom permissions (revert to defaults) */
  onReset?: () => void;
  /** Label shown when no custom permissions (e.g. "Using global permissions") */
  defaultsLabel?: string;
  /** When true, the Customize button is rendered disabled. */
  customizeDisabled?: boolean;
  /** Tooltip shown on the disabled Customize button. */
  customizeTooltip?: string;
}

function PermissionsStats({ permissions }: { permissions: PermissionsConfig }) {
  return (
    <>
      <div className="text-sm text-foreground">{describePermissions(permissions)}</div>
      {permissions.autoApproveReadOnly && (
        <div className="text-xs text-muted-foreground">Read-only operations auto-approved</div>
      )}
    </>
  );
}

export function PermissionsSummary({
  permissions,
  onManagePermissions,
  onCustomize,
  onReset,
  defaultsLabel,
  customizeDisabled,
  customizeTooltip,
}: PermissionsSummaryProps) {
  // No custom permissions — show defaults label + Customize button
  if (!permissions) {
    return (
      <TelemetryPath_Permissions>
        <div className="space-y-2">
          <div className="text-sm text-muted-foreground">
            {defaultsLabel ?? "Using global permissions"}
          </div>
          {onCustomize && (
            <>
              {customizeDisabled ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled
                        data-testid="customize-permissions-btn"
                      >
                        Customize permissions
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    {customizeTooltip ?? "Per-heartbeat overrides not available."}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onCustomize}
                  data-testid="customize-permissions-btn"
                >
                  Customize permissions
                </Button>
              )}
            </>
          )}
        </div>
      </TelemetryPath_Permissions>
    );
  }

  // Has permissions — show stats + Manage / Reset buttons
  return (
    <TelemetryPath_Permissions>
      <div className="space-y-2">
        <PermissionsStats permissions={permissions} />
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onManagePermissions}
            data-testid="manage-permissions-btn"
          >
            Manage Permissions
          </Button>
          {onReset && (
            <Button variant="ghost" size="sm" onClick={onReset} data-testid="reset-permissions-btn">
              Reset to defaults
            </Button>
          )}
        </div>
      </div>
    </TelemetryPath_Permissions>
  );
}
