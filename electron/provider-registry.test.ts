import { describe, expect, it, vi } from "vitest";

import {
  BRAIN_MEMORY_PROVIDER_ID,
  LOCAL_MEMORY_PROVIDER_ID,
  LOCAL_SESSION_STORAGE_PROVIDER_ID,
} from "../common/provider-config";
import type { IMemoryStore } from "./backend/ports";
import { createMemoryProvider } from "./memory-provider";
import { ProviderRegistry } from "./provider-registry";
import {
  createBuiltinSessionStorageProviderRegistry,
  createSessionStorageProvider,
  type SessionStorageProviderInstance,
} from "./session-storage-provider";
import type { ISessionStore } from "./session-store";
import { testDouble } from "./testing/harness";

vi.mock("electron", () => ({
  app: {
    getPath: () => "Q:\\test-app-data",
    getVersion: () => "0.0.0-test",
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
  },
}));

describe("ProviderRegistry", () => {
  it("rejects duplicate IDs and mismatched factory products", () => {
    const registry = new ProviderRegistry<void, { id: string; value: number }>();
    registry.register({ id: "one", create: () => ({ id: "one", value: 1 }) });

    expect(() => registry.register({ id: "one", create: () => ({ id: "one", value: 2 }) })).toThrow(
      'Provider "one" is already registered',
    );

    const mismatched = new ProviderRegistry<void, { id: string; value: number }>();
    mismatched.register({ id: "one", create: () => ({ id: "two", value: 1 }) });
    expect(() => mismatched.create("one", undefined)).toThrow(
      'Provider factory registered as "one" returned instance "two"',
    );
  });

  it("reports registered IDs for unknown selections", () => {
    const registry = new ProviderRegistry<void, { id: string }>();
    registry.register({ id: "local", create: () => ({ id: "local" }) });
    expect(() => registry.create("missing", undefined)).toThrow(
      'Unknown provider "missing". Registered providers: local',
    );
  });
});

describe("memory provider factory", () => {
  const store = testDouble<IMemoryStore>({});

  it("uses local storage by default", () => {
    const selected = createMemoryProvider({ mockMode: false, createLocal: () => store });
    expect(selected.requestedId).toBe(BRAIN_MEMORY_PROVIDER_ID);
    expect(selected.id).toBe(LOCAL_MEMORY_PROVIDER_ID);
  });

  it("uses local fallback for a removed provider without preserving an identity branch", () => {
    const selected = createMemoryProvider({
      providerId: "removed-provider",
      mockMode: false,
      createLocal: () => store,
    });
    expect(selected.requestedId).toBe("removed-provider");
    expect(selected.id).toBe(LOCAL_MEMORY_PROVIDER_ID);
  });
});

describe("session storage provider factory", () => {
  const store = testDouble<ISessionStore>({});

  function registry(): ProviderRegistry<{ mockMode: boolean }, SessionStorageProviderInstance> {
    const result = new ProviderRegistry<{ mockMode: boolean }, SessionStorageProviderInstance>();
    result.register({
      id: LOCAL_SESSION_STORAGE_PROVIDER_ID,
      create: () => ({ id: LOCAL_SESSION_STORAGE_PROVIDER_ID, store }),
    });
    return result;
  }

  it("registers only the local session store", () => {
    expect(createBuiltinSessionStorageProviderRegistry().ids()).toEqual(["local"]);
  });

  it("falls back to the local store for a persisted OneDrive selection", () => {
    const selected = createSessionStorageProvider({
      providerId: "onedrive",
      mockMode: false,
      registry: registry(),
    });
    expect(selected.requestedId).toBe("onedrive");
    expect(selected.id).toBe(LOCAL_SESSION_STORAGE_PROVIDER_ID);
  });

  it("keeps an explicit local selection in production mode", () => {
    const selected = createSessionStorageProvider({
      providerId: LOCAL_SESSION_STORAGE_PROVIDER_ID,
      mockMode: false,
      registry: registry(),
    });
    expect(selected.id).toBe(LOCAL_SESSION_STORAGE_PROVIDER_ID);
  });

  it("falls back safely when a configured session provider is unknown", () => {
    const selected = createSessionStorageProvider({
      providerId: "removed-provider",
      mockMode: false,
      registry: registry(),
    });
    expect(selected.requestedId).toBe("removed-provider");
    expect(selected.id).toBe(LOCAL_SESSION_STORAGE_PROVIDER_ID);
  });
});
