import { NO_WORK_SERVICE_PROVIDER_ID } from "../../common/provider-config";
import { ProviderRegistry } from "../provider-registry";
import type { ProviderInstance } from "../provider-registry";
import type { WorkServiceProviderId } from "./contracts";

export type WorkServiceProviderFactory<TProvider extends { readonly id: WorkServiceProviderId }> =
  () => TProvider;

export type WorkServiceProviderRegistry<TProvider extends ProviderInstance> = ProviderRegistry<
  void,
  TProvider
>;

function validateProviderId(id: WorkServiceProviderId, allowDisabled: boolean): void {
  if (id.trim() !== id || id.length === 0) {
    throw new Error("Work-service provider ID must be a non-empty, trimmed string");
  }
  if (!allowDisabled && id === NO_WORK_SERVICE_PROVIDER_ID) {
    throw new Error(`Work-service provider "${NO_WORK_SERVICE_PROVIDER_ID}" is reserved`);
  }
}

export function createWorkServiceProviderRegistry<
  TProvider extends ProviderInstance,
>(): WorkServiceProviderRegistry<TProvider> {
  return new ProviderRegistry<void, TProvider>();
}

export function registerWorkServiceProvider<TProvider extends ProviderInstance>(
  registry: WorkServiceProviderRegistry<TProvider>,
  id: WorkServiceProviderId,
  factory: WorkServiceProviderFactory<TProvider>,
): void {
  validateProviderId(id, false);
  registry.register({ id, create: factory });
}

export function selectWorkServiceProvider<TProvider extends ProviderInstance>(
  registry: WorkServiceProviderRegistry<TProvider>,
  id: WorkServiceProviderId,
  fallbackId?: WorkServiceProviderId,
): TProvider | null {
  validateProviderId(id, true);
  if (id === NO_WORK_SERVICE_PROVIDER_ID) return null;
  if (registry.has(id)) return registry.create(id, undefined);
  if (fallbackId) {
    validateProviderId(fallbackId, true);
    if (fallbackId === NO_WORK_SERVICE_PROVIDER_ID) return null;
    if (registry.has(fallbackId)) return registry.create(fallbackId, undefined);
  }
  return registry.create(id, undefined);
}
