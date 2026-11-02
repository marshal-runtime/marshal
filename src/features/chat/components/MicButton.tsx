import { TRANSCRIBE_NOT_CONFIGURED_MESSAGE } from "@common/transcribe-errors";
import { useCallback } from "react";
import { toast } from "sonner";

import { Loader2, Mic, Square } from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import { getTranscribeErrorKind } from "@/services/transcribe";

import { useAudioRecorder } from "../hooks/useAudioRecorder";
import { RecordingIndicator } from "./RecordingIndicator";

interface MicButtonProps {
  disabled?: boolean;
  /** Receives the recognized transcript when recording stops. */
  onTranscript: (text: string) => void;
}

/** Duration (ms) for the setup-remediation toast — longer so the user has time to read it. */
const SETUP_PROMPT_DURATION_MS = 12_000;

/**
 * Compose-bar microphone control. Click to record; click again to stop and
 * transcribe via the configured transcription provider. The recognized text is handed back through
 * `onTranscript` for insertion into the editor. While recording, a live
 * waveform + elapsed timer render alongside the stop button.
 */
export function MicButton({ disabled, onTranscript }: MicButtonProps) {
  const { status, busy, start, stopAndTranscribe, cancel, analyser, startedAt } =
    useAudioRecorder();

  const handleClick = useCallback(async () => {
    if (status === "transcribing") return;
    if (status === "recording") {
      try {
        const text = await stopAndTranscribe();
        if (text.trim()) onTranscript(text.trim());
        else toast("No speech detected");
      } catch (err) {
        const kind = getTranscribeErrorKind(err);
        if (kind === "not-configured") {
          toast.error(TRANSCRIBE_NOT_CONFIGURED_MESSAGE, { duration: SETUP_PROMPT_DURATION_MS });
        } else {
          toast.error(err instanceof Error ? err.message : "Transcription failed");
        }
      }
      return;
    }
    try {
      await start();
    } catch {
      // useAudioRecorder surfaces the error; toast for visibility.
      toast.error("Could not access the microphone");
    }
  }, [status, start, stopAndTranscribe, onTranscript]);

  const label =
    status === "recording"
      ? "Stop recording"
      : status === "transcribing"
        ? "Transcribing"
        : "Record voice message";

  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={
        status === "recording"
          ? "size-10 rounded-full text-destructive hover:text-destructive"
          : "size-10 rounded-full"
      }
      disabled={disabled || status === "transcribing"}
      aria-label={label}
      title={label}
      data-testid="mic-btn"
      data-recording={status === "recording" ? "true" : undefined}
      onClick={handleClick}
      onContextMenu={(e) => {
        // Right-click cancels an in-progress recording without transcribing.
        if (busy) {
          e.preventDefault();
          cancel();
        }
      }}
    >
      {status === "transcribing" ? (
        <Loader2 size={20} className="animate-spin" />
      ) : status === "recording" ? (
        <Square size={16} fill="currentColor" strokeWidth={0} />
      ) : (
        <Mic size={20} />
      )}
    </Button>
  );

  if (status === "recording") {
    return (
      <div className="flex items-center gap-1">
        {startedAt != null && <RecordingIndicator analyser={analyser} startedAt={startedAt} />}
        {button}
      </div>
    );
  }

  return button;
}
