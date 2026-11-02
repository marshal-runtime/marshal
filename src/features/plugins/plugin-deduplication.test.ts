import type { RuntimeExtensionCatalogEntry } from "@marshal/runtime/extensions";
import { describe, expect, it } from "vitest";

import { uniqueByKey, uniqueDetectedItems, uniqueRuntimeEntries } from "./plugin-deduplication";

// oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion is guarded by the surrounding logic; a typed guard is lint debt
const entry = {
  id: "catalog-browser",
  identity: "@marshal/browser",
  version: "1.0.0",
} as RuntimeExtensionCatalogEntry;

describe("plugin deduplication", () => {
  it("prefers an installed entry when the same version appears in multiple sources", () => {
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion is guarded by the surrounding logic; a typed guard is lint debt
    const installed = {
      ...entry,
      id: "native-browser",
      installation: { status: "disabled" },
    } as RuntimeExtensionCatalogEntry;
    const newer = { ...entry, id: "newer-browser", version: "2.0.0" };
    expect(uniqueRuntimeEntries([entry, installed, newer])).toEqual([installed, newer]);
  });

  it("removes repeated discoveries and catalog overlaps while keeping unknown and different versions", () => {
    const detected = {
      candidateId: "one",
      identity: entry.identity,
      version: entry.version,
      status: "detected" as const,
      diagnostics: [],
    };
    const otherVersion = { ...detected, candidateId: "two", version: "2.0.0" };
    const unknown = { candidateId: "unreadable", status: "unreadable" as const, diagnostics: [] };
    expect(
      uniqueDetectedItems(
        [detected, otherVersion, { ...otherVersion, candidateId: "copy" }, unknown],
        [entry],
      ),
    ).toEqual([otherVersion, unknown]);
  });

  it("preserves separately scoped records and removes repeats of the same record", () => {
    const local = { id: "local:test", name: "test" };
    const global = { id: "global:test", name: "test" };
    expect(uniqueByKey([local, global, local], (item) => item.id)).toEqual([local, global]);
  });
});
