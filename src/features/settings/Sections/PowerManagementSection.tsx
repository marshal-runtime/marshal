import { Switch } from "@/components/marshal-ui/marshal-switch";
import type { MSettings } from "@/types/electron";

import { SettingsRow } from "../SettingsRow";

interface PowerManagementSectionProps {
  settings: MSettings;
  onSaveSettings: (updated: MSettings) => void;
  // Mouse wiggle is dev-only (unattended remote machines).
  showMouseWiggle: boolean;
}

// TODO(telemetry): wire dedicated telemetry measures for the Power Management toggles.
// We intentionally do NOT reuse `InteractiveElementMonitor_Toggle` here ΓÇö
// that measure documents its expected path as `/App/Settings/McpServer` in
// Render.ts, and reusing it for an unrelated feature would perpetuate the
// shared-measure drift a reviewer flagged (and that was already
// fixed for OpenSettings). The right fix is dedicated measures (e.g.
// `Measure_InteractiveElement_PreventSleepToggle`,
// `Measure_InteractiveElement_MouseWiggleToggle`) under a new
// `PowerManagement` component scoped to `/App/Settings/PowerManagement` in
// `src/services/telemetry/schema` — out of scope here.
export function PowerManagementSection({
  settings,
  onSaveSettings,
  showMouseWiggle,
}: PowerManagementSectionProps) {
  return (
    <div className="flex flex-col">
      <SettingsRow
        htmlFor="prevent-sleep-switch"
        label="Prevent sleep"
        description="Prevents the system from sleeping while always-on features like Heartbeat are active."
      >
        <Switch
          id="prevent-sleep-switch"
          checked={settings.preventSleepEnabled ?? true}
          onCheckedChange={(enabled: boolean) =>
            onSaveSettings({ ...settings, preventSleepEnabled: enabled })
          }
        />
      </SettingsRow>
      <SettingsRow
        htmlFor="always-keep-awake-switch"
        label="Always keep awake"
        description="Keeps Marshal holding a sleep blocker while the app is running. On Windows, also sends periodic input so remote-desktop idle timers don't lock the session."
      >
        <Switch
          id="always-keep-awake-switch"
          checked={settings.alwaysKeepAwakeEnabled ?? false}
          onCheckedChange={(enabled: boolean) =>
            onSaveSettings({ ...settings, alwaysKeepAwakeEnabled: enabled })
          }
        />
      </SettingsRow>
      {window.platform === "win32" && showMouseWiggle && (
        <SettingsRow
          htmlFor="mouse-wiggle-switch"
          label="Mouse wiggle"
          description="Sends periodic mouse input so unattended Windows machines (e.g. remote VMs) don't lock while always-on features like Heartbeat are active."
        >
          <Switch
            id="mouse-wiggle-switch"
            checked={settings.mouseWiggleEnabled ?? true}
            onCheckedChange={(enabled: boolean) =>
              onSaveSettings({ ...settings, mouseWiggleEnabled: enabled })
            }
          />
        </SettingsRow>
      )}
    </div>
  );
}
