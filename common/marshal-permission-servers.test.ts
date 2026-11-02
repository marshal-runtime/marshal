import { describe, it, expect } from "vitest";

import {
  PERMISSION_SERVERS,
  DISPLAY_NAME_TO_CONFIG_KEY,
  CONFIG_KEY_TO_DISPLAY_NAME,
  SAFE_COMMAND_CATEGORIES,
  buildDisabledDisplayNameSet,
} from "./marshal-permission-servers";

describe("PERMISSION_SERVERS", () => {
  it("has exactly 3 entries", () => {
    expect(PERMISSION_SERVERS).toHaveLength(3);
  });

  it("contains filesystem, playwright, shell config keys", () => {
    const configKeys = PERMISSION_SERVERS.map((s) => s.configKey);
    expect(configKeys).toEqual(["filesystem", "playwright", "shell"]);
  });

  it("has no duplicate configKeys", () => {
    const configKeys = PERMISSION_SERVERS.map((s) => s.configKey);
    expect(new Set(configKeys).size).toBe(configKeys.length);
  });

  it("has no duplicate displayNames", () => {
    const displayNames = PERMISSION_SERVERS.map((s) => s.displayName);
    expect(new Set(displayNames).size).toBe(displayNames.length);
  });
});

describe("DISPLAY_NAME_TO_CONFIG_KEY", () => {
  it('maps "File System Access" to "filesystem"', () => {
    expect(DISPLAY_NAME_TO_CONFIG_KEY["File System Access"]).toBe("filesystem");
  });

  it('maps "Browser Control and Web Browsing" to "playwright"', () => {
    expect(DISPLAY_NAME_TO_CONFIG_KEY["Browser Control and Web Browsing"]).toBe("playwright");
  });

  it('maps "Shell" to "shell"', () => {
    expect(DISPLAY_NAME_TO_CONFIG_KEY["Shell"]).toBe("shell");
  });
});

describe("CONFIG_KEY_TO_DISPLAY_NAME", () => {
  it('maps "filesystem" to "File System Access"', () => {
    expect(CONFIG_KEY_TO_DISPLAY_NAME["filesystem"]).toBe("File System Access");
  });

  it('maps "playwright" to "Browser Control and Web Browsing"', () => {
    expect(CONFIG_KEY_TO_DISPLAY_NAME["playwright"]).toBe("Browser Control and Web Browsing");
  });

  it('maps "shell" to "Shell"', () => {
    expect(CONFIG_KEY_TO_DISPLAY_NAME["shell"]).toBe("Shell");
  });
});

describe("bidirectional consistency", () => {
  it("CONFIG_KEY_TO_DISPLAY_NAME[DISPLAY_NAME_TO_CONFIG_KEY[displayName]] === displayName for each server", () => {
    for (const server of PERMISSION_SERVERS) {
      const configKey = DISPLAY_NAME_TO_CONFIG_KEY[server.displayName];
      const roundTripped = CONFIG_KEY_TO_DISPLAY_NAME[configKey];
      expect(roundTripped).toBe(server.displayName);
    }
  });
});

describe("SAFE_COMMAND_CATEGORIES", () => {
  it("is a non-empty array", () => {
    expect(SAFE_COMMAND_CATEGORIES.length).toBeGreaterThan(0);
  });

  it("each category has a label and non-empty prefixes", () => {
    for (const category of SAFE_COMMAND_CATEGORIES) {
      expect(typeof category.label).toBe("string");
      expect(category.label.length).toBeGreaterThan(0);
      expect(category.prefixes.length).toBeGreaterThan(0);
    }
  });
});

describe("buildDisabledDisplayNameSet", () => {
  it("derives display names from user-disabled servers", () => {
    const disabled = buildDisabledDisplayNameSet({
      servers: { playwright: { enabled: false }, filesystem: { enabled: true } },
      tenantDisabledServers: undefined,
    });
    expect([...disabled]).toEqual(["Browser Control and Web Browsing"]);
  });

  it("merges tenant-disabled entries given as config keys", () => {
    const disabled = buildDisabledDisplayNameSet({
      servers: undefined,
      tenantDisabledServers: ["shell", "playwright"],
    });
    expect(disabled.has("Shell")).toBe(true);
    expect(disabled.has("Browser Control and Web Browsing")).toBe(true);
  });

  it("merges tenant-disabled entries given as display names", () => {
    // Tenant policy historically accepted both forms.
    const disabled = buildDisabledDisplayNameSet({
      servers: undefined,
      tenantDisabledServers: ["Shell", "Browser Control and Web Browsing"],
    });
    expect(disabled.has("Shell")).toBe(true);
    expect(disabled.has("Browser Control and Web Browsing")).toBe(true);
  });

  it("union of user-disabled and tenant-disabled, deduplicated", () => {
    const disabled = buildDisabledDisplayNameSet({
      servers: { playwright: { enabled: false } },
      tenantDisabledServers: ["playwright", "shell"],
    });
    expect([...disabled].sort()).toEqual(["Browser Control and Web Browsing", "Shell"]);
  });

  it("skips custom server keys without a built-in display mapping", () => {
    // buildSystemMessage only has prompt sections for built-in capabilities,
    // so omitting unknown keys is correct — they have no section to gate.
    const disabled = buildDisabledDisplayNameSet({
      servers: { my_custom_api: { enabled: false } },
      tenantDisabledServers: ["unknown_server"],
    });
    expect(disabled.size).toBe(0);
  });

  it("treats undefined servers and undefined tenant list as empty", () => {
    expect(
      buildDisabledDisplayNameSet({ servers: undefined, tenantDisabledServers: undefined }),
    ).toEqual(new Set());
  });
});
