/**
 * Audio transcription entry point.
 *
 * The renderer records a short audio clip, encodes it as WAV (PCM 16kHz mono),
 * and hands the bytes to the `transcribe:audio` IPC handler, which calls this
 * module. The selected `TranscriptionProvider` owns the wire format and
 * credential — see ./contracts.ts and ./providers/.
 */

import { createLogger } from "../../common/marshal-logger";
import type { TranscriptionProvider } from "./contracts";
import { resolveTranscriptionProvider } from "./registry";

const log = createLogger("Transcribe");

/** Cap upload size to keep IPC + memory bounded (short dictation only). */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export interface TranscribeOptions {
  /** BCP-47 locales to consider. Defaults to en-US. */
  locales?: string[];
  /** MIME type of the supplied audio. Defaults to audio/wav. */
  mimeType?: string;
  /** Transcription provider ID. Defaults to the configured provider. */
  providerId?: string;
  /** Provider instance injection for composition roots and contract tests. */
  provider?: TranscriptionProvider;
  /** Injectable credential acquirer (tests). */
  acquireToken?: () => Promise<string>;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Optional cancellation signal for callers with a bounded interaction window. */
  signal?: AbortSignal;
}

/**
 * Transcribe a bounded audio buffer to text.
 * Returns the combined transcript (possibly empty for silence).
 */
export async function transcribeAudio(
  audio: Uint8Array,
  opts: TranscribeOptions = {},
): Promise<string> {
  if (audio.byteLength === 0) {
    throw new Error("No audio data to transcribe.");
  }
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    throw new Error(
      `Audio too large (${audio.byteLength} bytes, max ${MAX_AUDIO_BYTES}). Record a shorter clip.`,
    );
  }

  const provider =
    opts.provider ??
    resolveTranscriptionProvider({
      ...(opts.providerId ? { providerId: opts.providerId } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.acquireToken ? { acquireToken: opts.acquireToken } : {}),
    });

  const startedAt = Date.now();
  const text = await provider.transcribe({
    audio,
    mimeType: opts.mimeType ?? "audio/wav",
    locales: opts.locales ?? ["en-US"],
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  log.info(
    `Transcribed ${audio.byteLength} bytes via ${provider.id} in ${Date.now() - startedAt}ms -> ${text.length} chars`,
  );
  return text;
}
