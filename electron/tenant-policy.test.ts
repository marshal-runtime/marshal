import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist mock variables so they're available inside vi.mock() factories
const mockExistsSync = vi.hoisted(() => vi.fn<(path: string) => boolean>());
const mockReadFileSync = vi.hoisted(() => vi.fn<(path: string) => string>());
const mockExecFileSync = vi.hoisted(() => vi.fn<(...args: unknown[]) => string>());

vi.mock("node:fs", () => ({
  default: { existsSync: mockExistsSync, readFileSync: mockReadFileSync },
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}));

vi.mock("node:child_process", () => ({
  execFileSync: mockExecFileSync,
}));

import {
  TenantPolicyProvider,
  readRegistryPolicy,
  readManagedPrefsPolicy,
  readLinuxSystemPolicy,
  isToolDisabledByTenant,
} from "./tenant-policy";

/** Extract the registry/defaults value-name from mock execFileSync args. */
function extractValueName(params: unknown[], index: number): string {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- mock arg extraction in tests
  return (params[1] as string[])[index];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TenantPolicyProvider", () => {
  describe("load", () => {
    it("returns empty policy when file does not exist", () => {
      mockExistsSync.mockReturnValue(false);
      const provider = new TenantPolicyProvider("/fake/dir");
      expect(provider.get()).toEqual({});
    });

    it("returns parsed policy from valid JSON file", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          version: 1,
          disabledServers: ["filesystem"],
          forcePrompt: true,
        }),
      );
      const provider = new TenantPolicyProvider("/fake/dir");
      expect(provider.get()).toEqual({
        version: 1,
        disabledServers: ["filesystem"],
        forcePrompt: true,
      });
    });

    it("returns empty policy when file contains malformed JSON", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("{not valid json!!!");
      const provider = new TenantPolicyProvider("/fake/dir");
      expect(provider.get()).toEqual({});
    });

    it("ignores unknown fields (forward compatibility)", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          version: 1,
          forcePrompt: true,
          futureFeature: "should be dropped",
          nestedFuture: { a: 1 },
        }),
      );
      const provider = new TenantPolicyProvider("/fake/dir");
      const policy = provider.get();
      expect(policy.forcePrompt).toBe(true);
      expect(policy).not.toHaveProperty("futureFeature");
      expect(policy).not.toHaveProperty("nestedFuture");
    });

    it("handles partial policy (only some fields set)", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ forcePrompt: true }));
      const provider = new TenantPolicyProvider("/fake/dir");
      const policy = provider.get();
      expect(policy.forcePrompt).toBe(true);
      expect(policy.disabledServers).toBeUndefined();
      expect(policy.disabledPermissionKinds).toBeUndefined();
    });
  });

  describe("get", () => {
    it("returns cached policy without re-reading file", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ forcePrompt: true }));
      const provider = new TenantPolicyProvider("/fake/dir");
      // Multiple get() calls should NOT trigger additional file reads
      provider.get();
      provider.get();
      expect(mockReadFileSync).toHaveBeenCalledTimes(1);
    });
  });

  describe("schema validation", () => {
    it("disabledServers defaults to undefined when absent", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ version: 1 }));
      const provider = new TenantPolicyProvider("/fake/dir");
      expect(provider.get().disabledServers).toBeUndefined();
    });

    it("disabledPermissionKinds filters to valid kinds only (strips read and unknown)", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          disabledPermissionKinds: ["shell", "invalid-kind", "write", "read", 42],
        }),
      );
      const provider = new TenantPolicyProvider("/fake/dir");
      // "read" is excluded — blocking reads makes the app non-functional
      expect(provider.get().disabledPermissionKinds).toEqual(["shell", "write"]);
    });

    it("forcePrompt defaults to undefined when absent", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ disabledServers: [] }));
      const provider = new TenantPolicyProvider("/fake/dir");
      expect(provider.get().forcePrompt).toBeUndefined();
    });

    it("disabledServers filters out non-string entries", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          disabledServers: ["ExampleMcp", 42, null, "filesystem"],
        }),
      );
      const provider = new TenantPolicyProvider("/fake/dir");
      expect(provider.get().disabledServers).toEqual(["ExampleMcp", "filesystem"]);
    });

    it("browserEgressBlockedOrigins defaults to undefined when absent", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ version: 1 }));
      const provider = new TenantPolicyProvider("/fake/dir");
      expect(provider.get().browserEgressBlockedOrigins).toBeUndefined();
    });

    it("browserEgressBlockedOrigins passes through string entries", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ browserEgressBlockedOrigins: ["https://evil.com", "https://bad.org"] }),
      );
      const provider = new TenantPolicyProvider("/fake/dir");
      expect(provider.get().browserEgressBlockedOrigins).toEqual([
        "https://evil.com",
        "https://bad.org",
      ]);
    });

    it("browserEgressBlockedOrigins filters out non-string entries", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ browserEgressBlockedOrigins: ["https://evil.com", 42, null, true] }),
      );
      const provider = new TenantPolicyProvider("/fake/dir");
      expect(provider.get().browserEgressBlockedOrigins).toEqual(["https://evil.com"]);
    });

    it("browserEgressBlockedOrigins filters out non-origin values (URL-parser validation)", () => {
      mockExistsSync.mockReturnValue(true);
      // oxlint-disable-next-line no-script-url -- intentional test input verifying that non-http(s) URLs are rejected
      const malformed = ["javascript:void", "https://", "bare-host", "https://evil.com/with-path"];
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ browserEgressBlockedOrigins: ["https://evil.com", ...malformed] }),
      );
      const provider = new TenantPolicyProvider("/fake/dir");
      expect(provider.get().browserEgressBlockedOrigins).toEqual(["https://evil.com"]);
    });
  });
});

// ── Phase 2 tests ──────────────────────────────────────────────────────────

describe("readRegistryPolicy", () => {
  it("queries SOFTWARE\\Policies\\Marshal (not the old Marshal path)", () => {
    mockExecFileSync.mockImplementation((...params: unknown[]) => {
      // extractValueName(params, 1) pulls the registry key arg from ['reg', 'query', KEY, '/v', name]
      const regKey = extractValueName(params, 1);
      expect(regKey).toContain("SOFTWARE\\Policies\\Marshal");
      expect(regKey).not.toContain("Marshal");
      return "    PolicyVersion    REG_DWORD    0x1\r\n\r\n";
    });
    readRegistryPolicy("win32");
  });

  it("returns null when not on Windows", () => {
    expect(readRegistryPolicy("darwin")).toBeNull();
    expect(readRegistryPolicy("linux")).toBeNull();
  });

  it("returns null when registry key does not exist (reg query fails)", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("The system was unable to find the specified registry key or value.");
    });
    expect(readRegistryPolicy("win32")).toBeNull();
  });

  it("parses policy from registry REG_SZ values (legacy JSON blob fallback)", () => {
    // Individual value queries throw (no individual values set)
    // Legacy blob query succeeds
    mockExecFileSync.mockImplementation((...params: unknown[]) => {
      const valueName = extractValueName(params, 3);
      if (valueName === "TenantPolicy") {
        return (
          "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Marshal\r\n" +
          '    TenantPolicy    REG_SZ    {"forcePrompt":true,"disabledServers":["ExampleMcp"]}\r\n\r\n'
        );
      }
      throw new Error("not found");
    });
    const policy = readRegistryPolicy("win32");
    expect(policy).toEqual({ forcePrompt: true, disabledServers: ["ExampleMcp"] });
  });

  it("parses policy from individual registry values (Intune-compatible)", () => {
    mockExecFileSync.mockImplementation((...params: unknown[]) => {
      const valueName = extractValueName(params, 3);
      if (valueName === "ForcePrompt") {
        return "    ForcePrompt    REG_DWORD    0x1\r\n";
      }
      if (valueName === "DisabledServers") {
        return "    DisabledServers    REG_SZ    ExampleMcp,filesystem\r\n";
      }
      if (valueName === "PolicyVersion") {
        return "    PolicyVersion    REG_DWORD    0x2\r\n";
      }
      throw new Error("not found");
    });
    const policy = readRegistryPolicy("win32");
    expect(policy).toEqual({
      version: 2,
      forcePrompt: true,
      disabledServers: ["ExampleMcp", "filesystem"],
    });
  });

  it("returns null when registry value contains invalid JSON", () => {
    mockExecFileSync.mockImplementation((...params: unknown[]) => {
      const valueName = extractValueName(params, 3);
      if (valueName === "TenantPolicy") {
        return (
          "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Marshal\r\n" +
          "    TenantPolicy    REG_SZ    {not valid json}\r\n\r\n"
        );
      }
      throw new Error("not found");
    });
    expect(readRegistryPolicy("win32")).toBeNull();
  });

  it("sanitizes registry policy through the same sanitizer as file policy", () => {
    mockExecFileSync.mockImplementation((...params: unknown[]) => {
      const valueName = extractValueName(params, 3);
      if (valueName === "TenantPolicy") {
        return (
          "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Marshal\r\n" +
          '    TenantPolicy    REG_SZ    {"disabledPermissionKinds":["shell","read","invalid"],"futureField":true}\r\n\r\n'
        );
      }
      throw new Error("not found");
    });
    const policy = readRegistryPolicy("win32");
    // "read" and "invalid" stripped, "futureField" dropped
    expect(policy?.disabledPermissionKinds).toEqual(["shell"]);
    expect(policy).not.toHaveProperty("futureField");
  });

  it("BrowserEgressBlockedOrigins individual registry value is parsed as comma-separated strings", () => {
    mockExecFileSync.mockImplementation((...params: unknown[]) => {
      const valueName = extractValueName(params, 3);
      if (valueName === "BrowserEgressBlockedOrigins") {
        return "    BrowserEgressBlockedOrigins    REG_SZ    https://evil.com,https://bad.org\r\n";
      }
      throw new Error("not found");
    });
    const policy = readRegistryPolicy("win32");
    expect(policy?.browserEgressBlockedOrigins).toEqual(["https://evil.com", "https://bad.org"]);
  });

  it("BrowserEgressBlockedOrigins individual registry value sets hasIndividualValues", () => {
    mockExecFileSync.mockImplementation((...params: unknown[]) => {
      const valueName = extractValueName(params, 3);
      if (valueName === "BrowserEgressBlockedOrigins") {
        return "    BrowserEgressBlockedOrigins    REG_SZ    https://evil.com\r\n";
      }
      throw new Error("not found");
    });
    // Should return non-null even without other individual values present
    expect(readRegistryPolicy("win32")).not.toBeNull();
    expect(readRegistryPolicy("win32")?.browserEgressBlockedOrigins).toEqual(["https://evil.com"]);
  });
});

describe("readManagedPrefsPolicy", () => {
  it("returns null when not on macOS", () => {
    expect(readManagedPrefsPolicy("win32")).toBeNull();
    expect(readManagedPrefsPolicy("linux")).toBeNull();
  });

  it("returns null when defaults domain has no policy (defaults read fails)", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("The domain/default pair of (com.marshal, TenantPolicy) does not exist");
    });
    expect(readManagedPrefsPolicy("darwin")).toBeNull();
  });

  it("parses policy from defaults read output (legacy JSON blob fallback)", () => {
    // Plist file exists; individual key queries throw; legacy blob query succeeds
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockImplementation((...params: unknown[]) => {
      const key = extractValueName(params, 2);
      if (key === "TenantPolicy") {
        return '{"forcePrompt":true,"disabledServers":["filesystem"]}';
      }
      throw new Error("not found");
    });
    const policy = readManagedPrefsPolicy("darwin");
    expect(policy).toEqual({ forcePrompt: true, disabledServers: ["filesystem"] });
  });

  it("parses policy from individual managed preference keys", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockImplementation((...params: unknown[]) => {
      const key = extractValueName(params, 2);
      if (key === "ForcePrompt") return "1";
      if (key === "DisabledServers") return "filesystem";
      throw new Error("not found");
    });
    const policy = readManagedPrefsPolicy("darwin");
    expect(policy).toEqual({ forcePrompt: true, disabledServers: ["filesystem"] });
  });

  it("returns null when defaults output is invalid JSON", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockImplementation((...params: unknown[]) => {
      const key = extractValueName(params, 2);
      if (key === "TenantPolicy") return "not json at all";
      throw new Error("not found");
    });
    expect(readManagedPrefsPolicy("darwin")).toBeNull();
  });

  it("sanitizes managed prefs policy", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockImplementation((...params: unknown[]) => {
      const key = extractValueName(params, 2);
      if (key === "TenantPolicy") {
        return '{"disabledPermissionKinds":["shell","read"],"unknownField":42}';
      }
      throw new Error("not found");
    });
    const policy = readManagedPrefsPolicy("darwin");
    expect(policy?.disabledPermissionKinds).toEqual(["shell"]);
    expect(policy).not.toHaveProperty("unknownField");
  });

  it("user pref path is never consulted — defaults write cannot bypass policy", () => {
    // No managed pref plist exists (existsSync returns false) → null, even if
    // `defaults read <domain>` would have succeeded via user prefs.
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => "1"); // would succeed if domain was used
    expect(readManagedPrefsPolicy("darwin")).toBeNull();
  });

  it("BrowserEgressBlockedOrigins managed pref is parsed as comma-separated strings", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockImplementation((...params: unknown[]) => {
      const key = extractValueName(params, 2);
      if (key === "BrowserEgressBlockedOrigins") return "https://evil.com";
      throw new Error("not found");
    });
    const policy = readManagedPrefsPolicy("darwin");
    expect(policy?.browserEgressBlockedOrigins).toEqual(["https://evil.com"]);
  });
});

describe("TenantPolicyProvider multi-source loading", () => {
  it("uses registry policy and ignores file on Windows (trust boundary)", () => {
    // File has version + forcePrompt:false — should be completely ignored
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: 1, forcePrompt: false }));
    // Registry has only forcePrompt:true (via legacy JSON blob)
    mockExecFileSync.mockImplementation((...params: unknown[]) => {
      const valueName = extractValueName(params, 3);
      if (valueName === "TenantPolicy") {
        return (
          "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Marshal\r\n" +
          '    TenantPolicy    REG_SZ    {"forcePrompt":true}\r\n\r\n'
        );
      }
      throw new Error("not found");
    });

    const provider = new TenantPolicyProvider("/fake/dir", "win32");
    expect(provider.get().forcePrompt).toBe(true);
    // version from file must NOT leak through — managed source is authoritative
    expect(provider.get().version).toBeUndefined();
  });

  it("uses managed prefs policy and ignores file on macOS (trust boundary)", () => {
    // File has version + disabledServers
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ version: 1, disabledServers: ["filesystem"] }),
    );
    // MDM prefs have different disabledServers (via legacy JSON blob)
    mockExecFileSync.mockImplementation((...params: unknown[]) => {
      const key = extractValueName(params, 2);
      if (key === "TenantPolicy") {
        return '{"disabledServers":["ExampleMcp"],"forcePrompt":true}';
      }
      throw new Error("not found");
    });

    const provider = new TenantPolicyProvider("/fake/dir", "darwin");
    expect(provider.get().disabledServers).toEqual(["ExampleMcp"]);
    expect(provider.get().forcePrompt).toBe(true);
    // version from file must NOT leak through
    expect(provider.get().version).toBeUndefined();
  });

  it("file policy cannot inject fields when managed source exists (security invariant)", () => {
    // Admin deploys only disabledServers via GPO (legacy JSON blob)
    mockExecFileSync.mockImplementation((...params: unknown[]) => {
      const valueName = extractValueName(params, 3);
      if (valueName === "TenantPolicy") {
        return (
          "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Marshal\r\n" +
          '    TenantPolicy    REG_SZ    {"disabledServers":["ExampleMcp"]}\r\n\r\n'
        );
      }
      throw new Error("not found");
    });
    // User puts forcePrompt:false in their file — must not take effect
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ forcePrompt: false }));

    const provider = new TenantPolicyProvider("/fake/dir", "win32");
    expect(provider.get().disabledServers).toEqual(["ExampleMcp"]);
    expect(provider.get().forcePrompt).toBeUndefined();
    // File should not even be read when managed source exists
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it("falls back to file when registry/prefs reader returns null", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ forcePrompt: true }));
    // Registry fails
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const provider = new TenantPolicyProvider("/fake/dir", "win32");
    expect(provider.get().forcePrompt).toBe(true);
  });

  it("uses only registry when file is missing", () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation((...params: unknown[]) => {
      const valueName = extractValueName(params, 3);
      if (valueName === "TenantPolicy") {
        return (
          "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Marshal\r\n" +
          '    TenantPolicy    REG_SZ    {"disabledServers":["ExampleMcp"]}\r\n\r\n'
        );
      }
      throw new Error("not found");
    });

    const provider = new TenantPolicyProvider("/fake/dir", "win32");
    expect(provider.get().disabledServers).toEqual(["ExampleMcp"]);
  });

  it("isTenantManaged returns false when no sources provide policy", () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const provider = new TenantPolicyProvider("/fake/dir", "win32");
    expect(provider.isTenantManaged()).toBe(false);
  });

  it("isTenantManaged returns true when file provides policy", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ forcePrompt: true }));
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const provider = new TenantPolicyProvider("/fake/dir", "win32");
    expect(provider.isTenantManaged()).toBe(true);
  });

  it("isTenantManaged returns true when only registry provides policy", () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation((...params: unknown[]) => {
      const valueName = extractValueName(params, 3);
      if (valueName === "TenantPolicy") {
        return (
          "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Marshal\r\n" +
          '    TenantPolicy    REG_SZ    {"disabledServers":["ExampleMcp"]}\r\n\r\n'
        );
      }
      throw new Error("not found");
    });

    const provider = new TenantPolicyProvider("/fake/dir", "win32");
    expect(provider.isTenantManaged()).toBe(true);
  });

  it("on linux, uses system policy path and ignores user file (trust boundary)", () => {
    // System policy file exists
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ forcePrompt: true }));

    const provider = new TenantPolicyProvider("/fake/dir", "linux");
    expect(provider.get().forcePrompt).toBe(true);
    // execFileSync should NOT be called on linux
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});

describe("readLinuxSystemPolicy", () => {
  it("returns null when not on Linux", () => {
    expect(readLinuxSystemPolicy("win32")).toBeNull();
    expect(readLinuxSystemPolicy("darwin")).toBeNull();
  });

  it("returns null when system policy file does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(readLinuxSystemPolicy("linux")).toBeNull();
  });

  it("parses policy from system policy file", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ forcePrompt: true, disabledServers: ["filesystem"] }),
    );
    const policy = readLinuxSystemPolicy("linux");
    expect(policy).toEqual({ forcePrompt: true, disabledServers: ["filesystem"] });
  });

  it("returns null when system policy file contains invalid JSON", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("not valid json");
    expect(readLinuxSystemPolicy("linux")).toBeNull();
  });
});

// ── Phase 3 tests ──────────────────────────────────────────────────────────

describe("sanitize — Phase 3 fields", () => {
  it("disabledModels filters out non-string entries", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        disabledModels: ["o3-mini", 42, null, "gpt-5"],
      }),
    );
    const provider = new TenantPolicyProvider("/fake/dir", "linux");
    expect(provider.get().disabledModels).toEqual(["o3-mini", "gpt-5"]);
  });

  it("disabledModels defaults to undefined when absent", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ forcePrompt: true }));
    const provider = new TenantPolicyProvider("/fake/dir", "linux");
    expect(provider.get().disabledModels).toBeUndefined();
  });

  it("disabledModels accepts empty array", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ disabledModels: [] }));
    const provider = new TenantPolicyProvider("/fake/dir", "linux");
    expect(provider.get().disabledModels).toEqual([]);
  });

  it("disableHeartbeat accepts boolean true", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ disableHeartbeat: true }));
    const provider = new TenantPolicyProvider("/fake/dir", "linux");
    expect(provider.get().disableHeartbeat).toBe(true);
  });

  it("disableHeartbeat ignores non-boolean values", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ disableHeartbeat: "yes" }));
    const provider = new TenantPolicyProvider("/fake/dir", "linux");
    expect(provider.get().disableHeartbeat).toBeUndefined();
  });

  it("disableWorkflows accepts boolean true", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ disableWorkflows: true }));
    const provider = new TenantPolicyProvider("/fake/dir", "linux");
    expect(provider.get().disableAutomations).toBe(true);
  });

  it("disableWorkflows ignores non-boolean values", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ disableWorkflows: 1 }));
    const provider = new TenantPolicyProvider("/fake/dir", "linux");
    expect(provider.get().disableAutomations).toBeUndefined();
  });

  it("all Phase 3 fields are preserved through registry policy", () => {
    mockExecFileSync.mockImplementation((...params: unknown[]) => {
      const valueName = extractValueName(params, 3);
      if (valueName === "TenantPolicy") {
        return (
          "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Marshal\r\n" +
          '    TenantPolicy    REG_SZ    {"disabledModels":["o3-mini"],"disableHeartbeat":true,"disableWorkflows":false}\r\n\r\n'
        );
      }
      throw new Error("not found");
    });
    const provider = new TenantPolicyProvider("/fake/dir", "win32");
    const policy = provider.get();
    expect(policy.disabledModels).toEqual(["o3-mini"]);
    expect(policy.disableHeartbeat).toBe(true);
    expect(policy.disableAutomations).toBe(false);
  });
});

describe("isToolDisabledByTenant", () => {
  it("returns null when policy is null (provider not wired)", () => {
    expect(isToolDisabledByTenant(null, "filesystem__read_file")).toBeNull();
  });

  it("returns null when policy has no disabledServers", () => {
    expect(isToolDisabledByTenant({}, "filesystem__read_file")).toBeNull();
  });

  it("returns null when disabledServers is empty", () => {
    expect(isToolDisabledByTenant({ disabledServers: [] }, "filesystem__read_file")).toBeNull();
  });

  it("returns server name when tool matches a disabled server config key", () => {
    const policy = { disabledServers: ["ExampleMcp"] };
    expect(isToolDisabledByTenant(policy, "AskExampleMcp")).toBe("ExampleMcp");
  });

  it("matches case-insensitively", () => {
    const policy = { disabledServers: ["filesystem"] };
    expect(isToolDisabledByTenant(policy, "Filesystem__Read_File")).toBe("filesystem");
  });

  it("returns null when tool does not match any disabled server", () => {
    const policy = { disabledServers: ["ExampleMcp"] };
    expect(isToolDisabledByTenant(policy, "filesystem__read_file")).toBeNull();
  });

  it("checks multiple disabled servers", () => {
    const policy = { disabledServers: ["ExampleMcp", "playwright"] };
    expect(isToolDisabledByTenant(policy, "AskExampleMcp")).toBe("ExampleMcp");
    expect(isToolDisabledByTenant(policy, "playwright__click")).toBe("playwright");
    expect(isToolDisabledByTenant(policy, "filesystem__read")).toBeNull();
  });
});
