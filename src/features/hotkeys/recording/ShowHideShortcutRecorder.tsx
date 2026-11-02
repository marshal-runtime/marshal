import { DEFAULT_SHOW_HIDE_SHORTCUT } from "@common/marshal/show-hide-shortcut";
import { formatForDisplay, useHotkeyRecorder, type Hotkey } from "@tanstack/react-hotkeys";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { KbdGroup, renderShortcutKeys } from "@/components/marshal-ui/kbd";
import { Button } from "@/components/marshal-ui/marshal-button";
import {
  electronAcceleratorToTanStackHotkey,
  validateShowHideHotkey,
} from "@/runtime-ui/hotkeys/accelerator-codec";
import type { MSettings } from "@/types/electron";

const INVALID_SAVED_SHORTCUT_MESSAGE =
  "Saved shortcut is invalid. Record a new shortcut or reset to default.";
const SHOW_HIDE_SHORTCUT_STATUS_QUERY_KEY = ["settings", "show-hide-shortcut-status"] as const;
const DISABLED_SHORTCUT_MESSAGE =
  "Shortcut is saved but inactive until global show/hide is enabled.";
type ShortcutErrorSource =
  | { kind: "validation"; message: string }
  | { kind: "saved-invalid"; message: string }
  | { kind: "registration"; message: string }
  | null;

interface ShowHideShortcutRecorderProps {
  settings: MSettings;
  onSaveSettings: (settings: MSettings) => void;
}

function getShortcutDisplay(accelerator: string): { display: string; error: string | null } {
  const result = electronAcceleratorToTanStackHotkey(accelerator);
  if (result.success) {
    return {
      display: formatForDisplay(result.hotkey),
      error: null,
    };
  }

  const defaultResult = electronAcceleratorToTanStackHotkey(DEFAULT_SHOW_HIDE_SHORTCUT);
  return {
    display: formatForDisplay(
      defaultResult.success ? defaultResult.hotkey : DEFAULT_SHOW_HIDE_SHORTCUT,
    ),
    error: INVALID_SAVED_SHORTCUT_MESSAGE,
  };
}

function useShowHideShortcutRegistrationError() {
  return useQuery({
    queryKey: SHOW_HIDE_SHORTCUT_STATUS_QUERY_KEY,
    queryFn: async ({ signal }) => {
      const result = await window.settingsAPI.getShowHideShortcutStatus();
      if (signal.aborted) return null;
      if (!result.success) {
        throw new Error(result.error || "Failed to load show/hide shortcut status.");
      }
      return result.status ?? null;
    },
    select: (status) => (status?.registered === false && status.error ? status.error : null),
    staleTime: Infinity,
  });
}

export function ShowHideShortcutRecorder({
  settings,
  onSaveSettings,
}: ShowHideShortcutRecorderProps) {
  const [error, setError] = useState<string | null>(null);
  const currentAccelerator = settings.showHideShortcut || DEFAULT_SHOW_HIDE_SHORTCUT;
  const displayState = useMemo(() => getShortcutDisplay(currentAccelerator), [currentAccelerator]);
  const shortcutStatus = useShowHideShortcutRegistrationError();

  const resetToDefault = useCallback(() => {
    setError(null);
    onSaveSettings({ ...settings, showHideShortcut: DEFAULT_SHOW_HIDE_SHORTCUT });
  }, [onSaveSettings, settings]);

  const recorder = useHotkeyRecorder({
    ignoreInputs: false,
    onRecord: (hotkey: Hotkey) => {
      const recordedHotkey: string = hotkey;
      if (recordedHotkey === "") {
        return;
      }

      const validation = validateShowHideHotkey(recordedHotkey);
      if (!validation.success) {
        setError(validation.error);
        return;
      }

      setError(null);
      onSaveSettings({ ...settings, showHideShortcut: validation.accelerator });
    },
    onCancel: () => setError(null),
    onClear: resetToDefault,
  });
  const errorSource = useMemo<ShortcutErrorSource>(() => {
    if (recorder.isRecording) return null;
    if (error) return { kind: "validation", message: error };
    if (displayState.error) return { kind: "saved-invalid", message: displayState.error };
    if (shortcutStatus.data) return { kind: "registration", message: shortcutStatus.data };
    return null;
  }, [displayState.error, error, recorder.isRecording, shortcutStatus.data]);
  const recordButtonLabel = recorder.isRecording
    ? "Recording shortcut, press keys now"
    : "Record shortcut";

  return (
    <div className="flex flex-col items-end gap-1" aria-busy={shortcutStatus.isPending}>
      <div className="flex items-center gap-2">
        <KbdGroup aria-label={displayState.display}>
          {renderShortcutKeys(displayState.display)}
        </KbdGroup>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={recordButtonLabel}
          onClick={() => {
            setError(null);
            recorder.startRecording();
          }}
        >
          {recorder.isRecording ? "Press shortcut..." : "Record"}
        </Button>
      </div>
      {errorSource ? (
        <div role="alert" className="max-w-64 text-right text-xs text-destructive">
          {errorSource.message}
        </div>
      ) : null}
      {!settings.showHideShortcutEnabled ? (
        <div className="max-w-64 text-right text-xs text-muted-foreground">
          {DISABLED_SHORTCUT_MESSAGE}
        </div>
      ) : null}
    </div>
  );
}
