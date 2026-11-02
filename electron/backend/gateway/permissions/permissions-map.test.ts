import { describe, expect, it } from "vitest";

import {
  extractPermissionsFromConfig,
  mapPermissionsToMarshalPatch,
  TOOLS_CONFIG_PATH,
  wrapPermissionsPatchAtConfigPath,
} from "./permissions-map";

const FULL_CONFIG_RESPONSE = {
  config: {
    tools: {
      alsoAllow: ["mcp:fs:read"],
      deny: ["mcp:fs:write"],
      exec: { ask: "on-miss", security: "allowlist", safeBins: ["git", "gh"] },
    },
  },
  hash: "abc123",
};

describe("extractPermissionsFromConfig", () => {
  it("maps a full marshal config to a PermissionsEnvelope shape", () => {
    const result = extractPermissionsFromConfig(FULL_CONFIG_RESPONSE);
    expect(result.permissions.tools).toEqual({
      "mcp:fs:read": true,
      "mcp:fs:write": false,
    });
    expect(result.permissions.autopilotMode).toBe(false);
    expect(result.permissions.autoApproveReadOnly).toBe(true);
    expect(result.permissions.allow).toEqual(["git", "gh"]);
    expect(result.permissions.denyPatterns).toEqual([]);
    expect(result.permissions.servers).toEqual({});
    expect(result.hasUnrepresentablePatterns).toBe(false);
    expect(result.baseHash).toBe("abc123");
  });

  it("flags hasUnrepresentablePatterns when marshal has globs", () => {
    const result = extractPermissionsFromConfig({
      config: { tools: { alsoAllow: ["mcp:fs:*"] } },
      hash: "h",
    });
    expect(result.hasUnrepresentablePatterns).toBe(true);
  });

  it("returns default-shaped permissions when config is empty", () => {
    const result = extractPermissionsFromConfig({ config: {}, hash: "h" });
    expect(result.permissions.tools).toEqual({});
    expect(result.permissions.autoApproveReadOnly).toBe(false);
    expect(result.permissions.allow).toEqual([]);
  });

  it("migrates legacy tool keys with canonical collision precedence", () => {
    const result = extractPermissionsFromConfig({
      config: {
        tools: {
          allow: [["tool:m", "get", "settings"].join("_")],
          alsoAllow: ["tool:marshal_create_skill"],
          deny: ["tool:m_create_skill", "tool:createSkill"],
        },
      },
      hash: "h",
    });

    expect(result.permissions.tools).toEqual({
      "tool:getSettings": true,
      "tool:createSkill": false,
    });
    expect(result.rawAllow).toEqual(["tool:getSettings"]);
    expect(result.migratedToolPolicy).toEqual({
      allow: ["tool:getSettings"],
      alsoAllow: [],
      deny: ["tool:createSkill"],
    });
    expect(result.migrationChanged).toBe(true);
  });
});

describe("mapPermissionsToMarshalPatch", () => {
  it("translates a tools-only patch to an marshal subtree patch", () => {
    const patch = mapPermissionsToMarshalPatch(
      { tools: { foo: true, bar: false } },
      { tools: {}, exec: {} },
    );
    expect(patch).toEqual({
      tools: {
        alsoAllow: ["foo"],
        deny: ["bar"],
      },
    });
  });

  it("translates autoApproveReadOnly into tools.exec subtree", () => {
    const patch = mapPermissionsToMarshalPatch(
      { autoApproveReadOnly: true },
      { tools: {}, exec: {} },
    );
    expect(patch.tools?.exec).toEqual({ ask: "on-miss", security: "allowlist" });
  });

  it("translates shell allow[] into tools.exec.safeBins (binary subset)", () => {
    const result = mapPermissionsToMarshalPatch(
      { allow: ["git", "gh api repos/*"] },
      { tools: {}, exec: {} },
    );
    expect(result.tools?.exec?.safeBins).toEqual(["git"]);
    expect(result.rejectedShellPatterns).toEqual(["gh api repos/*"]);
  });

  it("drops fields that have no marshal equivalent", () => {
    const patch = mapPermissionsToMarshalPatch(
      {
        denyPatterns: ["rm -rf /"],
        autopilotMode: true,
        servers: { fs: { enabled: false, autoApprove: false } },
      },
      { tools: {}, exec: {} },
    );
    expect(patch.tools).toBeUndefined();
  });
});

describe("wrapPermissionsPatchAtConfigPath", () => {
  it("wraps a tools-subtree patch under the root tools key", () => {
    expect(wrapPermissionsPatchAtConfigPath({ alsoAllow: ["foo"] })).toEqual({
      tools: { alsoAllow: ["foo"] },
    });
  });
});

describe("TOOLS_CONFIG_PATH", () => {
  it("is the constant ['tools']", () => {
    expect(TOOLS_CONFIG_PATH).toEqual(["tools"]);
  });
});

describe("round-trip", () => {
  it("extract → patch → simulate config response → extract preserves representable fields", () => {
    const original = {
      autoApproveReadOnly: true,
      allow: ["git"],
      tools: { foo: true, bar: false },
    };

    const writePatch = mapPermissionsToMarshalPatch(original, { tools: {}, exec: {} });

    // Simulate marshal applying the patch as a fresh config response:
    const simulatedResponse = {
      config: {
        tools: {
          ...(writePatch.tools ?? {}),
        },
      },
      hash: "h2",
    };
    const { permissions } = extractPermissionsFromConfig(simulatedResponse);

    expect(permissions.autoApproveReadOnly).toBe(true);
    expect(permissions.allow).toEqual(["git"]);
    expect(permissions.tools).toEqual({ foo: true, bar: false });
  });
});
