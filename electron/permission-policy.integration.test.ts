/**
 * Integration tests for PermissionPolicy — exercises the full evaluate() flow
 * with realistic settings, no internal mocks. Verifies that autoApproveReadOnly
 * correctly auto-approves read-only custom tools and prompts destructive ones.
 */
import { describe, it, expect, vi } from "vitest";

// Stub disk + electron primitives so the real SettingsManager / settings-store
// chain can run without touching the host filesystem. Used by the
// "settings write→read roundtrip" describe block at the bottom of this file;
// the autoApproveReadOnly tests above use testDouble<SettingsManager> and so
// don't rely on these mocks.
vi.mock("fs", () => ({
  default: {
    existsSync: () => false,
    mkdirSync: () => undefined,
    readFileSync: () => "",
    writeFileSync: () => undefined,
    promises: { mkdir: () => Promise.resolve(), writeFile: () => Promise.resolve() },
  },
  existsSync: () => false,
  mkdirSync: () => undefined,
  readFileSync: () => "",
  writeFileSync: () => undefined,
  promises: { mkdir: () => Promise.resolve(), writeFile: () => Promise.resolve() },
}));
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));
vi.mock("./app-paths", () => ({
  getAppDataDir: () => "/tmp/m-integration-test/.marshal",
}));

import type { PermissionsConfig, SessionPermissionMode } from "../common/marshal-ipc-contract";
import type { ApprovalRequest } from "./backend/types";
import { grantFolderForPath } from "./permission-path-scope";
import { PermissionPolicy } from "./permission-policy";
import { makeRequest as makeRequestBase } from "./policy-rules/test-helpers";
import { SettingsManager } from "./settings-manager";
import { DEFAULT_SETTINGS } from "./settings-store";
import type { TenantPolicyProvider } from "./tenant-policy";
import { testDouble } from "./testing/harness";

function buildPolicy(
  permissions: PermissionsConfig,
  options: {
    permissionMode?: SessionPermissionMode;
  } = {},
) {
  return new PermissionPolicy({
    settingsManager: testDouble<SettingsManager>({
      get: () => ({
        autoApprove: { global: false, perServer: {} },
        permissions,
      }),
      update: vi.fn<(s: Record<string, unknown>) => void>(),
    }),
    getPermissionMode: () => options.permissionMode ?? "default",
  });
}

function makeRequest(kind: ApprovalRequest["kind"], fields: Record<string, unknown> = {}) {
  return makeRequestBase({ id: "req-1", kind, ...fields });
}

describe("PermissionPolicy integration — autoApproveReadOnly", () => {
  const enabledPermissions: PermissionsConfig = {
    autoApproveReadOnly: true,
    allow: [],
    tools: {},
    servers: {
      filesystem: { enabled: true, autoApprove: true },
      playwright: { enabled: true, autoApprove: true },
      shell: { enabled: true, autoApprove: false },
      "example-mcp": { enabled: true, autoApprove: false },
    },
  };

  const disabledPermissions: PermissionsConfig = {
    autoApproveReadOnly: false,
    allow: [],
    tools: {},
    servers: { ...enabledPermissions.servers },
  };

  describe("read-only first-party tools", () => {
    const readOnlyTools = [
      "listLocalFiles",
      "getLocalFileTree",
      "statLocalPath",
      "listAutomations",
      "getAutomation",
      "listWorkspaces",
      "listSubagents",
      "goalGet",
    ];

    it.each(readOnlyTools)("auto-approves %s when enabled", (toolName) => {
      const policy = buildPolicy(enabledPermissions);
      expect(policy.evaluate(makeRequest("custom-tool", { toolName }))).toBe("approve");
    });

    it.each(readOnlyTools)("prompts for %s when disabled", (toolName) => {
      const policy = buildPolicy(disabledPermissions);
      expect(policy.evaluate(makeRequest("custom-tool", { toolName }))).toBe("prompt");
    });
  });

  describe("mutating first-party tools", () => {
    const destructiveTools = [
      "createSkill",
      "deleteSkill",
      "createAutomation",
      "forget",
      "moveLocalPath",
    ];

    it.each(destructiveTools)("prompts for %s even when enabled", (toolName) => {
      const policy = buildPolicy(enabledPermissions);
      expect(policy.evaluate(makeRequest("custom-tool", { toolName }))).toBe("prompt");
    });
  });

  describe("read-only self-tools", () => {
    const selfTools = ["recall", "listMemories", "getSettings", "listSkills"];

    it.each(selfTools)("auto-approves %s when enabled", (toolName) => {
      const policy = buildPolicy(enabledPermissions);
      expect(policy.evaluate(makeRequest("custom-tool", { toolName }))).toBe("approve");
    });
  });

  it("unknown custom tool prompts even with autoApproveReadOnly", () => {
    const policy = buildPolicy(enabledPermissions);
    expect(
      policy.evaluate(makeRequest("custom-tool", { toolName: "unknown_destructive_tool" })),
    ).toBe("prompt");
  });

  it("read-only shell commands are also auto-approved when enabled", () => {
    const policy = buildPolicy(enabledPermissions);
    expect(policy.evaluate(makeRequest("shell", { command: "ls -la" }))).toBe("approve");
  });

  it("write shell commands still prompt when enabled", () => {
    const policy = buildPolicy(enabledPermissions);
    expect(policy.evaluate(makeRequest("shell", { command: "rm -rf /" }))).toBe("prompt");
  });
});

describe("step 7a: structured tool auto-approve", () => {
  /** Base permissions: everything off except the tools map. */
  const basePermissions: PermissionsConfig = {
    autoApproveReadOnly: false,
    allow: [],
    tools: {},
    servers: {
      filesystem: { enabled: true, autoApprove: false },
      playwright: { enabled: true, autoApprove: false },
      shell: { enabled: true, autoApprove: false },
      "example-mcp": { enabled: true, autoApprove: false },
    },
  };

  function buildToolsPolicy(tools: Record<string, boolean>) {
    return buildPolicy({ ...basePermissions, tools });
  }

  it("custom-tool approved via tools map", () => {
    const policy = buildToolsPolicy({ "tool:createSkill": true });
    expect(policy.evaluate(makeRequest("custom-tool", { toolName: "createSkill" }))).toBe(
      "approve",
    );
  });

  it("MCP tool approved via tools map", () => {
    const policy = buildToolsPolicy({ "mcp:filesystem:read_file": true });
    expect(
      policy.evaluate(makeRequest("mcp", { serverName: "filesystem", toolName: "read_file" })),
    ).toBe("approve");
  });

  it("group key approves child tools", () => {
    const policy = buildToolsPolicy({ "tool:skills": true });
    expect(policy.evaluate(makeRequest("custom-tool", { toolName: "createSkill" }))).toBe(
      "approve",
    );
  });

  it("explicit false overrides group true", () => {
    const policy = buildToolsPolicy({
      "tool:skills": true,
      "tool:createSkill": false,
    });
    expect(policy.evaluate(makeRequest("custom-tool", { toolName: "createSkill" }))).toBe("prompt");
  });

  it("tool not in map prompts", () => {
    const policy = buildToolsPolicy({});
    expect(policy.evaluate(makeRequest("custom-tool", { toolName: "createSkill" }))).toBe("prompt");
  });

  it("group key false blocks child tools", () => {
    const policy = buildToolsPolicy({ "tool:skills": false });
    expect(policy.evaluate(makeRequest("custom-tool", { toolName: "createSkill" }))).toBe("prompt");
  });

  it("round-trip: persistAllowRule → evaluate", () => {
    const currentPermissions: PermissionsConfig = { ...basePermissions, tools: {} };
    const settingsManager = testDouble<SettingsManager>({
      get: () => ({
        autoApprove: { global: false, perServer: {} },
        permissions: currentPermissions,
      }),
      update: vi.fn<(s: Record<string, unknown>) => void>((s) => {
        if (s.permissions) Object.assign(currentPermissions, s.permissions);
      }),
    });

    const policy = new PermissionPolicy({
      settingsManager,
    });

    const mcpRequest = makeRequest("mcp", { serverName: "example-mcp", toolName: "ask" });

    // Record an "always-allow" decision — this calls persistAllowRule internally
    policy.recordDecision("always-allow", mcpRequest);

    // Now the same request should auto-approve via the tools map
    expect(policy.evaluate(mcpRequest)).toBe("approve");
  });
});

describe("PermissionPolicy integration — session-scoped entity permissions", () => {
  const basePermissions: PermissionsConfig = {
    autoApproveReadOnly: false,
    allow: [],
    tools: {},
    servers: {
      filesystem: { enabled: true, autoApprove: true },
      playwright: { enabled: true, autoApprove: true },
      shell: { enabled: true, autoApprove: false },
      "example-mcp": { enabled: true, autoApprove: false },
    },
  };

  it("session reuse cycle — register, evaluate, unregister, re-register different permissions", () => {
    const policy = buildPolicy(basePermissions);

    // Register shell auto-approve for session s1 (makeRequest uses "s1")
    policy.registerSessionPermissions("s1", {
      autoApproveReadOnly: false,
      allow: [],
      tools: {},
      servers: { shell: { enabled: true, autoApprove: true } },
    });

    // Evaluate — should approve
    expect(policy.evaluate(makeRequest("shell", { command: "npm run build" }))).toBe("approve");

    // Unregister
    policy.unregisterSessionPermissions("s1");

    // Re-register with different permissions (read-only only)
    policy.registerSessionPermissions("s1", {
      autoApproveReadOnly: true,
      allow: [],
      tools: {},
      servers: {},
    });

    // Same write command — now prompts (autoApproveReadOnly doesn't cover writes)
    expect(policy.evaluate(makeRequest("shell", { command: "npm run build" }))).toBe("prompt");

    // Read-only command — approved via autoApproveReadOnly
    expect(policy.evaluate(makeRequest("shell", { command: "ls -la" }))).toBe("approve");
  });

  it("between-run gap — register, unregister, evaluate without re-registering falls through to global", () => {
    const policy = buildPolicy(basePermissions);

    // Register shell auto-approve for session s1
    policy.registerSessionPermissions("s1", {
      autoApproveReadOnly: false,
      allow: [],
      tools: {},
      servers: { shell: { enabled: true, autoApprove: true } },
    });

    // Evaluate — approved
    expect(policy.evaluate(makeRequest("shell", { command: "rm -rf /" }))).toBe("approve");

    // Unregister
    policy.unregisterSessionPermissions("s1");

    // Evaluate without re-registering — falls through to global
    // Global has shell: { enabled: true, autoApprove: false }, so this prompts
    expect(policy.evaluate(makeRequest("shell", { command: "rm -rf /" }))).toBe("prompt");

    // Read kind always approved regardless
    expect(policy.evaluate(makeRequest("read"))).toBe("approve");
  });
});

describe("PermissionPolicy integration — reacts to SettingsManager.update() in-memory", () => {
  function setup() {
    // Real SettingsManager — constructor calls loadSettingsFromDisk which,
    // with fs mocked to existsSync=false, returns DEFAULT_SETTINGS.
    const settingsManager = new SettingsManager();
    const policy = new PermissionPolicy({
      settingsManager,
    });
    return { settingsManager, policy };
  }

  it("disabling Browser Control via SettingsManager.update() denies playwright pre-hook calls", () => {
    const { settingsManager, policy } = setup();

    // Sanity baseline — enabled by default, no deny.
    expect(
      policy.evaluatePreHook({ sessionId: "s1", toolName: "playwright-browser_navigate" }),
    ).toBeNull();

    // Mutate via the same shape the UI's PermissionsPanel writes.
    const current = settingsManager.get().permissions ?? DEFAULT_SETTINGS.permissions!;
    settingsManager.update({
      permissions: {
        ...current,
        servers: {
          ...current.servers,
          playwright: { enabled: false, autoApprove: false },
        },
      },
    });

    const result = policy.evaluatePreHook({
      sessionId: "s1",
      toolName: "playwright-browser_navigate",
    });
    expect(result?.permissionDecision).toBe("deny");
    expect(result?.permissionDecisionReason).toContain("Browser Control and Web Browsing");
  });

  it("disabling Browser Control via SettingsManager.update() denies web_fetch pre-hook calls", () => {
    const { settingsManager, policy } = setup();

    expect(policy.evaluatePreHook({ sessionId: "s1", toolName: "web_fetch" })).toBeNull();

    const current = settingsManager.get().permissions ?? DEFAULT_SETTINGS.permissions!;
    settingsManager.update({
      permissions: {
        ...current,
        servers: {
          ...current.servers,
          playwright: { enabled: false, autoApprove: false },
        },
      },
    });

    const result = policy.evaluatePreHook({
      sessionId: "s1",
      toolName: "web_fetch",
    });
    expect(result).toEqual({
      permissionDecision: "deny",
      permissionDecisionReason:
        "Browser Control and Web Browsing is currently disabled by the user.",
    });
  });

  it("disabling ExampleMcp via SettingsManager.update() denies via evaluate() Step 4", () => {
    // Symmetric coverage at the evaluate() entry point used by the SDK's
    // permission callback (distinct from the pre-hook path above).
    const { settingsManager, policy } = setup();

    expect(
      policy.evaluate({
        id: "r1",
        sessionId: "s1",
        kind: "mcp",
        serverName: "example-mcp",
        toolName: "ask",
        toolTitle: undefined,
        toolDescription: undefined,
        toolArgs: {},
        readOnly: false,
        toolCallId: undefined,
      } satisfies ApprovalRequest),
    ).not.toBe("deny");

    const current = settingsManager.get().permissions ?? DEFAULT_SETTINGS.permissions!;
    settingsManager.update({
      permissions: {
        ...current,
        servers: {
          ...current.servers,
          "example-mcp": { enabled: false, autoApprove: false },
        },
      },
    });

    expect(
      policy.evaluate({
        id: "r2",
        sessionId: "s1",
        kind: "mcp",
        serverName: "example-mcp",
        toolName: "ask",
        toolTitle: undefined,
        toolDescription: undefined,
        toolArgs: {},
        readOnly: false,
        toolCallId: undefined,
      } satisfies ApprovalRequest),
    ).toBe("deny");
  });

  it("re-enabling a server via update() flips the deny back off", () => {
    const { settingsManager, policy } = setup();
    const current = settingsManager.get().permissions ?? DEFAULT_SETTINGS.permissions!;

    settingsManager.update({
      permissions: {
        ...current,
        servers: {
          ...current.servers,
          playwright: { enabled: false, autoApprove: false },
        },
      },
    });
    expect(
      policy.evaluatePreHook({ sessionId: "s1", toolName: "playwright-browser_navigate" })
        ?.permissionDecision,
    ).toBe("deny");

    const afterDisable = settingsManager.get().permissions!;
    settingsManager.update({
      permissions: {
        ...afterDisable,
        servers: {
          ...afterDisable.servers,
          playwright: { enabled: true, autoApprove: true },
        },
      },
    });
    expect(
      policy.evaluatePreHook({ sessionId: "s1", toolName: "playwright-browser_navigate" }),
    ).toBeNull();
  });
});

describe("PermissionPolicy integration — forcePrompt applies to kind:read", () => {
  it("forcePrompt via tenant policy prompts for kind:read", () => {
    const policy = new PermissionPolicy({
      settingsManager: testDouble<SettingsManager>({
        get: () => ({ autoApprove: { global: false, perServer: {} }, permissions: undefined }),
        update: vi.fn<(s: Record<string, unknown>) => void>(),
      }),
      tenantPolicy: testDouble<TenantPolicyProvider>({
        get: () => ({ forcePrompt: true }),
      }),
    });

    expect(
      policy.evaluate({
        id: "r1",
        sessionId: "s1",
        kind: "read",
        path: "",
        toolCallId: undefined,
      } satisfies ApprovalRequest),
    ).toBe("prompt");
  });
});

describe("PermissionPolicy integration: kind:read blanket approval", () => {
  const basePermissions: PermissionsConfig = {
    autoApproveReadOnly: false,
    allow: [],
    tools: {},
    servers: {
      filesystem: { enabled: true, autoApprove: false },
      playwright: { enabled: true, autoApprove: false },
      shell: { enabled: true, autoApprove: false },
    },
  };

  const workspaceDir = "/workspace/project";
  const outsidePath = "/some/other/place/notes.txt";
  const sensitivePath = `${process.env.HOME ?? process.env.USERPROFILE}/.ssh/id_rsa`;

  function makeReadRequest(path: string) {
    return makeRequestBase({
      id: "req-read",
      sessionId: "s1",
      kind: "read",
      path,
      toolCallId: undefined,
    });
  }

  function buildPolicyWithStore(permissions: PermissionsConfig) {
    const current = structuredClone(permissions);
    const settingsManager = testDouble<SettingsManager>({
      get: () => ({ autoApprove: { global: false, perServer: {} }, permissions: current }),
      update: vi.fn<(s: Record<string, unknown>) => void>((s) => {
        if (s.permissions) Object.assign(current, s.permissions);
      }),
    });
    return new PermissionPolicy({ settingsManager, workspaceDir });
  }

  it("outside-workspace read prompts by default", () => {
    const policy = buildPolicyWithStore(basePermissions);
    expect(policy.evaluate(makeReadRequest(outsidePath))).toBe("prompt");
  });

  it("always-allow persists a folder grant: same-folder reads approve, other folders still prompt", () => {
    const policy = buildPolicyWithStore(basePermissions);
    const req = makeReadRequest(outsidePath); // /some/other/place/notes.txt
    expect(policy.evaluate(req)).toBe("prompt");
    expect(policy.recordDecision("always-allow", req)).toBe(true);
    // A sibling in the granted folder (/some/other/place) auto-approves.
    expect(policy.evaluate(makeReadRequest("/some/other/place/other.txt"))).toBe("approve");
    // A different folder still prompts — grants are folder-scoped, not blanket.
    expect(policy.evaluate(makeReadRequest("/another/path/file.txt"))).toBe("prompt");
  });

  it("allow-for-session approves only within the same session", () => {
    const policy = buildPolicyWithStore(basePermissions);
    const reqS1 = makeReadRequest(outsidePath);
    expect(policy.recordDecision("allow-session", reqS1)).toBe(true);
    expect(policy.evaluate(reqS1)).toBe("approve");

    const reqS2 = makeRequestBase({
      id: "req-read-2",
      sessionId: "s2",
      kind: "read",
      path: outsidePath,
      toolCallId: undefined,
    });
    expect(policy.evaluate(reqS2)).toBe("prompt");
  });

  it("filesystem.autoApprove does NOT auto-approve SDK reads outside the workspace (folder grant required)", () => {
    const policy = buildPolicyWithStore({
      ...basePermissions,
      servers: { ...basePermissions.servers, filesystem: { enabled: true, autoApprove: true } },
    });
    // FOLDER_GRANT_RULE runs before SERVER_AUTO_APPROVE_RULE: the global toggle
    // no longer extends past the workspace.
    expect(policy.evaluate(makeReadRequest(outsidePath))).toBe("prompt");
  });

  it("sensitive-path read still prompts even with tools['tool:read']: true", () => {
    const policy = buildPolicyWithStore({
      ...basePermissions,
      tools: { "tool:read": true },
    });
    expect(policy.evaluate(makeReadRequest(sensitivePath))).toBe("prompt");
  });

  it("filesystem MCP group toggle (tools['mcp:filesystem']: true) does NOT bypass the out-of-workspace gate", () => {
    const policy = buildPolicyWithStore({
      ...basePermissions,
      tools: { "mcp:filesystem": true },
    });
    expect(policy.evaluate(makeReadRequest(outsidePath))).toBe("prompt");
  });

  it("per-tool toggle tools['mcp:filesystem:read_text_file']: true does NOT bypass the out-of-workspace gate", () => {
    const policy = buildPolicyWithStore({
      ...basePermissions,
      tools: { "mcp:filesystem:read_text_file": true },
    });
    expect(policy.evaluate(makeReadRequest(outsidePath))).toBe("prompt");
  });

  it("per-tool toggle tools['mcp:filesystem:read_media_file']: true does NOT bypass the out-of-workspace gate", () => {
    const policy = buildPolicyWithStore({
      ...basePermissions,
      tools: { "mcp:filesystem:read_media_file": true },
    });
    expect(policy.evaluate(makeReadRequest(outsidePath))).toBe("prompt");
  });

  it("sensitive paths still prompt even when filesystem.autoApprove is true", () => {
    const policy = buildPolicyWithStore({
      ...basePermissions,
      servers: { ...basePermissions.servers, filesystem: { enabled: true, autoApprove: true } },
    });
    expect(policy.evaluate(makeReadRequest(sensitivePath))).toBe("prompt");
  });

  it("sensitive paths still prompt even when tools['mcp:filesystem'] group toggle is on", () => {
    const policy = buildPolicyWithStore({
      ...basePermissions,
      tools: { "mcp:filesystem": true },
    });
    expect(policy.evaluate(makeReadRequest(sensitivePath))).toBe("prompt");
  });

  it("always-allow on a kind:read in an entity session writes to the entity config, not global settings", () => {
    const globalState = structuredClone(basePermissions);
    const settingsManager = testDouble<SettingsManager>({
      get: () => ({ autoApprove: { global: false, perServer: {} }, permissions: globalState }),
      update: vi.fn<(s: Record<string, unknown>) => void>((s) => {
        if (s.permissions) Object.assign(globalState, s.permissions);
      }),
    });
    const policy = new PermissionPolicy({ settingsManager, workspaceDir });
    const entityPerms = structuredClone(basePermissions);
    let entitySaved: PermissionsConfig | undefined;
    policy.registerSessionPermissions("automation-sid", entityPerms, (updated) => {
      entitySaved = updated;
    });

    const req = makeRequestBase({
      id: "req-read-entity",
      sessionId: "automation-sid",
      kind: "read",
      path: outsidePath,
      toolCallId: undefined,
    });

    expect(policy.recordDecision("always-allow", req)).toBe(true);
    // Out-of-workspace reads persist a folder grant (not a blanket tool:read).
    // Global settings stay untouched.
    expect(globalState.allowedReadFolders).toBeUndefined();
    expect(globalState.tools["tool:read"]).toBeUndefined();
    // Entity-config copy got the folder grant through onPersist. Compute the
    // expected folder with the production helper so the assertion is cross-platform
    // (path.resolve drive-letters/backslashes on Windows).
    expect(entitySaved?.allowedReadFolders).toContain(grantFolderForPath(outsidePath));
  });
});
