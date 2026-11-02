import { CURSOR_AUTH_SETUP_INSTRUCTIONS } from "../../../common/runtime-config";
import type { RuntimeAuthLoginRequest, RuntimeAuthLoginResult } from "../runtime-contract";
import {
  CURSOR_API_KEY_ENV,
  CURSOR_BACKEND_URL_ENV,
  CURSOR_BROWSER_LOGIN_ID_PREFIX,
  CURSOR_CREDENTIAL_STORE_VERSION,
  CURSOR_LOGIN_URL_TIMEOUT_MS,
  CURSOR_MINTED_API_KEY_NAME,
  CURSOR_PRODUCTION_BACKEND_URL,
  type CursorProcessEnv,
} from "./constants";
import type { CursorSdkFacade, SdkCredentialStore, StoredSdkCredentials } from "./sdk-facade";

export function readCursorApiKeyFromEnv(env: CursorProcessEnv = process.env): string | undefined {
  const value = env[CURSOR_API_KEY_ENV]?.trim();
  return value || undefined;
}

export function cursorBackendUrl(env: CursorProcessEnv = process.env): string {
  return env[CURSOR_BACKEND_URL_ENV]?.trim() || CURSOR_PRODUCTION_BACKEND_URL;
}

export async function loadStoredCursorApiKey(
  store: SdkCredentialStore,
  env: CursorProcessEnv = process.env,
): Promise<string | undefined> {
  const stored = await store.load();
  return stored?.apiKey.trim() || readCursorApiKeyFromEnv(env);
}

export async function saveCursorApiKey(
  store: SdkCredentialStore,
  apiKey: string,
  extras?: Partial<Pick<StoredSdkCredentials, "email" | "apiKeyExpiresAtMs" | "backendUrl">>,
  env: CursorProcessEnv = process.env,
): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("Cursor API key must not be empty");
  await store.save({
    version: CURSOR_CREDENTIAL_STORE_VERSION,
    backendUrl: extras?.backendUrl ?? cursorBackendUrl(env),
    apiKey: trimmed,
    createdAtMs: Date.now(),
    ...(extras?.email ? { email: extras.email } : {}),
    ...(extras?.apiKeyExpiresAtMs !== undefined
      ? { apiKeyExpiresAtMs: extras.apiKeyExpiresAtMs }
      : {}),
  });
}

export async function clearCursorApiKey(store: SdkCredentialStore): Promise<void> {
  await store.clear();
}

export async function unauthenticatedCursorStatus(): Promise<{
  isAuthenticated: false;
  statusMessage: string;
}> {
  return {
    isAuthenticated: false,
    statusMessage: CURSOR_AUTH_SETUP_INSTRUCTIONS,
  };
}

export async function startCursorBrowserLogin(
  sdk: CursorSdkFacade,
  store: SdkCredentialStore,
): Promise<{ result: RuntimeAuthLoginResult; completion: Promise<void> }> {
  let resolveUrl: ((url: string) => void) | undefined;
  const authorizationUrl = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Cursor login URL was not provided")),
      CURSOR_LOGIN_URL_TIMEOUT_MS,
    );
    resolveUrl = (url) => {
      clearTimeout(timer);
      resolve(url);
    };
  });
  const completion = sdk
    .login({
      store,
      openBrowser: true,
      apiKeyName: CURSOR_MINTED_API_KEY_NAME,
      onLoginUrl: (url) => resolveUrl?.(url),
    })
    .then(async (login) => {
      await saveCursorApiKey(store, login.apiKey, {
        email: login.email,
        apiKeyExpiresAtMs: login.apiKeyExpiresAtMs,
      });
    });
  completion.catch(() => undefined);
  return {
    result: {
      status: "pending",
      method: "browser",
      loginId: `${CURSOR_BROWSER_LOGIN_ID_PREFIX}${Date.now()}`,
      authorizationUrl: await authorizationUrl,
    },
    completion,
  };
}

export function cursorLoginRequestUnsupported(request: RuntimeAuthLoginRequest): Error {
  return new Error(`Cursor does not support ${request.type} authentication`);
}
