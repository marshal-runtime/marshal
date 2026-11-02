import { createLogger } from "@common/marshal-logger";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, type ReactNode } from "react";

import { Switch } from "@/components/marshal-ui/marshal-switch";
import { RadioGroup, RadioGroupItem } from "@/components/marshal-ui/radio-group";
import { ShowHideShortcutRecorder } from "@/features/hotkeys";
import { cn } from "@/lib/marshal-class-names";
import type { MSettings } from "@/types/electron";

import { SettingsRow } from "../SettingsRow";

interface BackgroundSettings {
  enabled: boolean;
  runOnStartup: boolean;
  hideOnLaunch: boolean;
}

const DEFAULT_BG: BackgroundSettings = { enabled: false, runOnStartup: false, hideOnLaunch: false };

const log = createLogger("WindowBehavior");

type WindowMode = "default" | "background" | "mini-mode";

interface WindowBehaviorSectionProps {
  isOpen: boolean;
  settings: MSettings;
  onSaveSettings: (settings: MSettings) => void;
}

export function WindowBehaviorSection({
  isOpen,
  settings,
  onSaveSettings,
}: WindowBehaviorSectionProps) {
  const isMac = window.platform === "darwin";

  const queryClient = useQueryClient();

  const { data: bgSettings = DEFAULT_BG } = useQuery({
    queryKey: ["background", "settings"],
    queryFn: async () => {
      if (!window.backgroundAPI) return DEFAULT_BG;
      const result = await window.backgroundAPI.getSettings();
      return result.success && result.settings
        ? (result.settings as BackgroundSettings)
        : DEFAULT_BG;
    },
    enabled: isOpen,
  });

  const saveBgMutation = useMutation({
    mutationFn: async (updates: Partial<BackgroundSettings>) => {
      const result = await window.backgroundAPI?.saveSettings(updates);
      if (result && !result.success) {
        throw new Error(result.error || "Couldn't update background settings. Please try again.");
      }
    },
    onMutate: async (updates) => {
      await queryClient.cancelQueries({ queryKey: ["background", "settings"] });
      const previous = queryClient.getQueryData<BackgroundSettings>(["background", "settings"]);
      queryClient.setQueryData<BackgroundSettings>(["background", "settings"], (old) => ({
        ...(old ?? DEFAULT_BG),
        ...updates,
      }));
      return { previous };
    },
    onError: (err, _updates, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["background", "settings"], context.previous);
      }
      log.error("Failed to save background settings:", err);
      window.alert(
        err instanceof Error
          ? err.message
          : "Couldn't update background settings. Please try again.",
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["background", "settings"] });
    },
  });

  const { mutateAsync: saveBgAsync } = saveBgMutation;

  const saveBg = useCallback(
    (updates: Partial<BackgroundSettings>) =>
      saveBgAsync(updates).catch((err) => log.error("saveBg rejected:", err)),
    [saveBgAsync],
  );

  const mode: WindowMode = settings.miniModeEnabled
    ? "mini-mode"
    : bgSettings.enabled
      ? "background"
      : "default";

  const setMode = async (next: WindowMode) => {
    if (next === mode) return;

    if (next === "default") {
      // Disable background first (async), then clear mini mode (sync).
      // Preserve runOnStartup — startup registration is independent of window mode.
      if (bgSettings.enabled) {
        await saveBg({ enabled: false, hideOnLaunch: false });
      }
      if (settings.miniModeEnabled) {
        onSaveSettings({ ...settings, miniModeEnabled: false, startInMiniModeEnabled: undefined });
      }
    } else if (next === "background") {
      // Enable background first — if this fails, mini mode stays active instead
      // of stranding the user in "default" with nothing enabled.
      await saveBg({ enabled: true });
      if (settings.miniModeEnabled) {
        onSaveSettings({ ...settings, miniModeEnabled: false, startInMiniModeEnabled: undefined });
      }
    } else if (next === "mini-mode") {
      // Disable background first — if this fails, background stays active instead
      // of enabling both modes simultaneously.
      // Preserve runOnStartup — startup registration is independent of window mode.
      if (bgSettings.enabled) {
        await saveBg({ enabled: false, hideOnLaunch: false });
      }
      onSaveSettings({ ...settings, miniModeEnabled: true, startInMiniModeEnabled: true });
    }
  };

  const trayName = isMac ? "menu bar" : "tray";

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-3 border-b border-border/60 py-4">
        <p className="text-xs/5 text-muted-foreground">
          Choose what happens when you close or minimize the main window.
        </p>

        <RadioGroup
          value={mode}
          onValueChange={(val) => {
            if (val === "default" || val === "background" || val === "mini-mode") void setMode(val);
          }}
          className="grid gap-2"
        >
          <WindowModeOption
            id="mode-default"
            value="default"
            selected={mode === "default"}
            label="Default"
            description="Closing or minimizing the window behaves normally."
          />
          <WindowModeOption
            id="mode-background"
            value="background"
            selected={mode === "background"}
            label={`Run in background (${trayName} only)`}
            description={`Marshal keeps running in the ${trayName} when you close the window.`}
          >
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <span className="text-xs text-foreground">Start hidden ({trayName} only)</span>
              <Switch
                checked={bgSettings.hideOnLaunch}
                onCheckedChange={() => void saveBg({ hideOnLaunch: !bgSettings.hideOnLaunch })}
              />
            </label>
          </WindowModeOption>
          <WindowModeOption
            id="mode-mini"
            value="mini-mode"
            selected={mode === "mini-mode"}
            label="Show mini mode indicator"
            description="Shows a compact status indicator in the corner of your screen while the main window is hidden."
          >
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <span className="text-xs text-foreground">Launch directly into mini mode</span>
              <Switch
                checked={!!settings.startInMiniModeEnabled}
                onCheckedChange={() =>
                  onSaveSettings({
                    ...settings,
                    startInMiniModeEnabled: !settings.startInMiniModeEnabled,
                  })
                }
              />
            </label>
          </WindowModeOption>
        </RadioGroup>
      </div>

      <SubsectionLabel>Startup</SubsectionLabel>
      <SettingsRow htmlFor="launch-at-startup" label="Launch at system startup">
        <Switch
          id="launch-at-startup"
          checked={bgSettings.runOnStartup}
          onCheckedChange={() => void saveBg({ runOnStartup: !bgSettings.runOnStartup })}
        />
      </SettingsRow>

      <SubsectionLabel>Quick Access</SubsectionLabel>
      <SettingsRow
        htmlFor="show-hide-shortcut"
        label="Enable global show/hide shortcut"
        description="Use a keyboard shortcut to pop Marshal open without leaving what you're doing."
      >
        <Switch
          id="show-hide-shortcut"
          checked={!!settings.showHideShortcutEnabled}
          onCheckedChange={() =>
            onSaveSettings({
              ...settings,
              showHideShortcutEnabled: !settings.showHideShortcutEnabled,
            })
          }
        />
      </SettingsRow>
      <SettingsRow
        label="Shortcut"
        description={
          <>
            Click <strong>Record</strong> and then press the keys you want to use as your shortcut
            (for example, Ctrl+Alt+S).
          </>
        }
      >
        <ShowHideShortcutRecorder settings={settings} onSaveSettings={onSaveSettings} />
      </SettingsRow>
    </div>
  );
}

function WindowModeOption({
  id,
  value,
  selected,
  label,
  description,
  children,
}: {
  id: string;
  value: WindowMode;
  selected: boolean;
  label: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-xl border px-3.5 py-3 transition-colors",
        selected
          ? "border-brand-stroke/60 bg-brand-subtle/60"
          : "border-border/70 hover:border-border hover:bg-muted/30",
      )}
    >
      <label htmlFor={id} className="flex cursor-pointer items-center justify-between gap-3">
        <span className="text-[13px] font-medium text-foreground">{label}</span>
        <RadioGroupItem value={value} id={id} />
      </label>
      <div className="text-xs/5 text-muted-foreground">{description}</div>
      {selected && children ? (
        <div className="mt-2 border-t border-border/60 pt-2.5">{children}</div>
      ) : null}
    </div>
  );
}

function SubsectionLabel({ children }: { children: ReactNode }) {
  return (
    <h4 className="pt-4 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
      {children}
    </h4>
  );
}
