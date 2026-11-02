/**
 * Configuration-backed hosted-runtime provider. Fully neutral: the endpoint,
 * shared token and (optionally) a pre-minted bearer token all come from
 * configuration, so a self-hosted or third-party runtime needs no adapter code.
 */

import type { HostedRuntimeEndpoint, HostedRuntimeProvider } from "./contracts";

export const CONFIG_HOSTED_RUNTIME_PROVIDER_ID = "config";

export interface ConfigHostedRuntimeOptions {
  endpoint: HostedRuntimeEndpoint;
  /** Pre-minted bearer token, when the runtime expects one. */
  authToken?: string;
  deviceIdentityPath?: string;
}

export function createConfigHostedRuntimeProvider(
  options: ConfigHostedRuntimeOptions,
): HostedRuntimeProvider {
  return {
    id: CONFIG_HOSTED_RUNTIME_PROVIDER_ID,
    resolveEndpoint: () => options.endpoint,
    acquireAuthToken: async () => options.authToken,
    resolveDeviceIdentityPath: (defaultPath) => options.deviceIdentityPath ?? defaultPath,
  };
}
