import { describe, expect, it } from "vitest";

import type { PermissionsConfig } from "../common/marshal-ipc-contract";
import { LOCAL_FILE_TOOL_DEFINITIONS } from "./marshal-fs/shared";
import {
  FILE_UPLOAD_DISABLED,
  POLICY_PRE_HOOK_RULES,
  TENANT_DISABLED_SERVER,
  USER_DISABLED_SERVER,
  type PolicyContext,
} from "./permission-policy-checks";

const LOCAL_FILE_POLICY_TOOL_NAMES = Object.keys(LOCAL_FILE_TOOL_DEFINITIONS);

const DEFAULT_PERMISSIONS: PermissionsConfig = {
  autoApproveReadOnly: false,
  allow: [],
  tools: {},
  servers: {},
};

function makeContext(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    sessionId: "s1",
    toolName: "filesystem__read_file",
    fileUploadEnabled: true,
    permissions: DEFAULT_PERMISSIONS,
    ...overrides,
  };
}

describe("POLICY_PRE_HOOK_RULES", () => {
  it("orders tenant rules before user rules and tool-specific rules", () => {
    expect(POLICY_PRE_HOOK_RULES.map((rule) => rule.id)).toEqual([
      "tenant-disabled-server",
      "user-disabled-server",
      "playwright-file-write-fs-gate",
      "playwright-code-execution-fs-gate",
      "file-upload-disabled",
    ]);
  });
});

describe("pre-hook policy rules", () => {
  it("denies tenant-disabled tools before user-disabled server rules", () => {
    const ctx = makeContext({
      permissions: {
        ...DEFAULT_PERMISSIONS,
        servers: { filesystem: { enabled: false, autoApprove: false } },
      },
      tenantPolicy: {
        get: () => ({ disabledServers: ["filesystem"] }),
      },
    });

    const deny = TENANT_DISABLED_SERVER.preHook(ctx);

    expect(deny).toEqual({
      permissionDecision: "deny",
      permissionDecisionReason: "filesystem is disabled by your organization's policy.",
      serverName: "filesystem",
    });
  });

  it("denies SDK tools mapped to a tenant-disabled server", () => {
    const ctx = makeContext({
      toolName: "web_fetch",
      tenantPolicy: {
        get: () => ({ disabledServers: ["playwright"] }),
      },
    });

    expect(TENANT_DISABLED_SERVER.preHook(ctx)).toEqual({
      permissionDecision: "deny",
      permissionDecisionReason: "playwright is disabled by your organization's policy.",
      serverName: "playwright",
      kind: "custom-tool",
    });
  });

  it("denies uppercase SDK tools mapped to a user-disabled server", () => {
    const ctx = makeContext({
      toolName: "WEB_FETCH",
      permissions: {
        ...DEFAULT_PERMISSIONS,
        servers: { playwright: { enabled: false, autoApprove: false } },
      },
    });

    expect(USER_DISABLED_SERVER.preHook(ctx)).toMatchObject({
      permissionDecision: "deny",
      permissionDecisionReason:
        "Browser Control and Web Browsing is currently disabled by the user.",
      kind: "custom-tool",
    });
  });

  it("denies only exact, double-underscore, and hyphen-prefixed user-disabled server tools", () => {
    const disabledContext = makeContext({
      permissions: {
        ...DEFAULT_PERMISSIONS,
        servers: {
          shell: { enabled: false, autoApprove: false },
          metrics: { enabled: false, autoApprove: false },
        },
      },
    });

    expect(
      USER_DISABLED_SERVER.preHook({
        ...disabledContext,
        toolName: "metrics__ask",
      }),
    ).toMatchObject({
      permissionDecision: "deny",
      serverName: "metrics",
    });
    expect(
      USER_DISABLED_SERVER.preHook({ ...disabledContext, toolName: "metrics-ask" }),
    ).toMatchObject({
      permissionDecision: "deny",
      serverName: "metrics",
    });
    expect(USER_DISABLED_SERVER.preHook({ ...disabledContext, toolName: "metrics" })).toMatchObject(
      {
        permissionDecision: "deny",
        serverName: "metrics",
      },
    );
    expect(
      USER_DISABLED_SERVER.preHook({ ...disabledContext, toolName: "powershell_exec" }),
    ).toBeNull();
    expect(
      USER_DISABLED_SERVER.preHook({
        ...disabledContext,
        toolName: ["metrics", "history", "export"].join("_"),
      }),
    ).toBeNull();
  });

  it("denies SDK tools mapped to a user-disabled server", () => {
    const ctx = makeContext({
      toolName: "web_fetch",
      permissions: {
        ...DEFAULT_PERMISSIONS,
        servers: { playwright: { enabled: false, autoApprove: false } },
      },
    });

    expect(USER_DISABLED_SERVER.preHook(ctx)).toEqual({
      permissionDecision: "deny",
      permissionDecisionReason:
        "Browser Control and Web Browsing is currently disabled by the user.",
      serverName: "Browser Control and Web Browsing",
      kind: "custom-tool",
    });
  });

  it("denies Playwright file upload when file uploads are disabled", () => {
    expect(
      FILE_UPLOAD_DISABLED.preHook(
        makeContext({
          toolName: "playwright-browser_file_upload",
          fileUploadEnabled: false,
        }),
      ),
    ).toEqual({
      permissionDecision: "deny",
      permissionDecisionReason:
        'File uploads are disabled. Enable "Allow agent file uploads" in Settings → Permissions to use this tool.',
    });
    expect(
      FILE_UPLOAD_DISABLED.preHook(
        makeContext({
          toolName: "playwright-browser_file_upload",
          fileUploadEnabled: true,
        }),
      ),
    ).toBeNull();
  });

  describe("SDK filesystem tools gated by filesystem server", () => {
    it.each(["view", "grep", "glob", "edit", "create"])(
      "TENANT_DISABLED_SERVER denies '%s' when tenant disables filesystem",
      (toolName) => {
        const ctx = makeContext({
          toolName,
          tenantPolicy: { get: () => ({ disabledServers: ["filesystem"] }) },
        });
        // serverName is the raw disabledServers entry, not the display name —
        // same shape as the existing web_fetch / playwright test in this file.
        expect(TENANT_DISABLED_SERVER.preHook(ctx)).toEqual({
          permissionDecision: "deny",
          permissionDecisionReason: "filesystem is disabled by your organization's policy.",
          serverName: "filesystem",
          kind: "custom-tool",
        });
      },
    );

    it.each(["view", "grep", "glob", "edit", "create"])(
      "USER_DISABLED_SERVER denies '%s' when user disables filesystem",
      (toolName) => {
        const ctx = makeContext({
          toolName,
          permissions: {
            ...DEFAULT_PERMISSIONS,
            servers: { filesystem: { enabled: false, autoApprove: false } },
          },
        });
        // serverName is CONFIG_KEY_TO_DISPLAY_NAME["filesystem"] = "File System Access"
        expect(USER_DISABLED_SERVER.preHook(ctx)).toEqual({
          permissionDecision: "deny",
          permissionDecisionReason: "File System Access is currently disabled by the user.",
          serverName: "File System Access",
          kind: "custom-tool",
        });
      },
    );

    it.each(["view", "grep", "glob", "edit", "create"])(
      "no denial for '%s' when filesystem server is enabled",
      (toolName) => {
        const ctx = makeContext({
          toolName,
          permissions: {
            ...DEFAULT_PERMISSIONS,
            servers: { filesystem: { enabled: true, autoApprove: false } },
          },
        });
        expect(TENANT_DISABLED_SERVER.preHook(ctx)).toBeNull();
        expect(USER_DISABLED_SERVER.preHook(ctx)).toBeNull();
      },
    );
  });

  describe("local filesystem tools gated by filesystem server", () => {
    it.each(LOCAL_FILE_POLICY_TOOL_NAMES)(
      "TENANT_DISABLED_SERVER denies '%s' when tenant disables filesystem",
      (toolName) => {
        const ctx = makeContext({
          toolName,
          tenantPolicy: { get: () => ({ disabledServers: ["filesystem"] }) },
        });
        expect(TENANT_DISABLED_SERVER.preHook(ctx)).toEqual({
          permissionDecision: "deny",
          permissionDecisionReason: "filesystem is disabled by your organization's policy.",
          serverName: "filesystem",
          kind: "custom-tool",
        });
      },
    );

    it.each(LOCAL_FILE_POLICY_TOOL_NAMES)(
      "USER_DISABLED_SERVER denies '%s' when user disables filesystem",
      (toolName) => {
        const ctx = makeContext({
          toolName,
          permissions: {
            ...DEFAULT_PERMISSIONS,
            servers: { filesystem: { enabled: false, autoApprove: false } },
          },
        });
        expect(USER_DISABLED_SERVER.preHook(ctx)).toEqual({
          permissionDecision: "deny",
          permissionDecisionReason: "File System Access is currently disabled by the user.",
          serverName: "File System Access",
          kind: "custom-tool",
        });
      },
    );

    it.each(LOCAL_FILE_POLICY_TOOL_NAMES)(
      "no denial for '%s' when filesystem server is enabled",
      (toolName) => {
        const ctx = makeContext({
          toolName,
          permissions: {
            ...DEFAULT_PERMISSIONS,
            servers: { filesystem: { enabled: true, autoApprove: false } },
          },
        });
        expect(TENANT_DISABLED_SERVER.preHook(ctx)).toBeNull();
        expect(USER_DISABLED_SERVER.preHook(ctx)).toBeNull();
      },
    );
  });
});
