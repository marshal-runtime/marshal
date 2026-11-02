import { describe, it, expect, vi } from "vitest";

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn<() => boolean>(() => false),
    mkdirSync: vi.fn<() => void>(),
    readFileSync: vi.fn<() => string>(),
    writeFileSync: vi.fn<() => void>(),
    promises: { mkdir: vi.fn<() => Promise<void>>(), writeFile: vi.fn<() => Promise<void>>() },
  },
  existsSync: vi.fn<() => boolean>(() => false),
  mkdirSync: vi.fn<() => void>(),
  readFileSync: vi.fn<() => string>(),
  writeFileSync: vi.fn<() => void>(),
  promises: { mkdir: vi.fn<() => Promise<void>>(), writeFile: vi.fn<() => Promise<void>>() },
}));

vi.mock("./app-paths", () => ({
  getAppDataDir: () => "/tmp/test-settings",
}));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn<() => boolean>(() => true),
    encryptString: vi.fn<(s: string) => Buffer>((s: string) => Buffer.from(`enc:${s}`)),
    decryptString: vi.fn<(b: Buffer) => string>((b: Buffer) => b.toString().replace(/^enc:/, "")),
  },
}));

import { DEFAULT_TOOL_APPROVALS } from "../common/marshal-tool-registry";
import { migrateToolPermissionKeys } from "./migrate-tool-permission-keys";
import {
  sanitizePermissions,
  migratePermissions,
  migrateToolsFromAllow,
  DEFAULT_PERMISSIONS,
} from "./settings-store";

describe("sanitizePermissions", () => {
  it("returns defaults for undefined input", () => {
    expect(sanitizePermissions(undefined)).toEqual(DEFAULT_PERMISSIONS);
  });

  it("seeds DEFAULT_TOOL_APPROVALS (self-tools only) for new installs", () => {
    const result = sanitizePermissions(undefined);
    const tools = result.tools;
    expect(Object.keys(tools).length).toBe(Object.keys(DEFAULT_TOOL_APPROVALS).length);
    // Spot-check a few entries
    expect(tools["tool:recall"]).toBe(true);
    expect(tools["tool:getSettings"]).toBe(true);
    expect(tools["tool:listAutomations"]).toBe(true);
  });

  it("returns defaults for null input", () => {
    expect(sanitizePermissions(null)).toEqual(DEFAULT_PERMISSIONS);
  });

  it("preserves valid config and merges tool defaults", () => {
    const valid = {
      autopilotMode: true,
      autoApproveReadOnly: true,
      allow: ["npm run build", "cat *"],
      tools: {},
      servers: {
        filesystem: { enabled: true, autoApprove: true },
      },
    };
    const result = sanitizePermissions(valid);
    expect(result.autopilotMode).toBe(true);
    expect(result.autoApproveReadOnly).toBe(true);
    expect(result.allow).toEqual(["npm run build", "cat *"]);
    expect(result.servers).toEqual({ filesystem: { enabled: true, autoApprove: true } });
    // Empty user tools → self-tool defaults merged in
    expect(Object.keys(result.tools).length).toBe(Object.keys(DEFAULT_TOOL_APPROVALS).length);
    expect(result.tools["tool:recall"]).toBe(true);
  });

  it("preserves a legacy explicit deny over the canonical default allow", () => {
    const result = sanitizePermissions({
      autoApproveReadOnly: false,
      allow: [],
      servers: {},
      tools: { "tool:marshal_recall": false },
    });

    expect(result.tools["tool:recall"]).toBe(false);
    expect(result.tools).not.toHaveProperty("tool:marshal_recall");
  });

  it("preserves user's explicit false over default true", () => {
    const result = sanitizePermissions({
      autoApproveReadOnly: false,
      allow: [],
      tools: { "tool:listEmails": false },
      servers: {},
    });
    expect(result.tools["tool:listEmails"]).toBe(false);
    expect(result.tools["tool:recall"]).toBe(true);
  });

  it("filters non-string entries from allow list", () => {
    const input = {
      autoApproveReadOnly: false,
      allow: ["npm run build", 42, null, "cat *"],
      servers: {},
    };
    const result = sanitizePermissions(input);
    expect(result.allow).toEqual(["npm run build", "cat *"]);
  });

  it("strips whitespace-only patterns", () => {
    const input = {
      autoApproveReadOnly: false,
      allow: ["npm run build", "  ", ""],
      servers: {},
    };
    const result = sanitizePermissions(input);
    expect(result.allow).toEqual(["npm run build"]);
  });

  it("defaults autoApproveReadOnly to false if not boolean", () => {
    const input = {
      autoApproveReadOnly: "yes" as unknown,
      allow: [],
      servers: {},
    };
    const result = sanitizePermissions(input);
    expect(result.autoApproveReadOnly).toBe(false);
  });

  it("defaults autopilotMode to false if not boolean", () => {
    const result = sanitizePermissions({
      autopilotMode: "yes" as unknown,
      allow: [],
      servers: {},
    });
    expect(result.autopilotMode).toBe(false);
  });

  it("rejects bare * wildcard pattern", () => {
    const input = {
      autoApproveReadOnly: false,
      allow: ["npm run *", "*", "cat *"],
      servers: {},
    };
    const result = sanitizePermissions(input);
    expect(result.allow).toEqual(["npm run *", "cat *"]);
  });

  it("drops malformed server entries", () => {
    const input = {
      autoApproveReadOnly: false,
      allow: [],
      servers: {
        filesystem: { enabled: true, autoApprove: true },
        broken: "not-an-object" as unknown,
        alsobad: { enabled: "yes" } as unknown,
      },
    };
    const result = sanitizePermissions(input);
    expect(result.servers).toEqual({
      filesystem: { enabled: true, autoApprove: true },
    });
  });

  it("coerces null autoApproveReadOnly to false", () => {
    const result = sanitizePermissions({ autoApproveReadOnly: null });
    expect(result.autoApproveReadOnly).toBe(false);
  });

  it("coerces object autoApproveReadOnly to false", () => {
    const result = sanitizePermissions({ autoApproveReadOnly: {} });
    expect(result.autoApproveReadOnly).toBe(false);
  });

  it("coerces null allow to empty array", () => {
    const result = sanitizePermissions({ allow: null });
    expect(result.allow).toEqual([]);
  });

  it("coerces non-array allow to empty array", () => {
    const result = sanitizePermissions({ allow: "not-array" });
    expect(result.allow).toEqual([]);
  });

  it("coerces null servers to empty object", () => {
    const result = sanitizePermissions({ servers: null });
    expect(result.servers).toEqual({});
  });

  it("coerces array servers to empty object", () => {
    const result = sanitizePermissions({ servers: [1, 2, 3] });
    expect(result.servers).toEqual({});
  });

  it("drops server entry missing autoApprove", () => {
    const result = sanitizePermissions({
      servers: { fs: { enabled: true } },
    });
    expect(result.servers).toEqual({});
  });

  it("drops server entry with non-boolean enabled", () => {
    const result = sanitizePermissions({
      servers: { fs: { enabled: "yes", autoApprove: true } },
    });
    expect(result.servers).toEqual({});
  });

  it("ignores autoApproveAll field (migration handled in loadSettingsFromDisk)", () => {
    const result = sanitizePermissions({
      autoApproveAll: true,
      autoApproveReadOnly: false,
      allow: [],
      tools: {},
      servers: {},
    });
    expect(result).not.toHaveProperty("autoApproveAll");
    expect(result.autoApproveReadOnly).toBe(false);
  });

  it("defaults allowModelPermissionsChange to false when absent", () => {
    const result = sanitizePermissions({
      autoApproveReadOnly: false,
      allow: [],
      tools: {},
      servers: {},
    });
    expect(result.allowModelPermissionsChange).toBe(false);
  });

  it("preserves allowModelPermissionsChange: true from disk", () => {
    const result = sanitizePermissions({
      autoApproveReadOnly: false,
      allow: [],
      tools: {},
      servers: {},
      allowModelPermissionsChange: true,
    });
    expect(result.allowModelPermissionsChange).toBe(true);
  });
});

describe("migratePermissions", () => {
  it("returns null if permissions already exists", () => {
    const settings = {
      permissions: { autoApproveReadOnly: false, allow: [], servers: {} },
      autoApprove: { global: false, perServer: {} },
    };
    expect(migratePermissions(settings as Record<string, unknown>)).toBeNull();
  });

  it("migrates global auto-approve", () => {
    const settings = {
      autoApprove: { global: true, perServer: {} },
    };
    const result = migratePermissions(settings as Record<string, unknown>)!;
    expect(result.servers.filesystem.autoApprove).toBe(true);
    expect(result.servers.playwright.autoApprove).toBe(true);
    expect(result.servers.shell.autoApprove).toBe(true);
  });

  it("migrates per-server permissions with display name to config key mapping", () => {
    const settings = {
      autoApprove: {
        global: false,
        perServer: {
          Shell: { shell: true },
          "File System Access": { write: true },
        },
      },
    };
    const result = migratePermissions(settings as Record<string, unknown>)!;
    expect(result.servers.shell.autoApprove).toBe(true);
    expect(result.servers.filesystem.autoApprove).toBe(true);
    // Browser Control stays enabled but no longer auto-approves by default.
    expect(result.servers.playwright.autoApprove).toBe(false);
  });

  it("provides complete defaults for fresh install (no old keys)", () => {
    const settings = {};
    const result = migratePermissions(settings as Record<string, unknown>)!;
    expect(result.servers).toEqual(DEFAULT_PERMISSIONS.servers);
    expect(result.autoApproveReadOnly).toBe(false);
    expect(result.allow).toEqual([]);
    expect(result.tools).toEqual({}); // migration doesn't add tool defaults
  });

  it("does not crash when autoApprove is null", () => {
    const settings = {
      autoApprove: null,
    };
    const result = migratePermissions(settings as Record<string, unknown>)!;
    expect(result).toBeDefined();
    expect(result.servers).toEqual(DEFAULT_PERMISSIONS.servers);
  });

  it("skips perServer entries whose display name is not in DISPLAY_NAME_TO_CONFIG_KEY", () => {
    const settings = {
      autoApprove: {
        global: false,
        perServer: {
          "Unknown Service": { read: true },
        },
      },
    };
    const result = migratePermissions(settings as Record<string, unknown>)!;
    // Unknown service should be silently skipped, defaults preserved
    expect(result.servers).toEqual(DEFAULT_PERMISSIONS.servers);
  });
});

describe("migrateToolsFromAllow", () => {
  const base = {
    autoApproveReadOnly: false,
    tools: {},
    servers: {},
  } as const;

  it("moves tool: patterns from allow to tools", () => {
    const result = migrateToolsFromAllow({
      ...base,
      allow: ["npm run *", "tool:listEmails", "cat *"],
    });
    expect(result.allow).toEqual(["npm run *", "cat *"]);
    expect(result.tools).toEqual({ "tool:listEmails": true });
  });

  it("moves mcp: patterns from allow to tools", () => {
    const result = migrateToolsFromAllow({
      ...base,
      allow: ["mcp:filesystem:read_file", "ls -la"],
    });
    expect(result.allow).toEqual(["ls -la"]);
    expect(result.tools).toEqual({ "mcp:filesystem:read_file": true });
  });

  it("converts mcp:server:* wildcards to group keys", () => {
    const result = migrateToolsFromAllow({ ...base, allow: ["mcp:filesystem:*"] });
    expect(result.allow).toEqual([]);
    expect(result.tools).toEqual({ "mcp:filesystem": true });
  });

  it("preserves existing tools entries", () => {
    const result = migrateToolsFromAllow({
      ...base,
      allow: ["tool:sendEmail"],
      tools: { "tool:listEmails": true },
    });
    expect(result.tools).toEqual({
      "tool:listEmails": true,
      "tool:sendEmail": true,
    });
  });

  it("no-ops when allow has only shell patterns", () => {
    const result = migrateToolsFromAllow({ ...base, allow: ["npm run *", "cat *"] });
    expect(result.allow).toEqual(["npm run *", "cat *"]);
    expect(result.tools).toEqual({});
  });

  it("does not overwrite explicit false in tools during migration", () => {
    const result = migrateToolsFromAllow({
      ...base,
      allow: ["tool:listEmails"],
      tools: { "tool:listEmails": false },
    });
    expect(result.tools["tool:listEmails"]).toBe(false);
    expect(result.allow).toEqual([]);
  });

  it("is idempotent — running twice on migrated data is a no-op", () => {
    const first = migrateToolsFromAllow({
      ...base,
      allow: ["npm run *", "tool:sendEmail", "mcp:filesystem:read_file"],
      tools: { "tool:recall": true },
    });
    const second = migrateToolsFromAllow(first);
    expect(second).toEqual(first);
  });
});

describe("migrateToolPermissionKeys", () => {
  const base = {
    autoApproveReadOnly: false,
    allow: [] as string[],
    servers: {},
  };

  it("rewrites repo-era and host-era keys everywhere", () => {
    const { perms, changed } = migrateToolPermissionKeys({
      ...base,
      tools: {
        "tool:marshal_recall": false,
        "tool:m_get_settings": true,
        "tool:marshal_memory": true,
        "mcp:filesystem:read_file": true,
      },
      previousTools: {
        "tool:m_memory": {
          "tool:m_remember": true,
          "tool:marshal_forget": false,
        },
      },
    });

    expect(changed).toBe(true);
    expect(perms.tools).toEqual({
      "tool:recall": false,
      "tool:getSettings": true,
      "tool:memory": true,
      "mcp:filesystem:read_file": true,
    });
    expect(perms.previousTools).toEqual({
      "tool:memory": {
        "tool:remember": true,
        "tool:forget": false,
      },
    });
  });

  it("is a no-op (changed=false) when no legacy keys are present", () => {
    const input = {
      ...base,
      tools: { "tool:getSettings": true, "tool:recall": true },
    };
    const { perms, changed } = migrateToolPermissionKeys(input);
    expect(changed).toBe(false);
    expect(perms).toBe(input); // returns the same object — caller skips persist
  });

  it("prefers canonical values, then repo-era values, independent of insertion order", () => {
    const { perms } = migrateToolPermissionKeys({
      ...base,
      tools: {
        "tool:m_recall": true,
        "tool:marshal_recall": false,
        "tool:recall": true,
        "tool:m_get_settings": true,
        "tool:marshal_get_settings": false,
      },
    });
    expect(perms.tools["tool:recall"]).toBe(true);
    expect(perms.tools["tool:getSettings"]).toBe(false);
  });

  it("rewrites and deduplicates allow entries", () => {
    const { perms, changed } = migrateToolPermissionKeys({
      ...base,
      allow: ["tool:m_recall", "tool:recall", "tool:marshal_get_settings", "npm run *"],
      tools: {},
    });
    expect(changed).toBe(true);
    expect(perms.allow).toEqual(["tool:recall", "tool:getSettings", "npm run *"]);
  });

  it("expands legacy wildcard permissions into canonical exact keys", () => {
    const { perms, changed } = migrateToolPermissionKeys({
      ...base,
      allow: ["tool:marshal_*"],
      tools: {},
    });
    expect(changed).toBe(true);
    expect(perms.allow).toContain("tool:recall");
    expect(perms.allow).toContain("tool:getSettings");
    expect(perms.allow).toContain("tool:memory");
    expect(perms.allow).toContain("tool:marshal_*");
  });

  it("does not let a legacy wildcard override an explicit canonical deny", () => {
    const { perms } = migrateToolPermissionKeys({
      ...base,
      allow: [],
      tools: {
        "tool:marshal_*": true,
        "tool:recall": false,
      },
    });
    expect(perms.tools["tool:recall"]).toBe(false);
    expect(perms.tools["tool:getSettings"]).toBe(true);
  });

  it("preserves repo-era wildcard precedence over host-era aliases", () => {
    const { perms } = migrateToolPermissionKeys({
      ...base,
      allow: [],
      tools: {
        "tool:m_get_*": false,
        "tool:marshal_get_*": true,
      },
    });
    expect(perms.tools["tool:getSettings"]).toBe(true);
    expect(perms.tools["tool:getSkill"]).toBe(true);
  });

  it("is idempotent after preserving a legacy wildcard for external coverage", () => {
    const first = migrateToolPermissionKeys({
      ...base,
      allow: ["tool:marshal_*"],
      tools: {},
    });
    const second = migrateToolPermissionKeys(first.perms);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.perms).toBe(first.perms);
  });

  it("preserves unmatched external wildcard patterns", () => {
    const input = {
      ...base,
      allow: ["tool:m_custom_sdk_*"],
      tools: { "tool:m_custom_sdk_*": false },
    };
    const { perms, changed } = migrateToolPermissionKeys(input);
    expect(changed).toBe(false);
    expect(perms).toBe(input);
  });

  it("prefers a canonical previousTools group snapshot", () => {
    const { perms } = migrateToolPermissionKeys({
      ...base,
      tools: {},
      previousTools: {
        "tool:m_memory": { "tool:m_remember": false },
        "tool:marshal_memory": { "tool:marshal_remember": false },
        "tool:memory": { "tool:remember": true },
      },
    });
    expect(perms.previousTools).toEqual({
      "tool:memory": { "tool:remember": true },
    });
  });

  it("drops retired heartbeat and workflow-install permission keys", () => {
    const { perms, changed } = migrateToolPermissionKeys({
      ...base,
      allow: [
        "tool:marshal_get_heartbeat_status",
        "tool:m_workflow_install",
        "tool:marshal_*heartbeat*",
      ],
      tools: {
        "tool:marshal_run_heartbeat_now": false,
        "tool:marshal_workflow_install_local": true,
      },
      previousTools: {
        "tool:marshal_heartbeat": {
          "tool:marshal_set_heartbeat_settings": false,
        },
      },
    });
    expect(changed).toBe(true);
    expect(perms.allow).toEqual([]);
    expect(perms.tools).toEqual({});
    expect(perms.previousTools).toEqual({});
  });
});
