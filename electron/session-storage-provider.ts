import {
  DEFAULT_SESSION_STORAGE_PROVIDER_ID,
  LOCAL_SESSION_STORAGE_PROVIDER_ID,
  normalizeProviderId,
} from "../common/provider-config";
import { ProviderRegistry } from "./provider-registry";
import { LocalSessionStore, type ISessionStore } from "./session-store";

export interface SessionStorageProviderContext {
  mockMode: boolean;
}

export interface SessionStorageProviderInstance {
  id: string;
  store: ISessionStore;
}

export interface SessionStorageProviderFactories {
  createLocal(): LocalSessionStore;
}

const DEFAULT_FACTORIES: SessionStorageProviderFactories = {
  createLocal: () => new LocalSessionStore(),
};

export function createBuiltinSessionStorageProviderRegistry(
  factories: SessionStorageProviderFactories = DEFAULT_FACTORIES,
): ProviderRegistry<SessionStorageProviderContext, SessionStorageProviderInstance> {
  const registry = new ProviderRegistry<
    SessionStorageProviderContext,
    SessionStorageProviderInstance
  >();
  registry.register({
    id: LOCAL_SESSION_STORAGE_PROVIDER_ID,
    create: () => ({
      id: LOCAL_SESSION_STORAGE_PROVIDER_ID,
      store: factories.createLocal(),
    }),
  });
  return registry;
}

export interface CreateSessionStorageProviderOptions extends SessionStorageProviderContext {
  providerId?: string;
  registry?: ProviderRegistry<SessionStorageProviderContext, SessionStorageProviderInstance>;
}

export interface SessionStorageProviderSelection extends SessionStorageProviderInstance {
  requestedId: string;
}

export function createSessionStorageProvider(
  options: CreateSessionStorageProviderOptions,
): SessionStorageProviderSelection {
  const requestedId = normalizeProviderId(options.providerId, DEFAULT_SESSION_STORAGE_PROVIDER_ID);
  const registry = options.registry ?? createBuiltinSessionStorageProviderRegistry();
  const effectiveId = registry.has(requestedId) ? requestedId : DEFAULT_SESSION_STORAGE_PROVIDER_ID;
  const instance = registry.create(effectiveId, { mockMode: options.mockMode });
  return { ...instance, requestedId };
}
