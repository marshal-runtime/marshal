/**
 * Hosted-runtime provider selection.
 *
 * The hosted gateway has no built-in endpoint: the URL, the shared handshake
 * token and (optionally) a pre-minted bearer token all come from
 * configuration. With no URL configured, hosted sign-in reports that the
 * gateway is not configured instead of dialing a default host.
 */

import {
  CONFIG_HOSTED_RUNTIME_PROVIDER_ID,
  createConfigHostedRuntimeProvider,
} from "./config-provider";
import type { HostedRuntimeProvider } from "./contracts";
import { HostedRuntimeRegistry } from "./contracts";

// Marshal identity: these MARSHAL_* names are part of the Gateway service contract.
export const HOSTED_GATEWAY_URL_ENV = "MARSHAL_HOSTED_GATEWAY_URL";
export const HOSTED_GATEWAY_SHARED_TOKEN_ENV = "MARSHAL_GATEWAY_TOKEN";
export const HOSTED_GATEWAY_AUTH_TOKEN_ENV = "MARSHAL_HOSTED_GATEWAY_AUTH_TOKEN";

export type HostedRuntimeSelectionEnv = Readonly<Record<string, string | undefined>>;

export function createBuiltinHostedRuntimeRegistry(
  env: HostedRuntimeSelectionEnv = process.env,
): HostedRuntimeRegistry {
  const registry = new HostedRuntimeRegistry();
  const authToken = env[HOSTED_GATEWAY_AUTH_TOKEN_ENV];
  registry.register(CONFIG_HOSTED_RUNTIME_PROVIDER_ID, () =>
    createConfigHostedRuntimeProvider({
      endpoint: {
        url: env[HOSTED_GATEWAY_URL_ENV] ?? "",
        sharedToken: env[HOSTED_GATEWAY_SHARED_TOKEN_ENV] ?? "",
      },
      ...(authToken ? { authToken } : {}),
    }),
  );
  return registry;
}

export function resolveHostedRuntimeProvider(
  env: HostedRuntimeSelectionEnv = process.env,
): HostedRuntimeProvider {
  return createBuiltinHostedRuntimeRegistry(env).create(CONFIG_HOSTED_RUNTIME_PROVIDER_ID);
}
