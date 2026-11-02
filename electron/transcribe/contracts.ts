/**
 * Provider-neutral transcription contract.
 *
 * Speech-to-text differs per vendor in auth (delegated token vs. API key),
 * request encoding and response shape. Core code hands over bytes and expects
 * text back; everything else belongs to the adapter.
 */

export interface TranscriptionRequest {
  audio: Uint8Array;
  /** MIME type of the supplied audio. */
  mimeType: string;
  /** BCP-47 locales to consider. */
  locales: string[];
  signal?: AbortSignal;
}

export interface TranscriptionProvider {
  readonly id: string;
  /** Returns the combined transcript, possibly empty for silence. */
  transcribe(request: TranscriptionRequest): Promise<string>;
}

export type TranscriptionProviderFactory = () => TranscriptionProvider;

export class TranscriptionProviderRegistry {
  private readonly factories = new Map<string, TranscriptionProviderFactory>();

  register(id: string, factory: TranscriptionProviderFactory): void {
    if (id.trim() !== id || id.length === 0) {
      throw new Error("Transcription provider ID must be a non-empty, trimmed string");
    }
    if (this.factories.has(id)) {
      throw new Error(`Transcription provider "${id}" is already registered`);
    }
    this.factories.set(id, factory);
  }

  has(id: string): boolean {
    return this.factories.has(id);
  }

  registeredIds(): string[] {
    return [...this.factories.keys()].sort();
  }

  create(id: string): TranscriptionProvider {
    const factory = this.factories.get(id);
    if (!factory) {
      throw new Error(
        `Unknown transcription provider "${id}". Registered providers: ${
          this.registeredIds().join(", ") || "(none)"
        }`,
      );
    }
    const provider = factory();
    if (provider.id !== id) {
      throw new Error(
        `Transcription provider factory registered as "${id}" returned provider "${provider.id}"`,
      );
    }
    return provider;
  }
}

/** Filename hint some multipart APIs use to infer the container format. */
export function audioFileName(mimeType: string): string {
  const normalized = (mimeType.split(";")[0] ?? "").trim().toLowerCase();
  if (normalized === "audio/webm") return "audio.webm";
  if (normalized === "audio/ogg") return "audio.ogg";
  if (normalized === "audio/mpeg") return "audio.mp3";
  if (normalized === "audio/mp4") return "audio.m4a";
  return "audio.wav";
}

/** Copy into a fresh ArrayBuffer to avoid SharedArrayBuffer typing issues. */
export function audioBlob(audio: Uint8Array, mimeType: string): Blob {
  const bytes = new Uint8Array(audio.byteLength);
  bytes.set(audio);
  return new Blob([bytes], { type: mimeType });
}
