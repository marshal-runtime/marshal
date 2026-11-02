import { describe, expect, it, vi } from "vitest";

import { testDouble } from "../../testing/harness/test-double";
import {
  clearCursorApiKey,
  loadStoredCursorApiKey,
  saveCursorApiKey,
  startCursorBrowserLogin,
} from "./auth";
import {
  CURSOR_API_KEY_ENV,
  CURSOR_MINTED_API_KEY_NAME,
  CURSOR_PRODUCTION_BACKEND_URL,
} from "./constants";
import type { CursorSdkFacade, SdkCredentialStore, StoredSdkCredentials } from "./sdk-facade";

class MemoryStore implements SdkCredentialStore {
  private credentials: StoredSdkCredentials | undefined;

  async load(): Promise<StoredSdkCredentials | undefined> {
    return this.credentials;
  }

  async save(credentials: StoredSdkCredentials): Promise<void> {
    this.credentials = credentials;
  }

  async clear(): Promise<void> {
    this.credentials = undefined;
  }
}

describe("Cursor API key storage", () => {
  it("prefers a stored key over the launch environment", async () => {
    const store = new MemoryStore();
    await saveCursorApiKey(store, "stored-key");
    expect(await loadStoredCursorApiKey(store, { [CURSOR_API_KEY_ENV]: "env-key" })).toBe(
      "stored-key",
    );
  });

  it("falls back to CURSOR_API_KEY when Marshal has no stored key", async () => {
    const store = new MemoryStore();
    expect(await loadStoredCursorApiKey(store, { [CURSOR_API_KEY_ENV]: "env-key" })).toBe(
      "env-key",
    );
  });

  it("rejects an empty pasted key", async () => {
    const store = new MemoryStore();
    await expect(saveCursorApiKey(store, "   ")).rejects.toThrow(
      "Cursor API key must not be empty",
    );
  });

  it("clears the stored key on sign-out", async () => {
    const store = new MemoryStore();
    await saveCursorApiKey(store, "stored-key");
    await clearCursorApiKey(store);
    expect(await loadStoredCursorApiKey(store, {})).toBeUndefined();
  });
});

describe("Cursor browser key mint", () => {
  it("returns a pending browser login once the SDK supplies a URL", async () => {
    const store = new MemoryStore();
    const sdk = testDouble<CursorSdkFacade>({
      login: vi.fn<CursorSdkFacade["login"]>(async (options) => {
        options?.onLoginUrl?.("https://cursor.com/login");
        return {
          apiKey: "minted-key",
          email: "user@example.com",
          apiKeyExpiresAtMs: 1,
        };
      }),
    });

    const pending = await startCursorBrowserLogin(sdk, store);
    expect(pending.result).toMatchObject({
      status: "pending",
      method: "browser",
      authorizationUrl: "https://cursor.com/login",
    });
    await pending.completion;
    expect(sdk.login).toHaveBeenCalledWith(
      expect.objectContaining({
        store,
        openBrowser: true,
        apiKeyName: CURSOR_MINTED_API_KEY_NAME,
      }),
    );
    expect(await store.load()).toMatchObject({
      apiKey: "minted-key",
      email: "user@example.com",
      backendUrl: CURSOR_PRODUCTION_BACKEND_URL,
    });
  });
});
