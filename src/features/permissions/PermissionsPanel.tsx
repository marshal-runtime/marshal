import { ScrollArea } from "@/components/ui/scroll-area";
import { SurfaceHeader } from "@/components/ui/surface-header";
import { TelemetryPath_Permissions } from "@/services/telemetry/schema";
import type { PermissionsConfig, PermissionsControllableMap } from "@/types/electron";

import { PermissionsEditor } from "./PermissionsEditor";

export interface PermissionsPanelProps {
  /** Panel title — defaults to "Permissions" */
  title?: string;
  /** Back chevron → returns to the parent panel (e.g. Heartbeat, Settings, automation form). */
  onBack: () => void;
  /** X button → dismisses the entire panel stack and returns to the original page. */
  onClose?: () => void;
  permissions: PermissionsConfig;
  onUpdatePermissions: (permissions: PermissionsConfig) => void;
  /** Per-field controllable flags. When unset, treat as all-true (legacy callers). */
  controllable?: PermissionsControllableMap;
  /** File-chooser toggle (global panel only) */
  interceptFileChooser?: boolean;
  onToggleInterceptFileChooser?: () => void;
  /** Show "Edit raw JSON" button (global panel only) */
  showEditJson?: boolean;
  onEditJson?: () => void;
  /**
   * When true, the marshal config contains tool-name patterns that can't be
   * represented as per-tool toggles. Forwarded to PermissionsEditor to show a banner.
   */
  hasUnrepresentablePatterns?: boolean;
}

export function PermissionsPanel({
  title = "Permissions",
  onBack,
  onClose,
  permissions,
  onUpdatePermissions,
  controllable,
  interceptFileChooser,
  onToggleInterceptFileChooser,
  showEditJson = false,
  onEditJson,
  hasUnrepresentablePatterns,
}: PermissionsPanelProps) {
  return (
    <TelemetryPath_Permissions>
      <div className="flex h-full flex-col">
        <SurfaceHeader title={title} onBack={onBack} onClose={onClose} />
        <ScrollArea className="flex-1 bg-background">
          <div className="@container">
            <div className="mx-auto flex w-full max-w-4xl flex-col px-4 pt-5 pb-16 @3xl:px-8 @3xl:pt-8">
              <PermissionsEditor
                permissions={permissions}
                onUpdatePermissions={onUpdatePermissions}
                controllable={controllable}
                interceptFileChooser={interceptFileChooser}
                onToggleInterceptFileChooser={onToggleInterceptFileChooser}
                showEditJson={showEditJson}
                onEditJson={onEditJson}
                hasUnrepresentablePatterns={hasUnrepresentablePatterns}
              />
            </div>
          </div>
        </ScrollArea>
      </div>
    </TelemetryPath_Permissions>
  );
}
