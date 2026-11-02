import {
  OPENAI_TRANSCRIPTION_PROVIDER_ID,
  normalizeProviderId,
} from "../../common/provider-config";
import { TranscriptionProviderRegistry, type TranscriptionProvider } from "./contracts";
import { createOpenAITranscriptionProvider } from "./providers/openai";

export type TranscriptionSelectionEnv = Readonly<Record<string, string | undefined>>;

export interface BuiltinTranscriptionRegistryOptions {
  env?: TranscriptionSelectionEnv;
  fetchImpl?: typeof fetch;
  acquireToken?: () => Promise<string>;
}

export function createBuiltinTranscriptionRegistry(
  options: BuiltinTranscriptionRegistryOptions = {},
): TranscriptionProviderRegistry {
  const registry = new TranscriptionProviderRegistry();
  registry.register(OPENAI_TRANSCRIPTION_PROVIDER_ID, () =>
    createOpenAITranscriptionProvider({
      ...(options.env ? { env: options.env } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.acquireToken ? { acquireApiKey: options.acquireToken } : {}),
    }),
  );
  return registry;
}

export function resolveTranscriptionProvider(options: {
  providerId?: string;
  registry?: TranscriptionProviderRegistry;
  env?: TranscriptionSelectionEnv;
  fetchImpl?: typeof fetch;
  acquireToken?: () => Promise<string>;
}): TranscriptionProvider {
  const env = options.env ?? process.env;
  const registry =
    options.registry ??
    createBuiltinTranscriptionRegistry({
      env,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.acquireToken ? { acquireToken: options.acquireToken } : {}),
    });
  const requestedId = normalizeProviderId(
    options.providerId ?? env.MARSHAL_TRANSCRIBE_PROVIDER,
    OPENAI_TRANSCRIPTION_PROVIDER_ID,
  );
  const effectiveId = registry.has(requestedId) ? requestedId : OPENAI_TRANSCRIPTION_PROVIDER_ID;
  return registry.create(effectiveId);
}
