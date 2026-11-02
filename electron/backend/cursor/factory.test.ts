import { describe, expect, it, vi } from "vitest";

import { createCursorClientFactory } from "./factory";
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

function fakeSdk(): CursorSdkFacade {
  return {
    createAgent: vi.fn<CursorSdkFacade["createAgent"]>(),
    resumeAgent: vi.fn<CursorSdkFacade["resumeAgent"]>(),
    listRuns: vi.fn<CursorSdkFacade["listRuns"]>(),
    cancelRun: vi.fn<CursorSdkFacade["cancelRun"]>(),
    listModels: vi.fn<CursorSdkFacade["listModels"]>(),
    me: vi.fn<CursorSdkFacade["me"]>(),
    login: vi.fn<CursorSdkFacade["login"]>(),
    logout: vi.fn<CursorSdkFacade["logout"]>(),
    authStatus: vi.fn<CursorSdkFacade["authStatus"]>(),
    createFileCredentialStore: vi.fn<CursorSdkFacade["createFileCredentialStore"]>(
      () => new MemoryStore(),
    ),
  };
}

describe("createCursorClientFactory", () => {
  it("lets the launch-environment API key sign in only the original account", async () => {
    const env = { CURSOR_API_KEY: "key_from_launch_env" };
    const original = await createCursorClientFactory({
      sdk: fakeSdk(),
      store: new MemoryStore(),
      env,
    })("/tmp/workspace");
    const extra = await createCursorClientFactory({
      sdk: fakeSdk(),
      store: new MemoryStore(),
      env,
      accountId: "work",
    })("/tmp/workspace");

    await expect(original.getAuthStatus()).resolves.toMatchObject({ isAuthenticated: true });
    await expect(extra.getAuthStatus()).resolves.toMatchObject({ isAuthenticated: false });
  });

  it("opens an extra account's own credential store", async () => {
    const sdk = fakeSdk();
    await createCursorClientFactory({
      sdk,
      env: {},
      accountId: "work",
      credentialStorePath: "/tmp/cursor-accounts/work/auth.json",
    })("/tmp/workspace");

    expect(sdk.createFileCredentialStore).toHaveBeenCalledWith(
      "/tmp/cursor-accounts/work/auth.json",
    );
  });

  it("injects the workspace directory into the runtime client", async () => {
    const store = new MemoryStore();
    const sdk = {
      createAgent: vi.fn<CursorSdkFacade["createAgent"]>(),
      resumeAgent: vi.fn<CursorSdkFacade["resumeAgent"]>(),
      listRuns: vi.fn<CursorSdkFacade["listRuns"]>(),
      cancelRun: vi.fn<CursorSdkFacade["cancelRun"]>(),
      listModels: vi.fn<CursorSdkFacade["listModels"]>(),
      me: vi.fn<CursorSdkFacade["me"]>(),
      login: vi.fn<CursorSdkFacade["login"]>(),
      logout: vi.fn<CursorSdkFacade["logout"]>(),
      authStatus: vi.fn<CursorSdkFacade["authStatus"]>(),
      createFileCredentialStore: vi.fn<CursorSdkFacade["createFileCredentialStore"]>(),
    } satisfies CursorSdkFacade;
    const factory = createCursorClientFactory({ sdk, store, env: {} });
    const client = await factory("/tmp/workspace");
    await expect(client.getAuthStatus()).resolves.toMatchObject({ isAuthenticated: false });
  });
});
