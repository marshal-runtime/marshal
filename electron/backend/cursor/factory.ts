import type { RuntimeClientFactory } from "../runtime-contract";
import { CursorRuntimeClient } from "./client";
import { CURSOR_API_KEY_ENV, type CursorProcessEnv } from "./constants";
import { marshalCursorCredentialStorePath } from "./credential-store";
import { loadCursorSdk, type CursorSdkFacade, type SdkCredentialStore } from "./sdk-facade";

export interface CursorClientFactoryOptions {
  env?: CursorProcessEnv;
  store?: SdkCredentialStore;
  sdk?: CursorSdkFacade;
  credentialStorePath?: string;
  /** An extra account: its own credential store, and no launch-environment API key. */
  accountId?: string;
}

function accountEnvironment(env: CursorProcessEnv, accountId: string | undefined) {
  if (!accountId) return env;
  const scoped = { ...env };
  for (const name of Object.keys(scoped)) {
    if (name.toUpperCase() === CURSOR_API_KEY_ENV) delete scoped[name];
  }
  return scoped;
}

export function createCursorClientFactory(
  options: CursorClientFactoryOptions = {},
): RuntimeClientFactory {
  return async (workspaceDir) => {
    const sdk = options.sdk ?? (await loadCursorSdk());
    const store =
      options.store ??
      sdk.createFileCredentialStore(
        options.credentialStorePath ??
          marshalCursorCredentialStorePath(
            (await import("../../app-paths")).getAppDataDir(),
            options.accountId,
          ),
      );
    return new CursorRuntimeClient(sdk, {
      workspaceDir,
      env: accountEnvironment(options.env ?? process.env, options.accountId),
      store,
    });
  };
}
