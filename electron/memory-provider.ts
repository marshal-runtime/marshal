import { DEFAULT_MEMORY_PROVIDER_ID, normalizeProviderId } from "../common/provider-config";
import { ActiveMemoryStore, LOCAL_MEMORY_PROVIDER_ID } from "./active-memory-store";
import type { IMemoryStore } from "./backend/ports";
import { FilesystemMemoryStore } from "./filesystem-memory-store";

export interface MemoryProviderSelection {
  readonly id: typeof LOCAL_MEMORY_PROVIDER_ID;
  readonly requestedId: string;
  readonly store: ActiveMemoryStore;
}

export interface CreateMemoryProviderOptions {
  readonly providerId?: string;
  readonly mockMode: boolean;
  readonly createLocal?: () => IMemoryStore;
}

/** Core always starts on the minimal local fallback. Runtime extensions may
 * replace its delegate after activation through the registration service. */
export function createMemoryProvider(
  options: CreateMemoryProviderOptions,
): MemoryProviderSelection {
  const requestedId = normalizeProviderId(options.providerId, DEFAULT_MEMORY_PROVIDER_ID);
  const localStore = options.createLocal?.() ?? new FilesystemMemoryStore();
  return {
    id: LOCAL_MEMORY_PROVIDER_ID,
    requestedId,
    store: new ActiveMemoryStore(localStore, requestedId),
  };
}

export { LOCAL_MEMORY_PROVIDER_ID } from "./active-memory-store";
