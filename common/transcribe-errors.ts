/**
 * Shared error classification + remediation copy for audio transcription.
 *
 * Failures are classified into a `TranscribeErrorKind` that crosses IPC as a
 * serializable field, so the renderer can show an actionable prompt without
 * string-sniffing. This module is a dependency-free leaf importable from both
 * the main process and the renderer.
 */

/** How a transcription attempt failed, for UI remediation branching. */
export type TranscribeErrorKind = "not-configured" | "mic" | "other";

/** Shown when no transcription provider credential is configured. */
export const TRANSCRIBE_NOT_CONFIGURED_MESSAGE =
  "Voice transcription needs an OpenAI-compatible API key. Set MARSHAL_OPENAI_API_KEY (or OPENAI_API_KEY) and restart Marshal.";

const KINDS: readonly TranscribeErrorKind[] = ["not-configured", "mic", "other"];

/** Narrowing guard for values that arrive across IPC as plain strings. */
export function isTranscribeErrorKind(value: unknown): value is TranscribeErrorKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

/** Error carrying a classified {@link TranscribeErrorKind}. */
export class TranscribeConfigError extends Error {
  readonly kind: TranscribeErrorKind = "not-configured";
  constructor(message: string = TRANSCRIBE_NOT_CONFIGURED_MESSAGE) {
    super(message);
    this.name = "TranscribeConfigError";
  }
}

/** Classify an unknown transcription failure. */
export function transcribeErrorKind(error: unknown): TranscribeErrorKind {
  if (error instanceof TranscribeConfigError) return error.kind;
  return "other";
}
