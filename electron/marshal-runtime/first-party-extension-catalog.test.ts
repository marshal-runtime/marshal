import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  FIRST_PARTY_EXTENSION_CATALOG,
  resolveFirstPartyExtensionCatalog,
} from "./first-party-extension-catalog";

describe("first-party extension catalog", () => {
  it("pins and resolves every bundled extension through one catalog", () => {
    const root = path.resolve(import.meta.dirname, "..", "..");
    const resolved = resolveFirstPartyExtensionCatalog({
      location: { isPackaged: false, appPath: root, resourcesPath: root },
      runsDirectory: path.join(root, ".marshal", "swarm"),
    });

    expect(FIRST_PARTY_EXTENSION_CATALOG.map(({ identity }) => identity)).toEqual([
      "@agentic-browser/automation-extension",
      "@agentic-browser/marshal-runtime-extension",
      "@marshal/agentic-debugger-extension",
      "@marshal/swarm",
      "@marshal/overlay-review",
    ]);
    expect(resolved).toHaveLength(FIRST_PARTY_EXTENSION_CATALOG.length);
    for (const extension of resolved) {
      const parsed: unknown = JSON.parse(
        readFileSync(path.join(extension.request.packageRoot, "runtime-extension.json"), "utf8"),
      );
      if (typeof parsed !== "object" || parsed === null) {
        throw new TypeError("First-party extension manifest must be an object");
      }
      const manifest = parsed;
      expect(manifest).toMatchObject({
        identity: extension.identity,
        version: extension.version,
      });
      expect(extension.request.integrity.value).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
