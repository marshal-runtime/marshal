import { describe, expect, it, vi } from "vitest";

import { DEFAULT_WORK_SERVICE_PROVIDER_IDS } from "../../common/provider-config";
import type { NotificationProvider } from "./contracts";
import {
  createBuiltInWorkServiceProviderRegistries,
  createBuiltInWorkServiceProviders,
  selectWorkServiceProviders,
} from "./factory";
import type { WorkServiceFactoryDeps } from "./factory";
import { registerWorkServiceProvider } from "./registry";

function createDeps(): WorkServiceFactoryDeps {
  return {
    notifications: {
      relay: {
        processing: false,
        displaced: false,
        isConnected: vi.fn<() => boolean>(() => true),
        connect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
        disconnect: vi.fn<() => void>(),
      },
      isAvailable: vi.fn<() => boolean>(() => true),
      send: vi
        .fn<(content: string, sessionId?: string) => Promise<void>>()
        .mockResolvedValue(undefined),
    },
  };
}

function futureNotificationProvider(id: string): NotificationProvider {
  return {
    id,
    isAvailable: () => true,
    getStatus: () => ({ connected: false, processing: false }),
    connect: async () => undefined,
    disconnect: () => undefined,
    send: async () => undefined,
  };
}

describe("createBuiltInWorkServiceProviders", () => {
  it("selects the built-in notification provider from deterministic defaults", () => {
    const providers = createBuiltInWorkServiceProviders(
      DEFAULT_WORK_SERVICE_PROVIDER_IDS,
      createDeps(),
    );

    expect(providers.notifications?.id).toBe(
      DEFAULT_WORK_SERVICE_PROVIDER_IDS.notificationProviderId,
    );
  });

  it("disables notifications with none", () => {
    const providers = createBuiltInWorkServiceProviders(
      { ...DEFAULT_WORK_SERVICE_PROVIDER_IDS, notificationProviderId: "none" },
      createDeps(),
    );

    expect(providers.notifications).toBeNull();
  });

  it("delegates notification status and sends to the relay deps", async () => {
    const deps = createDeps();
    const providers = createBuiltInWorkServiceProviders(DEFAULT_WORK_SERVICE_PROVIDER_IDS, deps);

    expect(providers.notifications?.getStatus()).toEqual({
      connected: true,
      processing: false,
      metadata: { displaced: false },
    });
    await providers.notifications?.send("background update", "session-1");
    expect(deps.notifications.send).toHaveBeenCalledWith("background update", "session-1");
  });

  it("falls back to the built-in default when a configured adapter is unavailable", () => {
    const providers = createBuiltInWorkServiceProviders(
      {
        ...DEFAULT_WORK_SERVICE_PROVIDER_IDS,
        notificationProviderId: "future-adapter",
      },
      createDeps(),
    );

    expect(providers.notifications?.id).toBe(
      DEFAULT_WORK_SERVICE_PROVIDER_IDS.notificationProviderId,
    );
  });

  it("selects a future adapter when its registry provides the configured ID", () => {
    const registries = createBuiltInWorkServiceProviderRegistries(createDeps());
    registerWorkServiceProvider(registries.notifications, "future-notifications", () =>
      futureNotificationProvider("future-notifications"),
    );

    const providers = selectWorkServiceProviders(
      {
        ...DEFAULT_WORK_SERVICE_PROVIDER_IDS,
        notificationProviderId: "future-notifications",
      },
      registries,
    );

    expect(providers.notifications?.id).toBe("future-notifications");
  });
});
