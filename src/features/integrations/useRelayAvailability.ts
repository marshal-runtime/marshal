import { useRelayProviderSettings } from "./useRelayProviderSettings";

/**
 * True when at least one relay provider runtime is registered and reachable.
 * Relay affordances follow whichever providers the composition root registered.
 */
export function useRelayAvailable(): boolean {
  const { providers } = useRelayProviderSettings();
  return providers.some((provider) => provider.available);
}
