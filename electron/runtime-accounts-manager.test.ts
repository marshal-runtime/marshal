import { describe, expect, it, vi } from "vitest";

import type { MSettings } from "../common/marshal-ipc-contract";
import type { RuntimeAccountUsage } from "../common/runtime-account-usage";
import type { RuntimeAuthLoginResult, RuntimeClient } from "./backend/runtime-contract";
import {
  RuntimeAccountsManager,
  type RuntimeAccountsManagerDeps,
} from "./runtime-accounts-manager";
import { flushMicrotasks, testDouble } from "./testing/harness";

const WORKSPACE_DIR = "/tmp/marshal-runtime-accounts";

type AccountSettings = Pick<MSettings, "runtimeAccounts">;

function settingsStore(initial: AccountSettings = {}) {
  let current = testDouble<MSettings>(initial);
  return {
    get: () => current,
    update: vi.fn<(partial: Partial<MSettings>) => void>((partial) => {
      current = { ...current, ...partial };
    }),
  };
}

function fakeClient(
  options: { authenticated?: boolean; loginResult?: RuntimeAuthLoginResult } = {},
) {
  let authenticated = options.authenticated ?? false;
  const stop = vi.fn<RuntimeClient["stop"]>(async () => []);
  const logout = vi.fn<NonNullable<RuntimeClient["logout"]>>(async () => {
    authenticated = false;
  });
  const login = vi.fn<NonNullable<RuntimeClient["login"]>>(async () => {
    const result = options.loginResult ?? { status: "authenticated" };
    if (result.status === "authenticated") authenticated = true;
    return result;
  });
  const client = testDouble<RuntimeClient>({
    stop,
    getAuthStatus: vi.fn<RuntimeClient["getAuthStatus"]>(async () => ({
      isAuthenticated: authenticated,
    })),
    login,
    logout,
  });
  return {
    client,
    stop,
    login,
    logout,
    signIn: () => {
      authenticated = true;
    },
  };
}

function manager(
  initial: AccountSettings = {},
  client = fakeClient(),
  onSignInChanged = vi.fn<() => void>(),
) {
  const settings = settingsStore(initial);
  const createClientFactory = vi.fn<RuntimeAccountsManagerDeps["createClientFactory"]>(
    () => async () => client.client,
  );
  const accounts = new RuntimeAccountsManager({
    settings,
    createClientFactory,
    workspaceDir: WORKSPACE_DIR,
    onSignInChanged,
  });
  return { accounts, settings, createClientFactory, client, onSignInChanged };
}

const USAGE: RuntimeAccountUsage = {
  available: true,
  plan: "max",
  windows: [{ kind: "five_hour", usedPercent: 10, source: "fetch", fetchedAt: 1 }],
  fetchedAt: 1,
};

function usageManager(getUsage: NonNullable<RuntimeClient["getUsage"]>) {
  const fake = fakeClient({ authenticated: true });
  const usage = vi.fn<NonNullable<RuntimeClient["getUsage"]>>(getUsage);
  Object.assign(fake.client, { getUsage: usage });
  return { ...manager({}, fake), usage, fake };
}

describe("RuntimeAccountsManager usage", () => {
  it("reads usage on a short-lived client and caches it for a minute", async () => {
    vi.useFakeTimers();
    try {
      const { accounts, usage, fake, createClientFactory } = usageManager(async () => USAGE);

      await expect(accounts.getUsage("claude", "default")).resolves.toEqual(USAGE);
      await expect(accounts.getUsage("claude", "default")).resolves.toEqual(USAGE);
      expect(usage).toHaveBeenCalledTimes(1);
      expect(createClientFactory).toHaveBeenCalledWith("claude", undefined);
      expect(fake.stop).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(61_000);
      await accounts.getUsage("claude", "default");
      await accounts.getUsage("claude", "default", { force: true });
      expect(usage).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never overlaps reads of one account", async () => {
    let release!: (value: RuntimeAccountUsage) => void;
    const { accounts, usage } = usageManager(
      () =>
        new Promise<RuntimeAccountUsage>((resolve) => {
          release = resolve;
        }),
    );

    const first = accounts.getUsage("claude", "default", { force: true });
    const second = accounts.getUsage("claude", "default", { force: true });
    await flushMicrotasks();
    release(USAGE);

    await expect(Promise.all([first, second])).resolves.toEqual([USAGE, USAGE]);
    expect(usage).toHaveBeenCalledTimes(1);
  });

  it("reports a runtime without usage as not applicable and a failing read as an error", async () => {
    const none = manager();
    await expect(none.accounts.getUsage("cursor", "default")).resolves.toMatchObject({
      available: false,
      reason: "not_applicable",
    });

    const failing = usageManager(async () => {
      throw new Error("spawn failed");
    });
    await expect(failing.accounts.getUsage("claude", "default")).resolves.toMatchObject({
      available: false,
      reason: "error",
    });
    expect(failing.fake.stop).toHaveBeenCalledOnce();
  });

  it("drops cached usage when a sign-in changes and rejects unknown accounts", async () => {
    const { accounts, usage } = usageManager(async () => USAGE);
    await accounts.getUsage("claude", "default");
    expect(accounts.lastKnownUsage("claude", "default")).toEqual(USAGE);

    await accounts.signOut("claude", "default");
    expect(accounts.lastKnownUsage("claude", "default")).toBeUndefined();
    await accounts.getUsage("claude", "default");
    expect(usage).toHaveBeenCalledTimes(2);

    await expect(accounts.getUsage("claude", "ghost")).rejects.toThrow(/Unknown claude account/);
  });
});

describe("RuntimeAccountsManager", () => {
  it("lists each account runtime with its original account and per-account sign-in methods", () => {
    const { accounts } = manager();
    const runtimes = accounts.list();

    expect(runtimes.map((runtime) => runtime.runtimeId)).toEqual(["claude", "codex", "cursor"]);
    expect(runtimes[0]).toMatchObject({
      displayName: "Claude Agent",
      authMethods: [{ type: "browser" }],
      accounts: [
        { id: "default", label: "Primary", isOriginal: true, isDefault: true, targetKey: "claude" },
      ],
    });
    expect(runtimes[1]?.authMethods.map((method) => method.type)).toEqual([
      "browser",
      "device-code",
      "api-key",
    ]);
  });

  it("adds, renames, defaults, and removes accounts in settings", async () => {
    const { accounts, settings } = manager();

    const work = accounts.add("claude", "Work");
    expect(work).toMatchObject({ id: "work", label: "Work", targetKey: "claude@work" });
    accounts.add("claude", "Work");
    accounts.setDefault("claude", "work");
    accounts.rename("claude", "default", "Personal");

    expect(settings.get().runtimeAccounts).toEqual({
      claude: {
        accounts: [
          { id: "default", label: "Personal" },
          { id: "work", label: "Work" },
          { id: "work-2", label: "Work" },
        ],
        defaultAccountId: "work",
      },
    });
    expect(
      accounts.list()[0]?.accounts.map((account) => [account.label, account.isDefault]),
    ).toEqual([
      ["Personal", false],
      ["Work", true],
      ["Work", false],
    ]);

    expect(accounts.list()[0]?.accounts.map((account) => account.targetKey)).toEqual([
      "claude@default",
      "claude@work",
      "claude@work-2",
    ]);

    await accounts.remove("claude", "work");
    expect(settings.get().runtimeAccounts?.claude).toEqual({
      accounts: [
        { id: "default", label: "Personal" },
        { id: "work-2", label: "Work" },
      ],
    });
  });

  it("signs a removed account out and never removes the original account", async () => {
    const { accounts, createClientFactory, client } = manager({
      runtimeAccounts: { codex: { accounts: [{ id: "team" }] } },
    });

    await accounts.remove("codex", "team");

    expect(createClientFactory).toHaveBeenCalledWith("codex", "team");
    expect(client.logout).toHaveBeenCalledTimes(1);
    await expect(accounts.remove("codex", "default")).rejects.toThrow(
      "The original account cannot be removed",
    );
  });

  it("rejects runtimes without accounts, unknown accounts, and blank names", async () => {
    const { accounts } = manager();

    expect(() => accounts.add("copilot", "Work")).toThrow("copilot does not support accounts");
    expect(() => accounts.add("claude", "   ")).toThrow("Account name is required");
    expect(() => accounts.setDefault("claude", "missing")).toThrow(
      'Unknown claude account "missing"',
    );
    await expect(accounts.getStatus("claude", "missing")).rejects.toThrow("Unknown claude account");
  });

  it("checks status on a short-lived client of that account", async () => {
    const { accounts, createClientFactory, client } = manager(
      { runtimeAccounts: { claude: { accounts: [{ id: "work" }] } } },
      fakeClient({ authenticated: true }),
    );

    await expect(accounts.getStatus("claude", "work")).resolves.toEqual({ isAuthenticated: true });
    await accounts.getStatus("claude", "default");

    expect(createClientFactory.mock.calls).toEqual([
      ["claude", "work"],
      ["claude", undefined],
    ]);
    expect(client.stop).toHaveBeenCalledTimes(2);
  });

  it("stops the client after a sign-in that completes immediately", async () => {
    const { accounts, client } = manager({
      runtimeAccounts: { codex: { accounts: [{ id: "team" }] } },
    });

    await expect(
      accounts.login("codex", "team", { type: "api-key", apiKey: "sk-test" }),
    ).resolves.toEqual({ status: "authenticated" });
    expect(client.stop).toHaveBeenCalledTimes(1);
  });

  it("reports account changes, sign-ins and sign-outs so model lists refresh", async () => {
    const { accounts, onSignInChanged } = manager({
      runtimeAccounts: { codex: { accounts: [{ id: "team" }] } },
    });

    await accounts.login("codex", "team", { type: "api-key", apiKey: "sk-test" });
    expect(onSignInChanged).toHaveBeenCalledTimes(1);
    await accounts.signOut("codex", "team");
    expect(onSignInChanged).toHaveBeenCalledTimes(2);
    accounts.add("codex", "Second");
    expect(onSignInChanged).toHaveBeenCalledTimes(3);
  });

  it("keeps a pending sign-in's client until the runtime reports the account signed in", async () => {
    vi.useFakeTimers();
    try {
      const client = fakeClient({
        loginResult: {
          status: "pending",
          method: "device-code",
          loginId: "login-1",
          verificationUri: "https://example.test/device",
          userCode: "ABCD-EFGH",
          intervalSeconds: 1,
        },
      });
      const { accounts } = manager(
        { runtimeAccounts: { codex: { accounts: [{ id: "team" }] } } },
        client,
      );

      await expect(accounts.login("codex", "team", { type: "device-code" })).resolves.toEqual({
        status: "pending",
        method: "device-code",
        verificationUri: "https://example.test/device",
        userCode: "ABCD-EFGH",
      });
      expect(client.stop).not.toHaveBeenCalled();

      client.signIn();
      await vi.advanceTimersByTimeAsync(1_000);
      await flushMicrotasks();

      expect(client.stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects sign-in methods whose credentials would not persist per account", async () => {
    const { accounts, createClientFactory } = manager();

    await expect(
      accounts.login("claude", "default", { type: "api-key", apiKey: "sk-ant-test" }),
    ).rejects.toThrow("Claude Agent accounts cannot use that sign-in");
    expect(createClientFactory).not.toHaveBeenCalled();
  });
});
