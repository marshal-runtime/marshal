/**
 * OpenAI-compatible transcription adapter.
 *
 * Deliberately a plain `fetch` call against the `/audio/transcriptions`
 * endpoint rather than the OpenAI SDK: the request is one multipart POST and
 * pulling in the SDK would add a large dependency for it. Any OpenAI-compatible
 * gateway works by pointing the base URL elsewhere.
 *
 * Configuration (all optional except the API key):
 *   MARSHAL_OPENAI_API_KEY        (falls back to OPENAI_API_KEY)
 *   MARSHAL_OPENAI_BASE_URL       (default https://api.openai.com/v1)
 *   MARSHAL_OPENAI_TRANSCRIBE_MODEL (default whisper-1)
 */

import { createLogger } from "../../../common/marshal-logger";
import { OPENAI_TRANSCRIPTION_PROVIDER_ID } from "../../../common/provider-config";
import { TranscribeConfigError } from "../../../common/transcribe-errors";
import {
  audioBlob,
  audioFileName,
  type TranscriptionProvider,
  type TranscriptionRequest,
} from "../contracts";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_TRANSCRIBE_MODEL = "whisper-1";

const log = createLogger("Transcribe:OpenAI");

export type OpenAITranscriptionEnv = Readonly<Record<string, string | undefined>>;

export interface OpenAITranscriptionConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
}

export interface OpenAITranscriptionOptions {
  env?: OpenAITranscriptionEnv;
  fetchImpl?: typeof fetch;
  acquireApiKey?: () => Promise<string>;
}

export function readOpenAITranscriptionConfig(
  env: OpenAITranscriptionEnv = process.env,
): OpenAITranscriptionConfig {
  const apiKey = env.MARSHAL_OPENAI_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() || undefined;
  const baseUrl = (env.MARSHAL_OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
  return {
    ...(apiKey ? { apiKey } : {}),
    baseUrl,
    model: env.MARSHAL_OPENAI_TRANSCRIBE_MODEL ?? DEFAULT_OPENAI_TRANSCRIBE_MODEL,
  };
}

interface OpenAITranscriptionResponse {
  text?: string;
}

export function createOpenAITranscriptionProvider(
  options: OpenAITranscriptionOptions = {},
): TranscriptionProvider {
  return {
    id: OPENAI_TRANSCRIPTION_PROVIDER_ID,
    async transcribe(request: TranscriptionRequest): Promise<string> {
      const config = readOpenAITranscriptionConfig(options.env);
      const acquire =
        options.acquireApiKey ??
        (config.apiKey
          ? async () => config.apiKey!
          : () => {
              throw new TranscribeConfigError();
            });
      const apiKey = await acquire();

      const form = new FormData();
      form.append(
        "file",
        audioBlob(request.audio, request.mimeType),
        audioFileName(request.mimeType),
      );
      form.append("model", config.model);
      // The API takes a single ISO-639-1 language hint, not a locale list.
      const language = request.locales[0]?.split("-")[0];
      if (language) form.append("language", language);

      const resp = await (options.fetchImpl ?? fetch)(`${config.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        ...(request.signal ? { signal: request.signal } : {}),
      });

      if (!resp.ok) {
        log.error(`Transcription HTTP ${resp.status}`);
        throw new Error(`Transcription failed (HTTP ${resp.status})`);
      }

      const data: OpenAITranscriptionResponse = await resp.json();
      return (data.text ?? "").replace(/\s+/g, " ").trim();
    },
  };
}
