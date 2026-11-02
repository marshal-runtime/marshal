/**
 * Tests for CopilotBackend and CopilotSessionBackend.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeSessionError, sessionErrors } from "../../../common/telemetry/errors/marshal-session";
import { testDouble } from "../../testing/harness";
import type { RuntimeClient, RuntimeClientFactory, RuntimeModelInfo } from "../runtime-contract";
import type {
  ApprovalCallback,
  AttachApprovalRouterDeps,
  AuthStatus,
  RemoteSessionEvent,
} from "../types";

const { mockSendErrorTelemetry, mockSecureWriteFileSync, mockSecureMkdirSync } = vi.hoisted(() => ({
  mockSendErrorTelemetry: vi.fn<(err: unknown, cause?: unknown) => void>(),
  mockSecureWriteFileSync:
    vi.fn<(filePath: string, data: string | Buffer, opts?: { mode?: number }) => void>(),
  mockSecureMkdirSync: vi.fn<(dirPath: string, mode: number) => void>(),
}));
vi.mock("../../telemetry-errors", () => ({
  sendErrorTelemetry: mockSendErrorTelemetry,
  hasTelemetryMarker: () => false,
}));

vi.mock("../../platform-security", () => ({
  secureWriteFileSync: mockSecureWriteFileSync,
  secureMkdirSync: mockSecureMkdirSync,
}));

vi.mock("../../app-paths", () => ({
  getAppDataDir: () => "/mock-app-data",
}));
vi.mock("../../workspace-store", () => ({
  getActiveWorkspaceRoot: (workspaceDir: string) => workspaceDir,
}));

// ── Module mocks ─────────────────────────────────────────────────────────────
// Required because copilot/provider.ts transitively imports Electron APIs
// and copilot-sdk at module evaluation time.

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn<typeof import("fs").existsSync>(() => false),
    mkdirSync: vi.fn<typeof import("fs").mkdirSync>(),
    readFileSync: vi.fn<typeof import("fs").readFileSync>(),
    writeFileSync: vi.fn<typeof import("fs").writeFileSync>(),
    unlinkSync: vi.fn<typeof import("fs").unlinkSync>(),
    readdirSync: vi.fn<typeof import("fs").readdirSync>(() => []),
    accessSync: vi.fn<typeof import("fs").accessSync>(),
    chmodSync: vi.fn<typeof import("fs").chmodSync>(),
    constants: { X_OK: 1 },
    promises: { readFile: vi.fn<typeof import("fs").promises.readFile>() },
  },
  existsSync: vi.fn<typeof import("fs").existsSync>(() => false),
  mkdirSync: vi.fn<typeof import("fs").mkdirSync>(),
  readFileSync: vi.fn<typeof import("fs").readFileSync>(),
  writeFileSync: vi.fn<typeof import("fs").writeFileSync>(),
  unlinkSync: vi.fn<typeof import("fs").unlinkSync>(),
  readdirSync: vi.fn<typeof import("fs").readdirSync>(() => []),
  accessSync: vi.fn<typeof import("fs").accessSync>(),
  chmodSync: vi.fn<typeof import("fs").chmodSync>(),
  constants: { X_OK: 1 },
  promises: { readFile: vi.fn<typeof import("fs").promises.readFile>() },
}));

vi.mock("child_process", () => ({
  spawn: vi.fn<typeof import("child_process").spawn>(),
  execFile: vi.fn<typeof import("child_process").execFile>(),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getVersion: () => "0.0.0-test",
    getPath: vi.fn<(name: string) => string>((name: string) => {
      if (name === "home") return "/home/testuser";
      if (name === "temp") return "/tmp";
      return "/mock";
    }),
  },
}));

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: vi.fn<() => void>(),
}));

// Mock the adapter so attachApprovalRouter tests can assert the produced
// callback was registered without dragging in the broker/policy/SessionManager
// machinery.
const mockAdapter = vi.fn<ApprovalCallback>().mockResolvedValue("denied-interactively-by-user");
vi.mock("../local/approval-adapter", () => ({
  createApprovalCallbackAdapter: vi.fn<() => ApprovalCallback>(() => mockAdapter),
}));

// ── Test harness ─────────────────────────────────────────────────────────────

/**
 * Creates a minimal CopilotBackend with a stub client factory via dynamic
 * import (so mocks above are applied before the module loads its deps).
 * The client factory intentionally throws — none of the three new methods
 * require an initialized SDK client.
 */
async function createTestBackend() {
  const { CopilotBackend } = await import("./provider");
  const clientFactory = vi
    .fn<() => Promise<never>>()
    .mockRejectedValue(new Error("Should not call initClient"));
  return new CopilotBackend({
    workspaceDir: "/tmp/test-workspace",
    clientFactory,
  });
}

// ── symmetric lifecycle hooks ─────────────────────────────────────────────────

describe("CopilotSessionBackend — symmetric lifecycle hooks", () => {
  it("subscribeToRemoteEvents returns an immediate no-op unsubscribe and emits nothing", async () => {
    const backend = await createTestBackend();
    const received: RemoteSessionEvent[] = [];

    const unsub = await backend.sessions.subscribeToRemoteEvents((evt) => received.push(evt));

    expect(typeof unsub).toBe("function");
    expect(received).toEqual([]);
    expect(() => unsub()).not.toThrow();
  });

  it("applyConfigChange invokes recreate() exactly once", async () => {
    const backend = await createTestBackend();
    const recreate = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    await backend.sessions.applyConfigChange("session-123", recreate);

    expect(recreate).toHaveBeenCalledTimes(1);
  });

  it("notifyRenamed is a no-op and does not throw", async () => {
    const backend = await createTestBackend();

    const result = await backend.sessions.notifyRenamed("session-123", "New Name");

    expect(result).toBeUndefined();
  });
});

// ── signOut clears cached auth from JSON-with-comments config.json ──────────

describe("CopilotBackend.signOut — JSON-with-comments config.json", () => {
  it("strips logged_in_users and last_logged_in_user even when config has // comments", async () => {
    const backend = await createTestBackend();
    const fs = await import("fs");
    vi.mocked(fs.existsSync).mockImplementation((p) => String(p).endsWith("config.json"));
    vi.mocked(fs.readFileSync).mockReturnValue(
      `// User settings for the Copilot CLI.\n` +
        `// Edit at your own risk.\n` +
        `{\n` +
        `  "logged_in_users": [{"login":"alice"}],\n` +
        `  "last_logged_in_user": "alice",\n` +
        `  "telemetry": {"enabled": false}\n` +
        `}\n`,
    );
    mockSecureWriteFileSync.mockReset();

    void backend.signOut(); // don't await — keychain step is mocked but never resolves

    expect(mockSecureWriteFileSync).toHaveBeenCalledTimes(1);
    const payload = mockSecureWriteFileSync.mock.calls[0][1];
    expect(typeof payload).toBe("string");
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture: JSON.parse of a string we just wrote
    const written = JSON.parse(payload as string) as Record<string, unknown>;
    expect(written).not.toHaveProperty("logged_in_users");
    expect(written).not.toHaveProperty("last_logged_in_user");
    expect(written.telemetry).toEqual({ enabled: false });
  });
});

// ── killClientProcess tree-kills the CLI subtree on Windows ──────────────────

describe("CopilotBackend.killClientProcess — Windows subtree reap", () => {
  function withPlatform(value: NodeJS.Platform, fn: () => void) {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value, configurable: true });
    try {
      fn();
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  }

  it("force-kills the whole process tree via `taskkill /F /T` on win32", async () => {
    const backend = await createTestBackend();
    const cp = await import("child_process");
    const kill = vi.fn<(signal?: string) => boolean>();
    const internal = testDouble<{ client: unknown; killClientProcess(): void }>(backend);
    internal.client = {
      process: { pid: 4242, kill },
      markForceStopping: vi.fn<() => void>(),
    };
    vi.mocked(cp.spawn).mockReturnValue(
      testDouble<ReturnType<typeof cp.spawn>>({
        unref: vi.fn<() => void>(),
      }),
    );

    withPlatform("win32", () => {
      internal.killClientProcess();
    });

    // A single-PID SIGKILL orphans the CLI's MCP-server descendant tree on
    // Windows; the /T tree-kill is what actually reaps it.
    expect(cp.spawn).toHaveBeenCalledWith(
      "taskkill",
      ["/F", "/T", "/PID", "4242"],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it("does not shell out to taskkill on non-Windows platforms", async () => {
    const backend = await createTestBackend();
    const cp = await import("child_process");
    vi.mocked(cp.spawn).mockClear();
    const kill = vi.fn<(signal?: string) => boolean>();
    const internal = testDouble<{ client: unknown; killClientProcess(): void }>(backend);
    internal.client = {
      process: { pid: 99, kill },
      markForceStopping: vi.fn<() => void>(),
    };

    withPlatform("linux", () => {
      internal.killClientProcess();
    });

    expect(cp.spawn).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });
});

// ── getMcpConfig caching + playwrightHeadless bypass ─────────────────

describe("CopilotBackend.getMcpConfig — playwrightHeadless cache bypass", () => {
  it("caches the default but bypasses cache when playwrightHeadless=true", async () => {
    const backend = await createTestBackend();

    const defaultConfig = backend.getMcpConfig();
    const cachedAgain = backend.getMcpConfig();
    expect(cachedAgain).toBe(defaultConfig); // same object reference — cached

    const headlessConfig = backend.getMcpConfig(undefined, true);
    expect(headlessConfig).not.toBe(defaultConfig);
    const playwright = headlessConfig.playwright;
    // Playwright is configured as a local/stdio server, so it always has `args`.
    expect("args" in playwright && Array.isArray(playwright.args)).toBe(true);
    if (!("args" in playwright)) throw new Error("playwright config missing args");
    expect(playwright.args).toContain("--headless");

    const stillCached = backend.getMcpConfig();
    expect(stillCached).toBe(defaultConfig); // cache wasn't replaced
  });

  it("bypasses cache when any custom server has an envFile so .env edits take effect next session", async () => {
    const backend = await createTestBackend();

    const first = backend.getMcpConfig();
    const cachedAgain = backend.getMcpConfig();
    expect(cachedAgain).toBe(first); // baseline: caches with no envFile

    backend.setCustomMcpServers([
      { name: "demo", type: "command", command: "echo", envFile: "${mcpEnvDir}/demo.env" },
    ]);

    const afterEnvFile = backend.getMcpConfig();
    const afterEnvFileAgain = backend.getMcpConfig();
    expect(afterEnvFile).not.toBe(first); // cache invalidated on setCustomMcpServers
    expect(afterEnvFileAgain).not.toBe(afterEnvFile); // and not re-cached while envFile is in play
  });

  it("keeps local MCP servers on direct stdio while broker facades are disabled", async () => {
    const backend = await createTestBackend();
    backend.setCustomMcpServers([
      {
        name: "local-tool",
        type: "command",
        command: "npx",
        args: ["-y", "local-tool-mcp", "--stdio"],
      },
    ]);

    const config = await backend.prepareMcpConfig("session-local");

    expect(config.playwright).toHaveProperty("command");
    expect(config["local-tool"]).toMatchObject({
      command: "npx",
      args: ["-y", "local-tool-mcp", "--stdio"],
    });
    expect(config.playwright).not.toHaveProperty("url");
    expect(config["local-tool"]).not.toHaveProperty("url");
  });
});

describe("LocalBackend runtime-client auth", () => {
  it("delegates a typed login request when the adapter has no auth override", async () => {
    const { LocalBackend } = await import("../local/provider");
    const { createCopilotLocalRuntimeStrategy } = await import("./strategy");
    const login = vi
      .fn<NonNullable<RuntimeClient["login"]>>()
      .mockResolvedValue({ status: "authenticated" });
    const client = testDouble<RuntimeClient>({
      login,
      getAuthStatus: vi.fn<RuntimeClient["getAuthStatus"]>().mockResolvedValue({
        isAuthenticated: false,
      }),
    });
    const strategy = {
      ...createCopilotLocalRuntimeStrategy(),
      runtimeId: "test-local",
      auth: undefined,
    };
    const backend = new LocalBackend({
      workspaceDir: "/tmp/test-workspace",
      clientFactory: async () => client,
      strategy,
    });

    await backend.init();
    await expect(backend.login({ type: "api-key", apiKey: "secret" })).resolves.toEqual({});
    expect(login).toHaveBeenCalledWith({ type: "api-key", apiKey: "secret" });
  });

  it("calls client-native logout before terminating the runtime process", async () => {
    const { LocalBackend } = await import("../local/provider");
    const { createCopilotLocalRuntimeStrategy } = await import("./strategy");
    const order: string[] = [];
    const client = testDouble<RuntimeClient>({
      logout: vi.fn<NonNullable<RuntimeClient["logout"]>>(async () => {
        order.push("logout");
      }),
      process: {
        exitCode: null,
        killed: false,
        kill: () => {
          order.push("kill");
          return true;
        },
      },
    });
    const backend = new LocalBackend({
      workspaceDir: "/tmp/test-workspace",
      clientFactory: async () => client,
      strategy: {
        ...createCopilotLocalRuntimeStrategy(),
        runtimeId: "test-local",
        auth: undefined,
      },
    });

    await backend.init();
    await backend.signOut();

    expect(order).toEqual(["logout", "kill"]);
  });

  it("keeps client initialization blocked after sign-out until explicit login", async () => {
    const { LocalBackend } = await import("../local/provider");
    const { createCopilotLocalRuntimeStrategy } = await import("./strategy");
    const firstClient = testDouble<RuntimeClient>({
      logout: vi.fn<NonNullable<RuntimeClient["logout"]>>().mockResolvedValue(undefined),
      getAuthStatus: vi.fn<RuntimeClient["getAuthStatus"]>().mockResolvedValue({
        isAuthenticated: true,
        login: "environment",
      }),
    });
    const login = vi
      .fn<NonNullable<RuntimeClient["login"]>>()
      .mockResolvedValue({ status: "authenticated" });
    const secondClient = testDouble<RuntimeClient>({
      login,
      getAuthStatus: vi.fn<RuntimeClient["getAuthStatus"]>().mockResolvedValue({
        isAuthenticated: false,
      }),
    });
    const clientFactory = vi
      .fn<RuntimeClientFactory>()
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);
    const backend = new LocalBackend({
      workspaceDir: "/tmp/test-workspace",
      clientFactory,
      strategy: {
        ...createCopilotLocalRuntimeStrategy(),
        runtimeId: "test-local",
        auth: undefined,
      },
    });

    await backend.init();
    await backend.signOut();
    await backend.initClient();

    expect(clientFactory).toHaveBeenCalledTimes(1);
    await expect(backend.checkAuthStatus()).resolves.toEqual({ authenticated: false });

    await expect(backend.login({ type: "api-key", apiKey: "new-secret" })).resolves.toEqual({});
    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(login).toHaveBeenCalledWith({ type: "api-key", apiKey: "new-secret" });
  });

  it("does not publish a stale authenticated probe after sign-out", async () => {
    const { LocalBackend } = await import("../local/provider");
    const { createCopilotLocalRuntimeStrategy } = await import("./strategy");
    let resolveAuthStatus!: (status: Awaited<ReturnType<RuntimeClient["getAuthStatus"]>>) => void;
    const getAuthStatus = vi.fn<RuntimeClient["getAuthStatus"]>(
      () =>
        new Promise((resolve) => {
          resolveAuthStatus = resolve;
        }),
    );
    const client = testDouble<RuntimeClient>({
      getAuthStatus,
      logout: vi.fn<NonNullable<RuntimeClient["logout"]>>().mockResolvedValue(undefined),
    });
    const backend = new LocalBackend({
      workspaceDir: "/tmp/test-workspace",
      clientFactory: async () => client,
      strategy: {
        ...createCopilotLocalRuntimeStrategy(),
        runtimeId: "test-local",
        auth: undefined,
      },
    });

    await backend.init();
    const probe = backend.checkAuthStatus();
    await vi.waitFor(() => expect(getAuthStatus).toHaveBeenCalledOnce());
    await backend.signOut();
    resolveAuthStatus({ isAuthenticated: true, login: "stale-environment" });

    await expect(probe).resolves.toEqual({ authenticated: false });
  });

  it("rechecks auth generation after an async status augmentation", async () => {
    const { LocalBackend } = await import("../local/provider");
    const { createCopilotLocalRuntimeStrategy } = await import("./strategy");
    let resolveAugmentedStatus!: (status: AuthStatus) => void;
    const augmentStatus = vi.fn<(client: RuntimeClient, status: AuthStatus) => Promise<AuthStatus>>(
      () =>
        new Promise<AuthStatus>((resolve) => {
          resolveAugmentedStatus = resolve;
        }),
    );
    const client = testDouble<RuntimeClient>({
      getAuthStatus: vi.fn<RuntimeClient["getAuthStatus"]>().mockResolvedValue({
        isAuthenticated: true,
        login: "stale-user",
      }),
      logout: vi.fn<NonNullable<RuntimeClient["logout"]>>().mockResolvedValue(undefined),
    });
    const backend = new LocalBackend({
      workspaceDir: "/tmp/test-workspace",
      clientFactory: async () => client,
      strategy: {
        ...createCopilotLocalRuntimeStrategy(),
        runtimeId: "test-local",
        auth: { augmentStatus },
      },
    });

    await backend.init();
    const probe = backend.checkAuthStatus();
    await vi.waitFor(() => expect(augmentStatus).toHaveBeenCalledOnce());
    await backend.signOut();
    resolveAugmentedStatus({ authenticated: true, copilotPlan: "enterprise" });

    await expect(probe).resolves.toEqual({ authenticated: false });
  });
});

describe("CopilotToolBackend.attachApprovalRouter", () => {
  // Deps are port-typed on the interface; the mocked adapter never touches
  // them, so we hand it empty test doubles. The production code no longer
  // casts internally — these doubles are scoped to tests where none of the
  // port methods are invoked.
  const stubDeps: AttachApprovalRouterDeps = {
    broker: testDouble<AttachApprovalRouterDeps["broker"]>({}),
    policy: testDouble<AttachApprovalRouterDeps["policy"]>({}),
    classifier: testDouble<AttachApprovalRouterDeps["classifier"]>({}),
    canShowUI: () => true,
  };

  it("registers an approval callback on the backend (matches the SDK callback wiring)", async () => {
    const backend = await createTestBackend();
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only: read internal state via duck-typed access for verification
    const internal = backend as unknown as { getApprovalCallback: () => ApprovalCallback | null };
    expect(internal.getApprovalCallback()).toBeNull();

    const detach = backend.tools.attachApprovalRouter(stubDeps);
    expect(internal.getApprovalCallback()).not.toBeNull();
    // Verify the registered callback IS the mocked adapter (i.e. the
    // attach path actually called createApprovalCallbackAdapter and threaded
    // the result into setApprovalCallback).
    expect(internal.getApprovalCallback()).toBe(mockAdapter);

    // Detach unregisters so a stale adapter cannot fire after shutdown.
    detach();
    expect(internal.getApprovalCallback()).toBeNull();
  });
});

// ── listModels availability filter tests ────────────────────────────────────

/**
 * Test helper for `backend.listModels()`; other Copilot client methods are
 * intentionally unstubbed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test payloads intentionally mirror partially typed SDK model objects.
async function createBackendWithModels(models: any[]) {
  const { CopilotBackend } = await import("./provider");
  const listModels = vi
    .fn<RuntimeClient["listModels"]>()
    .mockResolvedValue(testDouble<RuntimeModelInfo[]>(models));
  const fakeClient = testDouble<RuntimeClient>({ listModels });
  const clientFactory = vi.fn<RuntimeClientFactory>().mockResolvedValue(fakeClient);
  const backend = new CopilotBackend({
    workspaceDir: "/tmp/test-workspace",
    clientFactory,
  });
  return { backend, listModels };
}

describe("CopilotBackend.listModels — SDK policy/availability filter", () => {
  it("keeps models with policy.state === 'enabled'", async () => {
    const { backend } = await createBackendWithModels([
      { id: "claude-opus-4.7", name: "Claude Opus 4.7", policy: { state: "enabled" } },
    ]);

    const result = await backend.listModels();

    expect(result.map((m) => m.id)).toEqual(["claude-opus-4.7"]);
  });

  it("keeps models with no policy field (no entitlement gating)", async () => {
    const { backend } = await createBackendWithModels([{ id: "free-model", name: "Free Model" }]);

    const result = await backend.listModels();

    expect(result.map((m) => m.id)).toEqual(["free-model"]);
  });

  it("drops models with policy.state === 'unconfigured' (admin/user not opted in)", async () => {
    // Regression: the SDK can list `gpt-5.5` as `"unconfigured"`, but
    // `session.create` still fails with `Model "gpt-5.5" is not available.`;
    // `listModels()` must drop it first.
    const { backend } = await createBackendWithModels([
      { id: "gpt-5.4", name: "GPT-5.4", policy: { state: "enabled" } },
      { id: "gpt-5.5", name: "GPT-5.5", policy: { state: "unconfigured" } },
    ]);

    const result = await backend.listModels();

    expect(result.map((m) => m.id)).toEqual(["gpt-5.4"]);
  });

  it("drops models with policy.state === 'disabled'", async () => {
    const { backend } = await createBackendWithModels([
      { id: "ok", name: "OK", policy: { state: "enabled" } },
      { id: "blocked", name: "Blocked", policy: { state: "disabled" } },
    ]);

    const result = await backend.listModels();

    expect(result.map((m) => m.id)).toEqual(["ok"]);
  });

  it("filters at cache-write time so getCachedModels() reflects the filter", async () => {
    const { backend, listModels } = await createBackendWithModels([
      { id: "ok", name: "OK", policy: { state: "enabled" } },
      { id: "preview", name: "Preview", policy: { state: "unconfigured" } },
    ]);

    await backend.listModels();
    // Regression: cache the filtered list, not the raw SDK list, so repeat
    // calls and `getCachedModels()` agree.
    const second = await backend.listModels();

    expect(listModels).toHaveBeenCalledTimes(1);
    expect(second.map((m) => m.id)).toEqual(["ok"]);
    expect((backend.tools.getCachedModels() ?? []).map((m) => m.id)).toEqual(["ok"]);
  });
});

// ── infer() telemetry ─────────────────────────────────────────────────────────

describe("CopilotBackend.infer — INFER_FAILED telemetry", () => {
  it("fires INFER_FAILED and rethrows when session creation fails", async () => {
    mockSendErrorTelemetry.mockReset();
    // The default test harness's clientFactory rejects on initClient(), which
    // is what infer() awaits when this.client is null. The rejection propagates
    // back through infer's outer try/catch — exactly the path we want to pin.
    const backend = await createTestBackend();

    await expect(
      backend.infer({ systemPrompt: "sys", userMessage: "hi", model: "test" }),
    ).rejects.toThrow("Should not call initClient");

    expect(mockSendErrorTelemetry).toHaveBeenCalledWith(
      makeSessionError(sessionErrors.INFER_FAILED),
      expect.any(Error),
    );
  });
});

// ── getMcpConfig per-session Playwright egress config ────────────────────────

describe("CopilotBackend.getMcpConfig — per-session Playwright egress config", () => {
  beforeEach(() => {
    mockSecureWriteFileSync.mockReset();
    mockSecureMkdirSync.mockReset();
  });

  it("writes playwright-mcp-config.json inside the session output dir", async () => {
    const backend = await createTestBackend();

    backend.getMcpConfig(undefined, false, "session-abc");

    expect(mockSecureWriteFileSync).toHaveBeenCalledTimes(1);
    const [writtenPath] = mockSecureWriteFileSync.mock.calls[0];
    expect(writtenPath).toMatch(/playwright-mcp-config\.json$/);
    expect(writtenPath).toContain("session-abc");
  });

  it("written config contains browser.initScript with one entry", async () => {
    const backend = await createTestBackend();

    backend.getMcpConfig(undefined, false, "session-abc");

    const [, writtenData] = mockSecureWriteFileSync.mock.calls[0];
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture: JSON.parse of a string we just captured from the mock
    const config = JSON.parse(writtenData as string) as Record<string, unknown>;
    expect(config).toMatchObject({
      browser: { initScript: expect.arrayContaining([expect.any(String)]) },
    });
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture: narrowing after toMatchObject guard above
    const initScript = (config.browser as Record<string, unknown>).initScript as unknown[];
    expect(initScript).toHaveLength(1);
  });

  it("writes file with mode 0o600", async () => {
    const backend = await createTestBackend();

    backend.getMcpConfig(undefined, false, "session-abc");

    const [, , opts] = mockSecureWriteFileSync.mock.calls[0];
    expect((opts as { mode?: number } | undefined)?.mode).toBe(0o600);
  });

  it("forwards tenant browserEgressBlockedOrigins into network.blockedOrigins", async () => {
    const backend = await createTestBackend();
    backend.setTenantPolicyProvider({
      isTenantManaged: () => true,
      get: () => ({
        browserEgressBlockedOrigins: ["https://evil.com"],
        restrictToWorkspace: false,
        disabledModels: [],
        disabledProviders: [],
      }),
    });

    backend.getMcpConfig(undefined, false, "session-blocked");

    const [, writtenData] = mockSecureWriteFileSync.mock.calls[0];
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture: JSON.parse of a string we just captured from the mock
    const config = JSON.parse(writtenData as string) as Record<string, unknown>;
    expect(config).toMatchObject({
      network: { blockedOrigins: ["https://evil.com"] },
    });
  });

  it("omits network key when tenant returns no browserEgressBlockedOrigins", async () => {
    const backend = await createTestBackend();
    backend.setTenantPolicyProvider({
      isTenantManaged: () => true,
      get: () => ({
        browserEgressBlockedOrigins: [],
        restrictToWorkspace: false,
        disabledModels: [],
        disabledProviders: [],
      }),
    });

    backend.getMcpConfig(undefined, false, "session-clean");

    const [, writtenData] = mockSecureWriteFileSync.mock.calls[0];
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture: JSON.parse of a string we just captured from the mock
    const config = JSON.parse(writtenData as string) as Record<string, unknown>;
    expect(config).not.toHaveProperty("network");
  });

  it("propagates secureWriteFileSync errors from session config write", async () => {
    const backend = await createTestBackend();
    mockSecureWriteFileSync.mockImplementation(() => {
      throw new Error("ENOSPC");
    });
    expect(() => backend.getMcpConfig(undefined, false, "session-err")).toThrow("ENOSPC");
  });
});
