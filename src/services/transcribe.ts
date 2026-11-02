// Renderer service for audio transcription via the main-process OpenAI
// transcription bridge. Records are encoded to WAV (PCM 16kHz mono) before
// crossing IPC.

import { createLogger } from "@common/marshal-logger";
import {
  isTranscribeErrorKind,
  type TranscribeErrorKind,
} from "@common/transcribe-errors";

const log = createLogger("TranscribeService");

/** Renderer-side error carrying the serialized {@link TranscribeErrorKind}. */
export class TranscribeError extends Error {
  readonly errorKind: TranscribeErrorKind;
  constructor(message: string, errorKind?: TranscribeErrorKind) {
    super(message);
    this.name = "TranscribeError";
    this.errorKind = errorKind ?? "other";
  }
}

/**
 * Read the transcription error kind off any thrown value. Uses a structural
 * check (not `instanceof`) so errors that cross boundaries still classify.
 */
export function getTranscribeErrorKind(error: unknown): TranscribeErrorKind | undefined {
  if (error instanceof Error && "errorKind" in error) {
    const kind = (error as { errorKind?: unknown }).errorKind;
    if (isTranscribeErrorKind(kind)) return kind;
  }
  return undefined;
}

class TranscribeService {
  /**
   * Send WAV audio bytes to the main process for transcription.
   * @param wavBytes WAV (PCM 16kHz mono) audio.
   * @returns the transcribed text (may be empty for silence).
   */
  async transcribe(wavBytes: Uint8Array): Promise<string> {
    if (!window.transcribeAPI) {
      throw new Error("Transcription is only available in the desktop app");
    }
    const base64 = uint8ToBase64(wavBytes);
    const result = await window.transcribeAPI.audio(base64, "audio/wav");
    if (!result.success) {
      throw new TranscribeError(result.error || "Transcription failed", result.errorKind);
    }
    log.info("Transcription returned", result.text?.length ?? 0, "chars");
    return result.text ?? "";
  }
}

/** Chunked base64 encode to avoid call-stack limits on large buffers. */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export const transcribeService = new TranscribeService();
