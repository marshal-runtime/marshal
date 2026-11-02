import * as fs from "fs";

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

import type { PermissionsConfig } from "../common/marshal-ipc-contract";
import { isPublicFirstPartyToolName } from "../common/tool-names";
import type { RuntimePermissionResult as PermissionRequestResult } from "./backend/runtime-contract";
import { LOCAL_FILE_TOOL_DEFINITIONS } from "./marshal-fs/shared";
import { createTestWorkServiceProviders } from "./test-helpers/work-service-test-providers";
import { SessionTestAccess, createTestBackend } from "./testing/harness";

const m = await vi.hoisted(async () => await import("./test-helpers/session-test-mocks"));
vi.mock("fs", m.fsFactory);
vi.mock("./session-archive", m.sessionArchiveFactory);
vi.mock("child_process", m.childProcessFactory);
vi.mock("electron", m.electronFactory);
vi.mock("@github/copilot-sdk", m.copilotSdkFactory);
vi.mock("./skills", m.skillsFactory);
vi.mock("./cli-path", m.cliPathFactory);
vi.mock("./safe-storage-file");

// Runtime-swappable skill prompt for tests that exercise per-request skill injection.
import { getSkillsForSystemPrompt } from "./skills";
const mockedGetSkills = vi.mocked(getSkillsForSystemPrompt);

const mockedFs = vi.mocked(fs);

async function createTestManager() {
  mockedFs.existsSync.mockReturnValue(false);
  const { SessionManager } = await import("./sessions");
  const mgr = new SessionManager("/test/workspace", await createTestBackend());
  const access = new SessionTestAccess(mgr);

  const mockSdkSession = {
    sessionId: "sdk-test",
    on: vi.fn<(handler: (event: any) => void) => void>(),
    send: vi.fn<() => void>(),
    destroy: vi.fn<() => void>(),
    rpc: {
      permissions: {
        setApproveAll: vi
          .fn<(params: { enabled: boolean }) => Promise<{ success: boolean }>>()
          .mockResolvedValue({
            success: true,
          }),
        resetSessionApprovals: vi.fn<() => Promise<{ success: boolean }>>().mockResolvedValue({
          success: true,
        }),
      },
    },
  };
  const mockCreateSession = vi.fn<(opts: any) => Promise<any>>().mockResolvedValue(mockSdkSession);
  access.client = { createSession: mockCreateSession };

  return { mgr, access, mockCreateSession, mockSdkSession };
}

const STALE_PERMISSION_RESULT_KINDS = [
  "approved",
  "denied-by-rules",
  "denied-interactively-by-user",
];
const SDK_PERMISSION_RESULT_KINDS = [
  "approve-once",
  "approve-for-session",
  "approve-for-location",
  "reject",
  "user-not-available",
  "no-result",
];

function expectSdkPermissionResult(result: PermissionRequestResult) {
  expect(SDK_PERMISSION_RESULT_KINDS).toContain(result.kind);
  expect(STALE_PERMISSION_RESULT_KINDS).not.toContain(result.kind);
}

/** Minimal mock managers for setSelfTools */
function createMockDeps() {
  return {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
    heartbeatManager: {
      getStatus: vi.fn<() => void>(),
      getSettings: vi.fn<() => void>(),
      runNow: vi.fn<() => void>(),
    } as any,
    automationManager: { listAutomations: vi.fn<() => never[]>().mockReturnValue([]) } as any, // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
    memoryManager: {
      formatForSystemPrompt: () => "",
      list: vi.fn<() => never[]>().mockReturnValue([]),
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
    settingsManager: {
      get: vi.fn<() => Record<string, unknown>>().mockReturnValue({}),
      update: vi.fn<() => void>(),
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
    goalManager: { getGoal: vi.fn<() => null>().mockReturnValue(null) } as any,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
    skillsManager: {
      list: vi.fn<() => never[]>().mockReturnValue([]),
      add: vi.fn<() => void>(),
      update: vi.fn<() => void>(),
      delete: vi.fn<() => void>(),
      getInstructions: vi.fn<() => null>().mockReturnValue(null),
    } as any,
    workServices: createTestWorkServiceProviders(),
    confirmPermissionsEscalation: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
  };
}

/** Create manager + call createSDKSession, returning the captured SDK options */
async function createSessionAndCapture(opts?: {
  model?: string;
  soul?: string;
  customMcpServers?: any[];
  withSelfTools?: boolean;
  tenantPolicy?: { disabledServers?: string[] };
  permissions?: Partial<PermissionsConfig>;
}) {
  const { mgr, access, mockCreateSession, mockSdkSession } = await createTestManager();

  // Default: set up self tools so the full tools array is populated
  if (opts?.withSelfTools !== false) {
    const deps = createMockDeps();
    mgr.setSelfTools(deps);
  }

  if (opts?.customMcpServers) {
    mgr.mcpStatus.setCustomMcpServers(opts.customMcpServers);
  }

  // Wire a PermissionPolicy so evaluatePreHook() works in onPreToolUse.
  const { PermissionPolicy } = await import("./permission-policy");
  const policy = new PermissionPolicy({
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
    settingsManager: {
      get: () => ({
        autoApprove: { global: false, perServer: {} },
        customMcpServers: [],
        ...(opts?.permissions ? { permissions: opts.permissions } : {}),
      }),
    } as never,
    ...(opts?.tenantPolicy ? { tenantPolicy: { get: () => opts.tenantPolicy } as never } : {}), // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
  });
  mgr.setPermissionPolicy(policy);

  await access.createSDKSession("s1", true, opts?.model, opts?.soul);

  const sdkOpts = mockCreateSession.mock.calls[0][0];
  return { mgr, access, sdkOpts, mockCreateSession, mockSdkSession, policy };
}

// Warm the module cache so the first test doesn't absorb the cold-start import cost.
// sessions.ts has a heavy dependency tree that can exceed the 15s test timeout on CI.
beforeAll(async () => {
  await import("./sessions");
}, 30_000);

beforeEach(() => {
  vi.clearAllMocks();
  mockedFs.existsSync.mockReturnValue(false);
  mockedFs.readdirSync.mockReturnValue([]);
  mockedGetSkills.mockReturnValue("");
});

// ---------------------------------------------------------------------------
// Tools passed to SDK
// ---------------------------------------------------------------------------

describe("SDK session tools", () => {
  it("includes the expected canonical self-tools", async () => {
    const { sdkOpts } = await createSessionAndCapture();
    const toolNames: string[] = sdkOpts.tools.map((t: any) => t.name);

    expect(toolNames).not.toContain("getHeartbeatStatus");
    expect(toolNames).not.toContain("setHeartbeatSettings");
    expect(toolNames).not.toContain("runHeartbeatNow");
    expect(toolNames).not.toContain("workflowInstall");
    expect(toolNames).not.toContain("workflowInstallLocal");
    // Automation tools
    expect(toolNames).toContain("listAutomations");
    expect(toolNames).toContain("createAutomation");
    expect(toolNames).toContain("runAutomationNow");
    // Model tools
    expect(toolNames).toContain("listModels");
    expect(toolNames).toContain("setDefaultModel");
    // Memory tools
    expect(toolNames).toContain("remember");
    expect(toolNames).toContain("recall");
    expect(toolNames).toContain("listMemories");
    expect(toolNames).toContain("forget");
    // Settings
    expect(toolNames).toContain("getSettings");
    expect(toolNames).toContain("updateSettings");
    // Session history
    expect(toolNames).toContain("searchSessions");
    expect(toolNames).toContain("getSessionTranscript");
    // Notifications
    expect(toolNames).toContain("notificationStatus");
    expect(toolNames).toContain("connectNotifications");
    expect(toolNames).toContain("disconnectNotifications");
  });

  it("first-party tools each have a handler function", async () => {
    const { sdkOpts } = await createSessionAndCapture();
    const firstPartyTools = sdkOpts.tools.filter((t: any) => isPublicFirstPartyToolName(t.name));
    for (const tool of firstPartyTools) {
      expect(typeof tool.handler).toBe("function");
    }
  });
});

// ---------------------------------------------------------------------------
// Session configuration
// ---------------------------------------------------------------------------

describe("SDK session configuration", () => {
  it("preserves root-agent-only streaming behavior on SDK 0.3", async () => {
    const { sdkOpts } = await createSessionAndCapture();

    expect(sdkOpts.streaming).toBe(true);
    expect(sdkOpts.includeSubAgentStreamingEvents).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MCP server configuration
// ---------------------------------------------------------------------------

describe("SDK session MCP servers", () => {
  it("does not register filesystem as an MCP server (it is a capability now)", async () => {
    const { sdkOpts } = await createSessionAndCapture();
    expect(sdkOpts.mcpServers).not.toHaveProperty("filesystem");
    expect(sdkOpts.mcpServers).toHaveProperty("playwright");
  });

  it("includes custom command-based MCP server", async () => {
    const { sdkOpts } = await createSessionAndCapture({
      customMcpServers: [
        { name: "My Custom Tool", type: "command", command: "custom-bin", args: ["--verbose"] },
      ],
    });

    expect(sdkOpts.mcpServers).toHaveProperty("my_custom_tool");
    expect(sdkOpts.mcpServers.my_custom_tool).toMatchObject({
      type: "local",
      command: "custom-bin",
      args: ["--verbose"],
    });
  });

  it("includes custom HTTP MCP server with Bearer token", async () => {
    const { sdkOpts } = await createSessionAndCapture({
      customMcpServers: [
        { name: "Remote API", type: "http", url: "https://mcp.example.com", accessToken: "secret" },
      ],
    });

    expect(sdkOpts.mcpServers).toHaveProperty("remote_api");
    expect(sdkOpts.mcpServers.remote_api).toMatchObject({
      type: "http",
      url: "https://mcp.example.com",
      headers: { Authorization: "Bearer secret" },
    });
  });

  it("does not allow custom server to override built-in playwright key", async () => {
    const { sdkOpts } = await createSessionAndCapture({
      customMcpServers: [{ name: "Playwright", type: "command", command: "evil-bin" }],
    });

    // playwright should still be the built-in one
    expect(sdkOpts.mcpServers.playwright.command).not.toBe("evil-bin");
  });
});

// ---------------------------------------------------------------------------
// Permission handler
// ---------------------------------------------------------------------------

describe("SDK session permission handler", () => {
  async function capturePermHandler(
    serverOverrides?: Record<string, { enabled: boolean; autoApprove: boolean }>,
  ) {
    const { mgr, access, mockCreateSession, mockSdkSession } = await createTestManager();

    // Wire a PermissionPolicy to the permissionCallback — mirrors how main.ts
    // wires createPermissionHandler. This is intentionally a second evaluate() call
    // site (the first is in permissions-dialog.ts) to verify the full session→policy flow.
    const { PermissionPolicy } = await import("./permission-policy");
    const policy = new PermissionPolicy({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
      settingsManager: {
        get: () => ({
          autoApprove: { global: false, perServer: {} },
          permissions: {
            autoApproveReadOnly: false,
            allow: [],
            tools: {},
            servers: {
              filesystem: { enabled: true, autoApprove: true },
              playwright: { enabled: true, autoApprove: true },
              shell: { enabled: true, autoApprove: false },
              ...serverOverrides,
            },
          },
          customMcpServers: [],
        }),
        update: vi.fn<(s: Record<string, unknown>) => void>(),
      } as never,
    });
    mgr.setPermissionCallback(async (request) => {
      const decision = policy.evaluate(request);
      if (decision === "approve") return "approved";
      if (decision === "deny") return "denied-by-rules";
      return "denied-interactively-by-user";
    });

    let permHandler: (req: any) => Promise<any>;
    mockCreateSession.mockImplementation(async (opts: any) => {
      permHandler = opts.onPermissionRequest;
      return {
        ...mockSdkSession,
      };
    });

    await access.createSDKSession("s1", true);
    return permHandler!;
  }

  it("auto-approves read operations", async () => {
    const handler = await capturePermHandler();
    const result = await handler({ kind: "read" });
    expectSdkPermissionResult(result);
    expect(result).toEqual({ kind: "approve-once" });
  });

  it("coalesces duplicate kind:read requests with the same toolCallId into one user prompt", async () => {
    const { mgr, access, mockCreateSession, mockSdkSession } = await createTestManager();

    let callCount = 0;
    let resolveCallback!: (
      d: "approved" | "denied-by-rules" | "denied-interactively-by-user",
    ) => void;
    const slowDecision = new Promise<
      "approved" | "denied-by-rules" | "denied-interactively-by-user"
    >((res) => {
      resolveCallback = res;
    });
    mgr.setPermissionCallback(async (_req) => {
      callCount++;
      return slowDecision;
    });

    let permHandler!: (req: any) => Promise<any>;
    mockCreateSession.mockImplementation(async (opts: any) => {
      permHandler = opts.onPermissionRequest;
      return { ...mockSdkSession };
    });
    await access.createSDKSession("s1", true);

    const payload = { kind: "read", path: "/outside/workspace/secret.txt", toolCallId: "tc-dup-1" };
    const p1 = permHandler(payload);
    const p2 = permHandler(payload); // identical duplicate — should coalesce

    expect(callCount).toBe(1); // only one prompt was raised

    resolveCallback("approved");
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ kind: "approve-once" });
    expect(r2).toEqual({ kind: "approve-once" });
    expect(callCount).toBe(1); // still only one call after resolution
  });

  it("does not re-prompt for a serial duplicate kind:read after the first resolves", async () => {
    // The SDK fires onPermissionRequest twice for the same read but SERIALLY —
    // the second request arrives only after the first has been approved/denied.
    const { mgr, access, mockCreateSession, mockSdkSession } = await createTestManager();

    let callCount = 0;
    mgr.setPermissionCallback(async (_req) => {
      callCount++;
      return "approved";
    });

    let permHandler!: (req: any) => Promise<any>;
    mockCreateSession.mockImplementation(async (opts: any) => {
      permHandler = opts.onPermissionRequest;
      return { ...mockSdkSession };
    });
    await access.createSDKSession("s1", true);

    const payload = {
      kind: "read",
      path: "/outside/workspace/secret.txt",
      toolCallId: "tc-serial-1",
    };

    // First request: approved, callback runs
    const r1 = await permHandler(payload);
    expect(r1).toEqual({ kind: "approve-once" });
    expect(callCount).toBe(1);

    // Second request: same toolCallId, arrives after first resolved — must NOT show a card
    const r2 = await permHandler(payload);
    expect(r2).toEqual({ kind: "approve-once" });
    expect(callCount).toBe(1); // no second prompt
  });

  it("passes the effective workspace as SDK workingDirectory", async () => {
    const { access, mockCreateSession } = await createTestManager();
    await access.createSDKSession("s1", true);
    expect(mockCreateSession.mock.calls[0][0].workingDirectory).toBe("/test/workspace");
  });

  it("auto-approves built-in filesystem MCP tools", async () => {
    const handler = await capturePermHandler();
    const result = await handler({ kind: "mcp", serverName: "filesystem", toolName: "read_file" });
    expectSdkPermissionResult(result);
    expect(result).toEqual({ kind: "approve-once" });
  });

  it("toggles SDK approve-all mode on active sessions through tool policy", async () => {
    const { access, mockSdkSession } = await createTestManager();
    await access.createSDKSession("s1", true);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- typed test accessor returns unknown for private backend internals
    const backend = access.backend as Awaited<ReturnType<typeof createTestBackend>>;
    await backend.tools.updateToolPolicy({ autoApproveAll: true });

    expect(mockSdkSession.rpc.permissions.setApproveAll).toHaveBeenCalledWith({
      enabled: true,
    });
  });

  it("throws when SDK approve-all mode reports failure", async () => {
    const { access, mockSdkSession } = await createTestManager();
    mockSdkSession.rpc.permissions.setApproveAll.mockResolvedValueOnce({ success: false });
    await access.createSDKSession("s1", true);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- typed test accessor returns unknown for private backend internals
    const backend = access.backend as Awaited<ReturnType<typeof createTestBackend>>;
    await expect(backend.tools.updateToolPolicy({ autoApproveAll: true })).rejects.toThrow(
      "SDK setApproveAll returned success=false",
    );
  });

  it("throws when SDK reset session approvals reports failure", async () => {
    const { access, mockSdkSession } = await createTestManager();
    mockSdkSession.rpc.permissions.resetSessionApprovals.mockResolvedValueOnce({ success: false });
    await access.createSDKSession("s1", true);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- testing internal SDK reset helper
    const backend = access.backend as Awaited<ReturnType<typeof createTestBackend>> & {
      resetSdkSessionApprovals(sessionId?: string): Promise<void>;
    };
    await expect(backend.resetSdkSessionApprovals("s1")).rejects.toThrow(
      "SDK resetSessionApprovals returned success=false",
    );
  });

  it("allows non-targeted shell commands even when Browser Control is disabled", async () => {
    // Pins the invariant that `permissions.servers.<key>.enabled = false` only
    // gates tools resolved to that server — generic shell commands like
    // `ls -la /tmp` whose first token isn't a builtin server name (e.g.
    // shell) must not be incorrectly denied by Step 4 of the evaluation
    // pipeline regardless of which MCP servers happen to be off.
    const handler = await capturePermHandler({
      playwright: { enabled: false, autoApprove: false },
    });
    const result = await handler({ kind: "shell", fullCommandText: "ls -la /tmp" });
    expectSdkPermissionResult(result);
    expect(result).not.toEqual(expect.objectContaining({ kind: "user-not-available" }));
    expect(result).not.toEqual(
      expect.objectContaining({ feedback: "Denied by permission policy." }),
    );
  });

  it("never exposes Marshal internal permission decisions to the SDK", async () => {
    const handler = await capturePermHandler();
    const results = await Promise.all([
      handler({ kind: "read" }),
      handler({ kind: "shell", fullCommandText: "echo hello" }),
      handler({ kind: "mcp", serverName: "filesystem", toolName: "read_file" }),
    ]);

    for (const result of results) {
      expectSdkPermissionResult(result);
    }
  });

  it("passes SDK 0.3 memory and hook permission kinds through the normal policy path", async () => {
    const handler = await capturePermHandler();

    const memoryResult = await handler({ kind: "memory", action: "write" });
    const hookResult = await handler({ kind: "hook", hookName: "onBeforeToolUse" });

    expectSdkPermissionResult(memoryResult);
    expectSdkPermissionResult(hookResult);
    expect(memoryResult).toEqual({ kind: "reject" });
    expect(hookResult).toEqual({ kind: "reject" });
  });

  it.each(["edit", "create"])(
    "auto-approves kind:hook for HITL tool '%s' to avoid the double-card on SDK write tools",
    async (toolName) => {
      const { access, mockCreateSession, mockSdkSession } = await createTestManager();
      let permHandler!: (req: any) => Promise<any>;
      mockCreateSession.mockImplementation(async (opts: any) => {
        permHandler = opts.onPermissionRequest;
        return { ...mockSdkSession };
      });
      await access.createSDKSession("s1", true);

      const result = await permHandler({ kind: "hook", toolName, toolCallId: `tc-${toolName}` });
      expectSdkPermissionResult(result);
      expect(result).toEqual({ kind: "approve-once" });
    },
  );
});

// ---------------------------------------------------------------------------
// Pre-tool-use hook (MCP tool blocking)
// ---------------------------------------------------------------------------

describe("SDK session onPreToolUse hook", () => {
  it("allows filesystem tool when File System Access is enabled", async () => {
    const { sdkOpts } = await createSessionAndCapture();
    const result = await sdkOpts.hooks.onPreToolUse({
      toolName: "filesystem__read_file",
      toolCallId: "tc-1",
    });
    expect(result.permissionDecision).toBeUndefined();
  });

  it("denies filesystem tool when permissions.servers.filesystem.enabled = false", async () => {
    const { sdkOpts } = await createSessionAndCapture({
      permissions: {
        autoApproveReadOnly: false,
        allow: [],
        tools: {},
        servers: {
          filesystem: { enabled: false, autoApprove: false },
          playwright: { enabled: true, autoApprove: true },
          shell: { enabled: true, autoApprove: false },
        },
      },
    });
    const result = await sdkOpts.hooks.onPreToolUse({
      toolName: "filesystem__read_file",
      toolCallId: "tc-deny",
    });
    expect(result.permissionDecision).toBe("deny");
    expect(result.permissionDecisionReason).toContain("File System Access");
  });

  it("denies custom MCP tool when permissions.servers[<custom-key>].enabled = false", async () => {
    // Pins the display-name → config-key derivation in checkUserDisabledTool
    // end-to-end through onPreToolUse, for a custom (non-builtin) server.
    const { sdkOpts } = await createSessionAndCapture({
      customMcpServers: [{ name: "My API", type: "command", command: "api-bin" }],
      permissions: {
        autoApproveReadOnly: false,
        allow: [],
        tools: {},
        servers: { my_api: { enabled: false, autoApprove: false } },
      },
    });
    const result = await sdkOpts.hooks.onPreToolUse({
      toolName: "my_api__do_stuff",
      toolCallId: "tc-custom-deny",
    });
    expect(result.permissionDecision).toBe("deny");
    expect(result.permissionDecisionReason).toContain("my_api");
  });

  it("denies tool when tenant policy disables the server", async () => {
    const { sdkOpts } = await createSessionAndCapture({
      tenantPolicy: { disabledServers: ["playwright"] },
    });
    const result = await sdkOpts.hooks.onPreToolUse({
      toolName: "playwright-browser_run_code",
      toolCallId: "tc-3",
    });
    expect(result.permissionDecision).toBe("deny");
    expect(result.permissionDecisionReason).toContain("organization");
  });

  it("denies SDK 'view' (kind:read) when filesystem server is user-disabled", async () => {
    const { sdkOpts } = await createSessionAndCapture({
      permissions: {
        autoApproveReadOnly: false,
        allow: [],
        tools: {},
        servers: { filesystem: { enabled: false, autoApprove: false } },
      },
    });
    const result = await sdkOpts.hooks.onPreToolUse({ toolName: "view", toolCallId: "tc-view" });
    expect(result.permissionDecision).toBe("deny");
    expect(result.permissionDecisionReason).toContain("File System Access");
  });

  it("denies SDK 'edit' (kind:write) when filesystem server is user-disabled", async () => {
    const { sdkOpts } = await createSessionAndCapture({
      permissions: {
        autoApproveReadOnly: false,
        allow: [],
        tools: {},
        servers: { filesystem: { enabled: false, autoApprove: false } },
      },
    });
    const result = await sdkOpts.hooks.onPreToolUse({ toolName: "edit", toolCallId: "tc-edit" });
    expect(result.permissionDecision).toBe("deny");
    expect(result.permissionDecisionReason).toContain("File System Access");
  });

  // The pre-hook RULES are unit-tested over all five names in
  // permission-policy-checks.test.ts; this drives the integration path
  // (buildHooks → onPreToolUse → evaluatePreHook → getGatingServerForTool) so a
  // regression in the local-file tool → "filesystem" mapping can't slip past.
  it.each(Object.keys(LOCAL_FILE_TOOL_DEFINITIONS))(
    "denies local-file tool '%s' via onPreToolUse when File System Access is disabled",
    async (toolName) => {
      const { sdkOpts } = await createSessionAndCapture({
        permissions: {
          autoApproveReadOnly: false,
          allow: [],
          tools: {},
          servers: { filesystem: { enabled: false, autoApprove: false } },
        },
      });
      const result = await sdkOpts.hooks.onPreToolUse({ toolName, toolCallId: `tc-${toolName}` });
      expect(result.permissionDecision).toBe("deny");
      expect(result.permissionDecisionReason).toContain("File System Access");
    },
  );

  it("does not emit tool.execution_start from pre-tool-use hook (SDK emits it natively)", async () => {
    const { mgr, sdkOpts } = await createSessionAndCapture();
    const events: any[] = [];
    mgr.addEventListener((_sid: string, event: any) => events.push(event));

    await sdkOpts.hooks.onPreToolUse({
      toolName: "filesystem__read_file",
      toolCallId: "tc-1",
      toolArgs: { path: "/foo" },
      serverName: "filesystem",
    });

    expect(events).toHaveLength(0);
  });

  it("does not duplicate running tool activity when hook and SDK lifecycle both fire", async () => {
    const { mgr, sdkOpts, mockSdkSession } = await createSessionAndCapture();
    const events: any[] = [];
    mgr.addEventListener((_sid: string, event: any) => events.push(event));

    await sdkOpts.hooks.onPreToolUse({
      toolName: "getSessionTranscript",
      toolCallId: "tc-transcript",
      toolArgs: { sessionId: "s-parent" },
    });

    const eventHandler = mockSdkSession.on.mock.calls[0][0];
    eventHandler({
      type: "tool.execution_start",
      data: {
        toolCallId: "tc-transcript",
        toolName: "getSessionTranscript",
        arguments: { sessionId: "s-parent" },
      },
    });
    eventHandler({
      type: "tool.execution_complete",
      data: { toolCallId: "tc-transcript", success: true, result: "ok" },
    });

    const toolsUpdated = events.filter((event) => event.type === "turn:tools-updated");
    expect(toolsUpdated).toHaveLength(2);
    expect(toolsUpdated[0].toolCalls).toHaveLength(1);
    expect(toolsUpdated[0].toolCalls[0]).toMatchObject({
      id: "tc-transcript",
      name: "getSessionTranscript",
      running: true,
    });
    expect(toolsUpdated[1].toolCalls).toEqual([
      expect.objectContaining({ id: "tc-transcript", running: false }),
    ]);
  });

  it("emits turn:tools-updated event on tool completion", async () => {
    const { mgr, mockSdkSession } = await createSessionAndCapture();
    const events: any[] = [];
    mgr.addEventListener((_sid: string, event: any) => events.push(event));

    // In the refactored backend, tool events come through the SDK event stream
    // (wireEvents -> normalizeEvent -> accumulator), not from hooks directly.
    const eventHandler = mockSdkSession.on.mock.calls[0][0];
    eventHandler({
      type: "tool.execution_complete",
      data: { toolCallId: "tc-1", success: true },
    });

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("turn:tools-updated");
    expect(events[1].type).toBe("turn:tool-completed");
  });

  it("buffers askUser results onto a question-only committed message", async () => {
    const { mgr, sdkOpts, mockSdkSession } = await createSessionAndCapture();
    const events: any[] = [];
    mgr.addEventListener((_sid: string, event: any) => events.push(event));

    await sdkOpts.hooks.onPostToolUse(
      {
        toolName: "askUser",
        toolCallId: "tc-ask",
        toolResult: JSON.stringify({
          success: true,
          question: "Pick one",
          answers: [{ title: "A" }, { title: "B" }],
          recommendedIndex: 0,
        }),
      },
      { sessionId: "s1" },
    );

    const eventHandler = mockSdkSession.on.mock.calls[0][0];
    eventHandler({ type: "assistant.message", data: { messageId: "msg-ask", content: "" } });

    const committed = events.find((event: any) => event.type === "turn:message-committed");
    expect(committed).toBeDefined();
    expect(committed.message.question).toMatchObject({
      question: "Pick one",
      recommendedIndex: 0,
    });
    expect(committed.message.content).toBe("");
  });

  it("persists question-only ask-user turns on idle without assistant text", async () => {
    const { mgr, sdkOpts, mockSdkSession } = await createSessionAndCapture();
    const appendSpy = vi.spyOn(mgr, "appendMessage").mockImplementation(() => true);

    await sdkOpts.hooks.onPostToolUse(
      {
        toolName: "askUser",
        toolCallId: "tc-ask",
        toolResult: JSON.stringify({
          success: true,
          question: "Pick one",
          answers: [{ title: "A" }, { title: "B" }],
        }),
      },
      { sessionId: "s1" },
    );

    const eventHandler = mockSdkSession.on.mock.calls[0][0];
    eventHandler({ type: "session.idle", data: {} });

    expect(appendSpy).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        role: "assistant",
        content: "",
        question: expect.objectContaining({ question: "Pick one" }),
      }),
      expect.any(Object),
    );
  });

  it("warns and skips invalid askUser payloads", async () => {
    const { mgr, sdkOpts, mockSdkSession } = await createSessionAndCapture();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events: any[] = [];
    mgr.addEventListener((_sid: string, event: any) => events.push(event));

    await sdkOpts.hooks.onPostToolUse(
      {
        toolName: "askUser",
        toolCallId: "tc-ask",
        toolResult: JSON.stringify({
          success: true,
          question: "Pick one",
          answers: [{ title: "A" }],
        }),
      },
      { sessionId: "s1" },
    );

    const eventHandler = mockSdkSession.on.mock.calls[0][0];
    eventHandler({
      type: "assistant.message",
      data: { messageId: "msg-ask", content: "Fallback" },
    });

    expect(
      warnSpy.mock.calls.some((call) => String(call[1]).includes("Invalid askUser tool result")),
    ).toBe(true);
    const committed = events.find((event: any) => event.type === "turn:message-committed");
    expect(committed.message.question).toBeUndefined();
  });

  it("silently skips malformed askUser payloads", async () => {
    const { mgr, sdkOpts, mockSdkSession } = await createSessionAndCapture();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events: any[] = [];
    mgr.addEventListener((_sid: string, event: any) => events.push(event));

    await sdkOpts.hooks.onPostToolUse(
      {
        toolName: "askUser",
        toolCallId: "tc-ask",
        toolResult: "{not-json",
      },
      { sessionId: "s1" },
    );

    const eventHandler = mockSdkSession.on.mock.calls[0][0];
    eventHandler({
      type: "assistant.message",
      data: { messageId: "msg-ask", content: "Fallback" },
    });

    expect(
      warnSpy.mock.calls.some((call) => String(call[1]).includes("Invalid askUser tool result")),
    ).toBe(false);
    const committed = events.find((event: any) => event.type === "turn:message-committed");
    expect(committed.message.question).toBeUndefined();
  });

  it("does not deny browser_take_screenshot in pre-hook when filesystem is enabled", async () => {
    const { sdkOpts } = await createSessionAndCapture();
    const result = await sdkOpts.hooks.onPreToolUse({
      toolName: "browser_take_screenshot",
      toolCallId: "tc-screenshot",
      toolArgs: { filename: "/tmp/shot.png" },
    });
    // The pre-hook must not deny file-write tools with paths — the write gate runs in permissionHandler.
    expect(result.permissionDecision).toBeUndefined();
  });

  const FS_DISABLED_PERMISSIONS: Partial<PermissionsConfig> = {
    autoApproveReadOnly: false,
    allow: [],
    tools: {},
    servers: {
      filesystem: { enabled: false, autoApprove: false },
      playwright: { enabled: true, autoApprove: true },
      shell: { enabled: true, autoApprove: false },
    },
  };

  it.each([
    "browser_take_screenshot",
    "browser_pdf_save",
    "browser_snapshot",
    "browser_console_messages",
    "browser_network_requests",
    "browser_stop_video",
  ])(
    "denies %s (bare) in pre-hook when filesystem is disabled (PLAYWRIGHT_FILE_WRITE_FS_GATE)",
    async (toolName) => {
      const { sdkOpts } = await createSessionAndCapture({
        permissions: FS_DISABLED_PERMISSIONS,
      });
      const result = await sdkOpts.hooks.onPreToolUse({
        toolName,
        toolCallId: `tc-fs-disabled-${toolName}`,
        toolArgs: { filename: "/tmp/shot.png" },
      });
      expect(result.permissionDecision).toBe("deny");
      expect(result.permissionDecisionReason).toContain("File System Access");
    },
  );

  it.each([
    "browser_take_screenshot",
    "browser_pdf_save",
    "browser_snapshot",
    "browser_console_messages",
    "browser_network_requests",
    "browser_stop_video",
  ])(
    "denies playwright-%s (prefixed) in pre-hook when filesystem is disabled (PLAYWRIGHT_FILE_WRITE_FS_GATE)",
    async (toolName) => {
      const { sdkOpts } = await createSessionAndCapture({
        permissions: FS_DISABLED_PERMISSIONS,
      });
      // Real SDK sends prefixed tool names to onPreToolUse
      const result = await sdkOpts.hooks.onPreToolUse({
        toolName: `playwright-${toolName}`,
        toolCallId: `tc-fs-disabled-prefixed-${toolName}`,
        toolArgs: { filename: "/tmp/shot.png" },
      });
      expect(result.permissionDecision).toBe("deny");
      expect(result.permissionDecisionReason).toContain("File System Access");
    },
  );

  it("denies playwright-browser_run_code in pre-hook when filesystem is disabled (PLAYWRIGHT_CODE_EXECUTION_FS_GATE)", async () => {
    // The code-execution gate matches on the prefixed form (isPlaywrightTool guard requires
    // playwright- prefix). The SDK sends prefixed names in practice.
    const { sdkOpts } = await createSessionAndCapture({
      permissions: FS_DISABLED_PERMISSIONS,
    });
    const result = await sdkOpts.hooks.onPreToolUse({
      toolName: "playwright-browser_run_code",
      toolCallId: "tc-run-code-fs-disabled",
    });
    expect(result.permissionDecision).toBe("deny");
    expect(result.permissionDecisionReason).toContain("File System Access");
  });
});

// ---------------------------------------------------------------------------
// Permission handler audit logging (getSkill and no-callback-fallback)
// ---------------------------------------------------------------------------

describe("SDK session permission handler audit logging", () => {
  it("logs audit entry for getSkill auto-approve", async () => {
    const { sdkOpts } = await createSessionAndCapture();
    const result = await sdkOpts.onPermissionRequest({
      kind: "custom-tool",
      toolName: "getSkill",
      toolCallId: "tc-skill-1",
    });
    expectSdkPermissionResult(result);
    expect(result).toEqual({ kind: "approve-once" });
  });

  it("denies by default when no permissionCallback is set (fail-closed)", async () => {
    const { mgr, access, mockCreateSession } = await createTestManager();
    const deps = createMockDeps();
    mgr.setSelfTools(deps);

    // Wire a policy but do NOT set a permissionCallback
    const { PermissionPolicy } = await import("./permission-policy");
    const policy = new PermissionPolicy({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
      settingsManager: {
        get: () => ({
          autoApprove: { global: false, perServer: {} },
          permissions: {
            autoApproveReadOnly: false,
            allow: [],
            servers: {
              filesystem: { enabled: true, autoApprove: true },
              playwright: { enabled: true, autoApprove: true },
              shell: { enabled: true, autoApprove: false },
            },
          },
          customMcpServers: [],
        }),
        update: vi.fn<(s: Record<string, unknown>) => void>(),
      } as never,
    });
    mgr.setPermissionPolicy(policy);

    await access.createSDKSession("s1", true);
    const sdkOpts = mockCreateSession.mock.calls[0][0];

    const result = await sdkOpts.onPermissionRequest({
      kind: "shell",
      toolName: "some_tool",
      toolCallId: "tc-fallback-1",
    });
    // No approval callback set — denies by default for safety (fail-closed).
    // In production, main.ts always wires the callback before session creation.
    expectSdkPermissionResult(result);
    expect(result).toEqual({ kind: "user-not-available" });
  });

  it("upgrades kind to write with isBrowserWrite for browser_take_screenshot with filename", async () => {
    const { mgr, sdkOpts, policy } = await createSessionAndCapture({
      permissions: {
        autoApproveReadOnly: false,
        allow: [],
        tools: {},
        servers: {
          playwright: { enabled: true, autoApprove: false },
          filesystem: { enabled: true, autoApprove: false },
          shell: { enabled: true, autoApprove: false },
        },
      },
    });
    const evaluateSpy = vi.spyOn(policy, "evaluate");
    mgr.setPermissionCallback(async (request) => {
      policy.evaluate(request);
      return "denied-interactively-by-user";
    });

    await sdkOpts.hooks.onPreToolUse({
      toolName: "browser_take_screenshot",
      toolCallId: "tc-shot",
      toolArgs: { filename: "/tmp/shot.png" },
    });
    await sdkOpts.onPermissionRequest({
      kind: "mcp",
      toolCallId: "tc-shot",
      toolName: "playwright-browser_take_screenshot",
    });

    expect(evaluateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "write",
        path: "/tmp/shot.png",
        origin: "synthesized-browser",
      }),
    );
  });

  it("upgrades kind to write with path '*' and isBrowserWrite for browser_run_code", async () => {
    const { mgr, sdkOpts, policy } = await createSessionAndCapture({
      permissions: {
        autoApproveReadOnly: false,
        allow: [],
        tools: {},
        servers: {
          playwright: { enabled: true, autoApprove: false },
          filesystem: { enabled: true, autoApprove: false },
          shell: { enabled: true, autoApprove: false },
        },
      },
    });
    const evaluateSpy = vi.spyOn(policy, "evaluate");
    mgr.setPermissionCallback(async (request) => {
      policy.evaluate(request);
      return "denied-interactively-by-user";
    });

    // No onPreToolUse needed — code-execution upgrade applies unconditionally in permissionHandler
    await sdkOpts.onPermissionRequest({
      kind: "mcp",
      toolCallId: "tc-run",
      toolName: "playwright-browser_run_code",
    });

    expect(evaluateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "write",
        path: "*",
        origin: "synthesized-browser",
        browserToolName: expect.stringContaining("browser_run_code"),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Browser write path queue — cap and FIFO ordering
// ---------------------------------------------------------------------------

describe("pendingBrowserWritePaths queue", () => {
  const WRITE_ALLOWED_PERMISSIONS: Partial<PermissionsConfig> = {
    autoApproveReadOnly: false,
    allow: [],
    tools: {},
    servers: {
      playwright: { enabled: true, autoApprove: false },
      filesystem: { enabled: true, autoApprove: false },
      shell: { enabled: true, autoApprove: false },
    },
  };

  it("evicts oldest entry when queue reaches the 50-entry cap", async () => {
    // Enqueue 51 paths for the same tool; the queue cap is 50, so the 51st
    // enqueue shifts out path-1. The first permission request should consume
    // path-2, not path-1.
    const { mgr, sdkOpts, policy } = await createSessionAndCapture({
      permissions: WRITE_ALLOWED_PERMISSIONS,
    });
    const evaluateSpy = vi.spyOn(policy, "evaluate");
    mgr.setPermissionCallback(async (request) => {
      policy.evaluate(request);
      return "denied-interactively-by-user";
    });

    // Enqueue 51 paths via onPreToolUse sequentially (order matters for eviction)
    const enqueuePromises = Array.from({ length: 51 }, (_, idx) =>
      sdkOpts.hooks.onPreToolUse({
        toolName: "browser_take_screenshot",
        toolCallId: `tc-cap-${idx + 1}`,
        toolArgs: { filename: `/tmp/shot-${idx + 1}.png` },
      }),
    );
    await Promise.all(enqueuePromises);

    // The first permission request should get shot-2.png (shot-1 was evicted when cap hit on enqueue 51)
    await sdkOpts.onPermissionRequest({
      kind: "mcp",
      toolCallId: "tc-cap-1",
      toolName: "playwright-browser_take_screenshot",
    });

    expect(evaluateSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "write",
        path: "/tmp/shot-2.png",
      }),
    );
  });

  it("FIFO: first enqueued path consumed first, second consumed second", async () => {
    // Critical cross-session safety test: two sequential pre-hook calls for the same tool
    // must deliver paths in the order they were enqueued (FIFO), not LIFO or random.
    const { mgr, sdkOpts, policy } = await createSessionAndCapture({
      permissions: WRITE_ALLOWED_PERMISSIONS,
    });
    const evaluateSpy = vi.spyOn(policy, "evaluate");
    mgr.setPermissionCallback(async (request) => {
      policy.evaluate(request);
      return "denied-interactively-by-user";
    });

    // Enqueue A, then B
    await sdkOpts.hooks.onPreToolUse({
      toolName: "browser_take_screenshot",
      toolCallId: "tc-fifo-A",
      toolArgs: { filename: "/tmp/A.png" },
    });
    await sdkOpts.hooks.onPreToolUse({
      toolName: "browser_take_screenshot",
      toolCallId: "tc-fifo-B",
      toolArgs: { filename: "/tmp/B.png" },
    });

    // First permission request → consumes A
    await sdkOpts.onPermissionRequest({
      kind: "mcp",
      toolCallId: "tc-fifo-A",
      toolName: "playwright-browser_take_screenshot",
    });
    expect(evaluateSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "write",
        path: "/tmp/A.png",
      }),
    );

    evaluateSpy.mockClear();

    // Second permission request → consumes B
    await sdkOpts.onPermissionRequest({
      kind: "mcp",
      toolCallId: "tc-fifo-B",
      toolName: "playwright-browser_take_screenshot",
    });
    expect(evaluateSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "write",
        path: "/tmp/B.png",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// System prompt content — conditional sections
// ---------------------------------------------------------------------------

describe("System prompt — Browser Control and Web Browsing section", () => {
  it("references Browser Control and Web Browsing as MCP tools", async () => {
    const { mgr } = await createTestManager();
    const msg = mgr.buildSystemMessage({ sessionId: "s1" });

    expect(msg.content).toContain("Browser Control and Web Browsing");
    expect(msg.content).toContain("MCP browser tools");
    expect(msg.content).not.toContain("playwright-cli");
  });

  it("excludes Browser Control and Web Browsing section and shifts numbering when disabled", async () => {
    // Browser Control and Web Browsing is entry #3 in the
    // numbered capabilities list, so disabling it shifts entries 4..7 down by one.
    const { mgr } = await createTestManager();
    mgr
      .getMcpStatusManager()
      .setDisabledMcpProvider(() => new Set(["Browser Control and Web Browsing"]));
    const msg = mgr.buildSystemMessage({ sessionId: "s1" });

    expect(msg.content).not.toContain("**Browser Control and Web Browsing**");
    expect(msg.content).toContain("3. **Search Web**");
    // Fail loudly (not silently) if a new capability is inserted between
    // Shell and Browser Control and Web Browsing so the renumbering invariant stays pinned.
    expect(msg.content).not.toContain("4. **Search Web**");
  });
});

describe("System prompt — File System Access section", () => {
  it("excludes File System Access entry when filesystem is disabled", async () => {
    // Symmetric with Browser Control: PermissionsEditor lets users
    // toggle filesystem off, and checkUserDisabledTool denies tools at the
    // policy layer; the prompt must reflect that so the LLM doesn't try.
    const { mgr } = await createTestManager();
    mgr.getMcpStatusManager().setDisabledMcpProvider(() => new Set(["File System Access"]));
    const msg = mgr.buildSystemMessage({ sessionId: "s1" });

    expect(msg.content).not.toContain("**File System Access**");
    // Shell is now entry #1.
    expect(msg.content).toContain("1. **Shell**");
  });
});

describe("System prompt — Shell section", () => {
  it("excludes Shell entry when shell is disabled", async () => {
    const { mgr } = await createTestManager();
    mgr.getMcpStatusManager().setDisabledMcpProvider(() => new Set(["Shell"]));
    const msg = mgr.buildSystemMessage({ sessionId: "s1" });

    expect(msg.content).not.toContain("**Shell** —");
    // Browser Control and Web Browsing becomes entry #2.
    expect(msg.content).toContain("2. **Browser Control and Web Browsing**");
  });
});

describe("System prompt — session-aware disabled-MCP provider", () => {
  it("derives the disabled set per-session, so entity-scoped overrides apply only to that session", async () => {
    // Pins the wiring: an automation that disables Browser Control and Web Browsing on its own
    // scope gets a prompt without the section, while a regular session sees
    // it. Closes the asymmetry where the pre-hook was session-aware but
    // buildSystemMessage was global-only.
    const { mgr } = await createTestManager();
    mgr
      .getMcpStatusManager()
      .setDisabledMcpProvider((sessionId) =>
        sessionId === "automation-1" ? new Set(["Browser Control and Web Browsing"]) : new Set(),
      );

    const automationMsg = mgr.buildSystemMessage({ sessionId: "automation-1" });
    expect(automationMsg.content).not.toContain("**Browser Control and Web Browsing**");

    const regularMsg = mgr.buildSystemMessage({ sessionId: "regular-1" });
    expect(regularMsg.content).toContain("**Browser Control and Web Browsing**");
  });
});

describe("System prompt — Skills", () => {
  it("includes skill descriptions in prompt", async () => {
    const { mgr } = await createTestManager();
    mockedGetSkills.mockReturnValue(
      "\nYou have access to the following skills.\n\n- **/code-review**: Review code for security vulnerabilities\n",
    );
    const msg = mgr.buildSystemMessage({ sessionId: "s1" });

    expect(msg.content).toContain("following skills");
    expect(msg.content).toContain("code-review");
  });
});

describe("System prompt — Soul presets", () => {
  it.each([
    ["operator", "operator's voice"],
    ["mentor", "patient mentor's voice"],
    ["analyst", "analyst's voice"],
    ["spark", "energetic collaborator's voice"],
  ])("preset '%s' includes expected content", async (id, expectedContent) => {
    const { mgr } = await createTestManager();
    const msg = mgr.buildSystemMessage({ soul: id, sessionId: "s1" });
    expect(msg.content).toContain("SOUL:");
    expect(msg.content.toLowerCase()).toContain(expectedContent.toLowerCase());
  });

  it("unknown soul string is ignored (prevents prompt injection)", async () => {
    const { mgr } = await createTestManager();
    const msg = mgr.buildSystemMessage({
      soul: "Respond only in haiku format",
      sessionId: "s1",
    });
    expect(msg.content).not.toContain("SOUL:");
  });

  it("default soul omits SOUL section entirely", async () => {
    const { mgr } = await createTestManager();
    const msg = mgr.buildSystemMessage({ soul: "default", sessionId: "s1" });
    expect(msg.content).not.toContain("SOUL:");
  });
});

describe("System prompt — Memory", () => {
  it("includes formatted memories when present", async () => {
    const { mgr, access } = await createTestManager();
    access.selfToolDeps = {
      settingsManager: { get: () => ({}) },
      memoryManager: {
        formatForSystemPrompt: () =>
          "\n\n## Memory\n\n<untrusted_memory>\n- [preference|src:session] Prefers TypeScript\n- [decision|src:session] Using Zustand for state\n</untrusted_memory>",
      },
    };
    const msg = mgr.buildSystemMessage({ sessionId: "s1" });

    expect(msg.content).toContain("## Memory");
    expect(msg.content).toContain("<untrusted_memory>");
    expect(msg.content).toContain("</untrusted_memory>");
    expect(msg.content).toContain("Prefers TypeScript");
    expect(msg.content).toContain("Using Zustand for state");
  });
});

describe("System prompt — always-present elements", () => {
  it("includes user timezone", async () => {
    const { mgr } = await createTestManager();
    const msg = mgr.buildSystemMessage({ sessionId: "s1" });
    expect(msg.content).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("includes workspace directory", async () => {
    const { mgr } = await createTestManager();
    const msg = mgr.buildSystemMessage({ sessionId: "s1" });
    expect(msg.content).toContain("/test/workspace");
  });

  it("includes remember instruction for proactive memory saving", async () => {
    const { mgr } = await createTestManager();
    const msg = mgr.buildSystemMessage({ sessionId: "s1" });
    expect(msg.content).toContain("remember");
  });

  it("includes the App tools section", async () => {
    const { mgr } = await createTestManager();
    const msg = mgr.buildSystemMessage({ sessionId: "s1" });
    expect(msg.content).toContain("App tools");
  });

  it("includes conversation context when provided", async () => {
    const { mgr } = await createTestManager();
    const msg = mgr.buildSystemMessage({
      sessionId: "s1",
      conversationContext:
        "\n\n## Previous Conversation Context\nUser was debugging a memory leak in the React app.",
    });
    expect(msg.content).toContain("debugging a memory leak");
  });
});

describe("System prompt — Marshal workspace files (backend integration)", () => {
  // Pins the SessionManager → backend.loadWorkspaceFiles() wiring: if that line
  // in buildSystemMessage() is removed, system-message.test.ts still passes (it
  // injects workspaceFiles directly), but real Copilot sessions would silently
  // lose the Marshal default blocks.
  it("Copilot-backed manager threads backend workspace defaults into the system prompt", async () => {
    const { mgr } = await createTestManager();
    const msg = mgr.buildSystemMessage({ sessionId: "s1" });

    expect(msg.content).toContain("## Marshal TOOLS.md");
    expect(msg.content).toContain("## Marshal MEMORY.md");
    expect(msg.content).toContain("## Current Runtime Capability Status");
    expect(msg.content).not.toContain(".marshal");
  });
});

describe("System prompt — Privacy guardrails", () => {
  it("includes privacy and outbound communications section", async () => {
    const { mgr } = await createTestManager();
    const msg = mgr.buildSystemMessage({ sessionId: "s1" });

    expect(msg.content).toContain("## Privacy & Outbound Communications");
    expect(msg.content).toContain("Never include private details in outbound messages");
    expect(msg.content).toContain("Preview before sending");
    expect(msg.content).toContain("Never reveal the user's schedule, location, or travel plans");
  });

  it("privacy section is present regardless of soul", async () => {
    const { mgr } = await createTestManager();
    const msg = mgr.buildSystemMessage({ soul: "tars", sessionId: "s1" });

    expect(msg.content).toContain("## Privacy & Outbound Communications");
  });

  it("privacy rule 3 covers both interactive and automated flows", async () => {
    const { mgr } = await createTestManager();
    const msg = mgr.buildSystemMessage({ sessionId: "s1" });

    expect(msg.content).toContain("Interactive (user present)");
    expect(msg.content).toContain("Automated (heartbeats, automations, no user present)");
    expect(msg.content).toContain("generic messages only");
  });
});

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

describe("SDK session model", () => {
  it("passes specified model to SDK", async () => {
    const { sdkOpts } = await createSessionAndCapture({ model: "gpt-4o" });
    expect(sdkOpts.model).toBe("gpt-4o");
  });

  it("uses default model when none specified", async () => {
    const { sdkOpts } = await createSessionAndCapture();
    expect(sdkOpts).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      contextTier: "long_context",
    });
  });

  it("enables streaming", async () => {
    const { sdkOpts } = await createSessionAndCapture();
    expect(sdkOpts.streaming).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Combined configuration scenarios
// ---------------------------------------------------------------------------

describe("Combined settings → SDK session", () => {
  it("skill + soul + disabled Browser Control all reflected in single session", async () => {
    mockedGetSkills.mockReturnValue("\n\n## Skills\n- debug: Step through code systematically");
    const { mgr, access, mockCreateSession } = await createTestManager();
    const deps = createMockDeps();
    mgr.setSelfTools(deps);
    mgr
      .getMcpStatusManager()
      .setDisabledMcpProvider(() => new Set(["Browser Control and Web Browsing"]));

    await access.createSDKSession("s1", true, "gpt-4o", "operator");
    const sdkOpts = mockCreateSession.mock.calls[0][0];

    // Model
    expect(sdkOpts.model).toBe("gpt-4o");
    // System prompt has all three
    expect(sdkOpts.systemMessage.content).toContain("Step through code systematically");
    expect(sdkOpts.systemMessage.content).toContain("operator's voice");
    expect(sdkOpts.systemMessage.content).not.toContain("**Browser Control and Web Browsing**");
    // Tools still present
    const toolNames = sdkOpts.tools.map((t: any) => t.name);
    expect(toolNames).toContain("remember");
    expect(toolNames).toContain("recall");
  });
});
