import fs from "fs";
import path from "path";

import { describe, it, expect } from "vitest";

import { getSelfFsTools } from "../electron/marshal-fs/tools";
import { DEFAULT_SETTINGS } from "./marshal-default-settings";
import { SDK_RESERVED_TOOL_NAMES } from "./marshal-sdk-builtin-tools";
import { APP_TOOLS_CATEGORY, MCP_BUILTIN_TOOLS, getToolGroupKey } from "./marshal-tool-registry";
import {
  ALL_PUBLIC_FIRST_PARTY_TOOL_NAMES,
  canonicalizeFirstPartyPermissionKey,
  canonicalizeFirstPartyToolName,
  LEGACY_FIRST_PARTY_TOOL_NAME_MAP,
  LOCAL_FILE_TOOL_NAMES,
  RETIRED_FIRST_PARTY_TOOL_NAMES,
} from "./tool-names";

/** Extract tool names from a category definition. */
function getRegisteredNames(category: typeof APP_TOOLS_CATEGORY): Set<string> {
  const names = new Set<string>();
  for (const group of category.groups) {
    for (const name of group.toolNames) names.add(name);
  }
  return names;
}

/**
 * Extract self-tool names from the source file by parsing canonical camelCase
 * `name: "..."` registrations.
 * This avoids needing to mock all SelfToolDeps just to get tool names.
 */
function getSelfToolNamesFromSource(): Set<string> {
  const src = fs.readFileSync(path.join(__dirname, "../electron/self-tools.ts"), "utf-8");
  const names = new Set<string>();
  for (const match of src.matchAll(/name:\s*"([a-z][A-Za-z0-9]*)"/g)) {
    names.add(match[1]);
  }
  return names;
}

describe("App tool registry sync", () => {
  const implementedNames = getSelfToolNamesFromSource();
  const registeredNames = getRegisteredNames(APP_TOOLS_CATEGORY);
  const localFileNames = getSelfFsTools({
    getWorkspaceDir: () => process.cwd(),
    getEffectiveFolderGrants: () => ({ read: [], write: [] }),
    settingsManager: { get: () => DEFAULT_SETTINGS },
  }).map((tool) => tool.name);

  it("registers every implemented self-tool and local-file tool", () => {
    const missing = [...implementedNames, ...localFileNames].filter(
      (name) => !registeredNames.has(name),
    );
    expect(missing).toEqual([]);
  });

  it("keeps every registered app tool backed by an implementation", () => {
    const implemented = new Set([...implementedNames, ...localFileNames]);
    const stale = [...registeredNames].filter((name) => !implemented.has(name));
    expect(stale).toEqual([]);
  });

  it("keeps the local-file implementation aligned with the catalog", () => {
    expect(localFileNames.sort()).toEqual([...LOCAL_FILE_TOOL_NAMES].sort());
  });
});

describe("first-party public tool catalog", () => {
  const categorized = APP_TOOLS_CATEGORY.groups.flatMap((group) => group.toolNames);

  it("has globally unique prefix-free camelCase names", () => {
    expect(new Set(categorized).size).toBe(categorized.length);
    expect(categorized).toEqual(expect.arrayContaining([...ALL_PUBLIC_FIRST_PARTY_TOOL_NAMES]));
    expect([...ALL_PUBLIC_FIRST_PARTY_TOOL_NAMES]).toEqual(expect.arrayContaining(categorized));
    for (const name of categorized) {
      expect(name).toMatch(/^[a-z][A-Za-z0-9]*$/);
    }
  });

  it("does not categorize retired model surfaces", () => {
    for (const name of RETIRED_FIRST_PARTY_TOOL_NAMES) {
      expect(categorized).not.toContain(name);
    }
  });

  it("leaves prototype-named external tools untouched", () => {
    expect(canonicalizeFirstPartyToolName("constructor")).toBe("constructor");
    expect(canonicalizeFirstPartyPermissionKey("tool:toString")).toBe("tool:toString");
  });

  it("keeps current SDK built-ins outside the legacy first-party namespace", () => {
    for (const name of SDK_RESERVED_TOOL_NAMES) {
      expect(LEGACY_FIRST_PARTY_TOOL_NAME_MAP).not.toHaveProperty(name);
    }
  });
});

describe("Playwright tool registry", () => {
  it("includes the unsafe run-code tool so policy and settings stay aligned", () => {
    const playwrightTools = MCP_BUILTIN_TOOLS.playwright.map((tool) => tool.name);
    expect(playwrightTools).toContain("browser_run_code_unsafe");
  });
});

describe("getToolGroupKey", () => {
  it("resolves every registered app tool to a group", () => {
    const allRegistered = getRegisteredNames(APP_TOOLS_CATEGORY);
    for (const name of allRegistered) {
      expect(getToolGroupKey(`tool:${name}`), `tool:${name} should have a group`).not.toBeNull();
    }
  });
});
