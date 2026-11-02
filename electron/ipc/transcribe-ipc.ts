/**
 * IPC handler for audio transcription. The renderer's mic button records a clip
 * (WAV PCM 16kHz mono), base64-encodes it, and invokes `transcribe:audio`.
 * Mirrors the structure of goal-ipc.ts.
 */

import type { IpcHandler, IpcInvokeMap } from "../../common/marshal-ipc-contract";
import { createLogger } from "../../common/marshal-logger";
import { isVoiceTranscriptionAvailable } from "../../common/runtime-config";
import { transcribeErrorKind } from "../../common/transcribe-errors";
import { loadSettingsFromDisk } from "../settings-store";
import { transcribeAudio } from "../transcribe/transcribe";

const log = createLogger("TranscribeIpc");

export const TRANSCRIBE_UNAVAILABLE_MESSAGE =
  "Voice transcription is unavailable for this runtime.";

export interface TranscribeIpcDeps {
  ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => void;
  loadRuntimeId?: () => string | undefined;
  transcribe?: typeof transcribeAudio;
}

export function registerTranscribeHandlers({
  ipcHandle,
  loadRuntimeId = () => loadSettingsFromDisk().runtimeId,
  transcribe = transcribeAudio,
}: TranscribeIpcDeps) {
  ipcHandle("transcribe:audio", async (_event, audioBase64: string, mimeType?: string) => {
    try {
      if (!isVoiceTranscriptionAvailable(loadRuntimeId())) {
        return {
          success: false,
          error: TRANSCRIBE_UNAVAILABLE_MESSAGE,
          errorKind: "other",
        };
      }
      const buffer = Buffer.from(audioBase64, "base64");
      const text = await transcribe(new Uint8Array(buffer), { mimeType });
      return { success: true, text };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Transcription failed";
      const errorKind = transcribeErrorKind(error);
      log.error(`Transcription failed (${errorKind}):`, message);
      return { success: false, error: message, errorKind };
    }
  });
}
