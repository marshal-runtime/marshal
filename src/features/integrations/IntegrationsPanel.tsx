import { ScrollArea } from "@/components/ui/scroll-area";
import { SurfaceHeader } from "@/components/ui/surface-header";
import { useSettings } from "@/features/settings/useSettings";
import { TelemetryPath_Integrations } from "@/services/telemetry/schema";

import { RelayProviderSettingsSection, type BotStatus } from "./RelayProviderSettingsSection";

interface IntegrationsPanelProps {
  isOpen: boolean;
  onClose?: () => void;
  onStatusChange?: (status: BotStatus) => void;
  onOpenSettings?: () => void;
}

export function IntegrationsPanel({
  isOpen,
  onClose,
  onStatusChange,
  onOpenSettings,
}: IntegrationsPanelProps) {
  const { settings, persist } = useSettings(isOpen);

  if (!isOpen) return null;

  return (
    <TelemetryPath_Integrations>
      <div
        className="flex size-full flex-col overflow-hidden bg-card"
        data-testid="integrations-panel"
      >
        <SurfaceHeader title="Integrations" onClose={onClose} />
        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-6 p-6">
            <RelayProviderSettingsSection
              settings={settings}
              persist={persist}
              onStatusChange={onStatusChange}
              onOpenSettings={onOpenSettings}
            />
          </div>
        </ScrollArea>
      </div>
    </TelemetryPath_Integrations>
  );
}
