import {
  DEFAULT_WORK_SERVICE_PROVIDER_IDS,
  normalizeWorkServiceProviderSettings,
} from "../../common/provider-config";
import type { WorkServiceProviderSettings } from "../../common/provider-config";
import type { NotificationProvider, WorkServiceProviders } from "./contracts";
import {
  createWorkServiceProviderRegistry,
  registerWorkServiceProvider,
  selectWorkServiceProvider,
} from "./registry";
import type { WorkServiceProviderRegistry } from "./registry";
import { RelayNotificationServiceProvider } from "./relay-service-provider";
import type { RelayNotificationAdapterDeps } from "./relay-service-provider";

export interface WorkServiceFactoryDeps {
  notifications: RelayNotificationAdapterDeps;
}

export interface WorkServiceProviderRegistries {
  notifications: WorkServiceProviderRegistry<NotificationProvider>;
}

export function createBuiltInWorkServiceProviderRegistries(
  deps: WorkServiceFactoryDeps,
): WorkServiceProviderRegistries {
  const notifications = createWorkServiceProviderRegistry<NotificationProvider>();
  registerWorkServiceProvider(
    notifications,
    DEFAULT_WORK_SERVICE_PROVIDER_IDS.notificationProviderId,
    () => new RelayNotificationServiceProvider(deps.notifications),
  );
  return { notifications };
}

export function selectWorkServiceProviders(
  settings: WorkServiceProviderSettings,
  registries: WorkServiceProviderRegistries,
): WorkServiceProviders {
  const normalized = normalizeWorkServiceProviderSettings(settings);
  return {
    notifications: selectWorkServiceProvider(
      registries.notifications,
      normalized.notificationProviderId,
      DEFAULT_WORK_SERVICE_PROVIDER_IDS.notificationProviderId,
    ),
  };
}

export function createBuiltInWorkServiceProviders(
  settings: WorkServiceProviderSettings,
  deps: WorkServiceFactoryDeps,
): WorkServiceProviders {
  return selectWorkServiceProviders(settings, createBuiltInWorkServiceProviderRegistries(deps));
}
